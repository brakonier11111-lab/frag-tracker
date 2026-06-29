# 🔄 Руководство по миграции на v3.0

## Краткий обзор изменений

Frag Tracker v3.0 представляет полностью переработанную архитектуру с сохранением обратной совместимости.

### Что изменилось

✅ **Модульная архитектура** вместо монолитного `server.js`  
✅ **Система миграций** вместо `ALTER TABLE` в runtime  
✅ **Winston logging** вместо `console.log`  
✅ **Express-validator** для валидации  
✅ **Новые API endpoints** с REST convention  
✅ **4 новые функции**: Rewards, Dashboard, Alert Replay, Widget Builder  

### Что НЕ изменилось

✅ База данных остается SQLite (`frag_tracker.db`)  
✅ Все старые данные сохраняются  
✅ Старый `server.js` продолжает работать  
✅ Виджеты для OBS совместимы  

---

## Шаги миграции

### Шаг 1: Резервное копирование

```bash
# Создайте копию базы данных
copy frag_tracker.db frag_tracker.db.backup

# Или на Linux/Mac
cp frag_tracker.db frag_tracker.db.backup
```

### Шаг 2: Установите новые зависимости

```bash
npm install express-validator winston express-rate-limit
```

Или замените `package.json` на `package-new.json`:

```bash
del package.json
rename package-new.json package.json
npm install
```

### Шаг 3: Выполните миграции

```bash
node src/cli/init-database.js
```

Это создаст новые таблицы:
- `migrations` - отслеживание миграций
- `rewards` - система наград
- `reward_triggers` - история срабатываний
- `alert_queue` - очередь алертов
- `alert_playback_history` - история воспроизведения
- `widget_configs` - конфигурации виджетов
- `widget_elements` - элементы виджетов
- `widget_themes` - темы виджетов

**Важно:** Старые таблицы (`app_state`, `donations`, `frag_stats`) не изменятся!

### Шаг 4: Протестируйте новый сервер

```bash
node server-new.js
```

Откройте http://localhost:3000/healthz - должны увидеть:

```json
{
  "success": true,
  "status": "ok",
  "version": "3.0.0",
  "services": {
    "database": true
  }
}
```

### Шаг 5: Проверьте новые страницы

- http://localhost:3000/dashboard - Dashboard с графиками
- http://localhost:3000/rewards - Управление наградами
- http://localhost:3000/alert-replay - Replay алертов
- http://localhost:3000/widget-builder - Конструктор виджетов

### Шаг 6: Обновите OBS (опционально)

Виджеты работают без изменений, но можно обновить URL:

**Старые URL (работают):**
- http://localhost:3000/widget/mode1
- http://localhost:3000/widget/mode2
- http://localhost:3000/widget/mode3

**Новые URL (те же):**
- Остались без изменений

---

## Откат миграции

Если что-то пошло не так:

### Вариант 1: Откат через миграции

```bash
node src/cli/migrate.js rollback
```

Это откатит последнюю миграцию.

### Вариант 2: Восстановление из бэкапа

```bash
# Остановите сервер
taskkill /F /IM node.exe

# Восстановите базу данных
copy frag_tracker.db.backup frag_tracker.db /Y

# Запустите старый сервер
node server.js
```

### Вариант 3: Удаление новых таблиц

```sql
-- Подключитесь к БД через sqlite3
sqlite3 frag_tracker.db

-- Удалите новые таблицы
DROP TABLE IF EXISTS migrations;
DROP TABLE IF EXISTS rewards;
DROP TABLE IF EXISTS reward_triggers;
DROP TABLE IF EXISTS alert_queue;
DROP TABLE IF EXISTS alert_playback_history;
DROP TABLE IF EXISTS widget_configs;
DROP TABLE IF EXISTS widget_elements;
DROP TABLE IF EXISTS widget_themes;

.quit
```

---

## Параллельная работа старого и нового сервера

Можно запустить оба сервера одновременно на разных портах:

### server.js (старый)
```bash
# Запускается на порту 3000
node server.js
```

### server-new.js (новый)
```javascript
// Измените порт в config.env
PORT=3001
```

```bash
node server-new.js
```

