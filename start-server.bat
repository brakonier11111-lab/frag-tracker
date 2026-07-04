@echo off
chcp 65001 >nul
title Frag-tracker Server - Единый запуск

echo.
echo ========================================
echo    FRAG-TRACKER SERVER - ЕДИНЫЙ ЗАПУСК
echo ========================================
echo.

:: Проверяем наличие Node.js
echo [1/6] Проверка Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js не найден! Установите Node.js с https://nodejs.org/
    echo.
    echo 📥 Скачать Node.js: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo ✅ Node.js найден: %NODE_VERSION%

:: Проверяем наличие package.json
echo.
echo [2/6] Проверка package.json...
if not exist "package.json" (
    echo ❌ package.json не найден!
    echo 📁 Убедитесь, что вы находитесь в папке проекта
    pause
    exit /b 1
)
echo ✅ package.json найден

:: Останавливаем существующие процессы
echo.
echo [3/6] Остановка существующих процессов...
taskkill /f /im node.exe >nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ Существующие процессы Node.js остановлены
) else (
    echo ⚠️ Процессы Node.js не найдены
)

:: Устанавливаем зависимости
echo.
echo [4/6] Установка зависимостей...
echo 📦 Устанавливаем npm пакеты...
call npm install
if %errorlevel% neq 0 (
    echo ❌ Ошибка установки зависимостей!
    echo 🔧 Попробуйте запустить от имени администратора
    pause
    exit /b 1
)
echo ✅ Зависимости установлены

:: Инициализируем базу данных
echo.
echo [5/6] Инициализация базы данных...
echo 🗄️ Создаем/обновляем базу данных...

:: Инициализация БД по общему пути (%LOCALAPPDATA%\FragTracker, см. src/bootstrap/paths.js)
call node init-db.js
if %errorlevel% neq 0 (
    echo ❌ Ошибка инициализации базы данных!
    pause
    exit /b 1
)

echo ✅ База данных инициализирована

:: Запускаем сервер
echo.
echo [6/6] Запуск сервера...
echo 🚀 Запускаем Frag-tracker Server...
echo.
echo ========================================
echo    СЕРВЕР ЗАПУЩЕН УСПЕШНО!
echo ========================================
echo.
echo 📱 Доступные страницы:
echo    • Главная: http://localhost:3000
echo    • Админ панель: http://localhost:3000/admin.html
echo    • Аналитика: http://localhost:3000/donations-analytics.html
echo    • Проверка БД: http://localhost:3000/database-init-check.html
echo    • Тест донатов: http://localhost:3000/test-donations.html
echo.
echo 🛑 Для остановки сервера нажмите Ctrl+C
echo.

:: Запускаем сервер
node server.js

:: Если сервер остановился
echo.
echo ========================================
echo    СЕРВЕР ОСТАНОВЛЕН
echo ========================================
echo.
pause