const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
console.log('🗄️ Открываем БД:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Ошибка открытия БД:', err);
        process.exit(1);
    }
    console.log('✅ БД открыта');
});

console.log('📝 Добавляем поле slowdown_random_settings...');
db.run(`ALTER TABLE app_state ADD COLUMN slowdown_random_settings TEXT`, (err) => {
    if (err) {
        if (err.message.includes('duplicate column')) {
            console.log('✅ Поле slowdown_random_settings уже существует');
        } else {
            console.error('❌ Ошибка добавления поля:', err);
            process.exit(1);
        }
    } else {
        console.log('✅ Поле slowdown_random_settings успешно добавлено');
    }
    
    db.close((err) => {
        if (err) {
            console.error('❌ Ошибка закрытия БД:', err);
        } else {
            console.log('🔒 БД закрыта');
            console.log('✅ Готово! Перезапустите сервер.');
        }
        process.exit(0);
    });
});



