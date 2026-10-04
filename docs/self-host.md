# Свой MBOX: установка за пять минут

Подходит, если вы хотите отдельный MBOX на своём компьютере или сервере — с вашими данными и без связи с чужим сервером.
Если вас просто пригласили в чужой MBOX, ничего ставить на сервер не нужно: откройте ссылку-приглашение и поставьте MBOX Desktop.

## Что нужно
- [Docker Desktop](https://www.docker.com/products/docker-desktop) (на сервере — Docker с `docker compose`).
- [Node.js 20+](https://nodejs.org) — только для установщика.
- Скачанная папка проекта (`git clone https://github.com/yowassupweb-ship-it/mbox`).

## Установка
```bash
node scripts/selfhost-setup.mjs
```
Установщик спросит логин, пароль (можно оставить пустым — сгенерирует) и домен. Дальше сам создаст `.env.selfhost` с ключами,
соберёт и запустит базу и приложение и напечатает адрес и вход. Без домена MBOX открывается на `http://localhost:3000`.

- **Домен и HTTPS:** укажите домен, направьте его на сервер, откройте порты 80 и 443 — сертификат выпустит Caddy.
- **Коллеги в одной сети:** `node scripts/selfhost-setup.mjs --lan` — MBOX станет доступен по адресу вашего компьютера в сети (`http://192.168.x.x:3000`).
- **Без вопросов:** `node scripts/selfhost-setup.mjs --user Аня --domain mbox.example.com --yes`.

## Дальше
1. Войдите под созданным логином. Пароль сразу можно сменить в «Настройки → Команда → Пароль».
2. «Настройки → Команда → Приглашения» — ссылка для коллеги: он сам выберет логин и пароль, вы выберете проекты и нужен ли ему Джарвис.
3. В MBOX Desktop на экране входа нажмите «Сервер … · другой сервер» и вставьте адрес вашего MBOX.
4. После входа приложение само заведёт личный токен и запустит ваших Claude Code и ChatGPT (кнопка «Войти» над чатом, если вход ещё не выполнен).

## Джарвис
Джарвис работает на ваших ключах моделей: впишите `GEMINI_API_KEY` и/или `GROQ_API_KEY` в `.env.selfhost` и перезапустите:
```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d
```
Без ключей MBOX работает полностью, кроме Джарвиса.

## Обслуживание
- Остановить: `docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml down` (данные остаются).
- Обновить: `git pull`, затем снова `node scripts/selfhost-setup.mjs` (ключи и пароль берутся из `.env.selfhost`).
- Копия базы: `docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml exec postgres pg_dump -U mbox mbox > backup.sql`.
- Не теряйте `.env.selfhost`: в нём ключ шифрования сохранённых секретов.
