# Lesta Games API — полная документация интеграции

> Актуально на 2026-07-16, после разбора монолита `server.js` на модули.
> Старый файл [`LESTA_STATS_DOCUMENTATION.md`](LESTA_STATS_DOCUMENTATION.md) описывает
> до-рефакторинговую версию (код прямо в `server.js`) — используйте **этот** документ
> как источник правды для нового проекта.

Это WoT **Blitz** API (`papi.tanksblitz.ru/wotb`), домен `api.tanki.su` используется
только для OAuth-логина и продления токена.

---

## 1. Архитектура модулей

| Файл | Роль |
|---|---|
| `server.js` | Объявляет `LESTA_CONFIG`, создаёт таблицы БД, регистрирует модули, содержит очередь внешних API-вызовов (`withLestaApiLock`) |
| `src/modules/lesta-sync/index.js` | Ядро: запрос статистики у Lesta, продление токена, применение дельт (запись боёв, автосписание фрагов), цикл автосинхронизации |
| `src/modules/lesta-routes/index.js` | HTTP-роуты: аккаунт/конфиг, статистика, достижения, техника, периоды, сессии, история |
| `src/modules/lesta-oauth/index.js` | OAuth-вход через Lesta, статичные тестовые страницы, поиск игрока по нику |
| `src/core/lesta-history.js` | Снапшоты истории статистики и снапшоты техники (танков), обёртки над Lesta API |
| `src/core/lesta-delta.js` | Чистая математика дельт (без БД/сети): защита от аномалий, агрегация по периодам |
| `public/lesta-stats.html` | Фронтенд-дашборд статистики игрока |
| `src/core/data-registry.js` | Регистрирует Lesta-поля `app_state` как источник данных для конструктора виджетов, исключая секреты (токены) |

Поток данных на верхнем уровне:

```
OAuth / ручной ввод ника
        │
        ▼
 привязка accountId ──► автосинк каждые 20с (1с при активном gold-tracker)
        │                       │
        │                       ▼
        │              account/info/ (Lesta API)
        │                       │
        │                       ▼
        │              applyLestaStats()
        │              ├─ пишет бои в frag_stats (фраг-трекер)
        │              ├─ автосписывает фраги в донат-режиме 1
        │              ├─ обновляет app_state.lesta_last_*
        │              ├─ вставляет снапшот в lesta_stats_history
        │              └─ WebSocket broadcast STATE_UPDATE
        │                       │
        ▼                       ▼
 lesta-stats.html ◄──── /api/lesta-* роуты (периоды, сессии, история, танки)
```

---

## 2. Конфигурация

```js
const LESTA_CONFIG = {
    applicationId: process.env.LESTA_APPLICATION_ID || 'da7874d5a895ff241d8b55e271c03ff3', // публичный demo application_id
    apiUrl: 'https://papi.tanksblitz.ru/wotb',
    openIdUrl: 'https://api.tanki.su/wot/auth/login/',
    accessToken: null,
    accountId: null,
    nickname: null
};
```

Продление токена — жёстко закодированный домен: `https://api.tanki.su/wot/auth/prolongate/`.

### Переменные окружения

| Переменная | Назначение |
|---|---|
| `LESTA_APPLICATION_ID` | application_id для всех вызовов Lesta API (либо тут, либо через `/api/lesta-config`, сохраняется в `app_state.lesta_application_id`) |
| `LESTA_AUTOSYNC=0` | полностью отключает автосинхронизацию |
| `LESTA_TEST_INJECT=1` | включает тестовый роут инъекции статистики без реального вызова API |
| `DEBUG_LESTA=1` | подробный `console.log` отладки статистики |
| `LESTA_HISTORY_HEARTBEAT_SEC` (900) | минимальный интервал между heartbeat-снапшотами истории при отсутствии активности |
| `LESTA_MAX_BATTLES_DELTA` (40) | максимально допустимая разница боёв между синками (иначе — resync, не бой) |
| `LESTA_RELIABLE_BATTLES_GAP` (3000) | допустимый разрыв в числе боёв для признания снапшота «надёжным» после resync |
| `LESTA_TANK_SNAPSHOT_MIN_SEC` (600) | минимальный интервал между снапшотами техники |
| `NODE_ENV=test` | включает тестовый роут `/api/lesta-test-stats/inject` |

