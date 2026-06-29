@echo off
chcp 65001 > nul
title Frag Tracker - Быстрый запуск
color 0B
echo.
echo ===============================================
echo    ФРАГ-ТРЕКЕР - БЫСТРЫЙ ЗАПУСК
echo ===============================================
echo.

:: Быстрая проверка Node.js
node --version > nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js не установлен!
    echo 📥 Скачайте с: https://nodejs.org/
    pause
    exit /b 1
)

:: Установка зависимостей если нужно
if not exist node_modules (
    echo 📦 Установка зависимостей...
    call npm install
    if errorlevel 1 (
        echo ❌ Ошибка установки зависимостей!
        pause
        exit /b 1
    )
)

:: Инициализация БД если нужно
if not exist frag_tracker.db (
    echo 🗄️ Инициализация базы данных...
    call node init-db.js
)

:: Обновление БД
echo 🔄 Обновление базы данных...
call node update-db.js > nul 2>&1
call node update-lesta-fields.js > nul 2>&1
call node update-lesta-fields-v2.js > nul 2>&1
call node add-discount-field.js > nul 2>&1

:: Запуск сервера
echo 🚀 Запуск сервера...
echo.
echo ✅ Админ-панель: http://localhost:3000/admin
echo 🔑 Авторизация DA: http://localhost:3000/auth/donationalerts
echo.
echo 💡 Для остановки нажмите Ctrl+C
echo.

node server.js
pause

