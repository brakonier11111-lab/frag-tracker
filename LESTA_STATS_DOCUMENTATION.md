# Документация: Страница Lesta Games Статистики (/lesta-stats)

## Обзор

Страница `/lesta-stats` предоставляет полный интерфейс для просмотра и управления статистикой игрока World of Tanks Blitz через API Lesta Games. Страница автоматически синхронизируется с API каждые 20 секунд и отображает актуальную статистику в реальном времени.

---

## Архитектура системы

### 1. Маршрутизация

**Файл:** `server.js`

```javascript
// Основной маршрут страницы
app.get('/lesta-stats', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'lesta-stats.html'));
});
```

**Файл страницы:** `public/lesta-stats.html`

---

## Основные компоненты

### 1. Конфигурация Lesta Games

**Расположение:** `server.js` (строки 46-53)

```javascript
const LESTA_CONFIG = {
    applicationId: process.env.LESTA_APPLICATION_ID || 'da7874d5a895ff241d8b55e271c03ff3',
    apiUrl: 'https://papi.tanksblitz.ru/wotb',        // API для получения данных
    openIdUrl: 'https://api.tanki.su/wot/auth/login/', // OAuth авторизация
    accessToken: null,    // Токен доступа (получается при авторизации)
    accountId: null,      // ID аккаунта игрока
    nickname: null,       // Никнейм игрока
    tokenExpiresAt: null  // Время истечения токена
};
```

**Загрузка из БД:** При старте сервера конфигурация загружается из таблицы `app_state` (строки 1814-1829)

---

### 2. OAuth Авторизация

#### 2.1. Инициация авторизации

**Маршрут:** `GET /auth/lesta`

**Функция:** Перенаправляет пользователя на страницу авторизации Lesta Games

```javascript
app.get('/auth/lesta', (req, res) => {
    const redirectUri = `http://localhost:${port}/auth/lesta/callback`;
    const authUrl = `${LESTA_CONFIG.openIdUrl}?application_id=${LESTA_CONFIG.applicationId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.redirect(authUrl);
});
```

#### 2.2. OAuth Callback

**Маршрут:** `GET /auth/lesta/callback`

**Параметры запроса:**
- `status` - статус авторизации ('ok' или 'error')
- `access_token` - токен доступа
- `account_id` - ID аккаунта
- `nickname` - никнейм игрока
- `expires_at` - время истечения токена (Unix timestamp)

**Процесс:**
1. Проверка статуса авторизации
2. Сохранение токена и данных аккаунта в `LESTA_CONFIG`
3. Сохранение в БД (таблица `app_state`)
4. Запуск автосинхронизации (если еще не запущена)
5. Отображение страницы успешной авторизации

**Код:** `server.js` (строки 2111-2192)

---

### 3. Получение статистики игрока

#### 3.1. Основная функция: `getLestaPlayerStats()`

**Расположение:** `server.js` (строки 3967-4083)

**Процесс работы:**

1. **Проверка конфигурации:**
   ```javascript
   if (!LESTA_CONFIG.applicationId || !LESTA_CONFIG.accountId) {
       return null;
   }
   ```

2. **Продление токена (если нужно):**
   - Проверяет, осталось ли меньше часа до истечения
   - Вызывает `prolongateLestaToken()` для продления

3. **Запрос к API Lesta Games:**
   ```javascript
   GET ${LESTA_CONFIG.apiUrl}/account/info/
   Параметры:
   - application_id: LESTA_CONFIG.applicationId
   - account_id: LESTA_CONFIG.accountId
   - access_token: LESTA_CONFIG.accessToken (опционально)
   - fields: 'statistics.all.battles,statistics.all.frags,...'
   ```

4. **Обработка ответа:**
   - Извлекает данные из `response.data.data[accountId]`
   - Парсит статистику из `playerData.statistics.all`
   - Вычисляет производные метрики (winRate, fragsPerBattle, avgDamage и т.д.)

