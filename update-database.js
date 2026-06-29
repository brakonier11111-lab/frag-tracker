#!/usr/bin/env node

/**
 * Скрипт для обновления базы данных
 * Добавляет недостающие поля в существующие таблицы
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

// Функция для проверки существования колонки
function columnExists(tableName, columnName, callback) {
    db.all(`PRAGMA table_info(${tableName})`, (err, columns) => {
        if (err) {
            return callback(err, false);
        }
        const exists = columns.some(col => col.name === columnName);
        callback(null, exists);
    });
}

// Обновление базы данных
async function updateDatabase() {
    console.log('🔄 Начинаем обновление базы данных...\n');
    
    return new Promise((resolve, reject) => {
        let completed = 0;
        const total = 3;
        
        function checkComplete(err) {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('❌ Ошибка:', err.message);
            }
            completed++;
            if (completed === total) {
                resolve();
            }
        }
        
        // Проверяем и добавляем custom_icon_url в donor_achievement_tiers
        columnExists('donor_achievement_tiers', 'custom_icon_url', (err, exists) => {
            if (err) {
                console.warn('⚠️ Не удалось проверить таблицу donor_achievement_tiers, пропускаем...');
                checkComplete(null);
            } else if (exists) {
                console.log('✅ Колонка donor_achievement_tiers.custom_icon_url уже существует');
                checkComplete(null);
            } else {
                db.run(`ALTER TABLE donor_achievement_tiers ADD COLUMN custom_icon_url TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                        checkComplete(err);
                    } else {
                        console.log('✅ Колонка donor_achievement_tiers.custom_icon_url успешно добавлена');
                        checkComplete(null);
                    }
                });
            }
        });
        
        // Проверяем и добавляем timer_discount в app_state
        columnExists('app_state', 'timer_discount', (err, exists) => {
            if (err) {
                console.warn('⚠️ Не удалось проверить таблицу app_state, пропускаем...');
                checkComplete(null);
            } else if (exists) {
                console.log('✅ Колонка app_state.timer_discount уже существует');
                checkComplete(null);
            } else {
                db.run(`ALTER TABLE app_state ADD COLUMN timer_discount INTEGER DEFAULT 0`, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                        checkComplete(err);
                    } else {
                        console.log('✅ Колонка app_state.timer_discount успешно добавлена');
                        checkComplete(null);
                    }
                });
            }
        });
        
        // Проверяем и добавляем stream_timer_started_ts
        columnExists('app_state', 'stream_timer_started_ts', (err, exists) => {
            if (err) {
                console.warn('⚠️ Не удалось проверить stream_timer_started_ts, пропускаем...');
                checkComplete(null);
            } else if (exists) {
                console.log('✅ Колонка app_state.stream_timer_started_ts уже существует');
                checkComplete(null);
            } else {
                db.run(`ALTER TABLE app_state ADD COLUMN stream_timer_started_ts INTEGER DEFAULT 0`, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                        checkComplete(err);
                    } else {
                        console.log('✅ Колонка app_state.stream_timer_started_ts успешно добавлена');
                        checkComplete(null);
                    }
                });
            }
        });
    });
}

// Выполняем обновление
updateDatabase()
    .then(() => {
        console.log('\n✅ Обновление базы данных завершено успешно!');
        db.close((err) => {
            if (err) {
                console.error('❌ Ошибка закрытия БД:', err);
                process.exit(1);
            }
            process.exit(0);
        });
    })
    .catch((err) => {
        console.error('\n❌ Ошибка обновления базы данных:', err);
        db.close();
        process.exit(1);
    });

