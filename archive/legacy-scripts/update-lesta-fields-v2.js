const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

console.log('🔄 Обновление полей Lesta Games v2...');

db.serialize(() => {
    // Добавляем новые поля для детальной статистики
    const newFields = [
        'lesta_last_wins INTEGER',
        'lesta_last_losses INTEGER',
        'lesta_last_damage_received INTEGER',
        'lesta_last_max_frags INTEGER',
        'lesta_last_frags8p INTEGER',
        'lesta_last_hits INTEGER',
        'lesta_last_shots INTEGER',
        'lesta_last_spotted INTEGER',
        'lesta_last_capture_points INTEGER',
        'lesta_last_dropped_capture_points INTEGER',
        'lesta_last_survived_battles INTEGER',
        'lesta_last_win_and_survived INTEGER',
        'lesta_last_max_xp INTEGER',
        'lesta_token_expires_at INTEGER'
    ];

    newFields.forEach(field => {
        const [fieldName] = field.split(' ');
        db.run(`ALTER TABLE app_state ADD COLUMN ${field}`, (err) => {
            if (err) {
                console.log(`ℹ️ Поле ${fieldName} уже существует`);
            } else {
                console.log(`✅ Добавлено поле ${fieldName}`);
            }
        });
    });

    console.log('✅ Обновление полей Lesta Games v2 завершено');
});

db.close();

