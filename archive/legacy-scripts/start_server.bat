@echo off
chcp 65001 > nul
title Frag Tracker - Запуск сервера
echo ===============================================
echo    ФРАГ-ТРЕКЕР - ЗАПУСК СЕРВЕРА
echo ===============================================
echo.

echo 📦 Проверка Node.js...
node --version > nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js не установлен!
    echo 📥 Скачайте с: https://nodejs.org/
    echo 🔧 Установите и перезапустите этот файл
    pause
    exit
)

echo ✅ Node.js обнаружен
echo.

echo 📦 Проверка зависимостей...
if not exist node_modules (
    echo 📦 Установка зависимостей...
    call npm install
    if errorlevel 1 (
        echo ❌ Ошибка установки зависимостей!
        pause
        exit
    )
    echo ✅ Зависимости установлены
) else (
    echo ✅ Зависимости уже установлены
)
echo.

echo 🗄️ Инициализация базы данных...
call node init-db.js
if errorlevel 1 (
    echo ❌ Ошибка инициализации базы данных!
    pause
    exit
)

echo ✅ База данных инициализирована
echo.

echo 🔄 Обновление полей Lesta Games...
call node update-lesta-fields.js
if errorlevel 1 (
    echo ❌ Ошибка обновления полей Lesta Games!
    pause
    exit
)

echo ✅ Поля Lesta Games обновлены
echo.

echo 🚀 Запуск сервера...
echo ===============================================
echo ✅ Панель управления: http://localhost:3000
echo ✅ OBS Виджет: http://localhost:3000/widget  
echo ✅ Виджет алертов: http://localhost:3000/alert
echo 🔑 Авторизация DA: http://localhost:3000/auth/donationalerts
echo 🔑 Авторизация Lesta: http://localhost:3000/auth/lesta
echo 🎮 Статистика Lesta: http://localhost:3000/lesta-stats
echo 🧪 Тест Lesta API: http://localhost:3000/lesta-test
echo 🧪 Расширенный тест Lesta API: http://localhost:3000/lesta-api-test
echo 🔗 DonatePay Webhook: http://localhost:3000/webhook/donatepay
echo 📊 Аналитика: http://localhost:3000/analytics
echo ===============================================
echo.

call node server.js
pause
