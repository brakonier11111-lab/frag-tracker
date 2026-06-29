## Режим “Очередь танков” (Tank Queue)

Этот режим отвечает за отображение интерактивной очереди “танков” на стриме (и в OBS/Browser Source). Он состоит из:
1) конфигуратора/редактора на странице `tank-queue.html`;
2) серверного слоя (Express + SQLite) с API `GET/POST /api/tank-queue`;
3) виджета для OBS `widget-tank-queue.html` (именно он содержит карусель текстов).

---

## 1) Поток данных (как всё работает)

1. Стример открывает UI `http://localhost:3000/tank-queue.html`.
2. UI загружает текущее состояние очереди и настроек через `GET /api/tank-queue`.
3. UI позволяет:
   - добавить/очистить “танки” (список `tank_queue`);
   - задать “текущий танк” по индексу (`current_tank_index`);
   - задать цены/надписи (order_price / order_price_top1 и т.д.);
   - задать карусель текстов (5 полей с флагом enabled + интервал);
   - задать 2 картинки (secondPhoto, streamerPhoto) и опционально 3-ю (thirdPhoto) для “пустой очереди”.
4. Все изменения сохраняются в БД через `POST /api/tank-queue/save`.
5. OBS-виджет `widget-tank-queue.html` раз в 2 секунды опрашивает `GET /api/tank-queue?lite=1` и рендерит:
   - карточку “текущий бой”;
   - карточку “очередь” (список следующих танков);
   - карточку “очередь пуста” (с фото/анимацией);
   - карусель “priceCarousel” (текст/цена).

---

## 2) Хранение в SQLite (таблицы)

### `tank_queue`
Заполняется танками, которые реально стоят в очереди.

Колонки:
- `id` (INTEGER, PK AUTOINCREMENT)
- `name` (TEXT, NOT NULL)
- `price` (INTEGER, NOT NULL)
- `conditions` (TEXT, DEFAULT '')
- `priority` (INTEGER, DEFAULT 0)
- `added_at` (INTEGER, DEFAULT 0) — время добавления (используется для сортировок/логики уведомлений)
- `created_at` (DATETIME DEFAULT CURRENT_TIMESTAMP)
- `updated_at` (DATETIME DEFAULT CURRENT_TIMESTAMP)

### `tank_queue_settings`
Одна строка настроек с `id = 1`.

Базовые колонки (виджетом используются следующие):
- `current_tank_index` (INTEGER, DEFAULT -1) — индекс текущего танка (см. заметки про индексы ниже)
- `order_price` (INTEGER DEFAULT 0)
- `order_price_top1` (INTEGER DEFAULT 0)
- `order_price_priority` (INTEGER DEFAULT 0)
- `order_price_mega` (INTEGER DEFAULT 0)
- `price_info` (TEXT DEFAULT '')
- `order_price_label` (TEXT DEFAULT 'Заказ танка')
- `order_price_top1_label` (TEXT DEFAULT 'Заказ танка до топ 1')
- `order_price_priority_label` (TEXT DEFAULT 'Приоритетный заказ')
- `order_price_mega_label` (TEXT DEFAULT 'Мегаприоритет')
- `order_price_enabled` (INTEGER DEFAULT 1)
- `order_price_top1_enabled` (INTEGER DEFAULT 1)
- `order_price_priority_enabled` (INTEGER DEFAULT 1)
- `order_price_mega_enabled` (INTEGER DEFAULT 1)
- `top1_section_visible` (INTEGER DEFAULT 0)
- `price_carousel` (TEXT) — JSON строка массива из 5 элементов
- `price_carousel_interval` (INTEGER DEFAULT 15) — секунды
- `streamer_photo` (TEXT) — путь к файлу в `public/` (для фото в пустой очереди / декоре)
- `second_photo` (TEXT) — путь к файлу
- `third_photo` (TEXT) — путь к файлу

---

## 3) Backend API

### 3.1 `GET /api/tank-queue`
Назначение: вернуть в клиент актуальные данные очереди и настроек.

Query-параметры:
- `lite=1` — “легкий” режим:
  - не грузит/не возвращает base64 фото;
  - возвращает только тексты/числа/массивы.

Возвращаемая структура (в целом одинаковая по смыслу для обоих режимов, но фото отсутствуют в `lite=1`):
- `success` (boolean)
- `tanks` (array of objects): список танков в очереди
  - `name` (string)
  - `price` (number)
  - `conditions` (string)
  - `priority` (number) — 0/1/2
  - `addedAt` (number) — берется из `added_at` (или fallback)
