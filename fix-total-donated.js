const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('frag_tracker.db');

console.log('🔧 Исправляем рассинхронизацию total_donated...');

// Получаем реальную сумму из таблицы donations
db.get('SELECT SUM(amount) as totalAmount FROM donations', (err, donationsRow) => {
    if (err) {
        console.error('❌ Ошибка при получении суммы донатов:', err);
        db.close();
        return;
    }
    
    const realTotalAmount = donationsRow ? donationsRow.totalAmount : 0;
    console.log('📊 Реальная сумма из таблицы donations:', realTotalAmount);
    
    // Обновляем total_donated в app_state
    db.run('UPDATE app_state SET total_donated = ? WHERE id = 1', [realTotalAmount], function(err) {
        if (err) {
            console.error('❌ Ошибка при обновлении total_donated:', err);
        } else {
            console.log('✅ total_donated успешно обновлен до:', realTotalAmount);
            console.log('🔄 Изменений в БД:', this.changes);
        }
        
        // Проверяем результат
        db.get('SELECT total_donated FROM app_state WHERE id = 1', (err, row) => {
            if (err) {
                console.error('❌ Ошибка при проверке:', err);
            } else {
                console.log('✅ Проверка: total_donated теперь =', row ? row.total_donated : 'не найдено');
            }
            
            db.close();
        });
    });
});








