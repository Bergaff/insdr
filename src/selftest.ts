/**
 * Юнит-тесты чистой логики (парсер вебхуков, подпись, ключи R2).
 * Запуск: npm run selftest (собирает esbuild'ом под node).
 */
import { parseWebhookPayload, verifyWebhookSignature } from './webhook';
import { extractAssetId, extractShortcode } from './pipeline';
import { safeMediaKey } from './media';
import { parseAd } from './ads';

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

// ---------- парсер объявлений (попутки/посылки) ----------
console.log('\nads parsing:');

// 1) Структурированная посылка — одно плечо строго по полям.
const parcel = parseAd(
  'ПОСЫЛКА\n#посылка\nОткуда: Минск\nКуда: Стамбул\nКогда: до 22.09.2026\nЦена: 15-20$\nКомментарий: маленький конвертик с кусочком ткани'
);
check('parcel kind', parcel.kind === 'parcel');
check('parcel одно плечо', parcel.legs.length === 1);
check(
  'parcel from/to',
  parcel.legs[0]?.from === 'Минск' && parcel.legs[0]?.to === 'Стамбул'
);
check('parcel date', parcel.legs[0]?.dateRaw?.includes('22.09.2026') === true);
check('parcel price', parcel.price === '15-20$');
check('parcel comment', parcel.comment?.includes('конвертик') === true);

// 2) Водитель, два направления в одном сообщении — два плеча по датам.
const driver2 = parseAd(
  '🚗#водитель подстроюсь\nпередачи попутчики посылки\n18-19.9 Белосток Гр Минск\n20-21.9 Мог Минск Белосток\nVb+375256663703\nTG+48459568684:KgRBPL'
);
check('driver kind', driver2.kind === 'driver');
check('driver два плеча', driver2.legs.length === 2);
check(
  'плечо 1 Белосток→Минск через Гродно',
  driver2.legs[0]?.from === 'Белосток' &&
    driver2.legs[0]?.to === 'Минск' &&
    driver2.legs[0]?.via.join(',') === 'Гродно' &&
    driver2.legs[0]?.dateRaw === '18-19.9'
);
check(
  'плечо 2 Могилёв→Белосток через Минск',
  driver2.legs[1]?.from === 'Могилёв' &&
    driver2.legs[1]?.to === 'Белосток' &&
    driver2.legs[1]?.via.join(',') === 'Минск' &&
    driver2.legs[1]?.dateRaw === '20-21.9'
);
check(
  'контакты',
  driver2.contacts.some((c) => c.includes('375256663703')) &&
    driver2.contacts.some((c) => c.includes('48459568684'))
);

// 3) Погранпункт пропускается + «обратно» разворачивает плечо; время не путается с датами.
const driver3 = parseAd(
  '18.09, пятница, в 15.00-16.00 еду Белосток Кузница Гродно.\nЕсть места, посылки пачкоматы\n20.09, воскресенье, в 11.00-12.00 обратно.\n\nВайбер +375297872212.'
);
check('driver3 kind', driver3.kind === 'driver');
check('driver3 два плеча', driver3.legs.length === 2);
check(
  'Кузница пропущена для заявки',
  driver3.legs[0]?.from === 'Белосток' &&
    driver3.legs[0]?.to === 'Гродно' &&
    driver3.legs[0]?.via.length === 0 &&
    driver3.legs[0]?.borderPoints.join(',') === 'Кузница' &&
    driver3.legs[0]?.dateRaw === '18.09'
);
check(
  'обратно развёрнуто',
  driver3.legs[1]?.reversed === true &&
    driver3.legs[1]?.from === 'Гродно' &&
    driver3.legs[1]?.to === 'Белосток' &&
    driver3.legs[1]?.dateRaw === '20.09'
);
check(
  'контакт вайбер',
  driver3.contacts.some((c) => c.includes('375297872212'))
);

// 4) Маршрут уровня страны + «обратно» с явным маршрутом и датой в конце.
const driver4 = parseAd(
  '28 сентября еду из РБ в Киев. Возьму попутчиков, посылки, передачи\nОбратно из Киева в Рб в период с 29.09-1.10'
);
check('driver4 два плеча', driver4.legs.length === 2);
check(
  'туда Беларусь→Киев',
  driver4.legs[0]?.from === 'Беларусь' &&
    driver4.legs[0]?.to === 'Киев' &&
    driver4.legs[0]?.dateRaw === '28 сентября'
);
check(
  'обратно Киев→Беларусь со своей датой',
  driver4.legs[1]?.from === 'Киев' &&
    driver4.legs[1]?.to === 'Беларусь' &&
    driver4.legs[1]?.dateRaw === '29.09-1.10'
);

// 5) Ложные срабатывания: глагол «мог» — не Могилёв, время — не дата.
const tricky = parseAd('28 сентября еду Минск Киев, мог бы взять посылки, выезд в 15.00');
check(
  'глагол «мог» не город',
  tricky.legs.length === 1 &&
    tricky.legs[0]?.from === 'Минск' &&
    tricky.legs[0]?.to === 'Киев' &&
    tricky.legs[0]?.dateRaw === '28 сентября'
);

// 6) Склонения: «из Варшавы через Кузницу в Гродно».
const decl = parseAd('18.09 еду из Варшавы через Кузницу в Гродно, есть места');
check(
  'склонения городов и погранпункта',
  decl.legs.length === 1 &&
    decl.legs[0]?.from === 'Варшава' &&
    decl.legs[0]?.to === 'Гродно' &&
    decl.legs[0]?.via.length === 0 &&
    decl.legs[0]?.borderPoints.join(',') === 'Кузница'
);

console.log(failed === 0 ? '\nВсе тесты пройдены ✅' : `\nПРОВАЛЕНО ТЕСТОВ: ${failed} ❌`);
process.exit(failed === 0 ? 0 : 1);
