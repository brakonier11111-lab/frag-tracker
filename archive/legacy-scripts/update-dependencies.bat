@echo off
chcp 65001 >nul
title Frag-tracker Server - Обновление зависимостей

echo.
echo ========================================
echo    FRAG-TRACKER SERVER - ОБНОВЛЕНИЕ
echo ========================================
echo.

:: Проверяем наличие Node.js
echo [1/3] Проверка Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js не найден! Установите Node.js с https://nodejs.org/
    pause
    exit /b 1
)
echo ✅ Node.js найден

:: Проверяем наличие package.json
echo.
echo [2/3] Проверка package.json...
if not exist "package.json" (
    echo ❌ package.json не найден!
    pause
    exit /b 1
)
echo ✅ package.json найден

:: Обновляем зависимости
echo.
echo [3/3] Обновление зависимостей...
echo 📦 Обновляем npm пакеты...

:: Останавливаем сервер если запущен
echo 🛑 Останавливаем сервер...
taskkill /f /im node.exe >nul 2>&1

:: Обновляем зависимости
call npm update
if %errorlevel% neq 0 (
    echo ❌ Ошибка обновления зависимостей!
    pause
    exit /b 1
)

echo ✅ Зависимости обновлены

echo.
echo ========================================
echo    ОБНОВЛЕНИЕ ЗАВЕРШЕНО
echo ========================================
echo.
echo 🚀 Теперь можете запустить сервер:
echo    • start-server-complete.bat - полный запуск
echo    • start-server-quick.bat - быстрый запуск
echo.
pause








