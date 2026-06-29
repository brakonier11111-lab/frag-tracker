const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Добавляем новые поля для режимов
    const newColumns = [
        'current_mode TEXT DEFAULT "mode1"',
        'timer_seconds INTEGER DEFAULT 0',
        'timer_paused BOOLEAN DEFAULT 0',
        'cost_per_minute INTEGER DEFAULT 50',
        'timer_alert_text TEXT DEFAULT "добавил времени"',
        // Mode 2 slowdown controls
        'timer_slowdown_active BOOLEAN DEFAULT 0',
        'timer_slowdown_factor REAL DEFAULT 1.0',
        'timer_slowdown_until_ts INTEGER DEFAULT 0',
        'custom_goal_name TEXT DEFAULT "единица"',
        'custom_units_needed INTEGER DEFAULT 10',
        'custom_units_done INTEGER DEFAULT 0',
        'custom_current_balance INTEGER DEFAULT 0',
        'custom_unit_cost INTEGER DEFAULT 50',
        'custom_unit_amount INTEGER DEFAULT 1',
        'custom_widget_left_label TEXT DEFAULT "ОСТАЛОСЬ"',
        'custom_widget_right_label TEXT DEFAULT "СДЕЛАНО"',
        'custom_alert_text TEXT DEFAULT "добавил к цели"'
    ];

    newColumns.forEach(column => {
        const [columnName] = column.split(' ');
        db.run(`ALTER TABLE app_state ADD COLUMN ${column}`, (err) => {
            if (err) {
                console.log(`ℹ️ Поле ${columnName} уже существует`);
            } else {
                console.log(`✅ Добавлено поле ${columnName}`);
            }
        });
    });

    // Добавляем поддержку прозрачности фона виджетов, если отсутствует
    db.run(`ALTER TABLE app_state ADD COLUMN widget_bg_opacity REAL DEFAULT 0.95`, (err) => {
        if (err) console.log('ℹ️ Поле widget_bg_opacity уже существует');
        else console.log('✅ Добавлено поле widget_bg_opacity');
    });

    // Размер шрифта строки стоимости в виджете (rem)
    db.run(`ALTER TABLE app_state ADD COLUMN widget_cost_font_size REAL DEFAULT 1.4`, (err) => {
        if (err) console.log('ℹ️ Поле widget_cost_font_size уже существует');
        else console.log('✅ Добавлено поле widget_cost_font_size');
    });

    // Тема (JSON) на режим
    db.run(`ALTER TABLE app_state ADD COLUMN theme_mode1 TEXT`, (err) => {
        if (err) console.log('ℹ️ Поле theme_mode1 уже существует');
        else console.log('✅ Добавлено поле theme_mode1');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN theme_mode2 TEXT`, (err) => {
        if (err) console.log('ℹ️ Поле theme_mode2 уже существует');
        else console.log('✅ Добавлено поле theme_mode2');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN theme_mode3 TEXT`, (err) => {
        if (err) console.log('ℹ️ Поле theme_mode3 уже существует');
        else console.log('✅ Добавлено поле theme_mode3');
    });

    // Добавляем новые поля в donations
    db.run(`ALTER TABLE donations ADD COLUMN time_earned INTEGER DEFAULT 0`, (err) => {
        if (err) console.log('ℹ️ Поле time_earned уже существует');
        else console.log('✅ Добавлено поле time_earned');
    });

    db.run(`ALTER TABLE donations ADD COLUMN custom_units_earned INTEGER DEFAULT 0`, (err) => {
        if (err) console.log('ℹ️ Поле custom_units_earned уже существует');
        else console.log('✅ Добавлено поле custom_units_earned');
    });

    console.log('✅ Миграция базы данных завершена');
});

db.close();