5. **Возвращаемые данные:**
   ```javascript
   {
       nickname: string,
       battles: number,
       frags: number,
       wins: number,
       losses: number,
       damage_dealt: number,
       damage_received: number,
       xp: number,
       max_frags: number,
       frags8p: number,
       hits: number,
       shots: number,
       spotted: number,
       capture_points: number,
       dropped_capture_points: number,
       survived_battles: number,
       win_and_survived: number,
       max_xp: number,
       winRate: string,           // Процент побед
       fragsPerBattle: string,    // Фраги за бой
       avgDamage: string,         // Средний урон
       avgXp: string,             // Средний опыт
       accuracy: string            // Точность стрельбы
   }
   ```

6. **Обработка ошибок:**
   - `ACCOUNT_ID_NOT_SPECIFIED` - не указан account_id
   - `INVALID_APPLICATION_ID` - неверный Application ID
   - `REQUEST_LIMIT_EXCEEDED` - превышены лимиты API
   - `SOURCE_NOT_AVAILABLE` - источник данных недоступен

---

### 4. Автосинхронизация

#### 4.1. Функция: `startLestaAutoSync()`

**Расположение:** `server.js` (строки 4087-4267)

**Процесс:**

1. **Запуск:** Вызывается при старте сервера, если есть `accessToken` и `accountId`

2. **Цикл синхронизации:**
   - Выполняется каждые **20 секунд**
   - Вызывает `getLestaPlayerStats()` для получения свежей статистики

3. **Обработка изменений:**

   **a) Новые бои:**
   ```javascript
   const battlesDifference = stats.battles - (state.lesta_last_battles || 0);
   if (battlesDifference > 0) {
       // Распределяем фраги между новыми боями
       for (let i = 0; i < battlesDifference; i++) {
           addBattleForce(new Date().toISOString(), battleFrags, 'lesta');
       }
   }
   ```

   **b) Изменение фрагов:**
   ```javascript
   const fragsDifference = currentFrags - previousFrags;
   if (fragsDifference > 0) {
       // Автоматическое списание фрагов в режиме 1 (фраг-трекер)
       // Обновляет frags_needed и frags_done
   }
   ```

4. **Обновление БД:**
   - Обновляет все поля `lesta_last_*` в таблице `app_state`
   - Сохраняет `lesta_previous_frags` для отслеживания изменений

5. **История изменений:**
   - Каждая синхронизация сохраняется в таблицу `lesta_stats_history`
   - Записываются: battles, frags, wins, losses, damage_dealt, xp, win_rate, frags_per_battle, avg_damage, avg_xp, frags_difference, auto_deducted

6. **Автосписание фрагов:**
   - Если фраги увеличились, автоматически списывает их из режима 1
   - Обновляет `frags_needed` и `frags_done`
   - Логирует событие `lesta_auto_deduct` в аналитику

7. **WebSocket обновления:**
   - После обновления БД вызывается `broadcastStateUpdate()` для отправки обновлений всем подключенным клиентам

---

### 5. API Endpoints

#### 5.1. `GET /api/lesta-stats`

**Назначение:** Получить текущую статистику игрока

**Процесс:**
1. Пытается получить свежую статистику через `getLestaPlayerStats()`
2. Если не удалось, берет данные из БД (таблица `app_state`)
3. Возвращает JSON с полями `success`, `stats`, `source` ('api' или 'database')

**Код:** `server.js` (строки 7203-7237)

---

#### 5.2. `POST /api/lesta-sync`

**Назначение:** Ручная синхронизация статистики

**Процесс:**
1. Вызывает `getLestaPlayerStats()`
2. Логирует событие `lesta_manual_sync` в аналитику
3. Возвращает обновленную статистику

**Код:** `server.js` (строки 8231-8251)

---

#### 5.3. `GET /api/lesta-history`

**Назначение:** Получить историю изменений статистики за период

**Параметры:**
- `period` - период ('1d', '7d', '30d', '180d', '365d')

