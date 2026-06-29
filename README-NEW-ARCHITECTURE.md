# 🚀 Frag Tracker v3.0 - Новая архитектура

## ✨ Что нового?

### 🏗️ **Рефакторинг архитектуры**
- ✅ Модульная структура: `routes`, `services`, `controllers`, `models`
- ✅ Разделение ответственности (separation of concerns)
- ✅ Чистая архитектура с DI (Dependency Injection)
- ✅ Улучшенная поддерживаемость кода

### 🛡️ **Безопасность и валидация**
- ✅ Централизованная обработка ошибок
- ✅ Валидация запросов через `express-validator`
- ✅ Rate limiting для API
- ✅ Helmet для безопасности headers
- ✅ Кастомные классы ошибок (AppError, ValidationError, etc.)

### 📊 **Система миграций БД**
- ✅ Версионирование схемы базы данных
- ✅ Откат миграций (rollback)
- ✅ CLI утилиты для управления миграциями
- ✅ Убраны все ALTER TABLE из runtime кода

### 📝 **Структурированное логирование**
- ✅ Winston logger с разными уровнями
- ✅ Логи в файлы (error.log, combined.log, donations.log)
- ✅ Цветной вывод в консоль
- ✅ Специализированные логгеры (logger.donation, logger.api, etc.)

### 🎁 **Система наград**
- ✅ Автоматические действия при достижении целей
- ✅ Типы триггеров: сумма доната, цель донатов, фраги, таймер
- ✅ Типы действий: алерт, webhook, звук, сообщение в чат
- ✅ Управление через веб-интерфейс
- ✅ История срабатываний

### 📈 **Dashboard с графиками**
- ✅ Аналитика в реальном времени
- ✅ Chart.js для визуализации
- ✅ Статистика по периодам (24ч, 7д, 30д, всё время)
- ✅ Топ донатеры, распределение по суммам
- ✅ Активность по часам

### 🎬 **Replay донатов**
- ✅ Очередь алертов для повтора
- ✅ Приоритизация алертов
- ✅ История воспроизведения
- ✅ Пропуск/завершение алертов
- ✅ Управление через веб-интерфейс

### 🎨 **Конструктор виджетов**
- ✅ Drag-and-drop редактор
- ✅ Шаблоны виджетов
- ✅ Кастомные элементы (текст, прогресс-бар, таймер, изображения)
- ✅ Сохранение конфигураций
- ✅ Генерация HTML/CSS кода

---

## 📁 Структура проекта

```
frag-tracker/
├── src/                          # Исходный код новой архитектуры
│   ├── config/                   # Конфигурация приложения
│   │   └── index.js              # Центральный конфиг
│   ├── database/                 # Работа с БД
│   │   ├── index.js              # Database wrapper с Promise API
│   │   ├── migrations.js         # Менеджер миграций
│   │   └── migrations/           # Файлы миграций
│   │       ├── 001_initial_schema.js
│   │       ├── 002_rewards_system.js
│   │       ├── 003_donation_replay.js
│   │       └── 004_widget_builder.js
│   ├── models/                   # Модели данных
│   │   ├── AppState.js           # Состояние приложения
│   │   ├── Donation.js           # Донаты
│   │   ├── Reward.js             # Награды
│   │   ├── AlertQueue.js         # Очередь алертов
│   │   └── WidgetConfig.js       # Конфигурации виджетов
│   ├── services/                 # Бизнес-логика
│   │   ├── DonationService.js    # Обработка донатов
│   │   ├── RewardService.js      # Управление наградами
│   │   ├── AlertQueueService.js  # Управление очередью
│   │   └── WidgetService.js      # Управление виджетами
│   ├── controllers/              # HTTP контроллеры
│   │   ├── DonationController.js
│   │   ├── RewardController.js
│   │   ├── AlertController.js
│   │   └── WidgetController.js
│   ├── routes/                   # API маршруты
│   │   ├── donations.js
│   │   ├── rewards.js
│   │   ├── alerts.js
│   │   ├── widgets.js
│   │   └── index.js
│   ├── middleware/               # Express middleware
│   │   ├── errorHandler.js       # Обработка ошибок
│   │   └── validator.js          # Валидация запросов
│   ├── utils/                    # Утилиты
│   │   ├── logger.js             # Winston logger
│   │   └── AppError.js           # Кастомные ошибки
│   └── cli/                      # CLI утилиты
│       ├── migrate.js            # Управление миграциями
│       └── init-database.js      # Инициализация БД
├── public/                       # Фронтенд
│   ├── dashboard-new.html        # 📈 Dashboard с графиками
│   ├── rewards-manager.html      # 🎁 Управление наградами
│   ├── alert-replay.html         # 🎬 Replay алертов
│   ├── widget-builder.html       # 🎨 Конструктор виджетов
│   └── ... (старые страницы)
├── logs/                         # Логи (создается автоматически)
│   ├── error.log
│   ├── combined.log
│   └── donations.log
├── server-new.js                 # ⭐ Новый точка входа
├── server.js                     # Старый сервер (для совместимости)
├── package-new.json              # Новые зависимости
├── config.env                    # Переменные окружения
└── frag_tracker.db              # База данных SQLite
```