- `currentTankIndex` (number) — из `current_tank_index`, fallback -1
- `orderPrice`, `orderPriceTop1`, `orderPricePriority`, `orderPriceMega` (numbers)
- `priceInfo` (string)
- `orderPriceLabel`, `orderPriceTop1Label`, `orderPricePriorityLabel`, `orderPriceMegaLabel` (string)
- `orderPriceEnabled`, `orderPriceTop1Enabled`, `orderPricePriorityEnabled`, `orderPriceMegaEnabled` (0/1)
- `top1SectionVisible` (0/1)
- `priceCarousel` (array):
  - каждый элемент: `{ text: string, enabled: boolean }`
  - берется из JSON, хранящегося в `tank_queue_settings.price_carousel`
- `priceCarouselInterval` (number, секунды)
- (не в lite) `streamerPhoto`, `secondPhoto`, `thirdPhoto` — base64 data URLs

Пояснение: `priceCarousel` парсится из поля `settings.price_carousel`. Если поле пустое/невалидное — отдается `[]`.

### 3.2 `POST /api/tank-queue/save`
Назначение: сохранить в БД:
1) массив танков (полностью перезаписывается таблица `tank_queue`);
2) настройки (обновляется `tank_queue_settings` id=1);
3) фото (если пришли base64 data URLs — сервер сохраняет их файлом в `public/uploads/` и пишет путь в settings).

Ожидаемые поля body (ключевые для логики):
- `tanks`: массив объектов
  - `name`, `price`, `conditions`, `priority`, `addedAt`
- `currentTankIndex`
- `orderPrice`, `orderPriceTop1`, `orderPricePriority`, `orderPriceMega`
- `priceInfo`
- `orderPriceLabel`, `orderPriceTop1Label`, `orderPricePriorityLabel`, `orderPriceMegaLabel`
- `orderPriceEnabled`, `orderPriceTop1Enabled`, `orderPricePriorityEnabled`, `orderPriceMegaEnabled`
- `top1SectionVisible`
- `priceCarousel`: массив `{ text, enabled }` (сохраняется как JSON строка)
- `priceCarouselInterval`
- `streamerPhoto`, `secondPhoto`, `thirdPhoto`: base64 data URL либо пусто/undefined (если не менять/удалять)

---

## 4) OBS-виджет с каруселью: `public/widget-tank-queue.html`

### URL
- Полноценный виджет: `http://localhost:3000/widget-tank-queue.html`
- (в репозитории также есть другой файл) `public/widget-tank-queue-obs.html` — упрощенный вариант без карусели (для справки).

### 4.1 Инициализация (`loadData`)
1) Выполняется `GET /api/tank-queue` (НЕ lite), чтобы:
   - получить `tanks`, `currentTankIndex` и настройки;
   - получить base64 фото.
2) После загрузки вызывается:
   - `updateOrderPrice()` (в этом виджете “устаревшая” функция: цена фактически формируется через карусель);
   - `renderQueue()` (рендер очереди/пустого состояния);
   - затем запускается “синхронизация карусели с пустотой очереди” (см. ниже).

### 4.2 Периодические обновления (`updateData`)
Каждые 2 секунды:
- `GET /api/tank-queue?lite=1`
- если массив `tanks` изменился — обновляется локальное `tanks` и `renderQueue()`
- если изменился `currentTankIndex` — обновляется и `renderQueue()`
- если изменилась карусель (`priceCarousel`) или интервал (`priceCarouselInterval`) — виджет приводит текущее состояние карусели в соответствие
- отдельно встроена логика “уведомления при добавлении танка”:
  - при росте длины массива и добавлении нового элемента в последние 5 секунд показывается notification-режим для карусели на 3 секунды

### 4.3 Определение “очередь пуста”
В виджете “пусто” означает:
- `tanks.length === 0`

При этом:
- скрывается карточка `queueSection`;
- скрывается `currentBattle`;
- отображается `emptyQueueSection` ИЛИ `thirdPhotoSection` (если `thirdPhoto` задан).

### 4.4 Текущий бой
Карта “текущий бой” показывается, если:
- `currentTankIndex >= 0 && currentTankIndex < tanks.length`

Внутри `renderQueue()` из общего списка строится:
- `queueTanks = tanks.filter((_, index) => index !== currentTankIndex)`

То есть “текущий” один — а “очередь” — это все остальные.

### 4.5 Очередь и видимость
Рендер очереди использует `queueLength = queueTanks.length`.