`applicationId` — публичный идентификатор приложения (не секрет). `accessToken` — приватный, получается через OAuth и хранится в БД, а не в env.

---

## 3. Внешние эндпоинты Lesta API

### 3.1 `GET https://papi.tanksblitz.ru/wotb/account/info/` — статистика аккаунта

Главный опрашиваемый эндпоинт, вызывается в `getLestaPlayerStats()`.

**Параметры:**
- `application_id`
- `account_id`
- `access_token` — опционально, нужен только для приватных данных (gold/credits/free_xp)
- `extra=statistics.rating` — запросить рейтинговую статистику
- `fields` — `statistics.all.*` (battles, frags, wins, losses, damage_dealt, damage_received, xp, max_frags, frags8p, hits, shots, spotted, capture_points, dropped_capture_points, survived_battles, win_and_survived, max_xp), `statistics.rating.*`, `statistics.clan.*`, `nickname`, `private.gold`, `private.credits`, `private.free_xp`

**Обработка:**
- `response.data.status === 'ok'` → `response.data.data[accountId]`
- Итоговые «бои/фраги/победы» = сумма трёх категорий: **all + rating + clan** — по документации Lesta `statistics.all.battles` не включает рейтинговые/клановые/турнирные бои
- `private.*` доступны только если передан `access_token` владельца аккаунта
- Возвращается нормализованный объект со счётчиками + вычисленными `winRate`, `fragsPerBattle`, `avgDamage`, `avgXp`, `accuracy`
- Известные коды ошибок: `ACCOUNT_ID_NOT_SPECIFIED`, `INVALID_APPLICATION_ID`, `REQUEST_LIMIT_EXCEEDED`, `SOURCE_NOT_AVAILABLE`
- timeout 8000 мс
- Вызов оборачивается в `withLestaApiLock` — общую очередь `externalApiChain`, гарантирующую последовательность внешних вызовов (Lesta/YouTube и т.п. без параллелизма)
- Если до истечения токена осталось меньше часа (`tokenExpiresAt - now < 3600`) — сперва вызывается продление токена

### 3.2 `GET https://api.tanki.su/wot/auth/prolongate/` — продление access_token

Параметры: `application_id`, `access_token`.
Ответ: `data.access_token`, `data.expires_at` → сохраняются в `LESTA_CONFIG` и `app_state` (`lesta_access_token`, `lesta_token_expires_at`).

### 3.3 `GET https://api.tanki.su/wot/auth/login/` — OAuth-логин

Редирект браузера с параметрами `application_id`, `redirect_uri`, `prompt=login`. Колбэк приходит на `/auth/lesta/callback`.

### 3.4 `GET .../account/achievements/` — достижения игрока

Параметры: `application_id`, `account_id`, `fields` (default `achievements,max_series`), `language` (default `ru`).
Ответ: `data[account_id]` с достижениями и сериями.

### 3.5 `GET .../tanks/stats/` — статистика по технике

Используется в двух местах:
1. Роут `/api/lesta-tankstats` — параметры `application_id`, `account_id`, `fields` (default `all,mark_of_mastery,battle_life_time,last_battle_time`), `language`, опционально `tank_id`, `access_token`. Отдельно обрабатывается кейс, когда Lesta вернула HTML вместо JSON (сбой бэкенда).
2. `fetchAccountTanksForAccount()` (`lesta-history.js`) — `fields='tank_id,all,mark_of_mastery,last_battle_time,battle_life_time'`, timeout 60000 мс. Обрабатывает `STATS_HIDDEN` — если игрок скрыл статистику в приватности WG ID, `data[account_id] === null`.

