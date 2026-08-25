# insdr — бот в личке Instagram: кидают рилс — возвращает mp4

Пользователь отправляет видео (рилс) в DM аккаунта, как обычно — **без ссылок,
сайтов и телеги**. Бот принимает видео, прогоняет его через процессор
(подключается любой: echo, внешний AI-API и т.п.) и присылает готовый **mp4
прямо в тот же чат**.

Всё лежит на **Cloudflare**: Worker + Queue + R2. Никаких серверов, вся
инфраструктура — бесплатный/дешёвый план Cloudflare.

```
 Instagram-пользователь
        │  DM: видео (рилс)
        ▼
 Meta  ──webhook POST /webhook──▶  Cloudflare Worker
                                      │ 1. проверка X-Hub-Signature-256
                                      │ 2. дедупликация (KV)
                                      │ 3. ответ "обработка..."
                                      │ 4. скачивание видео с временного CDN Meta
                                      ▼
                                    R2 (inbound/...)
                                      │
                                      ▼  Queue (insdr-video-jobs)
                                   VideoProcessor   ◀── подключаешь своё
                                      │              (src/processor.ts)
                                      ▼
                                    R2 (outbound/....mp4)
                                      │
                                      ▼  POST graph.instagram.com/me/messages
 Instagram-пользователь ◀── DM: готовый mp4
```

