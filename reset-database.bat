@echo off
chcp 65001 >nul
title Frag-tracker Server - Сброс базы данных

echo.
echo ========================================
echo    FRAG-TRACKER SERVER - СБРОС БД
echo ========================================
echo.

echo ⚠️  ВНИМАНИЕ! Этот скрипт удалит ВСЕ данные!
echo.
set /p confirm="Вы уверены? Введите 'ДА' для подтверждения: "
if not "%confirm%"=="ДА" (
    echo ❌ Операция отменена
    pause
    exit /b 0
)

echo.
echo [1/3] Остановка сервера...
taskkill /f /im node.exe >nul 2>&1
echo ✅ Сервер остановлен

echo.
echo [2/3] Удаление базы данных...
if exist "frag_tracker.db" (
    del "frag_tracker.db"
    echo ✅ База данных удалена
) else (
    echo ⚠️ База данных не найдена
)

echo.
echo [3/3] Создание новой базы данных...

:: Создаем скрипт инициализации БД
echo const sqlite3 = require('sqlite3').verbose(); > reset-temp.js
echo const path = require('path'); >> reset-temp.js
echo. >> reset-temp.js
echo console.log('🗄️ Создание новой базы данных...'); >> reset-temp.js
echo. >> reset-temp.js
echo const dbPath = path.join(__dirname, 'frag_tracker.db'); >> reset-temp.js
echo const db = new sqlite3.Database(dbPath); >> reset-temp.js
echo. >> reset-temp.js
echo db.serialize(() => { >> reset-temp.js
echo     // Основное состояние >> reset-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS app_state ( >> reset-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> reset-temp.js
echo         current_mode TEXT DEFAULT 'mode1', >> reset-temp.js
echo         frag_cost INTEGER DEFAULT 50, >> reset-temp.js
echo         frag_amount INTEGER DEFAULT 1, >> reset-temp.js
echo         frags_needed INTEGER DEFAULT 10, >> reset-temp.js
echo         frags_done INTEGER DEFAULT 0, >> reset-temp.js
echo         current_balance INTEGER DEFAULT 0, >> reset-temp.js
echo         total_donated INTEGER DEFAULT 0, >> reset-temp.js
echo         frag_name TEXT DEFAULT 'фраг', >> reset-temp.js
echo         widget_left_label TEXT DEFAULT 'ОСТАЛОСЬ', >> reset-temp.js
echo         widget_right_label TEXT DEFAULT 'СДЕЛАНО', >> reset-temp.js
echo         widget_progress_label TEXT DEFAULT 'До +1 фрага:', >> reset-temp.js
echo         widget_bg_opacity REAL DEFAULT 0.95, >> reset-temp.js
echo         widget_cost_font_size REAL DEFAULT 1.4, >> reset-temp.js
echo         timer_seconds INTEGER DEFAULT 0, >> reset-temp.js
echo         timer_paused BOOLEAN DEFAULT 0, >> reset-temp.js
echo         cost_per_minute INTEGER DEFAULT 50, >> reset-temp.js
echo         timer_alert_text TEXT DEFAULT 'добавил времени', >> reset-temp.js
echo         timer_slowdown_active BOOLEAN DEFAULT 0, >> reset-temp.js
echo         timer_slowdown_factor REAL DEFAULT 1.0, >> reset-temp.js
echo         timer_slowdown_until_ts INTEGER DEFAULT 0, >> reset-temp.js
echo         timer_discount_active BOOLEAN DEFAULT 0, >> reset-temp.js
echo         timer_discount REAL DEFAULT 0, >> reset-temp.js
echo         temperature_mode_active BOOLEAN DEFAULT 0, >> reset-temp.js
echo         temperature_current_amount REAL DEFAULT 0, >> reset-temp.js
echo         temperature_target_amount REAL DEFAULT 10000, >> reset-temp.js
echo         temperature_cooling_rate REAL DEFAULT 100, >> reset-temp.js
echo         temperature_overheated BOOLEAN DEFAULT 0, >> reset-temp.js
echo         temperature_peak_reward_minutes INTEGER DEFAULT 5, >> reset-temp.js
echo         custom_goal_name TEXT DEFAULT 'единица', >> reset-temp.js
echo         custom_units_needed INTEGER DEFAULT 10, >> reset-temp.js
echo         custom_units_done INTEGER DEFAULT 0, >> reset-temp.js
echo         custom_current_balance INTEGER DEFAULT 0, >> reset-temp.js
echo         custom_unit_cost INTEGER DEFAULT 50, >> reset-temp.js
echo         custom_unit_amount INTEGER DEFAULT 1, >> reset-temp.js
echo         custom_widget_left_label TEXT DEFAULT 'ОСТАЛОСЬ', >> reset-temp.js
echo         custom_widget_right_label TEXT DEFAULT 'СДЕЛАНО', >> reset-temp.js
echo         custom_alert_text TEXT DEFAULT 'добавил к цели', >> reset-temp.js
echo         theme_mode1 TEXT, >> reset-temp.js
echo         theme_mode2 TEXT, >> reset-temp.js
echo         theme_mode3 TEXT, >> reset-temp.js
echo         last_donation_id TEXT, >> reset-temp.js
echo         da_access_token TEXT, >> reset-temp.js
echo         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP >> reset-temp.js
echo     )`); >> reset-temp.js
echo. >> reset-temp.js
echo     // История донатов >> reset-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS donations ( >> reset-temp.js
echo         id TEXT PRIMARY KEY, >> reset-temp.js
echo         username TEXT NOT NULL, >> reset-temp.js
echo         amount REAL NOT NULL, >> reset-temp.js
echo         message TEXT, >> reset-temp.js
echo         currency TEXT DEFAULT 'RUB', >> reset-temp.js
echo         is_realtime BOOLEAN DEFAULT 0, >> reset-temp.js
echo         frags_earned INTEGER DEFAULT 0, >> reset-temp.js
echo         time_earned INTEGER DEFAULT 0, >> reset-temp.js
echo         custom_units_earned INTEGER DEFAULT 0, >> reset-temp.js
echo         timer_mode TEXT DEFAULT 'normal', >> reset-temp.js
echo         timer_seconds INTEGER DEFAULT 0, >> reset-temp.js
echo         discount_active BOOLEAN DEFAULT 0, >> reset-temp.js
echo         discount_percentage REAL DEFAULT 0, >> reset-temp.js
echo         slowdown_active BOOLEAN DEFAULT 0, >> reset-temp.js
echo         slowdown_factor REAL DEFAULT 1.0, >> reset-temp.js
echo         temperature_active BOOLEAN DEFAULT 0, >> reset-temp.js
echo         temperature_amount REAL DEFAULT 0, >> reset-temp.js
echo         temperature_target REAL DEFAULT 0, >> reset-temp.js
echo         temperature_overheated BOOLEAN DEFAULT 0, >> reset-temp.js
echo         temperature_reward_minutes INTEGER DEFAULT 0, >> reset-temp.js
echo         normalized_username TEXT DEFAULT '', >> reset-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP >> reset-temp.js
echo     )`); >> reset-temp.js
echo. >> reset-temp.js
echo     // Статистика фрагов >> reset-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS frag_stats ( >> reset-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> reset-temp.js
echo         battle_time DATETIME NOT NULL, >> reset-temp.js
echo         frags INTEGER NOT NULL DEFAULT 0, >> reset-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP >> reset-temp.js
echo     )`); >> reset-temp.js
echo. >> reset-temp.js
echo     // Цели сбора >> reset-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS donation_goals ( >> reset-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> reset-temp.js
echo         title TEXT NOT NULL DEFAULT 'Сбор на новый контент', >> reset-temp.js
echo         description TEXT DEFAULT 'Поддержите создание качественного контента!', >> reset-temp.js
echo         target_amount REAL NOT NULL DEFAULT 10000, >> reset-temp.js
echo         current_amount REAL NOT NULL DEFAULT 0, >> reset-temp.js
echo         total_donations INTEGER NOT NULL DEFAULT 0, >> reset-temp.js
echo         avg_donation REAL NOT NULL DEFAULT 0, >> reset-temp.js
echo         end_date DATETIME, >> reset-temp.js
echo         last_donation_time DATETIME, >> reset-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP, >> reset-temp.js
echo         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-temp.js
echo     )`); >> reset-temp.js
echo. >> reset-temp.js
echo     // Донаты к целям >> reset-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS goal_donations ( >> reset-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> reset-temp.js
echo         goal_id INTEGER NOT NULL, >> reset-temp.js
echo         amount REAL NOT NULL, >> reset-temp.js
echo         username TEXT, >> reset-temp.js
echo         message TEXT, >> reset-temp.js
echo         is_manual BOOLEAN DEFAULT 0, >> reset-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP, >> reset-temp.js
echo         FOREIGN KEY (goal_id) REFERENCES donation_goals (id) >> reset-temp.js
echo     )`); >> reset-temp.js
echo. >> reset-temp.js
echo     // Сессии температуры >> reset-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS temperature_sessions ( >> reset-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> reset-temp.js
echo         session_start DATETIME DEFAULT CURRENT_TIMESTAMP, >> reset-temp.js
echo         session_end DATETIME, >> reset-temp.js
echo         target_amount REAL NOT NULL, >> reset-temp.js
echo         total_donated REAL DEFAULT 0, >> reset-temp.js
echo         max_temperature REAL DEFAULT 0, >> reset-temp.js
echo         overheated BOOLEAN DEFAULT 0, >> reset-temp.js
echo         reward_minutes INTEGER DEFAULT 0, >> reset-temp.js
echo         cooling_rate REAL DEFAULT 0, >> reset-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP >> reset-temp.js
echo     )`); >> reset-temp.js
echo. >> reset-temp.js
echo     // Статистика времени таймера >> reset-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS timer_time_stats ( >> reset-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> reset-temp.js
echo         timer_seconds INTEGER NOT NULL, >> reset-temp.js
echo         donation_count INTEGER DEFAULT 0, >> reset-temp.js
echo         total_amount REAL DEFAULT 0, >> reset-temp.js
echo         avg_amount REAL DEFAULT 0, >> reset-temp.js
echo         mode TEXT DEFAULT 'normal', >> reset-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP, >> reset-temp.js
echo         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP >> reset-temp.js
echo     )`); >> reset-temp.js
echo. >> reset-temp.js
echo     // Вставляем начальные данные >> reset-temp.js
echo     db.run(`INSERT OR IGNORE INTO app_state (id) VALUES (1)`); >> reset-temp.js
echo     db.run(`INSERT OR IGNORE INTO donation_goals (id) VALUES (1)`); >> reset-temp.js
echo     console.log('✅ Новая база данных создана'); >> reset-temp.js
echo }); >> reset-temp.js
echo. >> reset-temp.js
echo db.close(); >> reset-temp.js

:: Запускаем создание новой БД
call node reset-temp.js
if %errorlevel% neq 0 (
    echo ❌ Ошибка создания новой базы данных!
    del reset-temp.js
    pause
    exit /b 1
)

:: Удаляем временный файл
del reset-temp.js
echo ✅ Новая база данных создана

echo.
echo ========================================
echo    СБРОС БД ЗАВЕРШЕН
echo ========================================
echo.
echo 🚀 Теперь можете запустить сервер:
echo    • start-server-complete.bat - полный запуск
echo    • start-server-quick.bat - быстрый запуск
echo.
pause