Далее данные обогащаются названиями/тирами/нацией через энциклопедию (см. 3.6).

### 3.6 `GET .../encyclopedia/vehicles/` — справочник техники

1. Роут `/api/lesta-vehicles` — параметры `application_id`, `fields` (default `tank_id,name,tier,type,nation,is_premium`), `language`, опционально `nation`, `tank_id`.
2. `enrichTanksWithVehicleNames()` — те же поля, timeout 30000 мс, дополняет сырые данные `/tanks/stats/` человекочитаемыми именами/тирами/нацией/премиум-флагом.

### 3.7 `GET .../account/list/` — поиск игрока по нику

Параметры: `application_id`, `search`, `fields='account_id,nickname'`, `type='startswith'`, `limit=100`.

---

## 4. Внутренние HTTP-роуты

### `src/modules/lesta-routes/index.js`

| Метод/путь | Назначение |
|---|---|
| `POST /api/lesta-set-account` | Привязать аккаунт (`accountId`, `nickname`). Проверяет `applicationId`, запрашивает свежую статистику, сохраняет в `app_state`, запускает автосинк, шлёт broadcast |
| `POST /api/reset-lesta` | Полный сброс привязки: останавливает автосинк, обнуляет токен/аккаунт/ник/весь кэш `lesta_last_*` (кроме `application_id`) |
| `POST /api/lesta-config` | Сохранить `applicationId`. Логирует событие аналитики `lesta_config` |
| `GET /api/lesta-stats` | Текущая статистика: сначала «живой» вызов `getLestaPlayerStats()`, при неудаче — fallback на сохранённые `app_state` (`source: 'api'` vs `'database'`) |
| `POST /api/sync-lesta-state` | Синхронизировать счётчики Lesta с локальной таблицей `frag_stats` (сброс точки отсчёта фраг-трекера) |
| `GET /api/lesta-achievements` | Проксирует `/account/achievements/` |
| `GET /api/lesta-tankstats` | Проксирует `/tanks/stats/` |
| `GET /api/lesta-vehicles` | Проксирует `/encyclopedia/vehicles/` |
| `GET /api/lesta-player-tanks` | Полный список танков игрока, обогащённый именами, фильтр по подстроке, сортировка по кол-ву боёв. Побочный эффект — `scheduleLestaTankSnapshot()`. При скрытой статистике — `code: 'STATS_HIDDEN'` |
| `GET /api/lesta-tank-period?period=1d\|7d\|30d\|180d\|365d` | Изменения по каждому танку за период относительно базового снапшота из `lesta_tank_snapshots` |
| `POST /api/lesta-prolongate` | Ручной вызов продления токена |
| `GET /api/lesta-test-stats` | Тестовый запрос статистики с логированием конфигурации |
| `POST /api/lesta-test-stats/inject` (только `NODE_ENV=test`/`LESTA_TEST_INJECT=1`) | Инъекция фейковой статистики через `applyLestaStats()` без реального вызова API — для тестов |
| `POST /api/lesta-sync` | Ручная синхронизация, логирует `lesta_manual_sync`, шлёт broadcast |
| `GET /api/lesta-period?period=...&daily=0\|1` | Дельта статистики за период + опционально по-дневная разбивка |
| `GET /api/lesta-session` | Статистика сессии: ручная (после `/lesta-session/start`) либо авто «за сегодня» |
| `GET /api/lesta-session-tanks` | Танки, задействованные в текущей сессии |
| `POST /api/lesta-session/start` | Зафиксировать baseline ручной сессии |
| `POST /api/lesta-session/reset` | Сбросить baseline ручной сессии |
| `POST /api/gold-tracker/start` / `stop` | Начать/остановить трекер «нетто» золота за сессию |
| `GET /api/gold-tracker/status` | Текущий статус трекера (`active`, `startedAt`, `baselineGold`, `currentGold`, `net`). Lesta API отдаёт только снимок баланса, без истории транзакций — поэтому считается чистая разница |
| `GET /api/lesta-history?period=...` | История снапшотов из `lesta_stats_history` |

