const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

console.log('🔄 Добавление полей для Lesta Games в базу данных...');

db.serialize(() => {
    // Добавляем поля для статистики Lesta Games
    const fields = [
        'lesta_last_battles INTEGER',
        'lesta_last_frags INTEGER', 
        'lesta_last_win_rate REAL',
        'lesta_last_frags_per_battle REAL',
        'lesta_last_damage_dealt INTEGER',
        'lesta_last_xp INTEGER',
        'lesta_previous_frags INTEGER',
        'lesta_auto_deduct INTEGER DEFAULT 1'
    ];

    fields.forEach(field => {
        const [fieldName] = field.split(' ');
        db.run(`ALTER TABLE app_state ADD COLUMN ${field}`, (err) => {
            if (err) {
                console.log(`ℹ️ Поле ${fieldName} уже существует`);
            } else {
                console.log(`✅ Добавлено поле ${fieldName}`);
            }
        });
    });

    // Создаем таблицу для истории изменений статистики Lesta Games
    db.run(`CREATE TABLE IF NOT EXISTS lesta_stats_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        battles INTEGER,
        frags INTEGER,
        wins INTEGER,
        losses INTEGER,
        damage_dealt INTEGER,
        xp INTEGER,
        win_rate REAL,
        frags_per_battle REAL,
        avg_damage INTEGER,
        avg_xp INTEGER,
        frags_difference INTEGER DEFAULT 0,
        auto_deducted INTEGER DEFAULT 0
    )`, (err) => {
        if (err) {
            console.log('ℹ️ Таблица lesta_stats_history уже существует');
        } else {
            console.log('✅ Создана таблица lesta_stats_history');
        }
    });

    // Устанавливаем автосинхронизацию и автосписание всегда включенными
    db.run(`UPDATE app_state SET lesta_auto_sync = 1, lesta_auto_deduct = 1 WHERE id = 1`, (err) => {
        if (!err) {
            console.log('✅ Автосинхронизация и автосписание установлены как включенные');
        }
    });

    console.log('✅ Обновление базы данных завершено');
});

db.close();
