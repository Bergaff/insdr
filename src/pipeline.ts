import type { Env, JobPayload } from './types';
import type { IgClient } from './ig';
import type { InboundMessage } from './webhook';

export class OversizeError extends Error {
  constructor(bytes: number, maxBytes: number) {
    super(`входящее видео ${Math.round(bytes / 1048576)} МБ больше лимита ${Math.round(maxBytes / 1048576)} МБ`);
    this.name = 'OversizeError';
  }
}

function toIntMb(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Скачивает URL в память с лимитом по размеру.
 * URL из вебхука Meta временный (CDN ig_messaging_cdn), поэтому скачиваем сразу.
 */
export async function fetchWithBudget(
  url: string,
  maxBytes: number
): Promise<{ buf: ArrayBuffer; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`скачивание ${url} → HTTP ${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new OversizeError(total, maxBytes);
      }
    }
  }
  const buf = new ArrayBuffer(total);
  const u8 = new Uint8Array(buf);
  let off = 0;
  for (const c of chunks) {
    u8.set(c, off);
    off += c.length;
  }
  const contentType = res.headers.get('content-type')?.split(';')[0] ?? 'video/mp4';
  return { buf, contentType };
}

/** asset_id из URL CDN Meta: .../ig_messaging_cdn/?asset_id=178...&signature=... */
export function extractAssetId(url: string): string | undefined {
  const m = url.match(/[?&]asset_id=(\d+)/);
  return m?.[1];
}

/** short-code поста из permalink: https://www.instagram.com/reel/Cxxxx/ */
export function extractShortcode(url: string): string | undefined {
  const m = url.match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
  return m?.[1];
}

function cleanKeyPart(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '');
}

/**
 * Обработка одного входящего сообщения:
 *  дедупликация → ACK → скачивание видео → R2 → очередь.
 * Ответ в DM уже ушёл до обработки, чтобы пользователь не ждал молчания.
 */
export async function handleInboundMessage(env: Env, ig: IgClient, msg: InboundMessage): Promise<void> {
  const mid = msg.messageId;

  // Дедупликация: Meta ретраит доставку до 36 часов.
  if (env.SEEN) {
    const key = `m:${cleanKeyPart(mid)}`;
    try {
      if (await env.SEEN.get(key)) {
        console.log(`[webhook] ${mid}: дубликат, пропускаю`);
        return;
      }
      await env.SEEN.put(key, '1', { expirationTtl: 5 * 24 * 3600 });
    } catch (e) {
      console.warn('[webhook] дедупликация недоступна:', e);
    }
  }

  if (msg.isEcho) {
    console.log(`[webhook] ${mid}: echo, игнорирую`);
    return;
  }
  if (!msg.senderId) return;

  const ackText = env.ACK_TEXT ?? 'Получил видео, обрабатываю 🎬';
  const errorText = env.ERROR_TEXT ?? 'Не получилось обработать видео. Попробуй отправить его ещё раз.';

  // 1) Обычный текст — вежливо отвечаем.
  if (msg.text && msg.media.length === 0) {
    const reply =
      env.TEXT_REPLY ??
      'Привет! Я бот 🤖 Пришли мне видео (рилс) прямо сюда в личку — и я верну результат.';
    await ig.sendText(msg.senderId, reply);
    return;
  }

  // 2) Ищем видео: вложение видео либо share (поделиться постом/рилсом).
  let downloadUrl: string | undefined;
  let source: 'video' | 'share' = 'video';

  const video = msg.media.find((m) => m.type === 'video' && m.url);
  const share = msg.media.find((m) => m.type === 'share' && m.url);

  if (video) {
    downloadUrl = video.url;
  } else if (share) {
    source = 'share';
    const idOrShortcode = extractAssetId(share.url!) ?? extractShortcode(share.url!);
    if (!idOrShortcode) {
      await ig.sendText(msg.senderId, 'Похоже, я не понял, какой рилс ты поделился. Отправь видео как вложение в чат, пожалуйста.');
      return;
    }
    const media = await ig.resolveMedia(idOrShortcode);
    if (media?.mediaUrl) {
      downloadUrl = media.mediaUrl;
    } else {
      await ig.sendText(
        msg.senderId,
        'Поделиться ссылкой на рилс я скачать не могу. Отправь видео напрямую в чат: камера → выбрать видео → отправить 🎬'
      );
      return;
    }
  }

  if (!downloadUrl) {
    if (msg.media.length > 0) {
      await ig.sendText(msg.senderId, 'Пока я отвечаю только на видео. Пришли рилс в личку 🎬');
    }
    return;
  }

  if (!env.MEDIA || !env.JOBS) {
    console.error('[webhook] биндинги MEDIA/JOBS не настроены (см. wrangler.jsonc)');
    await ig.sendText(msg.senderId, 'Сервис временно недоступен. Попробуй чуть позже.');
    return;
  }

  // 3) Немедленный ACK, потом скачивание + очередь.
  await ig.sendText(msg.senderId, ackText);

  try {
    const maxBytes = toIntMb(env.INBOUND_MAX_MB, 64) * 1048576;
    const { buf, contentType } = await fetchWithBudget(downloadUrl, maxBytes);
    const r2Key = `inbound/${cleanKeyPart(mid)}.mp4`;
    await env.MEDIA.put(r2Key, buf, { httpMetadata: { contentType } });
    const job: JobPayload = {
      messageId: mid,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      r2Key,
      source,
      contentType,
      createdAt: Date.now(),
    };
    await env.JOBS.send(job);
    console.log(`[webhook] ${mid}: скачано ${buf.byteLength} B → задача в очереди`);
  } catch (e) {
    console.error(`[webhook] ${mid}: ошибка при скачивании/очереди:`, e);
    await ig.sendText(msg.senderId, e instanceof OversizeError ? 'Видео получилось слишком большим. Попробуй ролик покороче.' : errorText);
  }
}
