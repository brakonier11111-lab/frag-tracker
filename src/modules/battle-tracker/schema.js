'use strict';

/** Миграции таблицы battle_sessions — вызывается из db.serialize в server.js */
function initBattleTrackerSchema(db) {
    db.run(`CREATE TABLE IF NOT EXISTS battle_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'active',
        my_nickname TEXT NOT NULL DEFAULT '',
        opponent_nickname TEXT NOT NULL,
        opponent_account_id TEXT NOT NULL,
        price TEXT NOT NULL DEFAULT '',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        winner TEXT,
        my_baseline_json TEXT NOT NULL DEFAULT '{}',
        opponent_baseline_json TEXT NOT NULL DEFAULT '{}',
        my_totals_json TEXT NOT NULL DEFAULT '{}',
        opponent_totals_json TEXT NOT NULL DEFAULT '{}',
        my_score REAL NOT NULL DEFAULT 0,
        opponent_score REAL NOT NULL DEFAULT 0,
        last_event_side TEXT,
        last_event_at DATETIME
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания таблицы battle_sessions:', err);
        else console.log('✅ Таблица battle_sessions готова');
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_battle_sessions_status ON battle_sessions(status)`, () => {});
}

module.exports = { initBattleTrackerSchema };
