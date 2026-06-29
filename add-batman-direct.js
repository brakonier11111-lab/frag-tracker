const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

const username = 'Бетмен';
const normalizedUsername = 'бетмен';

// Удаляем старые донаты Бетмена
db.run('DELETE FROM donations WHERE username = ? OR normalized_username = ?', 
    [username, normalizedUsername], 
    (err) => {
        if (err) {
            console.error('Ошибка удаления:', err);
            db.close();
            return;
        }
        
        console.log('Старые донаты удалены');
        
        // Добавляем первый донат: 45000₽ по 35₽/мин
        const time1 = Math.round(45000 / 35 * 60); // 77143 сек
        db.run(`
            INSERT INTO donations (
                id, username, normalized_username, amount, time_earned, 
                message, currency, is_realtime, frags_earned, 
                custom_units_earned, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            'batman-' + Date.now() + '-1',
            username,
            normalizedUsername,
            45000,
            time1,
            'Донат по цене 35р за минуту',
            'RUB',
            0,
            0,
            0,
            new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() // 30 дней назад
        ], (err) => {
            if (err) {
                console.error('Ошибка добавления доната 1:', err);
            } else {
                console.log(`✅ Донат 1 добавлен: 45000₽, ${time1} сек`);
                
                // Добавляем второй донат: 75000₽ по 50₽/мин
                const time2 = Math.round(75000 / 50 * 60); // 90000 сек
                db.run(`
                    INSERT INTO donations (
                        id, username, normalized_username, amount, time_earned, 
                        message, currency, is_realtime, frags_earned, 
                        custom_units_earned, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    'batman-' + Date.now() + '-2',
                    username,
                    normalizedUsername,
                    75000,
                    time2,
                    'Донат по цене 50р за минуту',
                    'RUB',
                    0,
                    0,
                    0,
                    new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString() // 25 дней назад
                ], (err) => {
                    if (err) {
                        console.error('Ошибка добавления доната 2:', err);
                    } else {
                        console.log(`✅ Донат 2 добавлен: 75000₽, ${time2} сек`);
                        
                        // Проверяем итоги
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
                                console.log(`   Общее время: ${row.total_time_seconds} сек (${Math.round(row.total_time_seconds / 60)} мин)`);
                            }
                            db.close();
                            console.log('\n✅ Готово! Бетмен добавлен в топ донатеров.');
                            console.log('   Обновите виджет в OBS или перезагрузите страницу.');
                        });
                    }
                });
            }
        });
    });

