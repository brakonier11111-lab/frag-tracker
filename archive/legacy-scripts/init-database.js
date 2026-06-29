const sqlite3 = require('sqlite3').verbose();
const path = require('path');

console.log('🗄️ Начинаем инициализацию базы данных...');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    console.log('📋 Создание таблиц...');
    
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
        -- Mode 2: Discount controls
        timer_discount_active BOOLEAN DEFAULT 0,
        timer_discount REAL DEFAULT 0,
        -- Mode 2: Temperature mode
        temperature_mode_active BOOLEAN DEFAULT 0,
        temperature_current_amount REAL DEFAULT 0,
        temperature_target_amount REAL DEFAULT 10000,
        temperature_cooling_rate REAL DEFAULT 100,
        temperature_overheated BOOLEAN DEFAULT 0,
        temperature_peak_reward_minutes INTEGER DEFAULT 5,
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
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы app_state:', err);
        } else {
            console.log('✅ Таблица app_state создана/обновлена');
        }
    });

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
        timer_mode TEXT DEFAULT 'normal',
        timer_seconds INTEGER DEFAULT 0,
        discount_active BOOLEAN DEFAULT 0,
        discount_percentage REAL DEFAULT 0,
        slowdown_active BOOLEAN DEFAULT 0,
        slowdown_factor REAL DEFAULT 1.0,
        temperature_active BOOLEAN DEFAULT 0,
        temperature_amount REAL DEFAULT 0,
        temperature_target REAL DEFAULT 0,
        temperature_overheated BOOLEAN DEFAULT 0,
        temperature_reward_minutes INTEGER DEFAULT 0,
        normalized_username TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы donations:', err);
        } else {
            console.log('✅ Таблица donations создана/обновлена');
        }
    });

    // Создаем таблицу для статистики фрагов
    db.run(`CREATE TABLE IF NOT EXISTS frag_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        battle_time DATETIME NOT NULL,
        frags INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы frag_stats:', err);
        } else {
            console.log('✅ Таблица frag_stats создана/обновлена');
        }
    });

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
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы donation_goals:', err);
        } else {
            console.log('✅ Таблица donation_goals создана/обновлена');
        }
    });

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
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы goal_donations:', err);
        } else {
            console.log('✅ Таблица goal_donations создана/обновлена');
        }
    });

    // Создаем таблицы для аналитики режимов таймера
    db.run(`CREATE TABLE IF NOT EXISTS temperature_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_start DATETIME DEFAULT CURRENT_TIMESTAMP,
        session_end DATETIME,
        target_amount REAL NOT NULL,
        total_donated REAL DEFAULT 0,
        max_temperature REAL DEFAULT 0,
        overheated BOOLEAN DEFAULT 0,
        reward_minutes INTEGER DEFAULT 0,
        cooling_rate REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы temperature_sessions:', err);
        } else {
            console.log('✅ Таблица temperature_sessions создана/обновлена');
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS timer_time_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timer_seconds INTEGER NOT NULL,
        donation_count INTEGER DEFAULT 0,
        total_amount REAL DEFAULT 0,
        avg_amount REAL DEFAULT 0,
        mode TEXT DEFAULT 'normal',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы timer_time_stats:', err);
        } else {
            console.log('✅ Таблица timer_time_stats создана/обновлена');
        }
    });

    console.log('📝 Вставка начальных данных...');
    
    // Вставляем начальное состояние
    db.run(`INSERT OR IGNORE INTO app_state (id) VALUES (1)`, (err) => {
        if (err) {
            console.error('❌ Ошибка вставки начального состояния:', err);
        } else {
            console.log('✅ Начальное состояние вставлено');
        }
    });
    
    // Вставляем начальную цель сбора
    db.run(`INSERT OR IGNORE INTO donation_goals (id) VALUES (1)`, (err) => {
        if (err) {
            console.error('❌ Ошибка вставки начальной цели:', err);
        } else {
            console.log('✅ Начальная цель сбора вставлена');
        }
    });

    console.log('✅ База данных успешно инициализирована!');
    console.log('📊 Созданы таблицы:');
    console.log('   - app_state (основное состояние)');
    console.log('   - donations (история донатов)');
    console.log('   - frag_stats (статистика фрагов)');
    console.log('   - donation_goals (цели сбора)');
    console.log('   - goal_donations (донаты к целям)');
    console.log('   - temperature_sessions (сессии температуры)');
    console.log('   - timer_time_stats (статистика времени таймера)');
    console.log('🎯 Вставлены начальные данные');
});

db.close((err) => {
    if (err) {
        console.error('❌ Ошибка закрытия БД:', err);
    } else {
        console.log('🔒 База данных закрыта');
        console.log('🚀 Инициализация завершена успешно!');
    }
});





