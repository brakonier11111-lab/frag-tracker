const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

console.log('🔄 Обновление полей DonatePay Widget...');

db.serialize(() => {
    // Добавляем поля для DonatePay
    const fields = [
        'dp_widget_url TEXT',
        'dp_last_transaction_id TEXT'
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

    console.log('✅ Обновление полей DonatePay Widget завершено');
});

db.close();
