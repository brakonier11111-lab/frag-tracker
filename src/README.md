# Архитектура Frag Tracker

```
src/
  bootstrap/paths.js     — пути, .env, расположение БД
  core/utils.js          — safeJsonParse, clampNum, round2
  modules/
    blitz-challenge/     — Tanks Blitz Challenge (API + сервис)
    roulette/            — API рулетки
    razblog/             — РазБЛОГировка (копилка золота)
  registerModules.js     — регистрация модулей в Express
```

## Дальнейший рефакторинг

Планируется вынести в отдельные модули:
- `donations/` — DonationAlerts, DonatePay, polling
- `lesta/` — Lesta API, сессии, frag-stats
- `widgets/` — donation-driven, donation-goal
- `pages/` — маршруты HTML-страниц
- `core/app-state.js` — getAppState / updateAppState
- `core/websocket.js` — broadcastToClients

`server.js` остаётся точкой входа до полного переноса.
