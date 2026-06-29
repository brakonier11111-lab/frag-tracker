const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Подключение к базе данных
const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

console.log('🚀 Инициализация стартовых значений статистики');
console.log('📊 Данные: 19 боев, 37 фрагов, 4 боя без фрагов');

// Параметры инициализации
const totalBattles = 19;
const totalFrags = 37;
const battlesWithoutFrags = 4;

// Расчеты
const battlesWithFrags = totalBattles - battlesWithoutFrags;
const fragsPerBattle = battlesWithFrags > 0 ? Math.floor(totalFrags / battlesWithFrags) : 0;
const remainingFrags = totalFrags - (fragsPerBattle * battlesWithFrags);

console.log('\n📈 Расчеты:');
console.log(`   Всего боев: ${totalBattles}`);
console.log(`   Боев с фрагами: ${battlesWithFrags}`);
console.log(`   Боев без фрагов: ${battlesWithoutFrags}`);
console.log(`   Всего фрагов: ${totalFrags}`);
console.log(`   Фрагов за бой: ${fragsPerBattle}`);
console.log(`   Остаток фрагов: ${remainingFrags}`);

console.log('\n🎯 Распределение:');
if (battlesWithFrags > 0) {
    console.log(`   • ${battlesWithFrags} боев с фрагами:`);
    console.log(`     - 1-й бой: ${fragsPerBattle + remainingFrags} фрагов`);
    if (battlesWithFrags > 1) {
        console.log(`     - ${battlesWithFrags - 1} боев: по ${fragsPerBattle} фрагов`);
    }
}
if (battlesWithoutFrags > 0) {
    console.log(`   • ${battlesWithoutFrags} боев: по 0 фрагов`);
}

// Очищаем существующую статистику
db.run('DELETE FROM frag_stats', (err) => {
    if (err) {
        console.error('❌ Ошибка очистки статистики:', err);
        process.exit(1);
    }
    
    console.log('\n✅ Статистика очищена');
    
    // Записываем бои
    let completedBattles = 0;
    const totalBattlesToProcess = totalBattles;
    
    function addBattle(battleIndex, frags) {
        const battleTime = new Date(Date.now() - (totalBattlesToProcess - battleIndex) * 60000).toISOString();
        
        db.run(
            'INSERT INTO frag_stats (battle_time, frags) VALUES (?, ?)',
            [battleTime, frags],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка записи боя:', err);
                    process.exit(1);
                }
                
                completedBattles++;
                console.log(`✅ Записан бой ${battleIndex}/${totalBattlesToProcess}: ${frags} фрагов`);
                
                if (completedBattles === totalBattlesToProcess) {
                    // Обновляем состояние Lesta Games
                    db.run(
                        `UPDATE app_state SET 
                            lesta_last_battles = ?, 
                            lesta_last_frags = ?,
                            lesta_previous_frags = ?
                        WHERE id = 1`,
                        [totalBattles, totalFrags, totalFrags],
                        function(err) {
                            if (err) {
                                console.error('❌ Ошибка обновления состояния:', err);
                                process.exit(1);
                            }
                            
                            console.log('\n✅ Состояние Lesta Games обновлено');
                            console.log('\n🎉 ИНИЦИАЛИЗАЦИЯ ЗАВЕРШЕНА!');
                            console.log('\n📊 Созданная статистика:');
                            console.log(`   Всего боев: ${totalBattles}`);
                            console.log(`   Всего фрагов: ${totalFrags}`);
                            console.log(`   Боев с фрагами: ${battlesWithFrags}`);
                            console.log(`   Боев без фрагов: ${battlesWithoutFrags}`);
                            console.log(`   Фрагов за бой: ${fragsPerBattle}`);
                            console.log(`   Остаток фрагов: ${remainingFrags}`);
                            console.log('\n🚀 Система готова к работе!');
                            
                            db.close();
                        }
                    );
                }
            }
        );
    }
    
    // Записываем бои с фрагами
    for (let i = 0; i < battlesWithFrags; i++) {
        let frags = fragsPerBattle;
        if (i === 0 && remainingFrags > 0) {
            frags += remainingFrags; // Добавляем остаток к первому бою
        }
        addBattle(i + 1, frags);
    }
    
    // Записываем бои без фрагов
    for (let i = 0; i < battlesWithoutFrags; i++) {
        addBattle(battlesWithFrags + i + 1, 0);
    }
});

