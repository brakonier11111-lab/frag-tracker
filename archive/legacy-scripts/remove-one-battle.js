const sqlite3 = require('sqlite3').verbose();

console.log('🗑️ Удаление одного боя без фрагов из статистики\n');

const db = new sqlite3.Database('./frag_tracker.db');

// Находим самый последний бой без фрагов
db.get(`
    SELECT id, battle_time, frags 
    FROM frag_stats 
    WHERE frags = 0 
    ORDER BY battle_time DESC 
    LIMIT 1
`, (err, row) => {
    if (err) {
        console.error('❌ Ошибка поиска боя без фрагов:', err);
        db.close();
        return;
    }
    
    if (!row) {
        console.log('✅ Боев без фрагов не найдено');
        db.close();
        return;
    }
    
    console.log('🔍 Найден бой без фрагов:');
    console.log(`   ID: ${row.id}`);
    console.log(`   Время: ${row.battle_time}`);
    console.log(`   Фраги: ${row.frags}`);
    
    // Удаляем этот бой
    db.run('DELETE FROM frag_stats WHERE id = ?', [row.id], function(err) {
        if (err) {
            console.error('❌ Ошибка удаления боя:', err);
        } else {
            console.log(`✅ Бой успешно удален (ID: ${row.id})`);
            
            // Проверяем результат
            db.all('SELECT COUNT(*) as count, SUM(frags) as total_frags FROM frag_stats', (err, stats) => {
                if (err) {
                    console.error('❌ Ошибка проверки результата:', err);
                } else {
                    console.log('\n📊 Результат:');
                    console.log(`   Всего записей: ${stats[0].count}`);
                    console.log(`   Всего фрагов: ${stats[0].total_frags || 0}`);
                    
                    // Проверяем сколько боев без фрагов осталось
                    db.get('SELECT COUNT(*) as count FROM frag_stats WHERE frags = 0', (err, zeroFrags) => {
                        if (err) {
                            console.error('❌ Ошибка проверки боев без фрагов:', err);
                        } else {
                            console.log(`   Боев без фрагов: ${zeroFrags.count}`);
                        }
                        db.close();
                    });
                }
            });
        }
    });
});

