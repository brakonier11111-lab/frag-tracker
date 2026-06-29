const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    console.log('📋 Создание таблицы donations...');
    
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
        db.close();
    });
});




