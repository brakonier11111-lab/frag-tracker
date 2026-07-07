const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = require('./src/bootstrap/paths').resolveDbPath();
const db = new sqlite3.Database(dbPath);

// 3 дня 4ч 55м = 3*86400 + 4*3600 + 55*60 = 259200 + 14400 + 3300 = 276900 секунд
const manualTimeSeconds = 3 * 86400 + 4 * 3600 + 55 * 60; // 276900 секунд

console.log(`⏰ Установка времени, добавленного вручную: ${manualTimeSeconds} секунд`);
console.log(`   Это равно: 3 дня 4 часа 55 минут`);

db.run(
    `UPDATE app_state SET timer_manual_time_added = ? WHERE id = 1`,
    [manualTimeSeconds],
    function(err) {
        if (err) {
            console.error('❌ Ошибка обновления:', err);
            db.close();
            return;
        }
        
        console.log(`✅ Значение timer_manual_time_added установлено: ${manualTimeSeconds} секунд`);
        
        // Проверяем, что значение установлено
        db.get(
            `SELECT timer_manual_time_added FROM app_state WHERE id = 1`,
            [],
            (err, row) => {
                if (err) {
                    console.error('❌ Ошибка проверки:', err);
                } else {
                    const days = Math.floor(row.timer_manual_time_added / 86400);
                    const hours = Math.floor((row.timer_manual_time_added % 86400) / 3600);
                    const minutes = Math.floor((row.timer_manual_time_added % 3600) / 60);
                    const seconds = row.timer_manual_time_added % 60;
                    
                    console.log(`\n📊 Проверка значения в БД:`);
                    console.log(`   timer_manual_time_added: ${row.timer_manual_time_added} секунд`);
                    console.log(`   Форматировано: ${days} д ${hours} ч ${minutes} м ${seconds} с`);
                }
                db.close();
                console.log('\n✅ Готово! Значение зафиксировано.');
                console.log('   Перезапустите сервер, чтобы изменения вступили в силу.');
            }
        );
    }
);










