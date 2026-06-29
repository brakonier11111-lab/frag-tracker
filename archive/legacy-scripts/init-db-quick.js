const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'frag_tracker.db');

console.log('🔄 Инициализация базы данных...');

// Если база уже существует, сначала удаляем её
if (fs.existsSync(dbPath)) {
    console.log('⚠️  Существующая база данных найдена. Удаление...');
    fs.unlinkSync(dbPath);
}

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Основное состояние
    db.run(`CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        current_mode TEXT DEFAULT 'mode1',
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
        timer_seconds INTEGER DEFAULT 0,
        timer_paused BOOLEAN DEFAULT 0,
        cost_per_minute INTEGER DEFAULT 50,
        timer_alert_text TEXT DEFAULT 'добавил времени',
        timer_slowdown_active BOOLEAN DEFAULT 0,
        timer_slowdown_factor REAL DEFAULT 1.0,
        timer_slowdown_until_ts INTEGER DEFAULT 0,
        custom_goal_name TEXT DEFAULT 'единица',
        custom_units_needed INTEGER DEFAULT 10,
        custom_units_done INTEGER DEFAULT 0,
        custom_current_balance INTEGER DEFAULT 0,
        custom_unit_cost INTEGER DEFAULT 50,
        custom_unit_amount INTEGER DEFAULT 1,
        custom_widget_left_label TEXT DEFAULT 'ОСТАЛОСЬ',
        custom_widget_right_label TEXT DEFAULT 'СДЕЛАНО',
        custom_alert_text TEXT DEFAULT 'добавил к цели',
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
            console.log('✅ Таблица app_state создана');
        }
    });

    // Добавляем начальную запись
    db.run(`INSERT OR REPLACE INTO app_state (id) VALUES (1)`, (err) => {
        if (err) {
            console.error('❌ Ошибка добавления начальной записи:', err);
        } else {
            console.log('✅ Начальная запись добавлена');
        }
    });

    // Таблица для цели сбора донатов
    db.run(`CREATE TABLE IF NOT EXISTS donation_goal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT 'Сбор на новый контент',
        description TEXT,
        target_amount INTEGER NOT NULL DEFAULT 10000,
        current_amount INTEGER NOT NULL DEFAULT 0,
        end_date DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы donation_goal:', err);
        } else {
            console.log('✅ Таблица donation_goal создана');
        }
    });

    // Добавляем начальную запись для цели донатов
    db.run(`INSERT OR REPLACE INTO donation_goal (id, title, target_amount, current_amount) 
            VALUES (1, 'Сбор на новый контент', 10000, 0)`, (err) => {
        if (err) {
            console.error('❌ Ошибка добавления начальной записи donation_goal:', err);
        } else {
            console.log('✅ Начальная запись donation_goal добавлена');
        }
    });

    // История донатов
    db.run(`CREATE TABLE IF NOT EXISTS donation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        amount INTEGER NOT NULL,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы donation_history:', err);
        } else {
            console.log('✅ Таблица donation_history создана');
        }
    });

    console.log('\n🎉 База данных успешно инициализирована!');
    db.close();
});






