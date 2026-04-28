# Telegram bot — перенос с Vercel на VPS (Beget)

Бот работает через **webhook** и принимает запросы на `POST /api/telegram`.

## Переменные окружения

- `TELEGRAM_BOT_TOKEN` — токен от `@BotFather`
- (опционально) `TELEGRAM_WEBHOOK_SECRET` — секрет для проверки заголовка `X-Telegram-Bot-Api-Secret-Token`
- (опционально) `START_RULES_TEXT` — текст правил, который показывается на `/start`
- `REQUIRED_CHANNELS` — каналы-партнеры (через запятую, например `@channel1,@channel2,@channel3`); без подписки генерация недоступна
- `TG_PROXY_SECRET` — секрет для проксирования Telegram-фото (нужно для обработки фото через внешнюю генерацию без утечки токена бота)
- `KIE_API_KEY` (или `KIE_API`) — ключ API от KIE.ai
- (опционально) `KIE_BASE_URL` — базовый URL API (по умолчанию `https://api.kie.ai`)
- (опционально) `KIE_T2I_MODEL`, `KIE_T2I_ASPECT_RATIO` — модель/параметры для `/t2i`
- (опционально) `KIE_I2I_MODEL` — модель для обработки фото
- (опционально) `KIE_POLL_TIMEOUT_MS`, `KIE_POLL_INTERVAL_MS` — ожидание/пуллинг задач
- `IMG_STYLE_PROMPT` — фиксированный промпт-стиль для обработки фото (по умолчанию `В мире дикой природы`)
- `PUBLIC_BASE_URL` — **обязательно на VPS**. Базовый публичный URL сервиса, например `https://bot.example.com` (нужно для ссылок на `/api/tg-proxy.jpg` и `/api/kie-callback`)

## Команды

- `/start` → `привет`
- `/img` → попросит прислать фото, обработает его в стиле из `IMG_STYLE_PROMPT`
- `/t2i <промпт>` → генерирует картинку по тексту и отправляет её

## Деплой на Vercel

1. Залей репозиторий в GitHub/GitLab/Bitbucket.
2. Импортируй проект в Vercel.
3. В **Project Settings → Environment Variables** добавь `TELEGRAM_BOT_TOKEN`, `KIE_API_KEY` (или `KIE_API`) (и при желании `TELEGRAM_WEBHOOK_SECRET`).
4. Задеплой.

Webhook URL будет таким:

`https://<твое-имя-проекта>.vercel.app/api/telegram`

## Установка webhook

На локальной машине:

```bash
export TELEGRAM_BOT_TOKEN="..."
# опционально:
export TELEGRAM_WEBHOOK_SECRET="..."

npm run set-webhook -- "https://<твое-имя-проекта>.vercel.app/api/telegram"
```

## Быстрая проверка

Открой в браузере:

`https://<твое-имя-проекта>.vercel.app/api/telegram`

Должно вернуть `{ "ok": true, "service": "telegram-webhook" }`.

## Деплой на VPS (Beget) — Docker (рекомендуется)

1. На VPS установи Docker + Docker Compose.
2. На сервере в директории проекта создай `.env` по примеру `.env.example` и обязательно укажи `PUBLIC_BASE_URL=https://<домен>`.
3. Запусти:

```bash
docker compose up -d --build
```

4. Подними Nginx (пример конфига в `deploy/nginx.conf.example`) и выпусти SSL-сертификат (certbot).

Webhook URL:

`https://<домен>/api/telegram`

## Деплой на VPS (Beget) — systemd (без Docker)

1. Установи Node.js 18+.
2. Скопируй проект в `/opt/telegram-bot`.
3. Создай `/opt/telegram-bot/.env` (по `.env.example`) и укажи `PUBLIC_BASE_URL`.
4. Создай systemd unit по примеру `deploy/systemd/telegram-bot.service.example`, затем:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-bot
```

