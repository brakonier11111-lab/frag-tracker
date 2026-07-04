# РазБЛОГировка 2026 — архив (пусто)

Рабочий код переехал в `src/modules/razblog/` (июль 2026):

- `src/modules/razblog/public/razblogirovka.html` — админка
- `src/modules/razblog/public/widget-razblogirovka-gold.html` — OBS-виджет
- `src/modules/razblog/razblogirovkaGoldService.js` — синхронизация с Lesta
- `src/modules/razblog/goldCalculator.js` — расчёт золота за бой

Данные в БД (`razblogirovka_battles`, поля `razblog_*` в `app_state`) сохранены.

Фича управляется флагом `RAZBLOG_ENABLED` (включена по умолчанию, `RAZBLOG_ENABLED=0` — отключить).
Виджет: `/widget/razblogirovka-gold`, админка: `/razblogirovka`.