Видео отдаётся Instagram по ссылке `<PUBLIC_BASE_URL>/m/outbound/<id>.mp4` —
Meta сама её скачивает, когда отправляет вложение (поэтому R2 можно держать
приватным, публичен только этот маршрут worker'а).

## Ограничения платформы (читай обязательно)

| Что | Ограничение |
|---|---|
| Тип аккаунта бота | Только **Professional (Business или Creator)**. Обычный personal-аккаунт API не даст. Переключение — бесплатно, в 2 тапа в приложении Instagram, для подписчиков выглядит так же |
| Кто начинает | Только пользователь. Бот **не может** писать первым (cold DM запрещены политикой Meta) |
| Окно ответа | 24 часа с момента сообщения пользователя (нам хватает с запасом) |
| Размер видео в DM | ≤ **25 МБ** (mp4). Входящее скачиваем с лимитом 64 МБ, результат проверяем по 25 МБ |
| Частота | Отправка видео — до 10/с (наших объёмов хватит) |
| Webhook | Приложение Meta должно быть в режиме **Live** (для своего аккаунта — Standard Access, без App Review для всех; см. шаг 3) |
| Полупрозрачность | Meta требует для автоматических чат-ботов раскрывать, что это бот — наш ACK/тексты это учитывают, тексты настраиваются |
| Токен | Долгоживущий, живёт **60 дней**, продлевается скриптом (`token.mjs refresh`) |

## Быстрый старт (локальная разработка, без Meta)

```bash
npm install
cp .dev.vars.example .dev.vars   # можно оставить как есть — это dry-run

npm run dev                      # 1) worker на http://localhost:8787
npm run demo                     # 2) в НОВОМ терминале: фейковые вебхуки
npm run selftest                 # юнит-тесты парсера/подписи (можно и без dev)
```

Без `IG_ACCESS_TOKEN` worker работает в **dry-run**: все DM логирует в консоль
вместо отправки в Meta. В логах `npm run dev` увидишь полный цикл:

```
[dry-run] 📩 text DM → 1000...: Получил видео, обрабатываю 🎬
[webhook] vid-...: скачано 307200 B → задача в очереди
[processor:echo] passthrough 307200 B
[dry-run] 🎬 video DM → 1000...: http://127.0.0.1:8787/m/outbound/vid-....mp4
[queue] vid-...: отправлено видео 307200 B → 1000...
```

## Продакшен: подключение настоящего аккаунта

### Шаг 1. Аккаунт Instagram → Professional

Instagram → Профиль → ⋯ → **Переключиться на профессиональный аккаунт** →
«Создатель» (Creator) или «Бизнес». Для обычных подписчиков ничего не меняется.

### Шаг 2. Приложение Meta (developers.facebook.com)

1. **My Apps → Create App → тип: Business** (обязательно Business, не User).
2. В приложении добавь продукт **Instagram** → *API setup with Instagram login*.
3. В *Business login settings*:
   - скопируй **Instagram App ID** и **Instagram App Secret**;
   - добавь OAuth redirect URI (например `https://<твой-домен>/oauth` или
     `http://localhost:8484/` для локального получения токена);
   - запросы разрешений: `instagram_business_basic`,
     `instagram_business_manage_messages`.
4. **Business Verification**: для Live-режима Meta попросит верифицировать
   бизнес (название компании + домен). Для аккаунта, которым владеешь сам,
   хватит Standard Access — полный App Review не нужен.

### Шаг 3. Токен (60 дней)

```bash
export IG_APP_ID=... IG_APP_SECRET=... OAUTH_REDIRECT_URI=http://localhost:8484/

# полный flow: печатает URL → логируешься под аккаунтом-ботом → код
# подхватывается локальным сервером → обмен на long token
node scripts/token.mjs login

# проверить, что токен работает и получить IG_ID аккаунта
export IG_ACCESS_TOKEN=<полученный токен>
node scripts/token.mjs me        # → IG_ID + username
```

Либо без кода: Meta App Dashboard → Instagram → API setup with Instagram login
→ **Generate token** (логин под аккаунтом) — сразу long-lived на 60 дней.

**Продление (1 раз в ~50 дней):**

```bash
node scripts/token.mjs refresh   # новый токен → wrangler secret put IG_ACCESS_TOKEN
```

### Шаг 4. Deploy на Cloudflare

```bash
npm install -g wrangler   # если ещё нет
wrangler login

# 1) KV для дедупликации:
wrangler kv namespace create SEEN
#    → впиши выданный id в wrangler.jsonc (раздел kv_namespaces, раскомментировать)

# 2) секреты:
wrangler secret put IG_ACCESS_TOKEN     # токен из шага 3
wrangler secret put IG_APP_SECRET       # App Secret (проверка подписи вебхука)
wrangler secret put WH_VERIFY_TOKEN     # любая длинная строка (hub.verify_token)
wrangler secret put PUBLIC_BASE_URL     # https://insdr-bot.<subdomain>.workers.dev

# 3) deploy (создаст worker, R2-бакет и очередь):
npm run deploy
```

`PUBLIC_BASE_URL` — это workers.dev URL твоего worker (после первого deploy
напишется в консоли). Instagram должен иметь к нему публичный доступ.

### Шаг 5. Webhook в Meta App Dashboard

1. App Dashboard → **Webhooks → Instagram**.
2. **Callback URL**: `https://insdr-bot.<subdomain>.workers.dev/webhook`
3. **Verify Token**: та же строка, что в `WH_VERIFY_TOKEN`.
   Meta отправит GET-запрос — worker ответит challenge (это проверка).
4. Подпишись на поле **`messages`** (Subscribe). Дополнительно можно:
   `messaging_optins`, `messaging_postbacks`, `messaging_referrals`,
   `messaging_seen`.
5. Включи подписку API-вызовом (обязательно, иначе события не придут):

```bash
node scripts/token.mjs subscribe
```

6. Тест: отправь своему аккаунту любое сообщение/видео с другого аккаунта —
   в логах Cloudflare (`wrangler tail`) должен появиться `POST /webhook 200`.

> Если аккаунт-бот ещё не добавлен в приложение — добавь его в
> App Dashboard (public test account), пока app в dev-режиме; в Live
> тестировать можно с любого аккаунта.

### Шаг 6. Проверяем

С другого аккаунта Instagram отправь рилс/видео в личку аккаунта-бота.
Ожидаем: «Получил видео, обрабатываю 🎬» → через секунды-минуты — видео в ответ.

## Что бот делает с видео: процессор

Вся магия — за одним интерфейсом в [`src/processor.ts`](src/processor.ts):

```ts
interface VideoProcessor {
  process(input: ProcessorInput, env: Env): Promise<ProcessorOutput>;
}
// input.video: ArrayBuffer входящего mp4
// output.video: ArrayBuffer | ReadableStream результата (mp4, ≤25 МБ)
```

Готовые варианты (переключается переменной `PROCESSOR`):

| PROCESSOR | Что делает |
|---|---|
| `echo` (по умолчанию) | Отдаёт то же самое видео. Для проверки всего пайплайна end-to-end |
| `http` | Шлёт видео на твой REST-сервис (multipart, поле `video`), в ответ принимает mp4 или JSON `{ "video_url": "..." }` |

Для `http`:

```bash
wrangler secret put PROCESSOR_URL      # https://tvoj-api.example.com/process
wrangler secret put PROCESSOR_API_KEY  # опционально, уйдёт в Authorization: Bearer
wrangler config --set vars.PROCESSOR=http   # или поправь wrangler.jsonc
```

Свой процессор: экспорт класса, реализующего `VideoProcessor`, и его выбор в
`createProcessor()`. Если задача долгая (>10–15 минут) — вынеси за queue:
processor кладёт job в свой сервис, а queue consumer опрашивает его статус
(схема «submit + poll»); интерфейс легко расширить.

## Файлы

```
src/index.ts      вход: /webhook, /m/<key>, /health + queue consumer
src/webhook.ts    парсер payload'ов Meta (2 формата) + HMAC-проверка подписи
src/pipeline.ts   входящее сообщение: ACK → скачивание → R2 → очередь
src/queue.ts      обработка: процессор → R2 → ответ video DM, ретраи
src/processor.ts  интерфейс VideoProcessor + echo + http
src/ig.ts         клиент graph.instagram.com (sendText/sendVideo/resolveMedia)
src/media.ts      отдача mp4 из R2 (/m/...), Range-запросы
scripts/token.mjs login / exchange / refresh / me / subscribe
scripts/mock-webhook.mjs  локальный e2e (npm run demo)
```

## Операции

**Логи:** `npx wrangler tail` — живые логи worker в терминале.

**Очистка R2** (входящие/исходящие копировать не обязательно): lifecycle-правила

```bash
npx wrangler r2 bucket lifecycle apply insdr-media --rules '[
  {"id":"inbound","status":"enabled","prefix":"inbound/","expiration_days":1},
  {"id":"outbound","status":"enabled","prefix":"outbound/","expiration_days":7}
]'
```

(исходящее видео остаётся у пользователя в его Instagram после отправки —
у Meta оно скачивается в момент отправки DM)

**Лимиты** (`wrangler.jsonc` → vars): `INBOUND_MAX_MB` (64), `OUTBOUND_MAX_MB`
(25, жёсткий лимит Meta), тексты ACK/ответов.

## FAQ

**Пользователь «поделиться» поделил ссылку на рилс, а не вложение.**
Тогда в вебхуке приходит `share` с URL поста. Бот пробует скачать видео через
Graph API (`GET /{media-id}?fields=media_url`) — работает, если автор поста —
профессиональный аккаунт. Иначе вежливо просит отправить видео как вложение
(камера → видео → отправить). Основная сцена — вложение: это и есть «кинуть
рилс в личку» обычным жестом.

**Почему ответ именно mp4?** Meta принимает в DM видео в mp4/ogg/avi/mov/webm
до 25 МБ; mp4 — универсальный вариант. Процессор сам должен выводить mp4.

**Можно ли отправлять видео + текст в одном сообщении?** Нет, лимит Meta:
одна отправка — либо текст, либо медиа. При желании до/после видео можно
слать короткий текстом (сейчас ACK уходит до обработки).

**А если обработчик упадёт?** Queue ретраит задачу 3 раза (итого 4 попытки);
если не помогло — бот пишет человеку «что-то пошло не так, попробуй позже».

**Зачем KV?** Meta ретраит несостоявшиеся вебхуки до 36 часов — без дедупа
человек получил бы несколько ответов на один рилс.