### `src/modules/lesta-oauth/index.js`

| Метод/путь | Назначение |
|---|---|
| `GET /lesta-test`, `/lesta-api-test`, `/lesta-stats` | Статичные HTML-страницы |
| `GET /auth/lesta` | Редирект на Lesta OAuth login |
| `GET /auth/lesta/callback` | Обработка ответа OAuth: сохраняет токен/аккаунт/ник, запускает автосинк, отправляет `postMessage({type:'LESTA_OAUTH_SUCCESS'})` окну-опенеру. Отдельно обрабатывает `code === 'AUTH_EXPIRED'` |
| `GET /api/lesta-search?nickname` | Поиск игрока по нику |

---

## 5. Логика применения статистики — `applyLestaStats()`

Вызывается после каждого успешного `getLestaPlayerStats()` (авто, вручную и через test-inject):

1. Логирует аналитику `lesta_sync`
2. Сравнивает новые `stats` с сохранёнными `lesta_last_*`
3. Считает `fragsDifference`/`battlesDifference` через `safeLestaCounterDelta` — при отрицательной разнице или превышении `LESTA_MAX_BATTLES_DELTA` изменение считается **resync** (не боем) и игнорируется
4. На каждый новый бой вызывает `addBattleForce(timestamp, frags, 'lesta')` — пишет в `frag_stats`
5. Если данных без изменений ≥ `LESTA_HISTORY_HEARTBEAT_SEC` — периодически обновляет `lesta_last_sync_time` (heartbeat), снапшотит gold/credits/free_xp при изменении
6. При наличии изменений — обновляет `lesta_last_*` в `app_state`, вставляет снапшот в `lesta_stats_history`, broadcast `STATE_UPDATE` по WebSocket
7. **Автосписание фрагов**: при `fragsDifference > 0` списывает их из донат-режима 1 (`frags_needed -= toComplete`, `frags_done += toComplete`), логирует `lesta_auto_deduct`
8. Вызывает опциональный хук `deps.afterSync(stats, state)` (используется модулем розыгрышей `razblog`)

---

## 6. Автосинхронизация

- Запускается при привязке аккаунта и после успешного OAuth
- Интервал: **20 секунд**, но **1 секунда** при активном `gold_tracker_active`
- Отключается `LESTA_AUTOSYNC=0`
- Реализована через рекурсивный `setTimeout` (не `setInterval`), чтобы не накапливать перекрывающиеся запросы
- Перед первым запуском вызывается `ensureLestaReliableSince()` — определяет «надёжную» точку истории после resync
- Все вызовы идут через общую очередь `withLestaApiLock` — не более одного внешнего API-вызова одновременно (шарится с YouTube и др.)

---

## 7. Дельта-математика и защита от аномалий — `src/core/lesta-delta.js`

Константы читаются из env при `require()` (см. таблицу переменных выше).

- `safeLestaCounterDelta(prev, cur, maxDelta)` — при отрицательной разнице или превышении лимита → `{delta:0, resync:true}`
- `deriveSnapshotDeltas()` — дельты battles/wins/losses/frags (лимит ×3)/damage (лимит 500000)/xp (лимит 250000), помечает `is_resync`
- `isReliableSnapshotRow(row, referenceBattles)` — если `referenceBattles < 5000`, строка всегда надёжна; иначе должна быть в пределах `LESTA_RELIABLE_BATTLES_GAP` от текущего числа боёв
- `buildDeltaSeries`, `aggregateDeltasList`, `computeLestaPeriodStatsFromRows` — агрегаты за период из серии снапшотов
- `getLestaPeriodDateFilter(period)` — маппинг `1d/7d/30d/180d/365d` → SQL date modifiers
- Покрыто юнит-тестами `tests/lesta-delta.test.js`

