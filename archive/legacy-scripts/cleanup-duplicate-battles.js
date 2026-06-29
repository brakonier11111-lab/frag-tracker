const sqlite3 = require('sqlite3').verbose();

console.log('🧹 Очистка дублированных боев в статистике фрагов\n');

const db = new sqlite3.Database('./frag_tracker.db');

// Получаем все записи для анализа
db.all('SELECT * FROM frag_stats ORDER BY battle_time DESC', (err, rows) => {
    if (err) {
        console.error('❌ Ошибка получения данных:', err);
        db.close();
        return;
    }
    
    console.log(`📊 Найдено записей: ${rows.length}`);
    
    if (rows.length === 0) {
        console.log('✅ Нет данных для очистки');
        db.close();
        return;
    }
    
    // Группируем записи по времени (с точностью до минуты)
    const groupedBattles = {};
    const duplicates = [];
    
    rows.forEach(row => {
        const battleTime = new Date(row.battle_time);
        // Группируем по минутам
        const timeKey = `${battleTime.getFullYear()}-${String(battleTime.getMonth() + 1).padStart(2, '0')}-${String(battleTime.getDate()).padStart(2, '0')} ${String(battleTime.getHours()).padStart(2, '0')}:${String(battleTime.getMinutes()).padStart(2, '0')}`;
        
        if (!groupedBattles[timeKey]) {
            groupedBattles[timeKey] = [];
        }
        groupedBattles[timeKey].push(row);
    });
    
    // Находим дубликаты
    Object.keys(groupedBattles).forEach(timeKey => {
        const battles = groupedBattles[timeKey];
        if (battles.length > 1) {
            console.log(`\n🔄 Найдены дубликаты в ${timeKey}:`);
            battles.forEach((battle, index) => {
                console.log(`   ${index + 1}. ID: ${battle.id}, Фраги: ${battle.frags}, Время: ${battle.battle_time}`);
            });
            
            // Оставляем запись с наибольшим количеством фрагов, остальные помечаем как дубликаты
            const sortedBattles = battles.sort((a, b) => b.frags - a.frags);
            const keepBattle = sortedBattles[0];
            
            console.log(`   ✅ Оставляем: ID ${keepBattle.id} с ${keepBattle.frags} фрагами`);
            
            // Помечаем остальные как дубликаты
            for (let i = 1; i < sortedBattles.length; i++) {
                duplicates.push(sortedBattles[i].id);
                console.log(`   ❌ Удаляем: ID ${sortedBattles[i].id} с ${sortedBattles[i].frags} фрагами`);
            }
        }
    });
    
    if (duplicates.length === 0) {
        console.log('\n✅ Дубликатов не найдено');
        db.close();
        return;
    }
    
    console.log(`\n🗑️ Найдено дубликатов для удаления: ${duplicates.length}`);
    
    // Подтверждение удаления
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    rl.question('\n❓ Удалить дубликаты? (y/N): ', (answer) => {
        rl.close();
        
        if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
            console.log('❌ Операция отменена');
            db.close();
            return;
        }
        
        // Удаляем дубликаты
        const placeholders = duplicates.map(() => '?').join(',');
        const deleteQuery = `DELETE FROM frag_stats WHERE id IN (${placeholders})`;
        
        db.run(deleteQuery, duplicates, function(err) {
            if (err) {
                console.error('❌ Ошибка удаления дубликатов:', err);
            } else {
                console.log(`✅ Удалено дубликатов: ${this.changes}`);
                
                // Проверяем результат
                db.all('SELECT COUNT(*) as count, SUM(frags) as total_frags FROM frag_stats', (err, stats) => {
                    if (err) {
                        console.error('❌ Ошибка проверки результата:', err);
                    } else {
                        console.log('\n📊 Результат очистки:');
                        console.log(`   Всего записей: ${stats[0].count}`);
                        console.log(`   Всего фрагов: ${stats[0].total_frags || 0}`);
                    }
                    
                    db.close();
                });
            }
        });
    });
});

