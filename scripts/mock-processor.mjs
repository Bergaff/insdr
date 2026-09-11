#!/usr/bin/env node
/**
 * Локальный мок внешнего API обработки видео (для PROCESSOR=http).
 * Имитирует сервис, который принимает multipart-файл "video" и отдаёт mp4.
 *
 *   POST /process      → ответ: тело готового mp4 (свои 64 КБ "результата")
 *   POST /process-json → ответ: JSON { "video_url": ".../result.mp4" }
 *   GET  /result.mp4   → тело "готового" mp4
 *
 * Если задан PROCESSOR_API_KEY — проверяет заголовок Authorization: Bearer.
 *
 * Запуск:  node scripts/mock-processor.mjs
 *   PROCESSOR_PORT=8898 PROCESSOR_API_KEY=...
 */
import http from 'node:http';

const PORT = Number(process.env.PROCESSOR_PORT || 8898);
const KEY = process.env.PROCESSOR_API_KEY || '';

// "Готовое видео" — 64 КБ, отличные от входящих 307200 B (чтобы было видно,
// что в DM ушёл именно результат процессора, а не исходник).
const result = Buffer.alloc(64 * 1024);
Buffer.from('MOCKAI-RESULT').copy(result, 0);
for (let i = 16; i < result.length; i++) result[i] = (i * 31) & 0xff;

function readMultipart(req) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';
      const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
      const hasField = buf.includes('name="video"');
      const hasFile = buf.includes('filename="video.mp4"');
      if (!m || !hasField || !hasFile) {
        resolve({ error: `невалидный multipart (boundary=${!!m}, field=${hasField}, file=${hasFile})`, bytes: buf.length });
        return;
      }
      // Примерная оценка размера файла: между заголовками части и концом тела.
      const head = buf.indexOf('filename="video.mp4"');
      const dataStart = buf.indexOf('\r\n\r\n', head);
      const approx = dataStart === -1 ? 0 : buf.length - (dataStart + 4) - 2;
      resolve({ file: { approxSize: approx } });
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === 'POST' && (url.pathname === '/process' || url.pathname === '/process-json')) {
      if (KEY && (req.headers['authorization'] ?? '') !== `Bearer ${KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      const r = await readMultipart(req);
      if (r.error) {
        console.error(`[mock-processor] 400: ${r.error}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: r.error }));
      }
      console.log(`[mock-processor] ← ${url.pathname}: video ~${r.file.approxSize} B`);
      if (url.pathname === '/process') {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': result.length });
        res.end(result);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ video_url: `http://127.0.0.1:${PORT}/result.mp4` }));
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/result.mp4') {
      console.log('[mock-processor] → отдаю result.mp4 по video_url');
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': result.length });
      res.end(result);
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (e) {
    console.error('[mock-processor] error:', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock processor: http://127.0.0.1:${PORT} (POST /process, POST /process-json)`);
  if (KEY) console.log('  auth: требуется Authorization: Bearer <PROCESSOR_API_KEY>');
});
