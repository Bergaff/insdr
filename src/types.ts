/**
 * Стек Cloudflare: R2 (MEDIA), Queue (JOBS), KV (SEEN, опционально).
 * Секреты/vars — см. wrangler.jsonc и .dev.vars.example.
 */
export interface Env {
  // --- Meta / Instagram ---
  /** Долгоживущий токен (60 дней) Instagram-аккаунта бота. Пусто = dry-run. */
  IG_ACCESS_TOKEN?: string;
  /** App ID приложения Meta (нужен для OAuth-скриптов). */
  IG_APP_ID?: string;
  /** App Secret — проверяем X-Hub-Signature-256 на вебхуке. */
  IG_APP_SECRET?: string;
  /** Строка для hub.verify_token при верификации вебхука. */
  WH_VERIFY_TOKEN?: string;

  // --- Сеть ---
  /** Публичный базовый URL worker (для выдачи готовых mp4 Instagram). */
  PUBLIC_BASE_URL?: string;

  // --- Процессор видео ---
  /** "echo" | "http". */
  PROCESSOR?: string;
  /** Endpoint внешнего API для PROCESSOR=http. */
  PROCESSOR_URL?: string;
  /** Bearer-токен для внешнего API. */
  PROCESSOR_API_KEY?: string;

  // --- Лимиты и тексты ---
  INBOUND_MAX_MB?: string;
  OUTBOUND_MAX_MB?: string;
  QUEUE_MAX_ATTEMPTS?: string;
  /** Текст-подтверждение сразу после получения видео. */
  ACK_TEXT?: string;
  /** Ответ на обычные текстовые сообщения. */
  TEXT_REPLY?: string;
  /** Ответ при ошибке. */
  ERROR_TEXT?: string;
  GRAPH_API_VERSION?: string;

  // --- Биндинги ---
  MEDIA?: R2Bucket;
  SEEN?: KVNamespace;
  JOBS?: Queue;
}

/** Сообщение в очереди на обработку. */
export interface JobPayload {
  messageId: string;
  conversationId?: string;
  senderId: string;
  senderName?: string;
  /** R2-ключ скачанного входящего видео. */
  r2Key: string;
  source: 'video' | 'share';
  contentType: string;
  createdAt: number;
}