Поведение по очереди:
- если `queueLength === 0`: виджет остаётся в “empty queue” (см. пункт 4.3)
- если `queueLength > 0`:
  - `queueSection` показывается
  - `queueCount` (маленький блок с количеством) показывается только когда `queueLength > 5`
  - список танков рендерится с ограничением 5 элементов (`tanksToShow`)

Также виджет анимирует появление/удаление элементов (классы `slide-in`, `slide-out`) и пересобирает DOM, стараясь сохранять элементы между апдейтами.

### 4.6 Карусель текстов (priceCarousel) — главная логика

#### Что такое `priceCarousel`
Это массив из 5 объектов:
`[{ text: string, enabled: boolean }, ...]`

Включенными считаются только элементы, удовлетворяющие:
- `item.enabled === true`
- `item.text` не пустой (`trim() !== ''`)

#### Как выбирается текущий текст
В виджете есть индекс:
- `currentCarouselIndex` (начинается с 0)

На каждой смене:
1) фильтруются enabled элементы `enabledItems`
2) выбирается `enabledItems[currentCarouselIndex % enabledItems.length]`
3) применяется `updatePriceCarousel()` для обновления DOM

#### Как извлекается “цена” из текста
Функция `extractPrice(text)` ищет число и валютный суффикс в тексте:
- поддерживается `150₽`, `150 руб`, `300 рублей`, `150 р.` и `150 р`

Если цена найдена:
- сверху показывается “текст без цены” (`extractTextWithoutPrice`)
- снизу показывается `"{price}₽"`

Если цена не найдена:
- показывается только крупный текст (режим `text-only`)
- `priceCarouselValue` скрывается

#### Тайминг
Интервал переключения:
- `intervalMs = priceCarouselInterval * 1000` (в мс)

Карусель запускается, если:
- `enabledItems.length > 0` (для одного элемента можно не крутить; в коде крутится только если `> 1`)

### 4.7 Особая логика: поведение при пустой очереди (важно)

Требование: “пока очередь пуста — всегда показывать первый вариант по счету текста в первой строке”.

Реализация в `widget-tank-queue.html`:
- когда `tanks.length === 0`:
  - карусель **останавливается** (`stopPriceCarousel()`)
  - `currentCarouselIndex = 0`
  - вызывается `updatePriceCarousel()` — в результате всегда показывается `enabledItems[0]` (1-й включенный текст)

Анти-лаг/анти-дерганье:
- виджет не вызывает `updatePriceCarousel()` на каждом опросе в пустом состоянии
- используются:
  - `lastQueueEmptyState` (переходы пусто/не пусто)
  - `lastPriceCarouselSignature` (отпечаток JSON массива `priceCarousel`)

### 4.8 Уведомление при добавлении танка
При добавлении нового танка (и если прошло < 5 секунд):
- текущий интервал карусели останавливается
- карусель переходит в класс `notification`
- сверху ставится “Добавлен в очередь”
- снизу показывается имя танка
- через 3 секунды notification снимается и:
  - если карусель была запущена раньше — она возвращается к вращению
  - иначе просто обновляет текущий элемент

---

## 5) Замечания и потенциальные граничные случаи

1) Индексы `currentTankIndex`:
   - `currentTankIndex` приходит с сервера как индекс в `tanks`, но сам виджет затем сортирует `tanks` на клиенте (`sortTanks()` в `renderQueue()`).
   - Поэтому “текущий танк” может интерпретироваться иначе после сортировки (сейчас так устроено в коде).
   - Если нужно жестко “текущий по конкретному танку”, можно будет перейти с индекса на стабильный id (в текущем коде id может отсутствовать).

2) Если `priceCarousel` пуст или в нем нет enabled элементов:
   - карусель переводится в состояние “скрыть значения” (в коде `priceCarouselValue.style.display = 'none'`).

3) Важно: OBS обычно должен использовать именно `widget-tank-queue.html` для карусели, потому что упрощенный `widget-tank-queue-obs.html` может не содержать этой логики.

---

## 6) Где именно это лежит в репозитории

- Backend:
  - `server.js`:
    - `GET /api/tank-queue`
    - `POST /api/tank-queue/save`
    - создание таблиц `tank_queue` / `tank_queue_settings`

- Виджет для OBS с каруселью:
  - `public/widget-tank-queue.html`

- Конфиг-страница для стримера:
  - `public/tank-queue.html`

- Упрощенный вариант виджета (для сравнения/старого режима):
  - `public/widget-tank-queue-obs.html`

