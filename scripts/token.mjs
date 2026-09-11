#!/usr/bin/env node
/**
 * Скрипт работы с токеном и подпиской Instagram API (Instagram Login).
 *
 * Переменные окружения:
 *   IG_APP_ID, IG_APP_SECRET — из Meta App Dashboard (Business login settings)
 *   IG_ACCESS_TOKEN          — текущий токен (для me/refresh/subscribe)
 *   OAUTH_REDIRECT_URI       — должен совпадать с OAuth redirect URI в дашборде
 *
 * Команды:
 *   node scripts/token.mjs login-url   — показать URL авторизации (открыть в браузере)
 *   node scripts/token.mjs login       — полный flow: локальный server ловит code,
 *                                        меняет на short→long token, печатает результат
 *   node scripts/token.mjs exchange <short_token>  — short → long (60 дней)
 *   node scripts/token.mjs refresh     — продлить long token ещё на 60 дней (токену должно быть >24ч)
 *   node scripts/token.mjs me          — показать IG_ID и username аккаунта
 *   node scripts/token.mjs subscribe   — включить вебхуки (subscribed_apps: messages, ...)
 */
import http from 'node:http';

const VERSION = process.env.GRAPH_API_VERSION || 'v25.0';
const GRAPH = `https://graph.instagram.com`;
const APP_ID = process.env.IG_APP_ID || '';
const APP_SECRET = process.env.IG_APP_SECRET || '';
const TOKEN = process.env.IG_ACCESS_TOKEN || '';
const REDIRECT = process.env.OAUTH_REDIRECT_URI || 'http://localhost:8484/';
const PORT = Number(process.env.OAUTH_PORT || 8484);
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'].join(',');

function authUrl() {
  return (
    `https://www.instagram.com/oauth/authorize?client_id=${APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&response_type=code&scope=${SCOPES}`
  );
}

async function graphGet(path, extra = {}) {
  const res = await fetch(`${GRAPH}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(TOKEN)}${extra.query ?? ''}`);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Graph ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function shortToLong(shortToken) {
  const res = await fetch(
    `${GRAPH}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(APP_SECRET)}&access_token=${encodeURIComponent(shortToken)}`
  );
  const data = await res.json().catch(() => null);
  if (!res.ok) fail(`exchange short→long → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: APP_ID,
    client_secret: APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT,
    code,
  });
  const res = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body });
  const data = await res.json().catch(() => null);
  if (!res.ok) fail(`exchange code → ${res.status}: ${JSON.stringify(data)}`);
  const first = Array.isArray(data?.data) ? data.data[0] : data;
  if (!first?.access_token) fail(`нет access_token в ответе: ${JSON.stringify(data)}`);
  return first;
}

const [cmd] = process.argv.slice(2);

switch (cmd) {
  case 'login-url': {
    if (!APP_ID) fail('задай IG_APP_ID');
    console.log('Открой в браузере (логин под аккаунтом-ботом):\n');
    console.log(authUrl());
    console.log(`\nПосле согласия Instagram перенаправит на ${REDIRECT}?code=...`);
    console.log('Далее: node scripts/token.mjs exchange <code>');
    break;
  }

  case 'login': {
    if (!APP_ID || !APP_SECRET) fail('задай IG_APP_ID и IG_APP_SECRET');
    console.log('Открой в браузере (логин под аккаунтом-ботом):\n');
    console.log(authUrl());
    console.log(`\nЖду перенаправление на http://localhost:${PORT}/ ... (Ctrl+C — отмена)\n`);

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      const code = u.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('нет code в query');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('code получен, обмениваю на токен...');
      server.close();

      try {
        const short = await exchangeCode(code);
        const long = await shortToLong(short.access_token);
        console.log('\n✔ Долгоживущий токен (60 дней):');
        console.log(`  ${long.access_token}`);
        console.log(`  expires_in: ${long.expires_in} c`);
        console.log('\nСохранить: wrangler secret put IG_ACCESS_TOKEN  (или в .dev.vars)');
        console.log('Далее: node scripts/token.mjs me  → узнать IG_ID');
      } catch (e) {
        fail(e.message);
      }
    });
    server.listen(PORT, () => console.log(`(сервер запущен на :${PORT})`));
    break;
  }

  case 'exchange': {
    const code = process.argv[2];
    if (!code) fail('использование: node scripts/token.mjs exchange <code|short_token>');
    if (!APP_ID || !APP_SECRET) fail('задай IG_APP_ID и IG_APP_SECRET');
    const short = await exchangeCode(code);
    console.log('short token: ✔');
    const long = await shortToLong(short.access_token);
    console.log('\n✔ Долгоживущий токен (60 дней):');
    console.log(`  ${long.access_token}`);
    break;
  }

  case 'refresh': {
    if (!TOKEN) fail('задай IG_ACCESS_TOKEN (текущий long token)');
    const data = await graphGet(`/refresh_access_token?grant_type=ig_refresh_token`);
    if (!data?.access_token) fail(`ответ без токена: ${JSON.stringify(data)}`);
    console.log('✔ Новый токен (ещё 60 дней):');
    console.log(`  ${data.access_token}`);
    console.log('\nОбнови: wrangler secret put IG_ACCESS_TOKEN (и .dev.vars)');
    break;
  }

  case 'me': {
    if (!TOKEN) fail('задай IG_ACCESS_TOKEN');
    const data = await graphGet('/me?fields=user_id,username,account_type');
    console.log(`✔ IG_ID:    ${data.user_id}`);
    console.log(`✔ username: ${data.username}`);
    console.log(`✔ type:     ${data.account_type}`);
    break;
  }

  case 'subscribe': {
    if (!TOKEN) fail('задай IG_ACCESS_TOKEN');
    const fields = 'messages,messaging_optins,messaging_postbacks,messaging_referrals,messaging_seen';
    const res = await fetch(
      `${GRAPH}/${VERSION}/me/subscribed_apps?subscribed_fields=${fields}&access_token=${encodeURIComponent(TOKEN)}`
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) fail(`subscribe → ${res.status}: ${JSON.stringify(data)}`);
    console.log('✔ Подписка на вебхуки включена:', fields);
    break;
  }

  default: {
    console.log('Команды: login-url | login | exchange <code> | refresh | me | subscribe');
    process.exit(cmd ? 1 : 0);
  }
}
