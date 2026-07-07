# Bat-файлы Frag Tracker

Канонические лаунчеры — только эти два:

- **`start-server.bat`** — запуск сервера (`node init-db.js` + `node server.js`, порт 3000)
- **`start-desktop.bat`** — запуск desktop-приложения (Electron)

Вспомогательные:

- **`stop-server.bat`** — остановка сервера
- **`build-desktop.bat`** — сборка desktop-приложения (electron-builder)
- **`initialize-starting-stats.bat`** — разовая инициализация стартовой статистики
- **`set-manual-time.bat`** — ручная установка времени таймера
- **`run-stagewise.bat`** — запуск stagewise (dev-инструмент)

Старые дубли (server-manager.bat, start-server-complete/quick/… и пр.)
перенесены в `archive/legacy-scripts/` — не использовать.
