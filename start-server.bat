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

:: Создаем скрипт инициализации БД
echo const sqlite3 = require('sqlite3').verbose(); > init-db-temp.js
echo const path = require('path'); >> init-db-temp.js
echo. >> init-db-temp.js
echo console.log('🗄️ Инициализация базы данных...'); >> init-db-temp.js
echo. >> init-db-temp.js
echo const dbPath = path.join(__dirname, 'frag_tracker.db'); >> init-db-temp.js
echo const db = new sqlite3.Database(dbPath); >> init-db-temp.js
echo. >> init-db-temp.js
echo db.serialize(() => { >> init-db-temp.js
echo     console.log('📋 Создание таблиц...'); >> init-db-temp.js
echo. >> init-db-temp.js
echo     // Основное состояние >> init-db-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS app_state ( >> init-db-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> init-db-temp.js
echo         current_mode TEXT DEFAULT 'mode1', >> init-db-temp.js
echo         frag_cost INTEGER DEFAULT 50, >> init-db-temp.js
echo         frag_amount INTEGER DEFAULT 1, >> init-db-temp.js
echo         frags_needed INTEGER DEFAULT 10, >> init-db-temp.js
echo         frags_done INTEGER DEFAULT 0, >> init-db-temp.js
echo         current_balance INTEGER DEFAULT 0, >> init-db-temp.js
echo         total_donated INTEGER DEFAULT 0, >> init-db-temp.js
echo         frag_name TEXT DEFAULT 'фраг', >> init-db-temp.js
echo         widget_left_label TEXT DEFAULT 'ОСТАЛОСЬ', >> init-db-temp.js
echo         widget_right_label TEXT DEFAULT 'СДЕЛАНО', >> init-db-temp.js
echo         widget_progress_label TEXT DEFAULT 'До +1 фрага:', >> init-db-temp.js
echo         widget_bg_opacity REAL DEFAULT 0.95, >> init-db-temp.js
echo         widget_cost_font_size REAL DEFAULT 1.4, >> init-db-temp.js
echo         timer_seconds INTEGER DEFAULT 0, >> init-db-temp.js
echo         timer_paused BOOLEAN DEFAULT 0, >> init-db-temp.js
echo         cost_per_minute INTEGER DEFAULT 50, >> init-db-temp.js
echo         timer_alert_text TEXT DEFAULT 'добавил времени', >> init-db-temp.js
echo         timer_slowdown_active BOOLEAN DEFAULT 0, >> init-db-temp.js
echo         timer_slowdown_factor REAL DEFAULT 1.0, >> init-db-temp.js
echo         timer_slowdown_until_ts INTEGER DEFAULT 0, >> init-db-temp.js
echo         timer_discount_active BOOLEAN DEFAULT 0, >> init-db-temp.js
echo         timer_discount REAL DEFAULT 0, >> init-db-temp.js
echo         temperature_mode_active BOOLEAN DEFAULT 0, >> init-db-temp.js
echo         temperature_current_amount REAL DEFAULT 0, >> init-db-temp.js
echo         temperature_target_amount REAL DEFAULT 10000, >> init-db-temp.js
echo         temperature_cooling_rate REAL DEFAULT 100, >> init-db-temp.js
echo         temperature_overheated BOOLEAN DEFAULT 0, >> init-db-temp.js
echo         temperature_peak_reward_minutes INTEGER DEFAULT 5, >> init-db-temp.js
echo         custom_goal_name TEXT DEFAULT 'единица', >> init-db-temp.js
echo         custom_units_needed INTEGER DEFAULT 10, >> init-db-temp.js
echo         custom_units_done INTEGER DEFAULT 0, >> init-db-temp.js
echo         custom_current_balance INTEGER DEFAULT 0, >> init-db-temp.js
echo         custom_unit_cost INTEGER DEFAULT 50, >> init-db-temp.js
echo         custom_unit_amount INTEGER DEFAULT 1, >> init-db-temp.js
echo         custom_widget_left_label TEXT DEFAULT 'ОСТАЛОСЬ', >> init-db-temp.js
echo         custom_widget_right_label TEXT DEFAULT 'СДЕЛАНО', >> init-db-temp.js
echo         custom_alert_text TEXT DEFAULT 'добавил к цели', >> init-db-temp.js
echo         theme_mode1 TEXT, >> init-db-temp.js
echo         theme_mode2 TEXT, >> init-db-temp.js
echo         theme_mode3 TEXT, >> init-db-temp.js
echo         last_donation_id TEXT, >> init-db-temp.js
echo         da_access_token TEXT, >> init-db-temp.js
echo         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-db-temp.js
echo     )`, (err) => { >> init-db-temp.js
echo         if (err) console.error('❌ Ошибка app_state:', err); >> init-db-temp.js
echo         else console.log('✅ Таблица app_state создана'); >> init-db-temp.js
echo     }); >> init-db-temp.js
echo. >> init-db-temp.js
echo     // История донатов >> init-db-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS donations ( >> init-db-temp.js
echo         id TEXT PRIMARY KEY, >> init-db-temp.js
echo         username TEXT NOT NULL, >> init-db-temp.js
echo         amount REAL NOT NULL, >> init-db-temp.js
echo         message TEXT, >> init-db-temp.js
echo         currency TEXT DEFAULT 'RUB', >> init-db-temp.js
echo         is_realtime BOOLEAN DEFAULT 0, >> init-db-temp.js
echo         frags_earned INTEGER DEFAULT 0, >> init-db-temp.js
echo         time_earned INTEGER DEFAULT 0, >> init-db-temp.js
echo         custom_units_earned INTEGER DEFAULT 0, >> init-db-temp.js
echo         timer_mode TEXT DEFAULT 'normal', >> init-db-temp.js
echo         timer_seconds INTEGER DEFAULT 0, >> init-db-temp.js
echo         discount_active BOOLEAN DEFAULT 0, >> init-db-temp.js
echo         discount_percentage REAL DEFAULT 0, >> init-db-temp.js
echo         slowdown_active BOOLEAN DEFAULT 0, >> init-db-temp.js
echo         slowdown_factor REAL DEFAULT 1.0, >> init-db-temp.js
echo         temperature_active BOOLEAN DEFAULT 0, >> init-db-temp.js
echo         temperature_amount REAL DEFAULT 0, >> init-db-temp.js
echo         temperature_target REAL DEFAULT 0, >> init-db-temp.js
echo         temperature_overheated BOOLEAN DEFAULT 0, >> init-db-temp.js
echo         temperature_reward_minutes INTEGER DEFAULT 0, >> init-db-temp.js
echo         normalized_username TEXT DEFAULT '', >> init-db-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-db-temp.js
echo     )`, (err) => { >> init-db-temp.js
echo         if (err) console.error('❌ Ошибка donations:', err); >> init-db-temp.js
echo         else console.log('✅ Таблица donations создана'); >> init-db-temp.js
echo     }); >> init-db-temp.js
echo. >> init-db-temp.js
echo     // Статистика фрагов >> init-db-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS frag_stats ( >> init-db-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> init-db-temp.js
echo         battle_time DATETIME NOT NULL, >> init-db-temp.js
echo         frags INTEGER NOT NULL DEFAULT 0, >> init-db-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-db-temp.js
echo     )`, (err) => { >> init-db-temp.js
echo         if (err) console.error('❌ Ошибка frag_stats:', err); >> init-db-temp.js
echo         else console.log('✅ Таблица frag_stats создана'); >> init-db-temp.js
echo     }); >> init-db-temp.js
echo. >> init-db-temp.js
echo     // Цели сбора >> init-db-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS donation_goals ( >> init-db-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> init-db-temp.js
echo         title TEXT NOT NULL DEFAULT 'Сбор на новый контент', >> init-db-temp.js
echo         description TEXT DEFAULT 'Поддержите создание качественного контента!', >> init-db-temp.js
echo         target_amount REAL NOT NULL DEFAULT 10000, >> init-db-temp.js
echo         current_amount REAL NOT NULL DEFAULT 0, >> init-db-temp.js
echo         total_donations INTEGER NOT NULL DEFAULT 0, >> init-db-temp.js
echo         avg_donation REAL NOT NULL DEFAULT 0, >> init-db-temp.js
echo         end_date DATETIME, >> init-db-temp.js
echo         last_donation_time DATETIME, >> init-db-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP, >> init-db-temp.js
echo         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-db-temp.js
echo     )`, (err) => { >> init-db-temp.js
echo         if (err) console.error('❌ Ошибка donation_goals:', err); >> init-db-temp.js
echo         else console.log('✅ Таблица donation_goals создана'); >> init-db-temp.js
echo     }); >> init-db-temp.js
echo. >> init-db-temp.js
echo     // Донаты к целям >> init-db-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS goal_donations ( >> init-db-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> init-db-temp.js
echo         goal_id INTEGER NOT NULL, >> init-db-temp.js
echo         amount REAL NOT NULL, >> init-db-temp.js
echo         username TEXT, >> init-db-temp.js
echo         message TEXT, >> init-db-temp.js
echo         is_manual BOOLEAN DEFAULT 0, >> init-db-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP, >> init-db-temp.js
echo         FOREIGN KEY (goal_id) REFERENCES donation_goals (id) >> init-db-temp.js
echo     )`, (err) => { >> init-db-temp.js
echo         if (err) console.error('❌ Ошибка goal_donations:', err); >> init-db-temp.js
echo         else console.log('✅ Таблица goal_donations создана'); >> init-db-temp.js
echo     }); >> init-db-temp.js
echo. >> init-db-temp.js
echo     // Сессии температуры >> init-db-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS temperature_sessions ( >> init-db-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> init-db-temp.js
echo         session_start DATETIME DEFAULT CURRENT_TIMESTAMP, >> init-db-temp.js
echo         session_end DATETIME, >> init-db-temp.js
echo         target_amount REAL NOT NULL, >> init-db-temp.js
echo         total_donated REAL DEFAULT 0, >> init-db-temp.js
echo         max_temperature REAL DEFAULT 0, >> init-db-temp.js
echo         overheated BOOLEAN DEFAULT 0, >> init-db-temp.js
echo         reward_minutes INTEGER DEFAULT 0, >> init-db-temp.js
echo         cooling_rate REAL DEFAULT 0, >> init-db-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-db-temp.js
echo     )`, (err) => { >> init-db-temp.js
echo         if (err) console.error('❌ Ошибка temperature_sessions:', err); >> init-db-temp.js
echo         else console.log('✅ Таблица temperature_sessions создана'); >> init-db-temp.js
echo     }); >> init-db-temp.js
echo. >> init-db-temp.js
echo     // Статистика времени таймера >> init-db-temp.js
echo     db.run(`CREATE TABLE IF NOT EXISTS timer_time_stats ( >> init-db-temp.js
echo         id INTEGER PRIMARY KEY AUTOINCREMENT, >> init-db-temp.js
echo         timer_seconds INTEGER NOT NULL, >> init-db-temp.js
echo         donation_count INTEGER DEFAULT 0, >> init-db-temp.js
echo         total_amount REAL DEFAULT 0, >> init-db-temp.js
echo         avg_amount REAL DEFAULT 0, >> init-db-temp.js
echo         mode TEXT DEFAULT 'normal', >> init-db-temp.js
echo         created_at DATETIME DEFAULT CURRENT_TIMESTAMP, >> init-db-temp.js
echo         updated_at DATETIME DEFAULT CURRENT_TIMESTAMP >> init-db-temp.js
echo     )`, (err) => { >> init-db-temp.js
echo         if (err) console.error('❌ Ошибка timer_time_stats:', err); >> init-db-temp.js
echo         else console.log('✅ Таблица timer_time_stats создана'); >> init-db-temp.js
echo     }); >> init-db-temp.js
echo. >> init-db-temp.js
echo     console.log('📝 Вставка начальных данных...'); >> init-db-temp.js
echo. >> init-db-temp.js
echo     // Вставляем начальные данные >> init-db-temp.js
echo     db.run(`INSERT OR IGNORE INTO app_state (id) VALUES (1)`, (err) => { >> init-db-temp.js
echo         if (err) console.error('❌ Ошибка вставки app_state:', err); >> init-db-temp.js
echo         else console.log('✅ Начальное состояние вставлено'); >> init-db-temp.js
echo     }); >> init-db-temp.js
echo. >> init-db-temp.js
echo     db.run(`INSERT OR IGNORE INTO donation_goals (id) VALUES (1)`, (err) => { >> init-db-temp.js
echo         if (err) console.error('❌ Ошибка вставки donation_goals:', err); >> init-db-temp.js
echo         else console.log('✅ Начальная цель сбора вставлена'); >> init-db-temp.js
echo     }); >> init-db-temp.js
echo. >> init-db-temp.js
echo     console.log('✅ База данных инициализирована успешно!'); >> init-db-temp.js
echo }); >> init-db-temp.js
echo. >> init-db-temp.js
echo db.close((err) => { >> init-db-temp.js
echo     if (err) { >> init-db-temp.js
echo         console.error('❌ Ошибка закрытия БД:', err); >> init-db-temp.js
echo         process.exit(1); >> init-db-temp.js
echo     } else { >> init-db-temp.js
echo         console.log('🔒 База данных закрыта'); >> init-db-temp.js
echo         console.log('🚀 Готово к запуску сервера!'); >> init-db-temp.js
echo     } >> init-db-temp.js
echo }); >> init-db-temp.js

:: Запускаем инициализацию БД
call node init-db-temp.js
if %errorlevel% neq 0 (
    echo ❌ Ошибка инициализации базы данных!
    del init-db-temp.js
    pause
    exit /b 1
)

:: Удаляем временный файл
del init-db-temp.js
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