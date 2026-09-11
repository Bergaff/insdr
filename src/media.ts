import type { Env } from './types';

/** Ключи вида inbound/<id>.mp4 и outbound/<id>.<ts>.mp4 */
const KEY_RE = /^(inbound|outbound)\/[\w.-]+$/;

export function safeMediaKey(key: string): string | null {
  if (!KEY_RE.test(key) || key.includes('..')) return null;
  return key;
}

interface ByteRange {
  offset: number;
  length: number;
}

/** Разбирает заголовок вида "bytes=123-455"; null — если нет/не понял. */
function parseRange(header: string | null, total: number): ByteRange | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const start = m[1] === '' ? undefined : Number(m[1]);
  const end = m[2] === '' ? undefined : Number(m[2]);
  if (start === undefined && end === undefined) return null;
  if (start !== undefined && start >= total) return null;
  const offset = start ?? 0;
  const length = end === undefined ? total - offset : Math.min(end - offset + 1, total - offset);
  if (length <= 0) return null;
  return { offset, length };
}

/**
 * GET /m/<key> — отдаёт mp4 из R2.
 * Instagram скачивает видео по этой ссылке, когда бот отправляет DM.
 * Поддерживает Range-запросы (просмотр в браузере).
 */
export async function serveMedia(env: Env, key: string, rangeHeader: string | null): Promise<Response> {
  const safe = safeMediaKey(key);
  if (!safe || !env.MEDIA) return new Response('not found', { status: 404 });

  // Сначала полный объект — узнаём size (метаданные R2, дёшево).
  const full = await env.MEDIA.get(safe);
  if (!full) return new Response('not found', { status: 404 });

  const contentType = full.httpMetadata?.contentType ?? 'video/mp4';
  const range = parseRange(rangeHeader, full.size);

  const obj = range ? await env.MEDIA.get(safe, { range }) : full;
  if (!obj) return new Response('not found', { status: 404 });

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=86400',
    'Accept-Ranges': 'bytes',
  };
  if (range) {
    headers['Content-Range'] = `bytes ${range.offset}-${range.offset + obj.size - 1}/${full.size}`;
    headers['Content-Length'] = String(obj.size);
    return new Response(obj.body, { status: 206, headers });
  }
  headers['Content-Length'] = String(obj.size);
  return new Response(obj.body, { headers });
}