**Процесс:**
1. Фильтрует записи из таблицы `lesta_stats_history` по периоду
2. Вычисляет статистику периода:
   - `total_records` - количество записей
   - `total_frags_gained` - всего получено фрагов
   - `total_frags_deducted` - всего списано фрагов
   - `total_battles_played` - сыграно боев
   - `avg_frags_per_update` - среднее фрагов за обновление

**Код:** `server.js` (строки 8255-8325)

---

#### 5.4. `GET /api/lesta-achievements`

**Назначение:** Получить достижения игрока

**Параметры:**
- `account_id` - ID аккаунта (обязательно)
- `fields` - поля для получения (по умолчанию: 'achievements,max_series')
- `language` - язык (по умолчанию: 'ru')

**Код:** `server.js` (строки 8012-8069)

---

#### 5.5. `GET /api/lesta-search`

**Назначение:** Поиск игроков по никнейму

**Параметры:**
- `nickname` - никнейм для поиска
- `type` - тип поиска ('startswith', 'exact')

**Код:** `server.js` (строки 7240-7280)

---

#### 5.6. `GET /api/lesta-tankstats`

**Назначение:** Получить статистику по конкретной технике

**Параметры:**
- `account_id` - ID аккаунта (обязательно)
- `tank_id` - ID техники (обязательно)
- `fields` - поля для получения
- `language` - язык

**Код:** `server.js` (строки 8072-8138)

---

#### 5.7. `GET /api/lesta-vehicles`

**Назначение:** Получить список техники

**Параметры:**
- `fields` - поля для получения
- `language` - язык

**Код:** `server.js` (строки 8141-8208)

---

#### 5.8. `POST /api/lesta-prolongate`

**Назначение:** Продлить токен доступа

**Код:** `server.js` (строки 8195-8209)

---

#### 5.9. `GET /api/lesta-test-stats`

**Назначение:** Тестовый endpoint для проверки получения статистики

**Код:** `server.js` (строки 8210-8229)

---

#### 5.10. `POST /api/reset-lesta`

**Назначение:** Сбросить все данные Lesta Games

**Процесс:**
- Очищает все поля `lesta_*` в таблице `app_state`
- Останавливает автосинхронизацию

---

### 6. Продление токена

#### Функция: `prolongateLestaToken()`

**Расположение:** `server.js` (строки 3920-3965)

**Процесс:**
1. Проверяет наличие `accessToken`
2. Отправляет запрос к API для продления токена
3. Обновляет `LESTA_CONFIG.accessToken` и `LESTA_CONFIG.tokenExpiresAt`
4. Сохраняет в БД

**Вызывается автоматически:**
- В `getLestaPlayerStats()` если токен скоро истечет (< 1 часа)

---

## Frontend (lesta-stats.html)

### 1. WebSocket подключение

**Функция:** `connectWebSocket()`

**Процесс:**
1. Подключается к WebSocket серверу
2. Слушает сообщения типа `state_update`
3. При получении обновления вызывает `updateUI(data.state)`
4. Автоматически переподключается при разрыве соединения (до 5 попыток)

**Код:** `public/lesta-stats.html` (строки 981-1012)

---

### 2. Обновление UI

#### Функция: `updateUI(state)`

**Процесс:**
1. Обновляет информацию об игроке:
   - Никнейм
   - Account ID
   - Статус авторизации

2. Сохраняет текущую статистику в `currentStats`

3. Вызывает `updateStatsDisplay()` для обновления всех метрик

4. Вызывает `updateFullStatsDisplay(state)` для полной статистики

5. Автоматически загружает достижения, если игрок авторизован

**Код:** `public/lesta-stats.html` (строки 1014-1066)

---

#### Функция: `updateStatsDisplay()`

**Процесс:**
Обновляет все элементы статистики на странице:
- Боевая статистика (бои, победы, поражения, винрейт)
- Фраги (всего, за бой, макс, 8+ уровня)
- Урон (нанесено, получено, средний, макс)
- Опыт (всего, средний, макс, выжил)
- Дополнительно (попадания, выстрелы, точность, обнаружено)
- Захват баз (очки захвата, защиты, победы+выжил)

**Код:** `public/lesta-stats.html` (строки 1068-1114)

