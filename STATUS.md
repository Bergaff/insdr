# insdr — статус проекта (обновлено 11.09.2026)

> Здесь только не-секретные данные. Токены и секреты живут в Cloudflare Secrets и Meta Dashboard.

## Цель
Бот в личке Instagram: пользователь присылает видео → бот возвращает mp4 в тот же чат.
Стек: Cloudflare Worker + Queue + R2 + KV, код деплоится из GitHub-ветки.

## Meta / Facebook
- Facebook App ID: `1627603262214914` (тип Business)
- Instagram App ID: `927910860382597`, имя `insdr-IG`
- Аккаунт-бот: `reelsdownload_bot` (IG_ID `17841436213947478`, тип MEDIA_CREATOR = профессиональный)
- Тестировщики Instagram: `reelsdownload_bot`, `wowsomuchexcited` (оба приняли приглашения)
- Разрешения: `instagram_business_basic`, `instagram_business_manage_messages` (+ publish/insights/comments) — «Готово к тестированию»
- Токен `IG_ACCESS_TOKEN`: получен через Generate token, **истекает 10.11.2026** (не забыть refresh!)
- Webhook: callback `https://insdr.tgmg.workers.dev/webhook` — Verify зелёный, поле `messages` подписано
- Подписка аккаунта: `POST me/subscribed_apps?subscribed_fields=messages` → `{"success": true}`
- Проверено: подпись X-Hub-Signature-256 сходится (тестовые вебхуки возвращают 200)

## Cloudflare
- Воркер: `insdr`, URL `https://insdr.tgmg.workers.dev`, деплой из GitHub-ветки `arena/01a08f7c-insdr`
- R2: бакет `insdr-media` (биндинг MEDIA)
- KV: неймспейс `SEEN`, id `eda87e01e8804597a01135b2e6a30a5a` (биндинг SEEN)
- Queue: `insdr-video-jobs` (продюсер JOBS + consumer на воркер `insdr`)
- Secrets (имена): `IG_ACCESS_TOKEN`, `IG_APP_SECRET`, `WH_VERIFY_TOKEN`, `PUBLIC_BASE_URL`
- `/health` → `{"ok":true,"live":true,"processor":"echo","r2":true,"queue":true}`
- Служебные страницы для Meta: `/privacy`, `/terms`, `/data-deletion`

## Текущий статус: ⏸️ СТОП на верификации бизнеса
- Настоящие сообщения не доходят до воркера (в логах нет POST) — Meta не шлёт события, пока приложение в Dev-режиме.
- Перевод в Live заблокирован: требуется **Подтверждение компании** (бизнес-портфолио не верифицировано).
- У владельца документов юрлица/ИП нет → официальный путь на паузе.

## Как возобновить (когда появятся документы или Meta смягчит требования)
1. Business Settings → Security Center → пройти подтверждение компании.
2. App Dashboard → тумблер в «Опубликовано» (Live).
3. Проверить: подписка `messages` на месте, при необходимости повторить Explorer-POST `me/subscribed_apps?subscribed_fields=messages`.
4. Живой тест: со второго аккаунта «привет» + видеофайл в личку бота → смотреть Logs воркера.
5. Обновить токен, если истёк: `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=СТАРЫЙ` → новый положить в Secrets воркера.

## Заметки
- Взаимная подписка аккаунтов нужна только для теста в Dev; в проде писать сможет кто угодно.
- Кнопка «Тестировать» в Meta шлёт пустышку без сообщения — бот на неё молчит, это нормально.
- Режим процессора сейчас `echo` (возвращает то же видео) — для проверки пайплайна.
