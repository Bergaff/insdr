/**
 * Парсинг и верификация вебхуков Instagram Messaging API.
 *
 * Meta присылает входящие DM одним из двух форматов (оба поддерживаем):
 *
 * 1) "messaging"-формат (Messenger Platform, актуальный):
 * {
 *   "object": "instagram",
 *   "entry": [{
 *     "id": "<IG_ACCOUNT_ID>",
 *     "time": 1757093298060,
 *     "messaging": [{
 *       "sender":   { "id": "<IGSID>" },
 *       "recipient":{ "id": "<IG_ACCOUNT_ID>" },
 *       "timestamp": 1757093297378,
 *       "is_echo": false,
 *       "message": {
 *         "mid": "<MESSAGE_ID>",
 *         "text": "..."                                  // либо
 *         "attachments": [                               // либо
 *           { "type": "video", "payload": { "url": "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=...&signature=..." } }
 *         ]
 *       }
 *     }]
 *   }]
 * }
 *
 * 2) "changes"-формат (Instagram API with Instagram Login):
 * {
 *   "object": "instagram",
 *   "entry": [{
 *     "id": "<IG_ACCOUNT_ID>",
 *     "time": 1757093298060,
 *     "changes": [{
 *       "field": "messages",
 *       "value": {
 *         "id": "<EVENT_ID>",
 *         "conversation": { "id": "<CONVERSATION_ID>" },
 *         "type": "MESSAGE",
 *         "sender": { "ig_scoped_id": "<IGSID>", "ig_name": "username" },
 *         "recipient": { "id": "<IG_ACCOUNT_ID>" },
 *         "message": {
 *           "id": "<MESSAGE_ID>",
 *           "text": "..."                                 // либо
 *           "media": [ { "type": "video", "url": "https://...", "thumbnail_url": "https://..." } ]
 *         },
 *         "create_time": 1757093297378
 *       }
 *     }]
 *   }]
 * }
 */

export interface IncomingMedia {
  /** video | image | share | audio | file | unknown */
  type: string;
  /** URL медиа (у share — URL CDN с asset_id или permalink поста). */
  url?: string;
  thumbnailUrl?: string;
  title?: string;
}

export interface InboundMessage {
  messageId: string;
  conversationId?: string;
  /** Instagram-scoped ID отправителя (IGSID) — используем как recipient.id. */
  senderId: string;
  senderName?: string;
  text?: string;
  media: IncomingMedia[];
  timestamp?: number;
  /** true, если событие — эхо нашего же сообщения (Meta дублирует outbound). */
  isEcho: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = any;

export function parseWebhookPayload(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  if (!body || typeof body !== 'object') return out;
  const root = body as AnyRecord;
  const entries: AnyRecord[] = Array.isArray(root.entry) ? root.entry : [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    // --- Формат 1: entry.messaging[] ---
    if (Array.isArray(entry.messaging)) {
      for (const m of entry.messaging) {
        if (!m || typeof m !== 'object') continue;
        const msg = m.message;
        if (!msg || typeof msg !== 'object') continue;

        const media: IncomingMedia[] = [];
        if (Array.isArray(msg.attachments)) {
          for (const a of msg.attachments) {
            if (!a || typeof a !== 'object') continue;
            media.push({
              type: typeof a.type === 'string' ? a.type : 'unknown',
              url: typeof a.payload?.url === 'string' ? a.payload.url : undefined,
              thumbnailUrl: typeof a.payload?.thumbnail_url === 'string' ? a.payload.thumbnail_url : undefined,
              title: typeof a.payload?.title === 'string' ? a.payload.title : undefined,
            });
          }
        }

        out.push({
          messageId:
            (typeof msg.mid === 'string' && msg.mid) ||
            (typeof m.timestamp === 'number' ? String(m.timestamp) : `msg-${Math.random()}`),
          conversationId: typeof msg.conversation?.id === 'string' ? msg.conversation.id : undefined,
          senderId: typeof m.sender?.id === 'string' ? m.sender.id : '',
          senderName: typeof m.sender?.name === 'string' ? m.sender.name : undefined,
          text: typeof msg.text === 'string' ? msg.text : undefined,
          media,
          timestamp: typeof m.timestamp === 'number' ? m.timestamp : undefined,
          isEcho: Boolean(m.is_echo || m.is_self || msg.is_echo || msg.is_self || msg.is_unsupported),
        });
      }
    }

    // --- Формат 2: entry.changes[] (field = "messages") ---
    if (Array.isArray(entry.changes)) {
      for (const ch of entry.changes) {
        if (!ch || typeof ch !== 'object' || ch.field !== 'messages') continue;
        const v = ch.value;
        if (!v || typeof v !== 'object') continue;
        const msg = v.message ?? {};

        const media: IncomingMedia[] = [];
        if (Array.isArray(msg.media)) {
          for (const mm of msg.media) {
            if (!mm || typeof mm !== 'object') continue;
            media.push({
              type: typeof mm.type === 'string' ? mm.type : 'unknown',
              url: typeof mm.url === 'string' ? mm.url : undefined,
              thumbnailUrl: typeof mm.thumbnail_url === 'string' ? mm.thumbnail_url : undefined,
              title: typeof mm.title === 'string' ? mm.title : undefined,
            });
          }
        }

        out.push({
          messageId:
            (typeof msg.id === 'string' && msg.id) ||
            (typeof v.id === 'string' && v.id) ||
            (typeof v.create_time === 'number' ? String(v.create_time) : `msg-${Math.random()}`),
          conversationId: typeof v.conversation?.id === 'string' ? v.conversation.id : undefined,
          senderId: typeof v.sender?.ig_scoped_id === 'string' ? v.sender.ig_scoped_id : '',
          senderName: typeof v.sender?.ig_name === 'string' ? v.sender.ig_name : undefined,
          text: typeof msg.text === 'string' ? msg.text : undefined,
          media,
          timestamp: typeof v.create_time === 'number' ? v.create_time : undefined,
          isEcho: Boolean(v.is_echo || v.is_self),
        });
      }
    }
  }

  return out;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Проверяет X-Hub-Signature-256 (HMAC-SHA256 от сырого тела с App Secret).
 * Возвращает false, если секрет не настроен или подпись не сходится.
 */
export async function verifyWebhookSignature(
  body: ArrayBuffer,
  headerSignature: string | null,
  appSecret: string
): Promise<boolean> {
  if (!appSecret) return false;
  if (!headerSignature) return false;
  const prefix = 'sha256=';
  if (!headerSignature.startsWith(prefix)) return false;
  const provided = headerSignature.slice(prefix.length);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, body);
  return timingSafeEqual(provided, hex(new Uint8Array(digest)));
}
