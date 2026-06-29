#!/usr/bin/env node

/**
 * Скрипт для очистки дубликатов уровней достижений в базе данных
 * Оставляет только одну запись для каждого уникального уровня
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

// Функция для очистки дубликатов уровней
function cleanupDuplicateTiers() {
    console.log('🔄 Начинаем очистку дубликатов уровней...\n');
    
    return new Promise((resolve, reject) => {
        // Сначала проверяем, есть ли дубликаты по sort_order
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
                console.log('✅ Дубликатов уровней не найдено');
                return resolve();
            }
            
            console.log(`📊 Найдено ${duplicates.length} уровней с дубликатами:\n`);
            
            let processed = 0;
            const total = duplicates.length;
            
            duplicates.forEach((dup, index) => {
                const sortOrder = dup.sort_order;
                const count = dup.count;
                const ids = dup.ids.split(',').map(id => parseInt(id));
                
                console.log(`  ${index + 1}. Уровень с sort_order=${sortOrder}: ${count} записей (ID: ${ids.join(', ')})`);
                
                // Оставляем только первую запись (с минимальным id), удаляем остальные
                const idsToDelete = ids.slice(1); // Все кроме первого
                
                if (idsToDelete.length > 0) {
                    const placeholders = idsToDelete.map(() => '?').join(',');
                    db.run(`DELETE FROM donor_achievement_tiers WHERE id IN (${placeholders})`, 
                        idsToDelete, 
                        (deleteErr) => {
                            if (deleteErr) {
                                console.error(`  ❌ Ошибка удаления дубликатов для sort_order=${sortOrder}:`, deleteErr);
                            } else {
                                console.log(`  ✅ Оставлена только одна запись для sort_order=${sortOrder} (ID: ${ids[0]})`);
                            }
                            
                            processed++;
                            if (processed === total) {
                                console.log('\n✅ Очистка завершена!');
                                resolve();
                            }
                        }
                    );
                } else {
                    processed++;
                    if (processed === total) {
                        console.log('\n✅ Очистка завершена!');
                        resolve();
                    }
                }
            });
        });
    });
}

// Выполняем очистку
cleanupDuplicateTiers()
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
            } else {
                console.log('\n✅ Все дубликаты уровней успешно удалены!');
            }
            
            db.close((err) => {
                if (err) {
                    console.error('❌ Ошибка закрытия БД:', err);
                    process.exit(1);
                }
                process.exit(0);
            });
        });
    })
    .catch((err) => {
        console.error('\n❌ Ошибка очистки:', err);
        db.close();
        process.exit(1);
    });

