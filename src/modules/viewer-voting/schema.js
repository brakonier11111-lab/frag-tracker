'use strict';

/** Миграции таблиц голосований зрителей — вызывается из db.serialize в server.js */
function initViewerVotingSchema(db) {
    db.run(`CREATE TABLE IF NOT EXISTS voting_polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        platforms TEXT NOT NULL DEFAULT 'vkplay,twitch,youtube',
        last_chat_message_id INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        activated_at DATETIME,
        closed_at DATETIME
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания таблицы voting_polls:', err);
        else console.log('✅ Таблица voting_polls готова');
    });

    db.run(`CREATE TABLE IF NOT EXISTS voting_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        keyword TEXT NOT NULL,
        image_url TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        votes_count INTEGER NOT NULL DEFAULT 0
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания таблицы voting_options:', err);
        else console.log('✅ Таблица voting_options готова');
    });

    db.run(`CREATE TABLE IF NOT EXISTS voting_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER NOT NULL,
        option_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(poll_id, platform, user_id)
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания таблицы voting_votes:', err);
        else console.log('✅ Таблица voting_votes готова');
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_voting_options_poll ON voting_options(poll_id)`, () => {});
    db.run(`CREATE INDEX IF NOT EXISTS idx_voting_votes_poll ON voting_votes(poll_id)`, () => {});
    db.run(`CREATE INDEX IF NOT EXISTS idx_voting_polls_status ON voting_polls(status)`, () => {});
}

module.exports = { initViewerVotingSchema };