---

## 🚀 Быстрый старт

### 1. Установка зависимостей

```bash
# Установите новые зависимости
npm install express-validator winston express-rate-limit
```

Или используйте `package-new.json`:

```bash
npm install --package-lock-only
```

### 2. Инициализация базы данных

```bash
# Выполните миграции
node src/cli/init-database.js

# Или через npm скрипт (если добавлен в package.json)
npm run migrate
```

### 3. Запуск нового сервера

```bash
# Запуск с новой архитектурой
node server-new.js

# Или через npm
npm start
```

Сервер запустится на `http://localhost:3000`

---

## 🎯 Доступные страницы

| Страница | URL | Описание |
|----------|-----|----------|
| 🏠 Главная | http://localhost:3000 | Старая главная страница |
| 📊 Dashboard | http://localhost:3000/dashboard | Аналитика с графиками |
| 🎁 Награды | http://localhost:3000/rewards | Управление наградами |
| 🎬 Replay | http://localhost:3000/alert-replay | Повтор алертов |
| 🎨 Конструктор | http://localhost:3000/widget-builder | Создание виджетов |
| 👨‍💼 Админка | http://localhost:3000/admin | Старая админка |

---

## 📡 API Endpoints (новые)

### Donations API

```http
GET    /api/donations              # Получить все донаты
GET    /api/donations/recent       # Последние донаты
GET    /api/donations/stats        # Статистика донатов
GET    /api/donations/top-donors   # Топ донатеры
GET    /api/donations/:id          # Донат по ID
POST   /api/donations/manual       # Создать ручной донат
POST   /api/donations/test         # Тестовый донат
DELETE /api/donations              # Удалить все донаты
```

### Rewards API

```http
GET    /api/rewards                # Все награды
GET    /api/rewards/stats          # Статистика наград
GET    /api/rewards/:id            # Награда по ID
GET    /api/rewards/:id/history    # История срабатываний
POST   /api/rewards                # Создать награду
POST   /api/rewards/:id/test       # Тестировать награду
POST   /api/rewards/:id/toggle     # Включить/выключить
PUT    /api/rewards/:id            # Обновить награду
DELETE /api/rewards/:id            # Удалить награду
```

### Alerts API

```http
GET    /api/alerts/pending         # Pending алерты
GET    /api/alerts/next            # Следующий алерт
GET    /api/alerts/stats           # Статистика очереди
GET    /api/alerts/history         # История воспроизведения
POST   /api/alerts/:id/complete    # Завершить алерт
POST   /api/alerts/:id/skip        # Пропустить алерт
POST   /api/alerts/replay/:donationId  # Повторить донат
DELETE /api/alerts/cleanup         # Очистить старые
```

### Widgets API

```http
GET    /api/widgets                # Все виджеты
GET    /api/widgets/:identifier    # Виджет по ID/slug
GET    /api/widgets/:id/elements   # Элементы виджета
GET    /api/widgets/:id/code       # Генерировать код
POST   /api/widgets                # Создать виджет
POST   /api/widgets/:id/clone      # Клонировать виджет
POST   /api/widgets/:id/elements   # Добавить элемент
POST   /api/widgets/:id/view       # Отметить просмотр
PUT    /api/widgets/:id            # Обновить виджет
DELETE /api/widgets/:id            # Удалить виджет
DELETE /api/widgets/elements/:elementId  # Удалить элемент
```

---

## 🛠️ CLI Команды

### Управление миграциями

```bash
# Выполнить все pending миграции
node src/cli/migrate.js

# Создать новую миграцию
node src/cli/migrate.js create <migration_name>

# Откатить последнюю миграцию
node src/cli/migrate.js rollback
```

### Примеры

```bash
# Создать миграцию для новой таблицы
node src/cli/migrate.js create add_user_roles

# Откатить миграцию
node src/cli/migrate.js rollback
```

