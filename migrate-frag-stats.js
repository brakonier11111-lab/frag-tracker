const sqlite3 = require('sqlite3').verbose();

console.log('🔄 Миграция статистики фрагов для учета всех боев от Lesta API\n');

const db = new sqlite3.Database('./frag_tracker.db');

// Получаем текущую статистику Lesta Games
db.get('SELECT lesta_last_battles, lesta_last_frags FROM app_state WHERE id = 1', (err, row) => {
    if (err) {
        console.error('❌ Ошибка получения данных Lesta:', err);
        db.close();
        return;
    }
    
    if (!row || !row.lesta_last_battles) {
        console.log('⚠️ Нет данных Lesta Games для миграции');
        db.close();
        return;
    }
    
    const totalLestaBattles = row.lesta_last_battles;
    const totalLestaFrags = row.lesta_last_frags || 0;
    
    console.log(`📊 Найдено данных Lesta Games:`);
    console.log(`   Всего боев: ${totalLestaBattles}`);
    console.log(`   Всего фрагов: ${totalLestaFrags}`);
    
    // Получаем текущую статистику фрагов
    db.all('SELECT COUNT(*) as count, SUM(frags) as total_frags FROM frag_stats', (err, stats) => {
        if (err) {
            console.error('❌ Ошибка получения статистики фрагов:', err);
            db.close();
            return;
        }
        
        const currentBattles = stats[0].count || 0;
        const currentFrags = stats[0].total_frags || 0;
        
        console.log(`📊 Текущая статистика фрагов:`);
        console.log(`   Записей в БД: ${currentBattles}`);
        console.log(`   Всего фрагов: ${currentFrags}`);
        
        // Вычисляем количество боев без фрагов
        const battlesWithoutFrags = totalLestaBattles - currentBattles;
        
        console.log(`\n🔍 Анализ:`);
        console.log(`   Боев с фрагами: ${currentBattles}`);
        console.log(`   Боев без фрагов: ${battlesWithoutFrags}`);
        console.log(`   Всего боев Lesta: ${totalLestaBattles}`);
        
        if (battlesWithoutFrags > 0) {
            console.log(`\n➕ Добавляем ${battlesWithoutFrags} боев без фрагов...`);
            
            // Добавляем бои без фрагов
            const stmt = db.prepare('INSERT INTO frag_stats (battle_time, frags) VALUES (?, ?)');
            
            for (let i = 0; i < battlesWithoutFrags; i++) {
                // Используем текущее время минус случайное количество минут для имитации прошлых боев
                const battleTime = new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString();
                stmt.run(battleTime, 0);
            }
            
            stmt.finalize((err) => {
                if (err) {
                    console.error('❌ Ошибка добавления боев без фрагов:', err);
                } else {
                    console.log(`✅ Успешно добавлено ${battlesWithoutFrags} боев без фрагов`);
                    
                    // Проверяем результат
                    db.all('SELECT COUNT(*) as count, SUM(frags) as total_frags FROM frag_stats', (err, finalStats) => {
                        if (err) {
                            console.error('❌ Ошибка проверки результата:', err);
                        } else {
                            console.log(`\n📊 Результат миграции:`);
                            console.log(`   Всего записей: ${finalStats[0].count}`);
                            console.log(`   Всего фрагов: ${finalStats[0].total_frags}`);
                            console.log(`   Боев с фрагами: ${finalStats[0].total_frags > 0 ? Math.floor(finalStats[0].total_frags) : 0}`);
                            console.log(`   Боев без фрагов: ${finalStats[0].count - (finalStats[0].total_frags > 0 ? Math.floor(finalStats[0].total_frags) : 0)}`);
                        }
                        
                        db.close();
                    });
                }
            });
        } else {
            console.log(`\n✅ Миграция не требуется - все бои уже учтены`);
            db.close();
        }
    });
});