---

### 3. Отображение изменений за период

#### Функция: `showChanges(period)`

**Параметры:**
- `period` - период ('1d', '7d', '30d', '180d', '365d')

**Процесс:**
1. Загружает историю через `/api/lesta-history?period=${period}`
2. Вычисляет разницу между первой и последней записью
3. Отображает изменения рядом с каждой метрикой:
   - Зеленый цвет для положительных изменений (+)
   - Красный цвет для отрицательных изменений (-)
   - Серый цвет для нулевых изменений (—)

**Код:** `public/lesta-stats.html` (строки 1333-1384)

---

### 4. Загрузка достижений

#### Функция: `loadAchievements(accountId)`

**Процесс:**
1. Запрашивает достижения через `/api/lesta-achievements`
2. Отображает:
   - Медали (achievements) - количество каждого достижения
   - Максимальные серии (max_series) - рекордные серии

**Код:** `public/lesta-stats.html` (строки 1157-1231)

---

### 5. Авторизация

#### Функция: `authLestaGames()`

**Процесс:**
1. Открывает окно авторизации `/auth/lesta`
2. Слушает сообщения от окна авторизации
3. При успешной авторизации обновляет состояние через `/api/state`
4. Обновляет UI

**Код:** `public/lesta-stats.html` (строки 1233-1279)

---

### 6. Дополнительные функции

#### `testStats()`
- Тестирует получение статистики через `/api/lesta-test-stats`
- Показывает результат в alert

#### `syncStats()`
- Выполняет ручную синхронизацию через `/api/lesta-sync`

#### `resetLestaData()`
- Сбрасывает все данные Lesta Games через `/api/reset-lesta`
- Требует подтверждения

#### `toggleFullStats()`
- Показывает/скрывает блок полной статистики аккаунта

---

## База данных

### Таблица: `app_state`

**Поля Lesta Games:**
- `lesta_application_id` - Application ID
- `lesta_access_token` - Токен доступа
- `lesta_token_expires_at` - Время истечения токена (Unix timestamp)
- `lesta_account_id` - ID аккаунта
- `lesta_nickname` - Никнейм игрока
- `lesta_auto_sync` - Автосинхронизация включена (0/1)
- `lesta_auto_deduct` - Автосписание фрагов включено (0/1)
- `lesta_last_battles` - Последнее количество боев
- `lesta_last_frags` - Последнее количество фрагов
- `lesta_last_wins` - Последнее количество побед
- `lesta_last_losses` - Последнее количество поражений
- `lesta_last_win_rate` - Последний винрейт (%)
- `lesta_last_frags_per_battle` - Последние фраги за бой
- `lesta_last_damage_dealt` - Последний нанесенный урон
- `lesta_last_damage_received` - Последний полученный урон
- `lesta_last_xp` - Последний опыт
- `lesta_last_max_frags` - Максимальные фраги за бой
- `lesta_last_frags8p` - Фраги на технике 8+ уровня
- `lesta_last_hits` - Попадания
- `lesta_last_shots` - Выстрелы
- `lesta_last_spotted` - Обнаружено врагов
- `lesta_last_capture_points` - Очки захвата
- `lesta_last_dropped_capture_points` - Очки защиты
- `lesta_last_survived_battles` - Выжил в боях
- `lesta_last_win_and_survived` - Победы + выжил
- `lesta_last_max_xp` - Максимальный опыт за бой
- `lesta_previous_frags` - Предыдущее количество фрагов (для отслеживания изменений)

---

### Таблица: `lesta_stats_history`

**Структура:**
```sql
CREATE TABLE lesta_stats_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    battles INTEGER,
    frags INTEGER,
    wins INTEGER,
    losses INTEGER,
    damage_dealt INTEGER,
    xp INTEGER,
    win_rate REAL,
    frags_per_battle REAL,
    avg_damage INTEGER,
    avg_xp INTEGER,
    frags_difference INTEGER DEFAULT 0,  -- Изменение фрагов с предыдущей записи
    auto_deducted INTEGER DEFAULT 0      -- Количество автоматически списанных фрагов
)
```

