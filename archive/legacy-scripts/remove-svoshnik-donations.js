const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Поиск донатов от СВОшник...\n');

// Сначала находим все донаты от СВОшник
db.all(
    `SELECT id, username, amount, time_earned, created_at 
     FROM donations 
     WHERE username LIKE '%СВОшник%' 
     ORDER BY created_at DESC`,
    (err, rows) => {
        if (err) {
            console.error('❌ Ошибка поиска донатов:', err);
            db.close();
            return;
        }

        if (rows.length === 0) {
            console.log('❌ Донаты не найдены');
            db.close();
            return;
        }

        console.log(`✅ Найдено донатов: ${rows.length}\n`);
        
        let totalAmount = 0;
        let totalTime = 0;
        
        rows.forEach((r, i) => {
            console.log(`${i + 1}. ID: ${r.id}`);
            console.log(`   Сумма: ${r.amount}₽`);
            console.log(`   Время: ${r.time_earned || 0}с`);
            console.log(`   Дата: ${r.created_at}\n`);
            totalAmount += r.amount || 0;
            totalTime += r.time_earned || 0;
        });

        console.log(`📊 Общая сумма: ${totalAmount}₽`);
        console.log(`📊 Общее время: ${totalTime}с\n`);

        // Находим донаты на сумму 14000₽ (скорее всего 2 по 7000₽)
        const targetAmount = 14000;
        const donationsToRemove = [];
        let currentSum = 0;

        // Берем самые последние донаты до достижения суммы 14000₽
        for (let i = 0; i < rows.length && currentSum < targetAmount; i++) {
            const donation = rows[i];
            if (currentSum + donation.amount <= targetAmount) {
                donationsToRemove.push(donation);
                currentSum += donation.amount;
            }
        }

        if (donationsToRemove.length === 0) {
            console.log('❌ Не найдено донатов на сумму 14000₽');
            db.close();
            return;
        }

        console.log(`\n🗑️ Будет удалено донатов: ${donationsToRemove.length}`);
        let removeAmount = 0;
        let removeTime = 0;
        
        donationsToRemove.forEach((d, i) => {
            console.log(`   ${i + 1}. ID: ${d.id}, Сумма: ${d.amount}₽, Время: ${d.time_earned || 0}с`);
            removeAmount += d.amount || 0;
            removeTime += d.time_earned || 0;
        });

        console.log(`\n📊 Итого будет удалено: ${removeAmount}₽, ${removeTime}с\n`);

        // Получаем текущее состояние
        db.get('SELECT timer_seconds, total_donated FROM app_state WHERE id = 1', (err, state) => {
            if (err) {
                console.error('❌ Ошибка получения состояния:', err);
                db.close();
                return;
            }

            const currentTimerSeconds = state.timer_seconds || 0;
            const currentTotalDonated = state.total_donated || 0;

            const newTimerSeconds = Math.max(0, currentTimerSeconds - removeTime);
            const newTotalDonated = Math.max(0, currentTotalDonated - removeAmount);

            console.log('📊 Текущее состояние:');
            console.log(`   Таймер: ${currentTimerSeconds}с`);
            console.log(`   Всего донатов: ${currentTotalDonated}₽\n`);

            console.log('📊 Новое состояние после удаления:');
            console.log(`   Таймер: ${newTimerSeconds}с (было ${currentTimerSeconds}с, убрали ${removeTime}с)`);
            console.log(`   Всего донатов: ${newTotalDonated}₽ (было ${currentTotalDonated}₽, убрали ${removeAmount}₽)\n`);

            // Удаляем донаты
            const donationIds = donationsToRemove.map(d => d.id);
            const placeholders = donationIds.map(() => '?').join(',');
            
            db.run(`DELETE FROM donations WHERE id IN (${placeholders})`, donationIds, function(err) {
                if (err) {
                    console.error('❌ Ошибка удаления донатов:', err);
                    db.close();
                    return;
                }

                console.log(`✅ Удалено донатов: ${this.changes}\n`);

                // Обновляем состояние приложения
                db.run(
                    'UPDATE app_state SET timer_seconds = ?, total_donated = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
                    [newTimerSeconds, newTotalDonated],
                    function(err) {
                        if (err) {
                            console.error('❌ Ошибка обновления состояния:', err);
                            db.close();
                            return;
                        }

                        console.log('✅ Состояние приложения обновлено');
                        console.log(`   Таймер: ${newTimerSeconds}с`);
                        console.log(`   Всего донатов: ${newTotalDonated}₽\n`);
                        console.log('✅ Готово! Донаты удалены, время и сумма вычтены.\n');

                        db.close();
                    }
                );
            });
        });
    }
);




