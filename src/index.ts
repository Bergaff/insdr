import type { MessageBatch } from '@cloudflare/workers-types';
import type { Env, JobPayload } from './types';
import { parseWebhookPayload, verifyWebhookSignature } from './webhook';
import { createIgClient } from './ig';
import { handleInboundMessage } from './pipeline';
import { handleJobs } from './queue';
import { serveMedia } from './media';

/**
 * insdr — Instagram DM-бот:
 *   человек кидает рилс в личку → worker скачивает видео,
 *   прогоняет через процессор → кидает mp4 обратно в личку.
 *
 * Маршруты:
 *   GET  /webhook — верификация вебхука Meta (hub.challenge)
 *   POST /webhook — входящие DM (X-Hub-Signature-256)
 *   GET  /m/<key> — отдача mp4 из R2 (Instagram качает результат по этой ссылке)
 *   GET  /health  — статус
 * Queue consumer: обработка видео (см. src/queue.ts).
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        live: Boolean(env.IG_ACCESS_TOKEN),
        processor: env.PROCESSOR ?? 'echo',
        r2: Boolean(env.MEDIA),
        queue: Boolean(env.JOBS),
      });
    }

    if (url.pathname === '/webhook') {
      // 1) Верификация: GET ?hub.mode=subscribe&hub.challenge=...&hub.verify_token=...
      if (request.method === 'GET') {
        const mode = url.searchParams.get('hub.mode');
        const challenge = url.searchParams.get('hub.challenge');
        const token = url.searchParams.get('hub.verify_token');
        if (
          mode === 'subscribe' &&
          challenge &&
          token &&
          env.WH_VERIFY_TOKEN &&
          token === env.WH_VERIFY_TOKEN
        ) {
          return new Response(challenge, { headers: { 'Content-Type': 'text/plain' } });
        }
        return new Response('verify token mismatch', { status: 403 });
      }

      // 2) События: POST с X-Hub-Signature-256
      if (request.method === 'POST') {
        const raw = await request.arrayBuffer();

        if (env.IG_APP_SECRET) {
          const sigHeader = request.headers.get('X-Hub-Signature-256');
          const ok = await verifyWebhookSignature(raw, sigHeader, env.IG_APP_SECRET);
          if (!ok) {
            console.warn(
              `[webhook] подпись X-Hub-Signature-256 не совпала (header: ${sigHeader ? 'есть' : 'нет'}, body: ${raw.byteLength} B)`
            );
            return new Response('bad signature', { status: 401 });
          }
        }

        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return new Response('bad json', { status: 400 });
        }

        const messages = parseWebhookPayload(body);
        if (messages.length === 0) {
          return new Response('ok', { status: 200 });
        }

        // Отвечаем Meta сразу, а обработку догоняем во background.
        const ig = createIgClient(env);
        for (const msg of messages) {
          ctx.waitUntil(handleInboundMessage(env, ig, msg));
        }
        return new Response('ok', { status: 200 });
      }

      return new Response('method not allowed', { status: 405 });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/m/')) {
      let key = '';
      try {
        key = decodeURIComponent(url.pathname.slice('/m/'.length));
      } catch {
        return new Response('bad key', { status: 400 });
      }
      return serveMedia(env, key, request.headers.get('Range'));
    }

    return new Response('not found', { status: 404 });
  },

  async queue(batch: MessageBatch<JobPayload>, env: Env): Promise<void> {
    return handleJobs(env, batch);
  },
};