---

## 8. История и снапшоты техники — `src/core/lesta-history.js`

### A. История общей статистики
- `insertLestaStatsSnapshot(stats, fragsDifference, previousCounters, accountId, cb)` — пишет строку в `lesta_stats_history` с абсолютными значениями + дельтами + `is_resync`. При resync обновляет `app_state.lesta_reliable_since`. После вставки триггерит `scheduleLestaTankSnapshot()`
- `fetchLestaHistoryWindow(period, referenceBattles, reliableSinceSec, cb)` — окно снапшотов за период + якорная точка до начала периода, с фильтром по надёжности
- `buildLestaDailyActivity(days, referenceBattles, reliableSinceSec, cb)` — по-дневная разбивка активности
- `detectLestaReliableSinceTimestamp` / `ensureLestaReliableSince` — детектируют момент, когда статистика вновь «надёжна» после resync (>5000 боёв, разрыв счётчика)

### B. Снапшоты техники
- `normalizeTankStatsList(apiData, accountId)` — парсит ответ `/tanks/stats/` (массив или объект по tank_id), отфильтровывает 0-боёвые танки, `null` → `hidden: true`
- `enrichTanksWithVehicleNames()` — подтягивает `/encyclopedia/vehicles/`, добавляет `name/tier/type/nation/is_premium`
- `tanksToSnapshotMap(tanks)` → компактная карта `{tank_id: {battles, wins, frags, damage_dealt, name, tier}}`
- `insertLestaTankSnapshot(accountId, tanksMap, cb)` — INSERT в `lesta_tank_snapshots` (JSON-строка)
- `fetchTankSnapshotBaseline` / `fetchNewestTankSnapshotInPeriod` — поиск ближайшего снапшота к границе периода
- `computeTankPeriodChanges(currentMap, baselineMap, maxBattlesDelta)` — дельты по каждому танку (лимит `LESTA_MAX_BATTLES_DELTA * 80` боёв на танк за период), сортировка по числу боёв
- `captureLestaTankSnapshot`/`scheduleLestaTankSnapshot` — не чаще раза в `LESTA_TANK_SNAPSHOT_MIN_SEC` (600с)
- `fetchAccountTanksForAccount(accountId, language)` — главный хелпер: полный обогащённый список танков игрока (объединяет 3.5 и 3.6)

---

## 9. Структуры данных в БД (SQLite)

### `app_state` (единственная строка, id=1) — Lesta-поля

```
lesta_application_id TEXT
lesta_access_token TEXT
lesta_token_expires_at INTEGER
lesta_account_id TEXT
lesta_nickname TEXT
lesta_auto_sync INTEGER DEFAULT 0        -- принудительно всегда 1
lesta_auto_deduct INTEGER DEFAULT 1      -- принудительно всегда включён
lesta_last_battles, lesta_last_frags, lesta_last_wins, lesta_last_losses INTEGER
lesta_last_win_rate, lesta_last_frags_per_battle REAL
lesta_last_damage_dealt, lesta_last_damage_received INTEGER
lesta_last_xp INTEGER
lesta_last_max_frags, lesta_last_frags8p INTEGER
lesta_last_hits, lesta_last_shots, lesta_last_spotted INTEGER
lesta_last_capture_points, lesta_last_dropped_capture_points INTEGER
lesta_last_survived_battles, lesta_last_win_and_survived INTEGER
lesta_last_max_xp INTEGER
lesta_last_gold, lesta_last_credits, lesta_last_free_xp INTEGER   -- приватные, нужен access_token
lesta_previous_frags INTEGER
lesta_last_sync_time INTEGER
lesta_last_history_at INTEGER DEFAULT 0
lesta_reliable_since INTEGER DEFAULT 0
lesta_last_tank_snapshot_at INTEGER DEFAULT 0
lesta_session_started_at INTEGER DEFAULT 0
lesta_session_baseline_battles/wins/losses/frags/damage/xp INTEGER DEFAULT 0
gold_tracker_active INTEGER DEFAULT 0
gold_tracker_started_at INTEGER DEFAULT 0
gold_tracker_baseline_gold INTEGER DEFAULT 0
-- dd_lesta_session_* — параллельные поля donation-driven-widget (отдельная фича)
```

