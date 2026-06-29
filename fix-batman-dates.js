const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

const username = 'Бетмен';
const normalizedUsername = 'бетмен';

console.log('🔧 Обновление дат донатов Бетмен...');

// Обновляем даты донатов Бетмен на более ранние (30 и 25 дней назад)
db.run(`
    UPDATE donations 
    SET created_at = ?
    WHERE username = ? AND normalized_username = ? 
      AND amount = 45000
    ORDER BY created_at DESC
    LIMIT 1
`, [
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 дней назад
    username,
    normalizedUsername
], (err) => {
    if (err) {
        console.error('Ошибка обновления доната 1:', err);
    } else {
        console.log('✅ Дата первого доната (45000₽) обновлена на 30 дней назад');
    }
    
    // Обновляем второй донат
    db.run(`
        UPDATE donations 
        SET created_at = ?
        WHERE username = ? AND normalized_username = ? 
          AND amount = 75000
        ORDER BY created_at DESC
        LIMIT 1
    `, [
        new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(), // 25 дней назад
        username,
        normalizedUsername
    ], (err) => {
        if (err) {
            console.error('Ошибка обновления доната 2:', err);
        } else {
            console.log('✅ Дата второго доната (75000₽) обновлена на 25 дней назад');
        }
        
        // Проверяем итоги
        db.get(`
            SELECT 
                COUNT(*) as count,
                MIN(created_at) as earliest,
                MAX(created_at) as latest
            FROM donations 
            WHERE username = ? OR normalized_username = ?
        `, [username, normalizedUsername], (err, row) => {
            if (err) {
                console.error('Ошибка проверки:', err);
            } else {
                console.log(`\n📊 Донаты Бетмен: ${row.count} шт.`);
                console.log(`   Самая ранняя дата: ${row.earliest}`);
                console.log(`   Самая поздняя дата: ${row.latest}`);
            }
            db.close();
            console.log('\n✅ Готово! Донаты Бетмен теперь с более ранними датами.');
        });
    });
});










