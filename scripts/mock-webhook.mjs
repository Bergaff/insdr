#!/usr/bin/env node
/**
 * Локальный e2e-тест: шлёт фейковые вебхуки в запущенный worker (npm run dev)
 * и проверяет, что пайплайн доходит до "video DM" в логах wrangler dev.
 *
 * Переменные окружения:
 *   WORKER_URL     — адрес worker (по умолчанию http://127.0.0.1:8787)
 *   WH_APP_SECRET  — должен совпадать с IG_APP_SECRET в .dev.vars (деф. test-secret)
 *   WH_VERIFY_TOKEN— должен совпадать с WH_VERIFY_TOKEN в .dev.vars (деф. test-token)
 *   MOCK_VIDEO_URL — url mp4, который worker будет "скачивать" (деф. — pexels-видео)
 *
 * Запуск:
 *   1) npm run dev
 *   2) npm run demo
 */
import crypto from 'node:crypto';
import http from 'node:http';

const WORKER = (process.env.WORKER_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const SECRET = process.env.WH_APP_SECRET || 'test-secret';
const VERIFY_TOKEN = process.env.WH_VERIFY_TOKEN || 'test-token';
const MOCK_PORT = Number(process.env.MOCK_SERVER_PORT || 8899);

/**
 * Видеofile: локальный http-сервер отдаёт "псевдо-mp4" (worker не парсит видео,
 * а лишь пересылает байты). Если задан MOCK_VIDEO_URL — используем его как есть.
 */
function startMockVideoServer() {
  // Детерминированный "видеофайл" ~300 КБ.
  const size = 300 * 1024;
  const data = Buffer.alloc(size);
  // Метка mp4-файла (ftyp) для вида.
  Buffer.from('?????M4?').copy(data, 0);
  let seed = 42;
  for (let i = 8; i < size; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed >> 16) & 0xff;
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/sample.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length });
      res.end(data);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(MOCK_PORT, '127.0.0.1', () => {
      resolve(server);
      console.log(`  (мокап видео: http://127.0.0.1:${MOCK_PORT}/sample.mp4, ${size} B)`);
    });
  });
}

const server = await startMockVideoServer();
const VIDEO_URL = process.env.MOCK_VIDEO_URL || `http://127.0.0.1:${MOCK_PORT}/sample.mp4`;

function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name} ${extra}`);
  }
}

async function post(payload, opts = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const headers = { 'Content-Type': 'application/json' };
  if (opts.badSignature) headers['X-Hub-Signature-256'] = 'sha256=deadbeef';
  else if (opts.skipSignature) delete headers['X-Hub-Signature-256'];
  else headers['X-Hub-Signature-256'] = sign(body, SECRET);
  const res = await fetch(`${WORKER}/webhook`, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

console.log(`\nЦель: ${WORKER}\n`);

// 1) Верификация вебхука (hub.challenge)
{
  const res = await fetch(
    `${WORKER}/webhook?hub.mode=subscribe&hub.challenge=123456789&hub.verify_token=${VERIFY_TOKEN}`
  );
  const text = await res.text();
  check('GET hub.challenge вернули', res.status === 200 && text === '123456789', `→ ${res.status} "${text}"`);

  const bad = await fetch(
    `${WORKER}/webhook?hub.mode=subscribe&hub.challenge=1&hub.verify_token=WRONG`
  );
  check('GET с чужим verify token → 403', bad.status === 403, `→ ${bad.status}`);
}

// 2) Текстовое сообщение
{
  const r = await post({
    object: 'instagram',
    entry: [
      {
        id: '17841476669073037',
        time: Date.now(),
        messaging: [
          {
            sender: { id: '10000000000000001' },
            recipient: { id: '17841476669073037' },
            timestamp: Date.now(),
            message: { mid: `text-${Date.now()}`, text: 'привет, бот' },
          },
        ],
      },
    ],
  });
  check('текстовое DM → 200', r.status === 200, `→ ${r.status} ${r.text}`);
}

// 3) Видео (messaging-формат, attachment video)
{
  const mid = `vid-${Date.now()}`;
  const r = await post({
    object: 'instagram',
    entry: [
      {
        id: '17841476669073037',
        time: Date.now(),
        messaging: [
          {
            sender: { id: '10000000000000002' },
            recipient: { id: '17841476669073037' },
            timestamp: Date.now(),
            message: {
              mid,
              attachments: [{ type: 'video', payload: { url: VIDEO_URL } }],
            },
          },
        ],
      },
    ],
  });
  check('видео DM (messaging) → 200', r.status === 200, `→ ${r.status} ${r.text}`);
  console.log(`  (скачиваю ${VIDEO_URL})`);
}

// 4) Видео (changes-формат, message.media[])
{
  const r = await post({
    object: 'instagram',
    entry: [
      {
        id: '17841476669073037',
        time: Date.now(),
        changes: [
          {
            field: 'messages',
            value: {
              id: `evt-${Date.now()}`,
              conversation: { id: 'conv-demo' },
              type: 'MESSAGE',
              sender: { ig_scoped_id: '10000000000000003', ig_name: 'demo.user' },
              recipient: { id: '17841476669073037' },
              message: {
                id: `vid2-${Date.now()}`,
                media: [{ type: 'video', url: VIDEO_URL, thumbnail_url: 'https://example.com/t.jpg' }],
              },
              create_time: Date.now(),
            },
          },
        ],
      },
    ],
  });
  check('видео DM (changes) → 200', r.status === 200, `→ ${r.status} ${r.text}`);
}

// 5) Echo (наше же сообщение) — должен пройти тихо, без ответов
{
  const r = await post({
    object: 'instagram',
    entry: [
      {
        messaging: [
          {
            is_echo: true,
            sender: { id: '17841476669073037' },
            recipient: { id: '10000000000000002' },
            timestamp: Date.now(),
            message: { mid: `echo-${Date.now()}`, text: 'echo' },
          },
        ],
      },
    ],
  });
  check('echo DM → 200 (без действий)', r.status === 200, `→ ${r.status} ${r.text}`);
}

// 6) Неверная подпись
{
  const r = await post({ object: 'instagram', entry: [] }, { badSignature: true });
  check('плохая подпись → 401', r.status === 401, `→ ${r.status} ${r.text}`);
}

// 7) health
{
  const res = await fetch(`${WORKER}/health`);
  const j = await res.json().catch(() => ({}));
  check('GET /health', res.status === 200 && j.ok === true, JSON.stringify(j));
}

console.log(
  failures === 0
    ? '\n✅ Webhook-слой работает. Теперь посмотри в терминал wrangler dev:'
    : `\n❌ Провалено проверок: ${failures}`
);
console.log(
  '   ожидаем в логах: "Получил видео, обрабатываю 🎬", "задача в очереди", "[dry-run] 🎬 video DM → ..."\n'
);
// Дай workerу время докачать и прогнать задачи, потом закрываем мок-сервер.
await new Promise((r) => setTimeout(r, 3000));
server.close();
process.exit(failures === 0 ? 0 : 1);
