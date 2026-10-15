# Прогоны для разработки (не CI)

Нужен локальный PostgreSQL 16 на 127.0.0.1:55432 с базой mbox (схема schema/mbox_postgres.sql) — НЕ боевая база.
Запуск из корня репозитория: node scripts/dev-tests/<файл>.

- google-planner.integration.mjs — синхронизация с Google на поддельном Google (53 сценария).
- passwords.integration.mjs — раздел «Пароли» и API браузера (25 сценариев).
- history.integration.mjs — страницы и дни «Истории».
- settings-shots.mjs, iphone-shots.mjs — скриншоты на подменённом API (нужен vite на :5180, playwright + Edge).