**Назначение:** Хранит историю всех синхронизаций для анализа изменений за период

---

## Интеграция с другими системами

### 1. Фраг-трекер (Режим 1)

**Автосписание фрагов:**
- При увеличении фрагов в Lesta Games автоматически списываются фраги из режима 1
- Обновляются поля `frags_needed` и `frags_done` в таблице `app_state`
- Логируется событие `lesta_auto_deduct` в аналитику

**Код:** `server.js` (строки 4198-4251)

---

### 2. Система боев

**Добавление боев:**
- При обнаружении новых боев вызывается `addBattleForce()` для каждого нового боя
- Бои записываются в таблицу `frag_stats`
- Источник боя помечается как 'lesta'

**Код:** `server.js` (строки 4114-4133)

---

### 3. WebSocket Broadcast

**Обновления состояния:**
- После каждой синхронизации вызывается `broadcastStateUpdate()`
- Все подключенные клиенты получают обновление через WebSocket
- Тип сообщения: `state_update`

**Код:** `server.js` (строки 5359-5397)

---

## Логирование и аналитика

### События аналитики:

1. **`lesta_sync`** - Автоматическая синхронизация
   - Параметры: battles, frags, winRate, fragsPerBattle

2. **`lesta_manual_sync`** - Ручная синхронизация
   - Параметры: battles, frags, winRate, fragsPerBattle

3. **`lesta_auto_deduct`** - Автоматическое списание фрагов
   - Параметры: frags_difference, frags_deducted, previous_frags, current_frags

---

## Безопасность

1. **Токены:**
   - Access token хранится в БД и в памяти
   - Автоматически продлевается перед истечением
   - Не передается в открытом виде клиентам

2. **OAuth:**
   - Использует официальный OAuth flow Lesta Games
   - Redirect URI должен быть зарегистрирован в приложении

3. **API ключи:**
   - Application ID можно настроить через переменные окружения или админку
   - По умолчанию используется тестовый Application ID

---

## Обработка ошибок

### Типичные ошибки:

1. **Токен истек:**
   - Автоматически продлевается при следующем запросе
   - Если продление не удалось, используется текущий токен до полного истечения

2. **API недоступен:**
   - Возвращается `null` из `getLestaPlayerStats()`
   - Используются данные из БД (последняя успешная синхронизация)

3. **Превышены лимиты API:**
   - Логируется ошибка `REQUEST_LIMIT_EXCEEDED`
   - Следующий запрос будет через 20 секунд (стандартный интервал)

4. **Неверный account_id:**
   - Проверяется при каждом запросе
   - Если не указан, функция возвращает `null`

---

## Производительность

1. **Интервал синхронизации:** 20 секунд
2. **Таймаут API запросов:** 10 секунд
3. **История изменений:** Ограничена 1000 записей на запрос
4. **WebSocket:** Поддерживает множественные подключения

---

## Расширение функциональности

### Добавление новых метрик:

1. Добавить поле в запрос `fields` в `getLestaPlayerStats()`
2. Добавить поле в возвращаемый объект статистики
3. Добавить поле в таблицу `app_state` (через миграцию)
4. Обновить `updateAppState()` в автосинхронизации
5. Добавить отображение на странице `lesta-stats.html`

### Добавление новых периодов:

1. Добавить case в `showChanges()` на frontend
2. Добавить case в `/api/lesta-history` на backend
3. Добавить кнопку периода в UI

---

## Заключение

Страница `/lesta-stats` представляет собой полнофункциональную систему интеграции с API Lesta Games, которая:

- Автоматически синхронизирует статистику каждые 20 секунд
- Отслеживает изменения и автоматически списывает фраги
- Сохраняет историю всех изменений
- Предоставляет удобный интерфейс для просмотра статистики
- Интегрируется с другими системами проекта (фраг-трекер, аналитика)
- Использует WebSocket для обновлений в реальном времени

Система спроектирована с учетом надежности, производительности и расширяемости.
