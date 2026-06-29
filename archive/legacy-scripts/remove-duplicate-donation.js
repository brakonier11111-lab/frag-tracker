const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Поиск дубликатов доната от СВОшник на 7000₽...\n');

// Сначала находим все донаты от СВОшник на 7000₽
db.all(
    `SELECT id, username, amount, time_earned, created_at 
     FROM donations 
     WHERE username LIKE '%СВОшник%' AND amount = 7000 
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
        rows.forEach((r, i) => {
            console.log(`${i + 1}. ID: ${r.id}`);
            console.log(`   Сумма: ${r.amount}₽`);
            console.log(`   Время добавлено: ${r.time_earned}с`);
            console.log(`   Дата: ${r.created_at}\n`);
        });

        // Если есть дубликаты, удаляем последний (самый новый)
        if (rows.length > 1) {
            const duplicateDonation = rows[0]; // Самый новый донат
            console.log(`\n🗑️ Удаляем дубликат: ID ${duplicateDonation.id}`);
            console.log(`   Сумма: ${duplicateDonation.amount}₽`);
            console.log(`   Время: ${duplicateDonation.time_earned}с\n`);

            // Получаем текущее состояние приложения
            db.get('SELECT timer_seconds, total_donated FROM app_state WHERE id = 1', (err, state) => {
                if (err) {
                    console.error('❌ Ошибка получения состояния:', err);
                    db.close();
                    return;
                }

                const currentTimerSeconds = state.timer_seconds || 0;
                const currentTotalDonated = state.total_donated || 0;
                const timeToRemove = duplicateDonation.time_earned || 0;
                const amountToRemove = duplicateDonation.amount || 0;

                const newTimerSeconds = Math.max(0, currentTimerSeconds - timeToRemove);
                const newTotalDonated = Math.max(0, currentTotalDonated - amountToRemove);

                console.log('📊 Текущее состояние:');
                console.log(`   Таймер: ${currentTimerSeconds}с`);
                console.log(`   Всего донатов: ${currentTotalDonated}₽\n`);

                console.log('📊 Новое состояние после удаления:');
                console.log(`   Таймер: ${newTimerSeconds}с (было ${currentTimerSeconds}с, убрали ${timeToRemove}с)`);
                console.log(`   Всего донатов: ${newTotalDonated}₽ (было ${currentTotalDonated}₽, убрали ${amountToRemove}₽)\n`);

                // Удаляем донат
                db.run('DELETE FROM donations WHERE id = ?', [duplicateDonation.id], function(err) {
                    if (err) {
                        console.error('❌ Ошибка удаления доната:', err);
                        db.close();
                        return;
                    }

                    console.log(`✅ Донат удален (ID: ${duplicateDonation.id})\n`);

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
                            console.log('✅ Готово! Дубликат удален, время и сумма вычтены.\n');

                            db.close();
                        }
                    );
                });
            });
        } else {
            console.log('ℹ️ Дубликатов не найдено, только один донат');
            db.close();
        }
    }
);




