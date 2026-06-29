@echo off
chcp 65001 > nul
title Frag Tracker - Запуск
echo ===============================================
echo    ФРАГ-ТРЕКЕР - ЗАПУСК СЕРВЕРА
echo ===============================================
echo.

echo 📦 Проверка Node.js...
node --version > nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js не установлен!
    echo 📥 Скачайте с: https://nodejs.org/
    pause
    exit
)

echo ✅ Node.js обнаружен
echo.

echo 🔄 Обновление полей Lesta Games v2...
call node update-lesta-fields-v2.js
if errorlevel 1 (
    echo ❌ Ошибка обновления полей Lesta Games v2!
    pause
    exit
)

echo ✅ Поля Lesta Games v2 обновлены
echo.

echo 🔄 Обновление полей DonatePay Widget...
call node update-donatepay-widget.js
if errorlevel 1 (
    echo ❌ Ошибка обновления полей DonatePay Widget!
    pause
    exit
)

echo ✅ Поля DonatePay Widget обновлены
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
echo 💰 Тест DonatePay API: http://localhost:3000/donatepay-test
echo 🔗 DonatePay Webhook: http://localhost:3000/webhook/donatepay
echo 📊 Аналитика: http://localhost:3000/analytics
echo ===============================================
echo.

node server.js
pause
