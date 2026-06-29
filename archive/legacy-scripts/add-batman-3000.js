const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

const username = 'Бетмен';
const normalizedUsername = 'бетмен';

// Расчет времени: 3000₽ по 50₽/мин = 3000/50*60 = 3600 секунд
const amount = 3000;
const timeEarned = Math.round(3000 / 50 * 60); // 3600 секунд = 60 минут

console.log('📝 Добавление доната 3000₽ для Бетмен...');

// Добавляем донат с датой 20 дней назад, чтобы он не был выше новых донатов
db.run(`
    INSERT INTO donations (
        id, username, normalized_username, amount, time_earned, 
        message, currency, is_realtime, frags_earned, 
        custom_units_earned, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, [
    'batman-3000-' + Date.now(),
    username,
    normalizedUsername,
    amount,
    timeEarned,
    'Донат 3000₽',
    'RUB',
    0,
    0,
    0,
    new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString() // 20 дней назад
], (err) => {
    if (err) {
        console.error('❌ Ошибка добавления доната:', err);
        db.close();
        return;
    }
    
    console.log(`✅ Донат добавлен: ${amount}₽, ${timeEarned} сек (${timeEarned / 60} мин)`);
    
    // Проверяем итоговую статистику
    db.get(`
        SELECT 
            SUM(amount) as total_amount,
            SUM(time_earned) as total_time_seconds,
            COUNT(*) as donation_count
        FROM donations 
        WHERE username = ? OR normalized_username = ?
    `, [username, normalizedUsername], (err, row) => {
        if (err) {
            console.error('Ошибка проверки:', err);
        } else {
            console.log('\n📊 Итоговая статистика для Бетмен:');
            console.log(`   Всего донатов: ${row.donation_count}`);
            console.log(`   Общая сумма: ${Math.round(row.total_amount)}₽`);
            console.log(`   Общее время: ${row.total_time_seconds} сек (${Math.round(row.total_time_seconds / 60)} мин, ${Math.round(row.total_time_seconds / 3600)} ч)`);
        }
        db.close();
        console.log('\n✅ Готово! 3000₽ добавлено к топу Бетмен.');
        console.log('   Обновите виджет в OBS или перезагрузите страницу.');
    });
});










