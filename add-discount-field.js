const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

db.run(`ALTER TABLE app_state ADD COLUMN timer_discount INTEGER DEFAULT 0`, (err) => {
    if (err) {
        console.log('ℹ️ Поле timer_discount уже существует');
    } else {
        console.log('✅ Добавлено поле timer_discount');
    }
    
    db.close();
});