### `lesta_stats_history`

```sql
CREATE TABLE lesta_stats_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    battles, frags, wins, losses, damage_dealt, xp INTEGER,
    win_rate, frags_per_battle REAL,
    avg_damage, avg_xp INTEGER,
    frags_difference INTEGER DEFAULT 0,
    auto_deducted INTEGER DEFAULT 0,
    battles_delta, wins_delta, losses_delta, frags_delta, damage_delta, xp_delta INTEGER DEFAULT 0,
    account_id TEXT,
    is_resync INTEGER DEFAULT 0
)
```

### `lesta_tank_snapshots`

```sql
CREATE TABLE lesta_tank_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    account_id TEXT,
    tanks_json TEXT NOT NULL   -- {tank_id: {battles, wins, frags, damage_dealt, name, tier}}
)
```

### Связанная таблица
- **`frag_stats`** — общая таблица боёв фраг-трекера; сюда пишутся записи через `addBattleForce(timestamp, frags, 'lesta')` при каждом новом бое.

---

## 10. Frontend — `public/lesta-stats.html`

Потребляет практически все Lesta-роуты:
поиск/привязка аккаунта, `/api/state` (+ WS `STATE_UPDATE`), ручная синхронизация/сброс,
блок достижений, справочник техники, список танков игрока с поиском,
статистика/танки за период (СУТКИ/НЕДЕЛЯ/МЕСЯЦ/ПОЛГОДА/ГОД), история,
блок сессии (ручной старт/сброс), блок gold-tracker.

---

## 11. Интеграции с другими модулями

- **`blitz-challenge`** — челлендж по винрейту/урону/медалям, использует ту же сессионную/периодную логику
- **`razblog`** (розыгрыши) — хук `afterSync` реагирует на изменения золота
- **`donation-driven-widget`** — использует Lesta-сессионные счётчики как драйвер параметра
- **`widget-builder` / `data-registry.js`** — привязка на произвольные виджеты выборочных полей `app_state` (ник, бои/фраги/победы/винрейт/урон за сессию) с live-обновлением через `STATE_UPDATE`, без доступа к секретным токенам

---

## 12. Ключевые нюансы для нового проекта

1. **Бои считаются как all + rating + clan** — иначе часть боёв (рейтинговые/клановые) теряется.
2. **Приватные поля (gold/credits/free_xp) требуют access_token** владельца — без OAuth недоступны.
3. **Resync-защита обязательна**: Lesta периодически пересчитывает счётчики статистики (после чего они могут скакнуть вниз или сильно вверх) — без `safeLestaCounterDelta`/`LESTA_MAX_BATTLES_DELTA` это будет ошибочно интерпретировано как сотни боёв за один тик.
4. **`STATS_HIDDEN`** — игрок может скрыть статистику в приватности WG ID; `/tanks/stats/` тогда возвращает `null` для аккаунта, это нужно обрабатывать отдельно (не как ошибку).
5. **application_id — публичный**, но access_token — приватный секрет, хранить только в БД/сессии, никогда не отдавать на фронт и не включать в `data-registry.js`.
6. **Очередь внешних вызовов** (`withLestaApiLock`) нужна, чтобы не словить `REQUEST_LIMIT_EXCEEDED` от параллельных запросов.
7. **Токен нужно продлевать заранее** (за час до истечения), иначе синк начнёт падать с ошибкой авторизации.
