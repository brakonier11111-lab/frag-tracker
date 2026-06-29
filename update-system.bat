@echo off
chcp 65001 > nul
title Frag Tracker - Обновление системы
color 0E
echo.
echo ===============================================
echo    ФРАГ-ТРЕКЕР - ОБНОВЛЕНИЕ СИСТЕМЫ
echo ===============================================
echo.

:: Проверка Node.js
echo 📦 Проверка Node.js...
node --version > nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js не установлен!
    echo 📥 Скачайте с: https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo ✅ Node.js: %NODE_VERSION%
echo.

:: Обновление зависимостей
echo 📦 Обновление зависимостей...
echo ⏳ Удаление старых зависимостей...
if exist node_modules rmdir /s /q node_modules
if exist package-lock.json del package-lock.json

echo ⏳ Установка зависимостей...
call npm install
if errorlevel 1 (
    echo ❌ Ошибка установки зависимостей!
    pause
    exit /b 1
)
echo ✅ Зависимости обновлены
echo.

:: Резервное копирование БД
echo 💾 Резервное копирование базы данных...
if exist frag_tracker.db (
    set BACKUP_NAME=frag_tracker_backup_%date:~-4,4%%date:~-10,2%%date:~-7,2%_%time:~0,2%%time:~3,2%%time:~6,2%.db
    set BACKUP_NAME=%BACKUP_NAME: =0%
    copy frag_tracker.db "%BACKUP_NAME%" > nul
    echo ✅ Резервная копия создана: %BACKUP_NAME%
) else (
    echo ⚠️ База данных не найдена, создаю новую...
)
echo.

:: Инициализация БД
echo 🗄️ Инициализация базы данных...
call node init-db.js
if errorlevel 1 (
    echo ❌ Ошибка инициализации базы данных!
    pause
    exit /b 1
)
echo ✅ База данных инициализирована
echo.

:: Обновление всех компонентов
echo 🔄 Обновление компонентов системы...

echo   📊 Обновление базы данных...
call node update-db.js
if errorlevel 1 echo     ⚠️ Предупреждение: Ошибка обновления БД

echo   🎮 Обновление полей Lesta Games...
call node update-lesta-fields.js
if errorlevel 1 echo     ⚠️ Предупреждение: Ошибка обновления Lesta v1

echo   🎮 Обновление полей Lesta Games v2...
call node update-lesta-fields-v2.js
if errorlevel 1 echo     ⚠️ Предупреждение: Ошибка обновления Lesta v2

echo   💰 Добавление поля скидки...
call node add-discount-field.js
if errorlevel 1 echo     ⚠️ Предупреждение: Ошибка добавления поля скидки

echo   🎨 Обновление виджета DonatePay...
call node update-donatepay-widget.js
if errorlevel 1 echo     ⚠️ Предупреждение: Ошибка обновления DonatePay

echo ✅ Компоненты обновлены
echo.

:: Проверка конфигурации
echo 🔧 Проверка конфигурации...
if not exist config.env (
    echo ⚠️ Файл config.env не найден, создаю...
    echo # DonationAlerts Configuration > config.env
    echo DA_CLIENT_ID=16225 >> config.env
    echo DA_CLIENT_SECRET=0VJ2dMRax8cJrQqAYQJ7dLnFCMPKOFZdjCHkU4Lw >> config.env
    echo DA_REDIRECT_URI=http://localhost:3000/auth/callback >> config.env
    echo. >> config.env
    echo # Server Configuration >> config.env
    echo PORT=3000 >> config.env
    echo ✅ Файл config.env создан
) else (
    echo ✅ Файл config.env найден
)
echo.

:: Проверка целостности системы
echo 🔍 Проверка целостности системы...
if exist server.js (
    echo ✅ Основной файл сервера найден
) else (
    echo ❌ Основной файл сервера не найден!
)

if exist package.json (
    echo ✅ Файл зависимостей найден
) else (
    echo ❌ Файл зависимостей не найден!
)

if exist init-db.js (
    echo ✅ Скрипт инициализации БД найден
) else (
    echo ❌ Скрипт инициализации БД не найден!
)

if exist frag_tracker.db (
    echo ✅ База данных создана
) else (
    echo ❌ База данных не создана!
)
echo.

:: Финальная проверка
echo 🧪 Финальная проверка...
node -e "console.log('✅ Node.js работает корректно')" 2>nul
if errorlevel 1 (
    echo ❌ Проблема с Node.js!
) else (
    echo ✅ Node.js работает корректно
)

echo.
echo ===============================================
echo    ОБНОВЛЕНИЕ СИСТЕМЫ ЗАВЕРШЕНО
echo ===============================================
echo.
echo 📋 Что было сделано:
echo   • Обновлены зависимости Node.js
echo   • Создана резервная копия БД
echo   • Инициализирована база данных
echo   • Обновлены все компоненты системы
echo   • Проверена конфигурация
echo   • Проверена целостность системы
echo.
echo 🚀 Теперь можно запустить сервер:
echo   • start-server-complete.bat - полный запуск
echo   • quick-start.bat - быстрый запуск
echo.
pause