---

## 📝 Логирование

Логи сохраняются в директории `logs/`:

- **error.log** - только ошибки
- **combined.log** - все логи
- **donations.log** - специальные логи донатов

### Использование в коде

```javascript
const logger = require('./src/utils/logger');

// Обычные логи
logger.info('Информационное сообщение');
logger.warn('Предупреждение');
logger.error('Ошибка', { error: err.message });

// Специальные логгеры
logger.donation('Донат обработан', { username, amount });
logger.api('API запрос', { method: 'GET', path: '/api/donations' });
logger.database('Запрос к БД выполнен');
logger.websocket('WebSocket сообщение отправлено');
```

---

## 🎁 Система наград - примеры

### Создание награды через API

```javascript
POST /api/rewards
Content-Type: application/json

{
  "name": "Большой донат",
  "description": "Срабатывает при донате >= 1000₽",
  "trigger_type": "donation_amount",
  "trigger_value": 1000,
  "action_type": "alert",
  "action_data": {
    "title": "Огромное спасибо!",
    "message": "Получен большой донат!"
  },
  "repeat_enabled": true,
  "enabled": true
}
```

### Типы триггеров

- `donation_amount` - сумма доната >= значения
- `donation_goal` - достижение цели сбора
- `frag_count` - количество фрагов >= значения
- `timer_expired` - таймер истек
- `custom_goal` - кастомная цель достигнута

### Типы действий

- `alert` - показать алерт
- `webhook` - отправить HTTP запрос
- `sound` - воспроизвести звук
- `chat_message` - сообщение в чат
- `command` - выполнить команду

---

## 🔄 Миграция со старого сервера

### Вариант 1: Постепенная миграция

1. Запустите новый сервер на другом порту:
```javascript
// в src/config/index.js
port: 3001
```

2. Протестируйте новый API

3. Переключите фронтенд на новый API

4. Остановите старый сервер

### Вариант 2: Одновременный запуск

Старый и новый сервер используют одну БД, поэтому можно запустить оба:

```bash
# Терминал 1: Старый сервер
node server.js

# Терминал 2: Новый сервер
node server-new.js
```

---

## ⚡ Производительность

### Оптимизации в новой версии

- ✅ Connection pooling для БД
- ✅ Rate limiting для защиты от DDoS
- ✅ Кэширование частых запросов (можно добавить)
- ✅ Промисы вместо callbacks
- ✅ Async/await для читаемости
- ✅ Транзакции для критичных операций

---

## 🐛 Отладка

### Включение debug логов

```bash
# В config.env
LOG_LEVEL=debug
NODE_ENV=development
```

### Просмотр логов в реальном времени

```bash
# Linux/Mac
tail -f logs/combined.log

# Windows (PowerShell)
Get-Content logs/combined.log -Wait
```

---

## 🔐 Безопасность

### Что реализовано

1. **Helmet** - защита HTTP headers
2. **CORS** - контроль доступа
3. **Rate Limiting** - защита от брутфорса
4. **Валидация** - проверка входных данных
5. **Sanitization** - очистка от XSS
6. **Error Handling** - безопасная обработка ошибок

### Рекомендации

- ❗ Удалите `config.env` из git (уже в `.gitignore`)
- ❗ Используйте переменные окружения для секретов
- ❗ Включите HTTPS в продакшене
- ❗ Регулярно обновляйте зависимости

---

## 📚 Дальнейшее развитие

### Запланировано

- [ ] Unit тесты (Jest)
- [ ] Integration тесты (Supertest)
- [ ] Docker контейнеризация
- [ ] CI/CD pipeline
- [ ] Swagger документация
- [ ] GraphQL API (опционально)
- [ ] Redis для кэширования
- [ ] PostgreSQL вместо SQLite (опционально)

### Как добавить новую фичу

1. Создайте миграцию в `src/database/migrations/`
2. Добавьте модель в `src/models/`
3. Реализуйте сервис в `src/services/`
4. Создайте контроллер в `src/controllers/`
5. Зарегистрируйте маршруты в `src/routes/`
6. Обновите `server-new.js` если нужно

---

## 🤝 Поддержка

Если возникли проблемы:

1. Проверьте логи в `logs/error.log`
2. Убедитесь что миграции выполнены
3. Проверьте `config.env`
4. Перезапустите сервер

---

## 📄 Лицензия

MIT License - используйте как хотите!

---

**Создано с ❤️ для стримеров**







