# Архитектура Frag Tracker

```
src/
  bootstrap/paths.js     — пути, .env, расположение БД
  core/                  — app-state, websocket-хаб, donation-bus, poll-filter, utils
  utils/logger.js        — файловое логирование (logs/)
  modules/               — вынесенные из server.js модули (явные deps, тела 1:1)
    pages/               — HTML-страницы и OBS-оверлеи (/, /admin, /widget/:mode…)
    diagnostics/         — диагностические/тестовые API-роуты
    donation-platforms/  — сетевой слой DonationAlerts/DonatePay
    donation-widgets/, donation-driven-widget/, donations-analytics/
    donor-achievements/, chat-stats/, roulette/, razblog/
    blitz-challenge/, boss-orders/, replay-live/, yandex-music/
    lesta-oauth/, lesta-sync/, lesta-routes/
    youtube-integration/, vkplay-integration/, twitch-integration/, online-viewers/
  registerModules.js     — регистрация большинства модулей в Express
```

Часть модулей (pages, diagnostics, donation-platforms, donation-widgets,
donation-driven-widget) регистрируется прямо в server.js — их deps завязаны
на порядок инициализации (express.static, polling-переменные).

## Что осталось в server.js (~8k строк)

Ядро, которое крутится на каждом стриме — трогать только с регресс-тестами
(`npm run test-pipeline`, `npm run test-lesta`):
- processDonation и веер потребителей (donation-bus), webhook DonatePay
- цикл опроса DA/DP (checkForNewDonations + module-scoped состояние)
- фраг-статистика (addFragStats/addBattleForce), таймер, temperature/slowdown
- Lesta history/tank-snapshot хелперы (их тянут lesta-routes/blitz через deps)
- донат-CRUD (/api/donations/*, /api/donors/*), admin config

## Тесты

`npm run smoke-test` (порт 3999), `test-pipeline` (3998), `test-lesta` (3997),
`test-poll-filter` (юнит). Все работают на КОПИИ БД, внешние опросы отключены.
Перед любыми правками логики — гонять их, не тестировать на проде :3000.
