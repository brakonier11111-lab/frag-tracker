@echo off
chcp 65001 >nul
title Frag-tracker Server - Главное меню

:menu
cls
echo.
echo ========================================
echo    FRAG-TRACKER SERVER - ГЛАВНОЕ МЕНЮ
echo ========================================
echo.
echo Выберите действие:
echo.
echo [1] 🚀 Полный запуск сервера (установка + БД + запуск)
echo [2] ⚡ Быстрый запуск сервера (только запуск)
echo [3] 🛑 Остановить сервер
echo [4] 📦 Обновить зависимости
echo [5] 🗑️ Сбросить базу данных
echo [6] 🔍 Проверить состояние
echo [7] 📱 Открыть веб-интерфейс
echo [8] 🖥️ Desktop-приложение (Electron)
echo [0] ❌ Выход
echo.
set /p choice="Введите номер (0-8): "

if "%choice%"=="1" goto full_start
if "%choice%"=="2" goto quick_start
if "%choice%"=="3" goto stop_server
if "%choice%"=="4" goto update_deps
if "%choice%"=="5" goto reset_db
if "%choice%"=="6" goto check_status
if "%choice%"=="7" goto open_web
if "%choice%"=="8" goto desktop_app
if "%choice%"=="0" goto exit
goto menu

:full_start
echo.
echo 🚀 Запуск полной инициализации...
call start-server-complete.bat
goto menu

:quick_start
echo.
echo ⚡ Быстрый запуск сервера...
call start-server-quick.bat
goto menu

:stop_server
echo.
echo 🛑 Остановка сервера...
call stop-server.bat
goto menu

:update_deps
echo.
echo 📦 Обновление зависимостей...
call update-dependencies.bat
goto menu

:reset_db
echo.
echo 🗑️ Сброс базы данных...
call reset-database.bat
goto menu

:check_status
echo.
echo 🔍 Проверка состояния...
echo.
echo Проверка Node.js...
node --version >nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ Node.js установлен
    node --version
) else (
    echo ❌ Node.js не найден
)

echo.
echo Проверка зависимостей...
if exist "node_modules" (
    echo ✅ Зависимости установлены
) else (
    echo ❌ Зависимости не установлены
)

echo.
echo Проверка базы данных...
if exist "frag_tracker.db" (
    echo ✅ База данных найдена
) else (
    echo ❌ База данных не найдена
)

echo.
echo Проверка процессов Node.js...
tasklist /fi "imagename eq node.exe" 2>nul | find /i "node.exe" >nul
if %errorlevel% equ 0 (
    echo ✅ Сервер запущен
    tasklist /fi "imagename eq node.exe"
) else (
    echo ❌ Сервер не запущен
)

echo.
pause
goto menu

:open_web
echo.
echo 📱 Открытие веб-интерфейса...
echo.
echo Проверка доступности сервера...
curl -s http://localhost:3000 >nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ Сервер доступен
    echo 🌐 Открываем веб-интерфейс...
    start http://localhost:3000
) else (
    echo ❌ Сервер недоступен
    echo 🚀 Запустите сервер сначала
)
echo.
pause
goto menu

:desktop_app
echo.
echo 🖥️ Запуск Desktop-приложения...
call start-desktop.bat
goto menu

:exit
echo.
echo 👋 До свидания!
echo.
pause
exit /b 0








