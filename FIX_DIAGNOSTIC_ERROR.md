# 🔧 Исправление ошибки диагностики

## 🐛 Проблема
Ошибка: `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`

Это означает, что сервер возвращает HTML страницу вместо JSON ответа.

## ✅ Решение

### 1. Перезапуск сервера
```bash
# Остановить сервер
taskkill /F /IM node20.exe

# Запустить сервер заново
cd "C:\Users\ixacy\Downloads\TTTEST — копия"
node server.js
```

### 2. Проверка через браузер
1. Откройте http://localhost:3000/admin
2. Нажмите "🔍 ДИАГНОСТИКА СТАТИСТИКИ ФРАГОВ"
3. Если ошибка сохраняется, перезапустите сервер

### 3. Альтернативный способ
Используйте тестовую страницу:
1. Откройте http://localhost:3000/test-diagnose-api.html
2. Нажмите "🧪 Тестировать API диагностики"
3. Проверьте результат

### 4. Ручная проверка API
Откройте в браузере:
- http://localhost:3000/api/frag-stats/diagnose
- http://localhost:3000/api/status
- http://localhost:3000/api/frag-stats?period=day

## 🔍 Диагностика

### Проверка статуса сервера
```bash
# Проверить, запущен ли сервер
tasklist | findstr node

# Проверить порт 3000
netstat -an | findstr :3000
```

### Проверка логов сервера
Если сервер не запускается, проверьте:
1. Есть ли ошибки в консоли
2. Корректно ли настроены зависимости
3. Доступна ли база данных

## 🚀 Быстрое решение

### Способ 1: Bat-файл
```bash
start-server-complete.bat
```

### Способ 2: Ручной запуск
```bash
cd "C:\Users\ixacy\Downloads\TTTEST — копия"
npm install
node server.js
```

### Способ 3: Через PowerShell
```powershell
cd "C:\Users\ixacy\Downloads\TTTEST — копия"
Start-Process -FilePath "node" -ArgumentList "server.js" -WindowStyle Hidden
```

## 📋 Проверочный список

- [ ] Сервер запущен на порту 3000
- [ ] Нет ошибок в консоли сервера
- [ ] База данных доступна
- [ ] Все зависимости установлены
- [ ] API эндпоинты работают

## 🆘 Если проблема не решается

1. **Полная переустановка**:
   ```bash
   # Удалить node_modules
   rmdir /s node_modules
   
   # Переустановить зависимости
   npm install
   
   # Запустить сервер
   node server.js
   ```

2. **Проверка версии Node.js**:
   ```bash
   node --version
   npm --version
   ```

3. **Очистка кэша**:
   ```bash
   npm cache clean --force
   ```

## 📞 Поддержка

Если проблема не решается:
1. Сохраните полный лог ошибок
2. Проверьте версию Node.js (должна быть 18+)
3. Убедитесь, что порт 3000 свободен
4. Обратитесь к разработчику с подробным описанием

