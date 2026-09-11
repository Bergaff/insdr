import type { Env } from './types';

/**
 * Точка расширения: всё, что превращает входящее видео в исходящее,
 * живёт за этим интерфейсом.
 *
 * Готовые реализации:
 *  - EchoProcessor — возвращает то же самое (проверка пайплайна end-to-end);
 *  - HttpProcessor — шлёт видео на внешний API (multipart, поле "video")
 *    и принимает mp4 в ответ (или JSON { "video_url": "..." }).
 *
 * Лимит: результат обязан быть mp4 ≤ 25 МБ (лимит Meta на видео в DM).
 */
export interface ProcessorInput {
  video: ArrayBuffer;
  contentType: string;
  senderId: string;
  messageId: string;
  source: 'video' | 'share';
}

export interface ProcessorOutput {
  video: ArrayBuffer | ReadableStream;
  contentType?: string;
}

export interface VideoProcessor {
  readonly name: string;
  process(input: ProcessorInput, env: Env): Promise<ProcessorOutput>;
}

/** Пасsthrough: отдаёт входящее видео без изменений. */
export class EchoProcessor implements VideoProcessor {
  readonly name = 'echo';
  async process(input: ProcessorInput): Promise<ProcessorOutput> {
    console.log(`[processor:echo] passthrough ${input.video.byteLength} B`);
    return { video: input.video, contentType: input.contentType || 'video/mp4' };
  }
}

/**
 * Вызывает внешний REST-сервис обработки видео.
 *
 * Запрос:  POST PROCESSOR_URL, multipart/form-data, файл в поле "video"
 *          (+ Authorization: Bearer PROCESSOR_API_KEY, если задан).
 * Ответ:   тело mp4 (content-type video/*)
 *          или JSON { "video_url": "https://..." } — тогда скачиваем по ссылке.
 */
export class HttpProcessor implements VideoProcessor {
  readonly name = 'http';
  constructor(
    private readonly url: string,
    private readonly apiKey?: string,
    private readonly timeoutMs = 14 * 60 * 1000 // чуть меньше wall-clock лимита queue consumer (15 мин)
  ) {}

  async process(input: ProcessorInput): Promise<ProcessorOutput> {
    const form = new FormData();
    form.append('video', new Blob([input.video], { type: input.contentType || 'video/mp4' }), 'video.mp4');

    const headers: Record<string, string> = {};
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    console.log(`[processor:http] → ${this.url} (${input.video.byteLength} B)`);
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`processor ${this.url} → ${res.status}: ${text.slice(0, 500)}`);
    }

    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const u = j && (j.video_url ?? j.url ?? j.result);
      if (typeof u !== 'string') {
        throw new Error('processor JSON ответ должен содержать video_url');
      }
      const r = await fetch(u, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!r.ok) throw new Error(`скачивание результата processor (${u}) → ${r.status}`);
      const buf = await r.arrayBuffer();
      return { video: buf, contentType: (r.headers.get('content-type') ?? 'video/mp4').split(';')[0] };
    }

    const buf = await res.arrayBuffer();
    return { video: buf, contentType: ct.split(';')[0] || 'video/mp4' };
  }
}

export function createProcessor(env: Env): VideoProcessor {
  const kind = (env.PROCESSOR ?? 'echo').toLowerCase();
  if (kind === 'echo') return new EchoProcessor();
  if (kind === 'http') {
    if (!env.PROCESSOR_URL) throw new Error('PROCESSOR=http, но PROCESSOR_URL не задан');
    return new HttpProcessor(env.PROCESSOR_URL, env.PROCESSOR_API_KEY);
  }
  throw new Error(`неизвестный PROCESSOR "${kind}" (поддерживаются: echo, http)`);
}
