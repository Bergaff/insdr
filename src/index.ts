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

    if (url.pathname === '/privacy') {
      return new Response(PRIVACY_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/terms') {
      return new Response(TERMS_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/data-deletion') {
      return new Response(DATA_DELETION_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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

/** Короткая политика конфиденциальности (нужна Meta для Live-режима). */
const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>insdr — Политика конфиденциальности / Privacy Policy</title></head>
<body style="font-family:sans-serif;max-width:720px;margin:2em auto;padding:0 1em;line-height:1.6">
<h1>Политика конфиденциальности insdr</h1>
<p><b>insdr</b> — бот для обработки видео в личных сообщениях Instagram: пользователь отправляет видео,
бот возвращает обработанный видеофайл в тот же чат.</p>
<h2>Какие данные мы получаем</h2>
<ul>
<li>Сообщения, которые вы сами отправляете боту (текст, видео, изображения).</li>
<li>Технические идентификаторы чата, необходимые для ответа (ID отправителя, ID сообщения).</li>
</ul>
<h2>Как используем</h2>
<ul>
<li>Исключительно для обработки вашего видео и отправки результата обратно в чат.</li>
<li>Входящие файлы хранятся временно и удаляются автоматически (до 24 часов), исходящие — до 7 дней.</li>
<li>Мы не продаём и не передаём ваши данные третьим лицам, кроме хостинг-провайдера
(Cloudflare) и API Meta/Instagram, через которые работает доставка сообщений.</li>
</ul>
<h2>Удаление данных</h2>
<p>Удалите переписку с ботом — это удалит сообщения у вас. Чтобы запросить удаление файлов
на нашей стороне, напишите владельцу приложения через страницу приложения в Meta.</p>
<p><i>Дата вступления: 11 сентября 2026 г.</i></p>
<hr>
<h1>Privacy Policy (short version)</h1>
<p><b>insdr</b> is a bot that processes videos sent to it via Instagram Direct and returns
the processed video to the same chat. We store messages you send only to process them and reply:
inbound files are auto-deleted within 24 hours, outbound files within 7 days. We do not sell or
share your data except with our hosting provider (Cloudflare) and Meta/Instagram APIs used for
message delivery.</p>
</body></html>`;

/** Короткое пользовательское соглашение (нужно Meta для Live-режима). */
const TERMS_HTML = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>insdr — Пользовательское соглашение / Terms of Service</title></head>
<body style="font-family:sans-serif;max-width:720px;margin:2em auto;padding:0 1em;line-height:1.6">
<h1>Пользовательское соглашение insdr</h1>
<p><b>insdr</b> — бот для обработки видео в личных сообщениях Instagram.</p>
<ol>
<li><b>Сервис.</b> Вы отправляете видео в личные сообщения аккаунта бота, бот возвращает
обработанный видеофайл в тот же чат. Ответ приходит, как правило, в течение нескольких минут.</li>
<li><b>Правила использования.</b> Запрещено отправлять контент, нарушающий закон или права третьих лиц,
а также спам. Мы вправе не обрабатывать такие сообщения.</li>
<li><b>Ограничения.</b> Принимаются видеофайлы разумного размера (до 64 МБ), результат — до 25 МБ
(техническое ограничение Instagram). Бот отвечает только на сообщения пользователей, первым не пишет.</li>
<li><b>Гарантии.</b> Сервис предоставляется «как есть», без гарантий бесперебойной работы.</li>
<li><b>Конфиденциальность.</b> Обработка данных описана в
<a href="/privacy">Политике конфиденциальности</a>.</li>
</ol>
<p><i>Дата вступления: 11 сентября 2026 г.</i></p>
<hr>
<h1>Terms of Service (short version)</h1>
<p><b>insdr</b> is an Instagram Direct video-processing bot: you send a video, the bot returns
the processed file to the same chat. Do not send unlawful, infringing or spam content.
Inbound files up to 64 MB, results up to 25 MB (Instagram platform limit). The service is
provided "as is", without warranties. Data handling is described in our
<a href="/privacy">Privacy Policy</a>.</p>
</body></html>`;

/** Инструкции по удалению данных (нужно Meta для Live-режима). */
const DATA_DELETION_HTML = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>insdr — Удаление данных / Data Deletion</title></head>
<body style="font-family:sans-serif;max-width:720px;margin:2em auto;padding:0 1em;line-height:1.6">
<h1>Удаление ваших данных</h1>
<ol>
<li><b>Переписка.</b> Удалите чат с ботом в Instagram — сообщения удалятся у вас.
Обратите внимание: удаление чата у вас не всегда удаляет его у собеседника — это ограничение Instagram.</li>
<li><b>Файлы на нашей стороне.</b> Входящие видео удаляются автоматически в течение 24 часов,
исходящие — в течение 7 дней. Отдельного запроса не требуется.</li>
<li><b>Досрочное удаление.</b> Напишите владельцу приложения через страницу приложения в Meta
с пометкой «Data deletion» и вашим username в Instagram — файлы, связанные с вашим чатом,
будут удалены вручную в течение 7 дней, о чём мы ответим тем же каналом.</li>
</ol>
<p>Подробнее — в <a href="/privacy">Политике конфиденциальности</a>.</p>
<hr>
<h1>Data Deletion (short version)</h1>
<p>Delete the chat with the bot in Instagram to remove messages on your side. Files on our side
auto-delete (inbound within 24 hours, outbound within 7 days). For earlier manual deletion,
contact the app owner via the Meta app page with subject "Data deletion" and your Instagram
username — we will delete your files within 7 days.</p>
</body></html>`;
