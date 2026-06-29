#!/usr/bin/env node

/**
 * Скрипт для исправления дубликатов уровней достижений
 * Удаляет все дубликаты, оставляя только одну запись с минимальным id для каждого sort_order
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'frag_tracker.db');

if (!fs.existsSync(dbPath)) {
    console.log('❌ База данных не найдена:', dbPath);
    process.exit(1);
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Ошибка подключения к БД:', err);
        process.exit(1);
    }
    console.log('✅ Подключено к базе данных');
});

// Функция для исправления дубликатов
function fixDuplicateTiers() {
    console.log('🔄 Начинаем исправление дубликатов уровней...\n');
    
    return new Promise((resolve, reject) => {
        // Находим все дубликаты по sort_order
        db.all(`
            SELECT sort_order, COUNT(*) as count, GROUP_CONCAT(id) as ids
            FROM donor_achievement_tiers
            GROUP BY sort_order
            HAVING COUNT(*) > 1
        `, (err, duplicates) => {
            if (err) {
                console.error('❌ Ошибка поиска дубликатов:', err);
                return reject(err);
            }
            
            if (duplicates.length === 0) {
                console.log('✅ Дубликатов не найдено');
                return resolve();
            }
            
            console.log(`📊 Найдено ${duplicates.length} уровней с дубликатами:\n`);
            
            let processed = 0;
            const total = duplicates.length;
            let deletedCount = 0;
            
            duplicates.forEach((dup, index) => {
                const sortOrder = dup.sort_order;
                const count = dup.count;
                const ids = dup.ids.split(',').map(id => parseInt(id)).sort((a, b) => a - b);
                
                console.log(`  ${index + 1}. sort_order=${sortOrder}: ${count} записей (ID: ${ids.join(', ')})`);
                
                // Оставляем только первую запись (с минимальным id), удаляем остальные
                const idsToDelete = ids.slice(1); // Все кроме первого
                deletedCount += idsToDelete.length;
                
                if (idsToDelete.length > 0) {
                    const placeholders = idsToDelete.map(() => '?').join(',');
                    db.run(`DELETE FROM donor_achievement_tiers WHERE id IN (${placeholders})`, 
                        idsToDelete, 
                        (deleteErr) => {
                            if (deleteErr) {
                                console.error(`  ❌ Ошибка удаления для sort_order=${sortOrder}:`, deleteErr);
                            } else {
                                console.log(`  ✅ Оставлена запись ID=${ids[0]}, удалено ${idsToDelete.length} дубликатов`);
                            }
                            
                            processed++;
                            if (processed === total) {
                                console.log(`\n✅ Очистка завершена! Удалено ${deletedCount} дубликатов`);
                                resolve();
                            }
                        }
                    );
                } else {
                    processed++;
                    if (processed === total) {
                        console.log(`\n✅ Очистка завершена! Удалено ${deletedCount} дубликатов`);
                        resolve();
                    }
                }
            });
        });
    });
}

// Выполняем исправление
fixDuplicateTiers()
    .then(() => {
        // Проверяем результат
        db.all(`
            SELECT sort_order, COUNT(*) as count
            FROM donor_achievement_tiers
            GROUP BY sort_order
            HAVING COUNT(*) > 1
        `, (err, remaining) => {
            if (err) {
                console.error('❌ Ошибка проверки:', err);
            } else if (remaining.length > 0) {
                console.log(`\n⚠️ Осталось ${remaining.length} уровней с дубликатами`);
                remaining.forEach(dup => {
                    console.log(`   - sort_order=${dup.sort_order}: ${dup.count} записей`);
                });
            } else {
                console.log('\n✅ Все дубликаты успешно удалены!');
            }
            
            // Показываем итоговое количество уровней
            db.all('SELECT COUNT(*) as total FROM donor_achievement_tiers', (err, result) => {
                if (!err && result && result[0]) {
                    console.log(`\n📊 Итого уровней в базе: ${result[0].total}`);
                }
                
                db.close((err) => {
                    if (err) {
                        console.error('❌ Ошибка закрытия БД:', err);
                        process.exit(1);
                    }
                    process.exit(0);
                });
            });
        });
    })
    .catch((err) => {
        console.error('\n❌ Ошибка исправления:', err);
        db.close();
        process.exit(1);
    });

