# 🔍 Руководство по диагностике DonationAlerts

## ❌ Проблема
Донаты с DonationAlerts не отображаются, несмотря на наличие API ключей и ссылок на виджет.

## 🔍 Диагностика

### 1. Проверка через браузер
Откройте в браузере: http://localhost:3000/donation-alerts-test.html

### 2. Проверка статуса системы
Откройте: http://localhost:3000/api/status

### 3. Проверка OAuth авторизации
Откройте: http://localhost:3000/api/da-oauth-test

### 4. Проверка API донатов
Откройте: http://localhost:3000/api/da-api-test

### 5. Диагностика донатов
Откройте: http://localhost:3000/api/debug-donations

## 🔧 Возможные проблемы и решения

### Проблема 1: Нет токена доступа
**Симптомы:**
- В статусе системы показывается "DonationAlerts Не подключен"
- API тест возвращает ошибку "Access token не настроен"

**Решение:**
1. Откройте http://localhost:3000/admin
2. Нажмите "🔗 АВТОРИЗАЦИЯ DONATIONALERTS"
3. Выполните OAuth авторизацию
4. Скопируйте код из URL после перенаправления
5. Введите код в админ-панели

### Проблема 2: Токен устарел
**Симптомы:**
- API возвращает ошибку 401 Unauthorized
- В логах сервера: "Токен устарел, требуется повторная авторизация"

**Решение:**
1. Выполните повторную OAuth авторизацию
2. Получите новый токен доступа

### Проблема 3: Неправильные права доступа
**Симптомы:**
- API возвращает ошибку 403 Forbidden
- Профиль пользователя не получается

**Решение:**
1. Проверьте scope в OAuth авторизации
2. Убедитесь, что используется scope: `oauth-donation-index`

### Проблема 4: Проблемы с виджетом
**Симптомы:**
- Виджет не загружается
- Ошибка при тестировании виджета

**Решение:**
1. Проверьте правильность токена виджета
2. Убедитесь, что токен виджета совпадает с access token
3. Проверьте URL виджета

## 🚀 Пошаговая диагностика

### Шаг 1: Проверка конфигурации
```bash
# Проверьте переменные окружения
echo $DA_CLIENT_ID
echo $DA_CLIENT_SECRET
echo $DA_REDIRECT_URI
```

### Шаг 2: Проверка токена в БД
```sql
SELECT da_access_token FROM app_state WHERE id = 1;
```

### Шаг 3: Тест API вручную
```bash
curl -X GET "https://www.donationalerts.com/api/v1/user/oauth" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Шаг 4: Тест получения донатов
```bash
curl -X GET "https://www.donationalerts.com/api/v1/alerts/donations" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

## 📊 Структура ответа API

### Успешный ответ профиля:
```json
{
  "data": {
    "id": 12345,
    "username": "your_username",
    "email": "your_email@example.com"
  }
}
```

### Успешный ответ донатов:
```json
{
  "data": [
    {
      "id": 30530030,
      "name": "donation",
      "username": "Ivan",
      "message": "Hello!",
      "amount": 500,
      "currency": "RUB",
      "is_shown": 1,
      "created_at": "2019-09-29 09:00:00",
      "shown_at": null
    }
  ],
  "meta": {
    "current_page": 1,
    "total": 1
  }
}
```

## 🔧 Исправление проблем

### 1. Перезапуск сервера
```bash
# Остановить сервер
taskkill /F /IM node.exe

# Запустить сервер
node server.js
```

### 2. Очистка токена
```sql
UPDATE app_state SET da_access_token = NULL WHERE id = 1;
```

### 3. Повторная авторизация
1. Откройте http://localhost:3000/admin
2. Нажмите "🔗 АВТОРИЗАЦИЯ DONATIONALERTS"
3. Выполните авторизацию заново

## 📋 Чек-лист диагностики

- [ ] Сервер запущен и доступен
- [ ] Переменные окружения настроены
- [ ] OAuth авторизация выполнена
- [ ] Токен доступа получен и сохранен
- [ ] API профиля работает
- [ ] API донатов работает
- [ ] Виджет загружается
- [ ] Донаты отображаются в системе

## 🎯 Ожидаемый результат

После исправления:
- ✅ Статус системы показывает "DonationAlerts Подключен"
- ✅ API тесты проходят успешно
- ✅ Донаты получаются и отображаются
- ✅ Виджет работает корректно
- ✅ Система отслеживает новые донаты

## 🚀 Дополнительные ресурсы

- [Документация DonationAlerts API](https://www.donationalerts.com/api/v1)
- [OAuth 2.0 спецификация](https://tools.ietf.org/html/rfc6749)
- [Тестовая страница](http://localhost:3000/donation-alerts-test.html)
- [Админ-панель](http://localhost:3000/admin)

