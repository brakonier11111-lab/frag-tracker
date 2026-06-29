const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Подключение к базе данных
const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

console.log('✏️ Ручное редактирование статистики');
console.log('📊 Вы можете изменить количество боев, фрагов и боев без фрагов');

// Получаем текущую статистику
function getCurrentStats() {
    return new Promise((resolve, reject) => {
        db.all('SELECT frags FROM frag_stats', (err, rows) => {
            if (err) {
                reject(err);
                return;
            }
            
            const totalBattles = rows.length;
            const totalFrags = rows.reduce((sum, row) => sum + row.frags, 0);
            const battlesWithoutFrags = rows.filter(row => row.frags === 0).length;
            
            resolve({
                totalBattles,
                totalFrags,
                battlesWithoutFrags
            });
        });
    });
}

// Редактируем статистику
function editStats(totalBattles, totalFrags, battlesWithoutFrags) {
    return new Promise((resolve, reject) => {
        // Рассчитываем распределение боев
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
                reject(err);
                return;
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
                            reject(err);
                            return;
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
                                        reject(err);
                                        return;
                                    }
                                    
                                    console.log('\n✅ Состояние Lesta Games обновлено');
                                    console.log('\n🎉 РЕДАКТИРОВАНИЕ ЗАВЕРШЕНО!');
                                    console.log('\n📊 Обновленная статистика:');
                                    console.log(`   Всего боев: ${totalBattles}`);
                                    console.log(`   Всего фрагов: ${totalFrags}`);
                                    console.log(`   Боев с фрагами: ${battlesWithFrags}`);
                                    console.log(`   Боев без фрагов: ${battlesWithoutFrags}`);
                                    console.log(`   Фрагов за бой: ${fragsPerBattle}`);
                                    console.log(`   Остаток фрагов: ${remainingFrags}`);
                                    console.log('\n🚀 Система готова к работе!');
                                    
                                    resolve({
                                        totalBattles,
                                        totalFrags,
                                        battlesWithFrags,
                                        battlesWithoutFrags,
                                        fragsPerBattle,
                                        remainingFrags
                                    });
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
    });
}

// Основная функция
async function main() {
    try {
        // Получаем текущую статистику
        const currentStats = await getCurrentStats();
        
        console.log('\n📊 Текущая статистика:');
        console.log(`   Всего боев: ${currentStats.totalBattles}`);
        console.log(`   Всего фрагов: ${currentStats.totalFrags}`);
        console.log(`   Боев без фрагов: ${currentStats.battlesWithoutFrags}`);
        
        // Параметры для редактирования (можно изменить)
        const newTotalBattles = 25;  // Новое количество боев
        const newTotalFrags = 50;    // Новое количество фрагов
        const newBattlesWithoutFrags = 5;  // Новое количество боев без фрагов
        
        console.log('\n✏️ Новые значения:');
        console.log(`   Всего боев: ${newTotalBattles}`);
        console.log(`   Всего фрагов: ${newTotalFrags}`);
        console.log(`   Боев без фрагов: ${newBattlesWithoutFrags}`);
        
        // Проверяем корректность данных
        if (newBattlesWithoutFrags > newTotalBattles) {
            console.error('❌ Ошибка: Количество боев без фрагов не может быть больше общего количества боев');
            process.exit(1);
        }
        
        if (newTotalFrags < 0) {
            console.error('❌ Ошибка: Количество фрагов не может быть отрицательным');
            process.exit(1);
        }
        
        // Редактируем статистику
        await editStats(newTotalBattles, newTotalFrags, newBattlesWithoutFrags);
        
        db.close();
        
    } catch (error) {
        console.error('❌ Ошибка:', error);
        db.close();
        process.exit(1);
    }
}

// Запуск
main();

