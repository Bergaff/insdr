import type { MessageBatch } from '@cloudflare/workers-types';
import type { Env, JobPayload } from './types';
import { createIgClient, IgApiError } from './ig';
import { createProcessor } from './processor';

function toIntMb(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Queue consumer: берёт задачу, прогоняет видео через процессор,
 * складывает результат в R2 и отправляет его обратно в DM.
 */
export async function handleJobs(env: Env, batch: MessageBatch<unknown>): Promise<void> {
  const ig = createIgClient(env);
  const maxAttempts = toIntMb(env.QUEUE_MAX_ATTEMPTS, 4);

  for (const m of batch.messages) {
    const p = m.body as JobPayload;
    if (!p || typeof p !== 'object' || !p.messageId || !p.senderId || !p.r2Key) {
      console.error('[queue] некорректный payload задачи, пропускаю', p);
      m.ack();
      continue;
    }
    try {
      if (!env.MEDIA) throw new Error('биндинг R2 (MEDIA) не настроен');

      const obj = await env.MEDIA.get(p.r2Key);
      if (!obj) throw new Error(`входящий объект ${p.r2Key} не найден в R2`);

      const processor = createProcessor(env);
      const out = await processor.process(
        {
          video: await obj.arrayBuffer(),
          contentType: obj.httpMetadata?.contentType ?? 'video/mp4',
          senderId: p.senderId,
          messageId: p.messageId,
          source: p.source,
        },
        env
      );

      const bytes =
        out.video instanceof ArrayBuffer ? out.video : await new Response(out.video as ReadableStream).arrayBuffer();
      const contentType = out.contentType ?? 'video/mp4';

      const maxOutBytes = toIntMb(env.OUTBOUND_MAX_MB, 25) * 1048576;
      if (bytes.byteLength > maxOutBytes) {
        await ig.sendText(
          p.senderId,
          'Готово, но файл получился больше 25 МБ — Instagram не даёт такое отправить. Попробуй другой ролик.'
        );
        console.warn(`[queue] ${p.messageId}: результат ${bytes.byteLength} B превышает лимит, не отправляю`);
        m.ack();
        continue;
      }

      const base = (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
      if (!base) throw new Error('PUBLIC_BASE_URL не задан — Instagram не сможет скачать результат');

      const outKey = `outbound/${p.messageId}.${Date.now()}.mp4`;
      await env.MEDIA.put(outKey, bytes, { httpMetadata: { contentType } });
      const publicUrl = `${base}/m/${outKey}`;

      await ig.sendVideo(p.senderId, publicUrl);
      console.log(`[queue] ${p.messageId}: отправлено видео ${bytes.byteLength} B → ${p.senderId}`);
      m.ack();
    } catch (e) {
      const msg = e instanceof IgApiError ? `${e.message} (code=${e.code ?? '-'}, subcode=${e.subcode ?? '-'})` : String(e);
      console.error(`[queue] ${p.messageId}: attempt ${m.attempts}/${maxAttempts} FAILED: ${msg}`);
      if (m.attempts >= maxAttempts) {
        // Больше не ретраим — сообщаем человеку один раз.
        try {
          await ig.sendText(p.senderId, 'Что-то пошло не так при обработке видео. Попробуй ещё раз чуть позже.');
        } catch {
          /* пользователь мог просто удалить чат — не критично */
        }
        m.ack();
      } else {
        m.retry();
      }
    }
  }
}
