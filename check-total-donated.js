const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('frag_tracker.db');

console.log('🔍 Проверяем значение total_donated в базе данных...');

db.get('SELECT total_donated FROM app_state WHERE id = 1', (err, row) => {
    if (err) {
        console.error('❌ Ошибка:', err);
    } else {
        console.log('💰 total_donated в БД:', row ? row.total_donated : 'не найдено');
    }
    
    // Также проверим общую сумму из таблицы donations
    db.get('SELECT SUM(amount) as totalAmount FROM donations', (err, donationsRow) => {
        if (err) {
            console.error('❌ Ошибка при подсчете донатов:', err);
        } else {
            console.log('📊 Общая сумма из таблицы donations:', donationsRow ? donationsRow.totalAmount : 'не найдено');
        }
        
        // Проверим количество записей
        db.get('SELECT COUNT(*) as count FROM donations', (err, countRow) => {
            if (err) {
                console.error('❌ Ошибка при подсчете количества:', err);
            } else {
                console.log('📈 Количество донатов в БД:', countRow ? countRow.count : 'не найдено');
            }
            
            db.close();
        });
    });
});