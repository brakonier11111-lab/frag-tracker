const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

// Функция нормализации имени (копия из server.js)
function normalizeUsername(username) {
    if (!username || typeof username !== 'string') {
        return '';
    }
    
    let normalized = username.toLowerCase().trim();
    normalized = normalized.replace(/\s+/g, ' ');
    normalized = normalized.replace(/[_\-\s]+/g, '_');
    normalized = normalized.replace(/[^a-zа-я0-9_]/g, '');
    normalized = normalized.replace(/_+/g, '_');
    normalized = normalized.replace(/^_+|_+$/g, '');
    
    if (!normalized) {
        return username.toLowerCase().trim();
    }
    
    return normalized;
}

// Расчет времени:
// 45000р по 35р за минуту = 45000 / 35 = 1285.71 минут = 77142.86 секунд ≈ 77143 секунд
// 75000р по 50р за минуту = 75000 / 50 = 1500 минут = 90000 секунд
// Итого: 77143 + 90000 = 167143 секунд

const username = 'Бетмен';
const normalizedUsername = normalizeUsername(username);

// Создаем два доната для реалистичности
const donations = [
    {
        id: crypto.randomUUID(),
        username: username,
        normalized_username: normalizedUsername,
        amount: 45000,
        time_earned: Math.round(45000 / 35 * 60), // 77143 секунд
        message: 'Донат по цене 35р за минуту',
        created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() // 7 дней назад
    },
    {
        id: crypto.randomUUID(),
        username: username,
        normalized_username: normalizedUsername,
        amount: 75000,
        time_earned: Math.round(75000 / 50 * 60), // 90000 секунд
        message: 'Донат по цене 50р за минуту',
        created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() // 3 дня назад
    }
];

db.serialize(() => {
    console.log('📝 Добавление донатов для Бетмен...');
    
    // Проверяем, есть ли уже донаты от этого пользователя
    db.all('SELECT id, amount, time_earned FROM donations WHERE username = ? OR normalized_username = ?', 
        [username, normalizedUsername], 
        (err, existing) => {
            if (err) {
                console.error('❌ Ошибка проверки существующих донатов:', err);
                db.close();
                return;
            }
            
            if (existing && existing.length > 0) {
                console.log(`⚠️ Найдено ${existing.length} существующих донатов от "${username}"`);
                console.log('   Удаляем старые донаты...');
                
                db.run('DELETE FROM donations WHERE username = ? OR normalized_username = ?', 
                    [username, normalizedUsername], 
                    (delErr) => {
                        if (delErr) {
                            console.error('❌ Ошибка удаления старых донатов:', delErr);
                            db.close();
                            return;
                        }
                        console.log('✅ Старые донаты удалены');
                        insertDonations();
                    });
            } else {
                insertDonations();
            }
        });
    
    function insertDonations() {
        let inserted = 0;
        const total = donations.length;
        
        donations.forEach((donation, index) => {
            const stmt = db.prepare(`
                INSERT INTO donations (
                    id, username, normalized_username, amount, time_earned, 
                    message, currency, is_realtime, frags_earned, 
                    custom_units_earned, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            stmt.run(
                donation.id,
                donation.username,
                donation.normalized_username,
                donation.amount,
                donation.time_earned,
                donation.message,
                'RUB',
                0, // is_realtime
                0, // frags_earned
                0, // custom_units_earned
                donation.created_at
            , (err) => {
                if (err) {
                    console.error(`❌ Ошибка добавления доната ${index + 1}:`, err);
                } else {
                    inserted++;
                    console.log(`✅ Донат ${index + 1} добавлен: ${donation.amount}₽, ${donation.time_earned} сек`);
                    
                    if (inserted === total) {
                        // Проверяем итоговую сумму
                        db.get(`
                            SELECT 
                                SUM(amount) as total_amount,
                                SUM(time_earned) as total_time_seconds,
                                COUNT(*) as donation_count
                            FROM donations 
                            WHERE username = ? OR normalized_username = ?
                        `, [username, normalizedUsername], (sumErr, row) => {
                            if (sumErr) {
                                console.error('❌ Ошибка проверки итогов:', sumErr);
                            } else {
                                console.log('\n📊 Итоговая статистика для Бетмен:');
                                console.log(`   Всего донатов: ${row.donation_count}`);
                                console.log(`   Общая сумма: ${Math.round(row.total_amount)}₽`);
                                console.log(`   Общее время: ${row.total_time_seconds} сек (${Math.round(row.total_time_seconds / 60)} мин, ${Math.round(row.total_time_seconds / 3600)} ч)`);
                            }
                            db.close();
                            console.log('\n✅ Готово! Донаты Бетмен добавлены в базу данных.');
                        });
                    }
                }
            });
            
            stmt.finalize();
        });
    }
});










