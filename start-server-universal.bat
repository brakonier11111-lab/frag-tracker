@echo off
title Frag-tracker Server

echo.
echo ========================================
echo    FRAG-TRACKER SERVER - ЕДИНЫЙ ЗАПУСК
echo ========================================
echo.

echo [1/6] Проверка Node.js...
node --version
if %errorlevel% neq 0 (
    echo ОШИБКА: Node.js не найден!
    pause
    exit /b 1
)
echo OK: Node.js найден

echo.
echo [2/6] Проверка package.json...
if not exist "package.json" (
    echo ОШИБКА: package.json не найден!
    pause
    exit /b 1
)
echo OK: package.json найден

echo.
echo [3/6] Остановка существующих процессов...
taskkill /f /im node.exe >nul 2>&1
echo OK: Процессы остановлены

echo.
echo [4/6] Установка зависимостей...
npm install
if %errorlevel% neq 0 (
    echo ОШИБКА: Ошибка установки зависимостей!
    pause
    exit /b 1
)
echo OK: Зависимости установлены

echo.
echo [5/6] Инициализация базы данных...
if exist "init-database.js" (
    node init-database.js
    if %errorlevel% neq 0 (
        echo ОШИБКА: Ошибка инициализации БД!
        pause
        exit /b 1
    )
    echo OK: База данных инициализирована
) else (
    echo ОШИБКА: init-database.js не найден!
    pause
    exit /b 1
)

echo.
echo [6/6] Запуск сервера...
echo.
echo ========================================
echo    СЕРВЕР ЗАПУЩЕН УСПЕШНО!
echo ========================================
echo.
echo Доступные страницы:
echo    • Главная: http://localhost:3000
echo    • Админ панель: http://localhost:3000/admin.html
echo    • Аналитика: http://localhost:3000/donations-analytics.html
echo.
echo Для остановки сервера нажмите Ctrl+C
echo.

node server.js

echo.
echo ========================================
echo    СЕРВЕР ОСТАНОВЛЕН
echo ========================================
echo.
pause








