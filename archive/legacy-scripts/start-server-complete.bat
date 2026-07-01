@echo off
chcp 65001 >nul
title Frag-tracker Server - Полный запуск

echo.
echo ========================================
echo    FRAG-TRACKER SERVER - ПОЛНЫЙ ЗАПУСК
echo ========================================
echo.

:: Проверяем наличие Node.js
echo [1/5] Проверка Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js не найден! Установите Node.js с https://nodejs.org/
    pause
    exit /b 1
)
echo ✅ Node.js найден

:: Проверяем наличие package.json
echo.
echo [2/5] Проверка package.json...
if not exist "package.json" (
    echo ❌ package.json не найден!
    pause
    exit /b 1
)
echo ✅ package.json найден

:: Устанавливаем зависимости
echo.
echo [3/5] Установка зависимостей...
echo 📦 Устанавливаем npm пакеты...
call npm install
if %errorlevel% neq 0 (
    echo ❌ Ошибка установки зависимостей!
    pause
    exit /b 1
)
echo ✅ Зависимости установлены

:: Инициализируем базу данных
echo.
echo [4/5] Инициализация базы данных...
echo 🗄️ Создаем/обновляем базу данных...

:: Создаем скрипт инициализации БД
echo const sqlite3 = require('sqlite3').verbose(); > init-temp.js
echo const path = require('path'); >> init-temp.js
echo. >> init-temp.js
echo console.log('🗄️ Инициализация базы данных...'); >> init-temp.js
echo. >> init-temp.js
echo const dbPath = path.join(__dirname, 'frag_tracker.db'); >> init-temp.js
echo const db = new sqlite3.Database(dbPath); >> init-temp.js
echo. >> init-temp.js
echo db.serialize(() => { >> init-temp.js
echo     // Основное состояние >> init-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS app_state ( >> init-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> init-temp.js
echo         current_mode TEXT DEFAULT 'mode1', >> init-temp.js
echo         frag_cost INTEGER DEFAULT 50, >> init-temp.js
echo         frag_amount INTEGER DEFAULT 1, >> init-temp.js
echo         frags_needed INTEGER DEFAULT 10, >> init-temp.js
echo         frags_done INTEGER DEFAULT 0, >> init-temp.js
echo         current_balance INTEGER DEFAULT 0, >> init-temp.js
echo         total_donated INTEGER DEFAULT 0, >> init-temp.js
echo         frag_name TEXT DEFAULT 'фраг', >> init-temp.js
echo         widget_left_label TEXT DEFAULT 'ОСТАЛОСЬ', >> init-temp.js
echo         widget_right_label TEXT DEFAULT 'СДЕЛАНО', >> init-temp.js
echo         widget_progress_label TEXT DEFAULT 'До +1 фрага:', >> init-temp.js
echo         widget_bg_opacity REAL DEFAULT 0.95, >> init-temp.js
echo         widget_cost_font_size REAL DEFAULT 1.4, >> init-temp.js
echo         timer_seconds INTEGER DEFAULT 0, >> init-temp.js
echo         timer_paused BOOLEAN DEFAULT 0, >> init-temp.js
echo         cost_per_minute INTEGER DEFAULT 50, >> init-temp.js
echo         timer_alert_text TEXT DEFAULT 'добавил времени', >> init-temp.js
echo         timer_slowdown_active BOOLEAN DEFAULT 0, >> init-temp.js
echo         timer_slowdown_factor REAL DEFAULT 1.0, >> init-temp.js
echo         timer_slowdown_until_ts INTEGER DEFAULT 0, >> init-temp.js
echo         timer_discount_active BOOLEAN DEFAULT 0, >> init-temp.js
echo         timer_discount REAL DEFAULT 0, >> init-temp.js
echo         temperature_mode_active BOOLEAN DEFAULT 0, >> init-temp.js
echo         temperature_current_amount REAL DEFAULT 0, >> init-temp.js
echo         temperature_target_amount REAL DEFAULT 10000, >> init-temp.js
echo         temperature_cooling_rate REAL DEFAULT 100, >> init-temp.js
echo         temperature_overheated BOOLEAN DEFAULT 0, >> init-temp.js
echo         temperature_peak_reward_minutes INTEGER DEFAULT 5, >> init-temp.js
echo         custom_goal_name TEXT DEFAULT 'единица', >> init-temp.js
echo         custom_units_needed INTEGER DEFAULT 10, >> init-temp.js
echo         custom_units_done INTEGER DEFAULT 0, >> init-temp.js
echo         custom_current_balance INTEGER DEFAULT 0, >> init-temp.js
echo         custom_unit_cost INTEGER DEFAULT 50, >> init-temp.js
echo         custom_unit_amount INTEGER DEFAULT 1, >> init-temp.js
echo         custom_widget_left_label TEXT DEFAULT 'ОСТАЛОСЬ', >> init-temp.js
echo         custom_widget_right_label TEXT DEFAULT 'СДЕЛАНО', >> init-temp.js
echo         custom_alert_text TEXT DEFAULT 'добавил к цели', >> init-temp.js
echo         theme_mode1 TEXT, >> init-temp.js
echo         theme_mode2 TEXT, >> init-temp.js
echo         theme_mode3 TEXT, >> init-temp.js
echo         last_donation_id TEXT, >> init-temp.js
echo         da_access_token TEXT, >> init-temp.js
echo         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-temp.js
echo     )`); >> init-temp.js
echo. >> init-temp.js
echo     // История донатов >> init-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS donations ( >> init-temp.js
echo         id TEXT PRIMARY KEY, >> init-temp.js
echo         username TEXT NOT NULL, >> init-temp.js
echo         amount REAL NOT NULL, >> init-temp.js
echo         message TEXT, >> init-temp.js
echo         currency TEXT DEFAULT 'RUB', >> init-temp.js
echo         is_realtime BOOLEAN DEFAULT 0, >> init-temp.js
echo         frags_earned INTEGER DEFAULT 0, >> init-temp.js
echo         time_earned INTEGER DEFAULT 0, >> init-temp.js
echo         custom_units_earned INTEGER DEFAULT 0, >> init-temp.js
echo         timer_mode TEXT DEFAULT 'normal', >> init-temp.js
echo         timer_seconds INTEGER DEFAULT 0, >> init-temp.js
echo         discount_active BOOLEAN DEFAULT 0, >> init-temp.js
echo         discount_percentage REAL DEFAULT 0, >> init-temp.js
echo         slowdown_active BOOLEAN DEFAULT 0, >> init-temp.js
echo         slowdown_factor REAL DEFAULT 1.0, >> init-temp.js
echo         temperature_active BOOLEAN DEFAULT 0, >> init-temp.js
echo         temperature_amount REAL DEFAULT 0, >> init-temp.js
echo         temperature_target REAL DEFAULT 0, >> init-temp.js
echo         temperature_overheated BOOLEAN DEFAULT 0, >> init-temp.js
echo         temperature_reward_minutes INTEGER DEFAULT 0, >> init-temp.js
echo         normalized_username TEXT DEFAULT '', >> init-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-temp.js
echo     )`); >> init-temp.js
echo. >> init-temp.js
echo     // Статистика фрагов >> init-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS frag_stats ( >> init-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> init-temp.js
echo         battle_time DATETIME NOT NULL, >> init-temp.js
echo         frags INTEGER NOT NULL DEFAULT 0, >> init-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-temp.js
echo     )`); >> init-temp.js
echo. >> init-temp.js
echo     // Цели сбора >> init-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS donation_goals ( >> init-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> init-temp.js
echo         title TEXT NOT NULL DEFAULT 'Сбор на новый контент', >> init-temp.js
echo         description TEXT DEFAULT 'Поддержите создание качественного контента!', >> init-temp.js
echo         target_amount REAL NOT NULL DEFAULT 10000, >> init-temp.js
echo         current_amount REAL NOT NULL DEFAULT 0, >> init-temp.js
echo         total_donations INTEGER NOT NULL DEFAULT 0, >> init-temp.js
echo         avg_donation REAL NOT NULL DEFAULT 0, >> init-temp.js
echo         end_date DATETIME, >> init-temp.js
echo         last_donation_time DATETIME, >> init-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP, >> init-temp.js
echo         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-temp.js
echo     )`); >> init-temp.js
echo. >> init-temp.js
echo     // Донаты к целям >> init-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS goal_donations ( >> init-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> init-temp.js
echo         goal_id INTEGER NOT NULL, >> init-temp.js
echo         amount REAL NOT NULL, >> init-temp.js
echo         username TEXT, >> init-temp.js
echo         message TEXT, >> init-temp.js
echo         is_manual BOOLEAN DEFAULT 0, >> init-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP, >> init-temp.js
echo         FOREIGN KEY (goal_id) REFERENCES donation_goals (id) >> init-temp.js
echo     )`); >> init-temp.js
echo. >> init-temp.js
echo     // Сессии температуры >> init-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS temperature_sessions ( >> init-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> init-temp.js
echo         session_start DATETIME DEFAULT CURRENT_TIMESTAMP, >> init-temp.js
echo         session_end DATETIME, >> init-temp.js
echo         target_amount REAL NOT NULL, >> init-temp.js
echo         total_donated REAL DEFAULT 0, >> init-temp.js
echo         max_temperature REAL DEFAULT 0, >> init-temp.js
echo         overheated BOOLEAN DEFAULT 0, >> init-temp.js
echo         reward_minutes INTEGER DEFAULT 0, >> init-temp.js
echo         cooling_rate REAL DEFAULT 0, >> init-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-temp.js
echo     )`); >> init-temp.js
echo. >> init-temp.js
echo     // Статистика времени таймера >> init-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS timer_time_stats ( >> init-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> init-temp.js
echo         timer_seconds INTEGER NOT NULL, >> init-temp.js
echo         donation_count INTEGER DEFAULT 0, >> init-temp.js
echo         total_amount REAL DEFAULT 0, >> init-temp.js
echo         avg_amount REAL DEFAULT 0, >> init-temp.js
echo         mode TEXT DEFAULT 'normal', >> init-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP, >> init-temp.js
echo         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-temp.js
echo     )`); >> init-temp.js
echo. >> init-temp.js
echo     // Вставляем начальные данные >> init-temp.js
echo     db.run(`INSERT OR IGNORE INTO app_state (id) VALUES (1)`); >> init-temp.js
echo     db.run(`INSERT OR IGNORE INTO donation_goals (id) VALUES (1)`); >> init-temp.js
echo     console.log('✅ База данных инициализирована'); >> init-temp.js
echo }); >> init-temp.js
echo. >> init-temp.js
echo db.close(); >> init-temp.js

:: Запускаем инициализацию БД
call node init-temp.js
if %errorlevel% neq 0 (
    echo ❌ Ошибка инициализации базы данных!
    del init-temp.js
    pause
    exit /b 1
)

:: Удаляем временный файл
del init-temp.js
echo ✅ База данных инициализирована

:: Запускаем сервер
echo.
echo [5/5] Запуск сервера...
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