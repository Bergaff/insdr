/**
 * Юнит-тесты чистой логики (парсер вебхуков, подпись, ключи R2).
 * Запуск: npm run selftest (собирает esbuild'ом под node).
 */
import { parseWebhookPayload, verifyWebhookSignature } from './webhook';
import { extractAssetId, extractShortcode } from './pipeline';
import { safeMediaKey } from './media';

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.error(`  ✘ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

// ---------- парсинг: format "messaging" (Messenger Platform) ----------
console.log('\nwebhook parsing (messaging format):');
const messagingVideo = {
  object: 'instagram',
  entry: [
    {
      id: '17841476669073037',
      time: 1757093298060,
      messaging: [
        {
          sender: { id: '17841476669073038' },
          recipient: { id: '17841476669073037' },
          timestamp: 1757093297378,
          message: {
            mid: 'aWdfZAG1faXRlbToxOklHTWVz...',
            attachments: [
              {
                type: 'video',
                payload: {
                  url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=17869495296426197&signature=abc',
                },
              },
            ],
          },
        },
      ],
    },
  ],
};
const m1 = parseWebhookPayload(messagingVideo);
check('одно сообщение', m1.length === 1);
check('senderId', m1[0]?.senderId === '17841476669073038');
check('messageId', m1[0]?.messageId === 'aWdfZAG1faXRlbToxOklHTWVz...');
check('video url', m1[0]?.media[0]?.url?.includes('asset_id=17869495296426197') === true);

const shareMsg = {
  entry: [
    {
      messaging: [
        {
          sender: { id: '42' },
          recipient: { id: '1' },
          timestamp: 1,
          message: {
            mid: 'mid-share',
            attachments: [{ type: 'share', payload: { url: 'https://www.instagram.com/reel/Cabc123XYZ/' } }],
          },
        },
      ],
    },
  ],
};
const m2 = parseWebhookPayload(shareMsg);
check('share type', m2[0]?.media[0]?.type === 'share');

const textMsg = {
  entry: [
    {
      messaging: [
        {
          sender: { id: '43' },
          recipient: { id: '1' },
          timestamp: 2,
          message: { mid: 'mid-text', text: 'привет' },
        },
      ],
    },
  ],
};
check('text', parseWebhookPayload(textMsg)[0]?.text === 'привет');

const echoMsg = {
  entry: [
    {
      messaging: [
        {
          is_echo: true,
          sender: { id: '17841476669073037' },
          recipient: { id: '17841476669073038' },
          timestamp: 3,
          message: { mid: 'mid-echo', text: 'echo' },
        },
      ],
    },
  ],
};
check('echo флаг', parseWebhookPayload(echoMsg)[0]?.isEcho === true);

// ---------- парсинг: format "changes" (Instagram Login) ----------
console.log('\nwebhook parsing (changes format):');
const changesVideo = {
  object: 'instagram',
  entry: [
    {
      id: '17841476669073037',
      time: 1757093298060,
      changes: [
        {
          field: 'messages',
          value: {
            id: 'evt-1',
            conversation: { id: 'conv-1' },
            type: 'MESSAGE',
            sender: { ig_scoped_id: '77', ig_name: 'user.name' },
            recipient: { id: '17841476669073037' },
            message: {
              id: 'mid-changes',
              media: [{ type: 'video', url: 'https://cdn.example/v.mp4', thumbnail_url: 'https://cdn.example/t.jpg' }],
            },
            create_time: 1757093297000,
          },
        },
      ],
    },
  ],
};
const m3 = parseWebhookPayload(changesVideo);
check('одно сообщение', m3.length === 1);
check('senderId (ig_scoped_id)', m3[0]?.senderId === '77');
check('senderName', m3[0]?.senderName === 'user.name');
check('conversationId', m3[0]?.conversationId === 'conv-1');
check('video url', m3[0]?.media[0]?.url === 'https://cdn.example/v.mp4');
check('thumbnail', m3[0]?.media[0]?.thumbnailUrl === 'https://cdn.example/t.jpg');

// другие поля changes игнорируются
const otherChanges = {
  entry: [{ changes: [{ field: 'comments', value: { id: 'x' } }] }],
};
check('comments игнор', parseWebhookPayload(otherChanges).length === 0);

check('пустой payload', parseWebhookPayload({}).length === 0);
check('мусор', parseWebhookPayload(null).length === 0);

// ---------- извлечение id ----------
console.log('\nid extraction:');
check(
  'asset_id из CDN url',
  extractAssetId('https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=17869495296426197&signature=x') ===
    '17869495296426197'
);
check('short-code из permalink', extractShortcode('https://www.instagram.com/reel/Cabc123XYZ/?utm=x') === 'Cabc123XYZ');
check('p permalink', extractShortcode('https://www.instagram.com/p/AbCdEf_Gh/') === 'AbCdEf_Gh');
check('нет id', extractAssetId('https://example.com/') === undefined);

// ---------- подпись ----------
console.log('\nsignature:');
const secret = 'test-secret';
const body = JSON.stringify(messagingVideo);
const enc = new TextEncoder().encode(body);
const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(secret),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign']
);
const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc));
const hexSig = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
const buf = new ArrayBuffer(enc.byteLength);
new Uint8Array(buf).set(enc);

check('валидная подпись', (await verifyWebhookSignature(buf, `sha256=${hexSig}`, secret)) === true);
const corrupted = (hexSig[0] === 'f' ? '0' : 'f') + hexSig.slice(1);
check('битая подпись (та же длина)', (await verifyWebhookSignature(buf, `sha256=${corrupted}`, secret)) === false);
check('чужой секрет', (await verifyWebhookSignature(buf, `sha256=${hexSig}`, 'other')) === false);
check('нет заголовка', (await verifyWebhookSignature(buf, null, secret)) === false);
check('без секрета', (await verifyWebhookSignature(buf, `sha256=${hexSig}`, '')) === false);

// ---------- R2 ключи ----------
console.log('\nr2 keys:');
check('inbound ok', safeMediaKey('inbound/abc_123.mp4') === 'inbound/abc_123.mp4');
check('outbound ok', safeMediaKey('outbound/abc.1735100000000.mp4') === 'outbound/abc.1735100000000.mp4');
check('path traversal', safeMediaKey('../etc/passwd') === null);
check('чужой префикс', safeMediaKey('private/x.mp4') === null);
check('слэш', safeMediaKey('a/b/c.mp4') === null);

console.log(failed === 0 ? '\nВсе тесты пройдены ✅' : `\nПРОВАЛЕНО ТЕСТОВ: ${failed} ❌`);
process.exit(failed === 0 ? 0 : 1);
