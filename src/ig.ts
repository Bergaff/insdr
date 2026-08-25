import type { Env } from './types';

export const GRAPH_BASE = 'https://graph.instagram.com';

export class IgApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly subcode?: number
  ) {
    super(message);
    this.name = 'IgApiError';
  }
}

export interface ResolvedMedia {
  mediaUrl?: string;
  mediaType?: string;
  permalink?: string;
}

export interface IgClient {
  /** true — реальные запросы к Meta; false — dry-run (логирование в консоль). */
  readonly live: boolean;
  /** @returns message_id */
  sendText(to: string, text: string): Promise<string | undefined>;
  /** Отправляет видео по публичному URL (Meta сама его скачивает). @returns message_id */
  sendVideo(to: string, videoUrl: string): Promise<string | undefined>;
  /** Пытается разрешить media id/short-code в скачиваемый URL (для share-сообщений). */
  resolveMedia(idOrShortcode: string): Promise<ResolvedMedia | null>;
  me(): Promise<{ userId: string; username: string }>;
}

function apiVersion(env: Env): string {
  return env.GRAPH_API_VERSION ?? 'v25.0';
}

class LiveIgClient implements IgClient {
  readonly live = true;
  constructor(private readonly env: Env) {}

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${GRAPH_BASE}/${apiVersion(this.env)}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.env.IG_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const err = (data?.error ?? {}) as Record<string, unknown>;
      throw new IgApiError(
        `IG API ${path} → ${res.status}: ${String(err.message ?? '')} ${String(
          err.error_user_msg ?? ''
        )}`.trim(),
        typeof err.code === 'number' ? err.code : res.status,
        typeof err.error_subcode === 'number' ? err.error_subcode : undefined
      );
    }
    return data ?? {};
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(
      `${GRAPH_BASE}/${apiVersion(this.env)}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(
        this.env.IG_ACCESS_TOKEN!
      )}`
    );
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const err = (data?.error ?? {}) as Record<string, unknown>;
      throw new IgApiError(
        `IG API GET ${path} → ${res.status}: ${String(err.message ?? '')}`.trim(),
        typeof err.code === 'number' ? err.code : res.status,
        typeof err.error_subcode === 'number' ? err.error_subcode : undefined
      );
    }
    return data ?? {};
  }

  async sendText(to: string, text: string): Promise<string | undefined> {
    // Лимит Meta: 1000 байт UTF-8.
    const safe = new TextEncoder().encode(text).slice(0, 1000);
    const data = await this.post('/me/messages', {
      recipient: { id: to },
      message: { text: new TextDecoder().decode(safe) },
    });
    return typeof data.message_id === 'string' ? data.message_id : undefined;
  }

  async sendVideo(to: string, videoUrl: string): Promise<string | undefined> {
    const data = await this.post('/me/messages', {
      recipient: { id: to },
      message: {
        attachment: {
          type: 'video',
          payload: { url: videoUrl },
        },
      },
    });
    return typeof data.message_id === 'string' ? data.message_id : undefined;
  }

  async resolveMedia(idOrShortcode: string): Promise<ResolvedMedia | null> {
    try {
      const data = await getMediaById(this.env, idOrShortcode);
      return {
        mediaUrl: typeof data.media_url === 'string' ? data.media_url : undefined,
        mediaType: typeof data.media_type === 'string' ? data.media_type : undefined,
        permalink: typeof data.permalink === 'string' ? data.permalink : undefined,
      };
    } catch {
      return null;
    }
  }

  async me(): Promise<{ userId: string; username: string }> {
    const data = await this.get('/me?fields=user_id,username');
    return {
      userId: typeof data.user_id === 'string' ? data.user_id : '',
      username: typeof data.username === 'string' ? data.username : '',
    };
  }
}

/**
 * Dry-run: вместо реальных запросов Meta логит DM в консоль.
 * Используется локально, когда IG_ACCESS_TOKEN пуст (wrangler dev).
 */
class DryRunIgClient implements IgClient {
  readonly live = false;
  async sendText(to: string, text: string): Promise<string | undefined> {
    console.log(`[dry-run] 📩 text DM → ${to}: ${text}`);
    return `dry-msg-${Math.random().toString(36).slice(2)}`;
  }
  async sendVideo(to: string, videoUrl: string): Promise<string | undefined> {
    console.log(`[dry-run] 🎬 video DM → ${to}: ${videoUrl}`);
    return `dry-msg-${Math.random().toString(36).slice(2)}`;
  }
  async resolveMedia(): Promise<ResolvedMedia | null> {
    // Без токена разрешить share нельзя — обработчик попросит отправить видео вложением.
    return null;
  }
  async me(): Promise<{ userId: string; username: string }> {
    return { userId: 'DRY-RUN', username: 'dry_run' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getMediaById(env: Env, idOrShortcode: string): Promise<any> {
  const url = `${GRAPH_BASE}/${apiVersion(env)}/${idOrShortcode}?fields=id,media_type,media_url,permalink,username&access_token=${encodeURIComponent(
    env.IG_ACCESS_TOKEN!
  )}`;
  const res = await fetch(url);
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const err = (data?.error ?? {}) as Record<string, unknown>;
    throw new IgApiError(
      `IG media resolve ${idOrShortcode} → ${res.status}: ${String(err.message ?? '')}`.trim(),
      typeof err.code === 'number' ? err.code : res.status,
      typeof err.error_subcode === 'number' ? err.error_subcode : undefined
    );
  }
  return data ?? {};
}

export function createIgClient(env: Env): IgClient {
  return env.IG_ACCESS_TOKEN ? new LiveIgClient(env) : new DryRunIgClient();
}
