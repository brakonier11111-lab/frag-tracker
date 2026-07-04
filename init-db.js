const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const { resolveDbPath } = require('./src/bootstrap/paths');
const dbPath = resolveDbPath();
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Основное состояние
    db.run(`CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        current_mode TEXT DEFAULT 'mode1',
        -- Mode 1: Frag Tracker
        frag_cost INTEGER DEFAULT 50,
        frag_amount INTEGER DEFAULT 1,
        frags_needed INTEGER DEFAULT 10,
        frags_done INTEGER DEFAULT 0,
        current_balance INTEGER DEFAULT 0,
        total_donated INTEGER DEFAULT 0,
        frag_name TEXT DEFAULT 'фраг',
        widget_left_label TEXT DEFAULT 'ОСТАЛОСЬ',
        widget_right_label TEXT DEFAULT 'СДЕЛАНО',
        widget_progress_label TEXT DEFAULT 'До +1 фрага:',
        widget_bg_opacity REAL DEFAULT 0.95,
        widget_cost_font_size REAL DEFAULT 1.4,
        -- Mode 2: Timer
        timer_seconds INTEGER DEFAULT 0,
        timer_paused BOOLEAN DEFAULT 0,
        cost_per_minute INTEGER DEFAULT 50,
        timer_alert_text TEXT DEFAULT 'добавил времени',
        -- Mode 2: Slowdown controls
        timer_slowdown_active BOOLEAN DEFAULT 0,
        timer_slowdown_factor REAL DEFAULT 1.0,
        timer_slowdown_until_ts INTEGER DEFAULT 0,
        slowdown_random_settings TEXT,
        -- Mode 3: Custom Tracker
        custom_goal_name TEXT DEFAULT 'единица',
        custom_units_needed INTEGER DEFAULT 10,
        custom_units_done INTEGER DEFAULT 0,
        custom_current_balance INTEGER DEFAULT 0,
        custom_unit_cost INTEGER DEFAULT 50,
        custom_unit_amount INTEGER DEFAULT 1,
        custom_widget_left_label TEXT DEFAULT 'ОСТАЛОСЬ',
        custom_widget_right_label TEXT DEFAULT 'СДЕЛАНО',
        custom_alert_text TEXT DEFAULT 'добавил к цели',
        -- Common
        theme_mode1 TEXT,
        theme_mode2 TEXT,
        theme_mode3 TEXT,
        last_donation_id TEXT,
        da_access_token TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // История донатов
    db.run(`CREATE TABLE IF NOT EXISTS donations (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        amount REAL NOT NULL,
        message TEXT,
        currency TEXT DEFAULT 'RUB',
        is_realtime BOOLEAN DEFAULT 0,
        frags_earned INTEGER DEFAULT 0,
        time_earned INTEGER DEFAULT 0,
        custom_units_earned INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Создаем таблицу для статистики фрагов
    db.run(`CREATE TABLE IF NOT EXISTS frag_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        battle_time DATETIME NOT NULL,
        frags INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Создаем таблицу для сбора донатов
    db.run(`CREATE TABLE IF NOT EXISTS donation_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT 'Сбор на новый контент',
        description TEXT DEFAULT 'Поддержите создание качественного контента!',
        target_amount REAL NOT NULL DEFAULT 10000,
        current_amount REAL NOT NULL DEFAULT 0,
        total_donations INTEGER NOT NULL DEFAULT 0,
        avg_donation REAL NOT NULL DEFAULT 0,
        end_date DATETIME,
        last_donation_time DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Создаем таблицу для истории донатов цели
    db.run(`CREATE TABLE IF NOT EXISTS goal_donations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        username TEXT,
        message TEXT,
        is_manual BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (goal_id) REFERENCES donation_goals (id)
    )`);

    // Вставляем начальное состояние
    db.run(`INSERT OR IGNORE INTO app_state (id) VALUES (1)`);
    
    // Вставляем начальную цель сбора
    db.run(`INSERT OR IGNORE INTO donation_goals (id) VALUES (1)`);

    console.log('✅ База данных инициализирована с поддержкой 3 режимов и статистики фрагов');
});

db.close();