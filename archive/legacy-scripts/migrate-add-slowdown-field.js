const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
console.log('🗄️ Открываем БД:', dbPath);

const db = new sqlite3.Database(dbPath);

db.run(`ALTER TABLE app_state ADD COLUMN slowdown_random_settings TEXT`, (err) => {
    if (err) {
        if (err.message.includes('duplicate column name')) {
            console.log('✅ Поле slowdown_random_settings уже существует');
        } else {
            console.error('❌ Ошибка:', err.message);
        }
    } else {
        console.log('✅ Поле slowdown_random_settings успешно добавлено');
    }
    db.close();
});




