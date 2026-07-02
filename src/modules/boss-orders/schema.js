'use strict';

/** Миграции таблиц boss_orders — вызывается из db.serialize в server.js */
function initBossOrdersSchema(db) {
    db.run(`CREATE TABLE IF NOT EXISTS boss_orders_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        threshold_amount REAL NOT NULL DEFAULT 500,
        header_text TEXT NOT NULL DEFAULT 'ПРИКАЗ ОТ ЗРИТЕЛЯ',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы boss_orders_config:', err);
            return;
        }
        db.run('INSERT OR IGNORE INTO boss_orders_config (id) VALUES (1)', (e) => {
            if (e) console.error('❌ Ошибка инициализации boss_orders_config:', e);
        });
    });

    db.run(`CREATE TABLE IF NOT EXISTS boss_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        donation_id TEXT,
        username TEXT NOT NULL,
        normalized_username TEXT,
        amount REAL NOT NULL DEFAULT 0,
        order_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания таблицы boss_orders:', err);
    });
    db.run('CREATE INDEX IF NOT EXISTS idx_boss_orders_status ON boss_orders(status)', () => {});
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_boss_orders_donation_id ON boss_orders(donation_id)', () => {});
}

module.exports = { initBossOrdersSchema };
