# РазБЛОГировка 2026 — архив

Модуль «Копилка золота» отключён и вынесен сюда (июнь 2026).

## Что внутри

- `public/razblogirovka.html` — админка
- `public/widget-razblogirovka-gold.html` — OBS-виджет
- `src/services/razblogirovkaGoldService.js` — синхронизация с Lesta
- `src/utils/goldCalculator.js` — расчёт золота за бой

Данные в БД (`razblogirovka_battles`, поля `razblog_*` в `app_state`) сохранены.

## Включить снова

1. В `start-server-quick.bat` или перед запуском:
   ```
   set RAZBLOG_ENABLED=1
   ```
2. Перезапустить сервер.
3. Убрать виджет из OBS и добавить заново: `/widget/razblogirovka-gold`
