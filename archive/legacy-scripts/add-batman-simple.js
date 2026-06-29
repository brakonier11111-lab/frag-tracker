const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

const username = 'Бетмен';
const normalizedUsername = 'бетмен';

// Расчет времени:
// 45000р по 35р за минуту = 45000/35*60 = 77143 секунд
// 75000р по 50р за минуту = 75000/50*60 = 90000 секунд
// Итого: 77143 + 90000 = 167143 секунд

const donations = [
    {
        id: 'batman-1-' + Date.now(),
        amount: 45000,
        time_earned: Math.round(45000 / 35 * 60),
        created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
        id: 'batman-2-' + Date.now(),
        amount: 75000,
        time_earned: Math.round(75000 / 50 * 60),
        created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    }
];

db.serialize(() => {
    console.log('Добавление донатов для Бетмен...');
    
    // Удаляем старые донаты Бетмена, если есть
    db.run('DELETE FROM donations WHERE username = ? OR normalized_username = ?', 
        [username, normalizedUsername], 
        (err) => {
            if (err) {
                console.error('Ошибка удаления старых донатов:', err);
            } else {
                console.log('Старые донаты удалены (если были)');
            }
            
            // Добавляем новые донаты
            let completed = 0;
            donations.forEach((donation, index) => {
                db.run(`
                    INSERT INTO donations (
                        id, username, normalized_username, amount, time_earned, 
                        message, currency, is_realtime, frags_earned, 
                        custom_units_earned, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    donation.id,
                    username,
                    normalizedUsername,
                    donation.amount,
                    donation.time_earned,
                    index === 0 ? 'Донат по цене 35р за минуту' : 'Донат по цене 50р за минуту',
                    'RUB',
                    0,
                    0,
                    0,
                    donation.created_at
                ], (err) => {
                    if (err) {
                        console.error(`Ошибка добавления доната ${index + 1}:`, err);
                    } else {
                        console.log(`Донат ${index + 1} добавлен: ${donation.amount}₽, ${donation.time_earned} сек`);
                    }
                    
                    completed++;
                    if (completed === donations.length) {
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
                                console.error('Ошибка проверки итогов:', err);
                            } else {
                                console.log('\nИтоговая статистика для Бетмен:');
                                console.log(`   Всего донатов: ${row.donation_count}`);
                                console.log(`   Общая сумма: ${Math.round(row.total_amount)}₽`);
                                console.log(`   Общее время: ${row.total_time_seconds} сек (${Math.round(row.total_time_seconds / 60)} мин)`);
                            }
                            db.close();
                            console.log('\nГотово! Бетмен добавлен в топ донатеров.');
                        });
                    }
                });
            });
        });
});










