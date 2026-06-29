const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

const username = 'Бетмен';
const normalizedUsername = 'бетмен';

console.log('🔧 Проверка и исправление дат всех донатов Бетмен...\n');

// Сначала получаем самый последний донат (не от Бетмен) для определения минимальной даты
db.get(`
    SELECT created_at 
    FROM donations 
    WHERE (username != ? AND normalized_username != ?)
    ORDER BY datetime(created_at) DESC 
    LIMIT 1
`, [username, normalizedUsername], (err, lastNonBatman) => {
    if (err) {
        console.error('Ошибка получения последнего доната:', err);
        db.close();
        return;
    }
    
    const minDate = lastNonBatman ? new Date(lastNonBatman.created_at) : new Date();
    console.log(`📅 Последний донат (не от Бетмен): ${lastNonBatman ? lastNonBatman.created_at : 'нет'}`);
    console.log(`📅 Минимальная дата для донатов Бетмен: ${minDate.toISOString()}\n`);
    
    // Получаем все донаты Бетмен
    db.all(`
        SELECT id, amount, created_at 
        FROM donations 
        WHERE username = ? OR normalized_username = ?
        ORDER BY datetime(created_at) DESC
    `, [username, normalizedUsername], (err, batmanDonations) => {
        if (err) {
            console.error('Ошибка получения донатов Бетмен:', err);
            db.close();
            return;
        }
        
        if (!batmanDonations || batmanDonations.length === 0) {
            console.log('⚠️ Донаты Бетмен не найдены');
            db.close();
            return;
        }
        
        console.log(`📊 Найдено донатов Бетмен: ${batmanDonations.length}`);
        batmanDonations.forEach((d, i) => {
            console.log(`   ${i + 1}. ${d.amount}₽ - ${d.created_at}`);
        });
        console.log('');
        
        // Проверяем, какие донаты нужно исправить
        let fixedCount = 0;
        const daysAgo = [35, 30, 25, 20, 15]; // Даты для разных донатов
        
        batmanDonations.forEach((donation, index) => {
            const donationDate = new Date(donation.created_at);
            const targetDate = new Date(minDate.getTime() - daysAgo[index % daysAgo.length] * 24 * 60 * 60 * 1000);
            
            if (donationDate >= minDate) {
                console.log(`🔧 Исправление доната ${donation.amount}₽: ${donation.created_at} -> ${targetDate.toISOString()}`);
                
                db.run(`
                    UPDATE donations 
                    SET created_at = ?
                    WHERE id = ?
                `, [targetDate.toISOString(), donation.id], (updateErr) => {
                    if (updateErr) {
                        console.error(`   ❌ Ошибка обновления: ${updateErr.message}`);
                    } else {
                        console.log(`   ✅ Обновлено`);
                        fixedCount++;
                    }
                    
                    // После последнего обновления проверяем итоги
                    if (index === batmanDonations.length - 1) {
                        setTimeout(() => {
                            db.get(`
                                SELECT 
                                    COUNT(*) as count,
                                    MIN(created_at) as earliest,
                                    MAX(created_at) as latest
                                FROM donations 
                                WHERE username = ? OR normalized_username = ?
                            `, [username, normalizedUsername], (checkErr, row) => {
                                if (checkErr) {
                                    console.error('Ошибка проверки:', checkErr);
                                } else {
                                    console.log(`\n📊 Итоги для Бетмен:`);
                                    console.log(`   Всего донатов: ${row.count}`);
                                    console.log(`   Самая ранняя дата: ${row.earliest}`);
                                    console.log(`   Самая поздняя дата: ${row.latest}`);
                                }
                                db.close();
                                console.log(`\n✅ Готово! Исправлено дат: ${fixedCount}`);
                            });
                        }, 500);
                    }
                });
            } else {
                console.log(`✓ Донат ${donation.amount}₽ уже с правильной датой: ${donation.created_at}`);
            }
        });
        
        if (batmanDonations.length === 0) {
            db.close();
        }
    });
});