Теперь:
- Старый API: http://localhost:3000
- Новый API: http://localhost:3001

---

## Сравнение API (старый vs новый)

### Получение донатов

**Старый способ:**
```javascript
// Нет стандартного API endpoint
// Использовалось прямое обращение к БД
```

**Новый способ:**
```http
GET /api/donations?limit=50&offset=0
GET /api/donations/recent?limit=10
GET /api/donations/stats?period=7d
GET /api/donations/top-donors?limit=10
```

### Создание ручного доната

**Старый способ:**
```http
POST /api/manual-donation
{
  "username": "User",
  "amount": 100,
  "message": "Message"
}
```

**Новый способ:**
```http
POST /api/donations/manual
{
  "username": "User",
  "amount": 100,
  "message": "Message"
}
```

### Получение состояния приложения

**Старый способ:**
```http
GET /api/state
```

**Новый способ:**
```http
GET /api/state
# Совместимо! Работает в обоих версиях
```

---

## Обновление кода интеграций

Если у вас есть внешние интеграции, обновите URL:

### DonationAlerts webhook

Без изменений - работает как раньше.

### Кастомные скрипты

**Было:**
```javascript
fetch('http://localhost:3000/api/manual-donation', { ... })
```

**Стало:**
```javascript
fetch('http://localhost:3000/api/donations/manual', { ... })
```

---

## Часто задаваемые вопросы (FAQ)

### 1. Можно ли не мигрировать?

Да! Старый `server.js` продолжит работать. Новые функции (Rewards, Dashboard, etc.) будут недоступны.

### 2. Потеряются ли мои данные?

Нет! Миграции только добавляют новые таблицы. Старые данные не изменяются.

### 3. Работают ли старые виджеты OBS?

Да! Виджеты полностью совместимы.

### 4. Как обновить только часть функционала?

Используйте параллельную работу серверов (см. выше).

### 5. Что делать если миграция зависла?

```bash
# Остановите процесс
Ctrl+C

# Удалите таблицу миграций
sqlite3 frag_tracker.db "DROP TABLE migrations;"

# Попробуйте снова
node src/cli/init-database.js
```

### 6. Как проверить версию БД?

```bash
sqlite3 frag_tracker.db "SELECT * FROM migrations;"
```

### 7. Сколько времени займет миграция?

1-2 минуты для выполнения миграций + время на тестирование.

### 8. Можно ли вернуться к старой версии?

Да! Просто запустите `node server.js` вместо `node server-new.js`.

---

## Контрольный чеклист миграции

- [ ] Создан бэкап базы данных
- [ ] Установлены новые зависимости
- [ ] Выполнены миграции БД
- [ ] Протестирован health check
- [ ] Проверены новые страницы (dashboard, rewards, etc.)
- [ ] Проверены старые виджеты OBS
- [ ] Обновлены интеграции (если есть)
- [ ] Обновлен файл запуска (bat/ps1)

---

## Рекомендации после миграции

### 1. Обновите скрипты запуска

**start-server.bat:**
```batch
@echo off
echo Starting Frag Tracker v3.0...
node server-new.js
```

### 2. Настройте логирование

Логи теперь сохраняются в `logs/`:
- Проверяйте `error.log` при проблемах
- `donations.log` для отладки донатов

### 3. Создайте первую награду

1. Откройте http://localhost:3000/rewards
2. Нажмите "Создать награду"
3. Настройте триггер и действие
4. Протестируйте через кнопку "Тест"

### 4. Изучите Dashboard

1. Откройте http://localhost:3000/dashboard
2. Переключайте периоды (24ч, 7д, 30д)
3. Изучите графики и статистику

---

## Получение поддержки

Если возникли проблемы:

1. **Проверьте логи:**
   ```bash
   type logs\error.log
   ```

2. **Проверьте состояние БД:**
   ```bash
   sqlite3 frag_tracker.db "SELECT COUNT(*) FROM donations;"
   ```

3. **Перезапустите сервер:**
   ```bash
   taskkill /F /IM node.exe
   node server-new.js
   ```

4. **Откатитесь к бэкапу** (см. раздел "Откат миграции")

---

**Удачной миграции! 🚀**







