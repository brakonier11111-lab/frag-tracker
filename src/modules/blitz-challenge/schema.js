'use strict';

const { BLITZ_DEFAULT_HEADERS } = require('./constants');

/** Миграции таблиц blitz_challenge — вызывается из db.serialize в server.js */
function initBlitzChallengeSchema(db) {
    db.run(`CREATE TABLE IF NOT EXISTS blitz_challenge (
        id INTEGER PRIMARY KEY DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        session_balance REAL NOT NULL DEFAULT 0,
        wr_enabled INTEGER NOT NULL DEFAULT 1,
        wr_start REAL NOT NULL DEFAULT 60,
        wr_current REAL NOT NULL DEFAULT 60,
        wr_cap REAL NOT NULL DEFAULT 85,
        wr_per_amount REAL NOT NULL DEFAULT 100,
        wr_step REAL NOT NULL DEFAULT 1,
        dmg_enabled INTEGER NOT NULL DEFAULT 1,
        dmg_start REAL NOT NULL DEFAULT 2000,
        dmg_current REAL NOT NULL DEFAULT 2000,
        dmg_cap REAL NOT NULL DEFAULT 5000,
        dmg_per_amount REAL NOT NULL DEFAULT 100,
        dmg_step REAL NOT NULL DEFAULT 100,
        medals_enabled INTEGER NOT NULL DEFAULT 1,
        medals_required REAL NOT NULL DEFAULT 1,
        medals_start REAL NOT NULL DEFAULT 1,
        medals_cap REAL NOT NULL DEFAULT 12,
        medals_per_amount REAL NOT NULL DEFAULT 200,
        medals_step REAL NOT NULL DEFAULT 1,
        medals_types TEXT NOT NULL DEFAULT '[]',
        medals_baseline TEXT NOT NULL DEFAULT '{}',
        medals_earned INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы blitz_challenge:', err);
        } else {
            const defaultMedals = JSON.stringify([
                { code: 'markOfMastery', label: 'Мастер', icon: '🎖️' },
                { code: 'medalRadleyWalters', label: 'Калибр', icon: '🔥' },
                { code: 'medalKnispel', label: 'Стальной дождь', icon: '⚡' },
                { code: 'titleSniper', label: 'Снайпер', icon: '🎯' },
                { code: 'medalKay', label: 'Бог войны', icon: '👑' }
            ]);
            db.run('INSERT OR IGNORE INTO blitz_challenge (id, medals_types) VALUES (1, ?)', [defaultMedals], (e) => {
                if (e && !e.message.includes('UNIQUE')) console.error('❌ Ошибка инициализации blitz_challenge:', e);
                else console.log('✅ Таблица blitz_challenge готова');
            });
        }
    });

    db.run("ALTER TABLE blitz_challenge ADD COLUMN medals_list TEXT NOT NULL DEFAULT '[]'", (err) => {
        if (err && !String(err.message).includes('duplicate column')) return;
        db.get('SELECT medals_list FROM blitz_challenge WHERE id = 1', (e, row) => {
            if (e || !row) return;
            const cur = (row.medals_list || '').trim();
            if (cur && cur !== '[]') return;
            const seed = JSON.stringify([
                { id: 'm1', label: 'Калибр', icon: '🔥', image: '', required: 1, earned: 0 }
            ]);
            db.run('UPDATE blitz_challenge SET medals_list = ? WHERE id = 1', [seed]);
        });
    });
    db.run("ALTER TABLE blitz_challenge ADD COLUMN active_type TEXT NOT NULL DEFAULT 'winrate'", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN header_text TEXT NOT NULL DEFAULT ''", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN consequence_text TEXT NOT NULL DEFAULT ''", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN header_texts TEXT NOT NULL DEFAULT ''", (err) => {
        if (err && !String(err.message).includes('duplicate column')) return;
        db.get('SELECT active_type, header_text, header_texts FROM blitz_challenge WHERE id = 1', (e, row) => {
            if (e || !row) return;
            const cur = (row.header_texts || '').trim();
            if (cur && cur !== '{}' && cur !== '[]') return;
            const legacy = (row.header_text || '').trim();
            const seed = {
                winrate: legacy || BLITZ_DEFAULT_HEADERS.winrate,
                damage: BLITZ_DEFAULT_HEADERS.damage,
                medals: BLITZ_DEFAULT_HEADERS.medals
            };
            db.run('UPDATE blitz_challenge SET header_texts = ?, header_text = ? WHERE id = 1', [JSON.stringify(seed), '']);
        });
    });
    // Таймеры челленджа: обратный отсчёт (сколько времени дано) и секундомер (сколько уже выполняю)
    db.run("ALTER TABLE blitz_challenge ADD COLUMN timer_countdown_enabled INTEGER NOT NULL DEFAULT 0", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN timer_countdown_seconds INTEGER NOT NULL DEFAULT 3600", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN timer_countdown_started_at INTEGER NOT NULL DEFAULT 0", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN timer_elapsed_enabled INTEGER NOT NULL DEFAULT 0", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN timer_elapsed_started_at INTEGER NOT NULL DEFAULT 0", () => {});
    // Активность зрителей (чат/лайки) двигает челлендж так же, как донаты
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_chat_enabled INTEGER NOT NULL DEFAULT 0", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_chat_goal_start REAL NOT NULL DEFAULT 1000", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_chat_goal_current REAL NOT NULL DEFAULT 1000", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_chat_progress REAL NOT NULL DEFAULT 0", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_chat_reward_type TEXT NOT NULL DEFAULT 'damage'", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_chat_reward_amount REAL NOT NULL DEFAULT 100", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_chat_escalation_mode TEXT NOT NULL DEFAULT 'percent'", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_chat_escalation_value REAL NOT NULL DEFAULT 20", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_likes_enabled INTEGER NOT NULL DEFAULT 0", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_likes_goal_start REAL NOT NULL DEFAULT 500", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_likes_goal_current REAL NOT NULL DEFAULT 500", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_likes_progress REAL NOT NULL DEFAULT 0", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_likes_reward_type TEXT NOT NULL DEFAULT 'winrate'", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_likes_reward_amount REAL NOT NULL DEFAULT 1", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_likes_escalation_mode TEXT NOT NULL DEFAULT 'percent'", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_likes_escalation_value REAL NOT NULL DEFAULT 20", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN activity_likes_baseline TEXT NOT NULL DEFAULT '{}'", () => {});
    db.run(`CREATE TABLE IF NOT EXISTS blitz_challenge_presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания таблицы blitz_challenge_presets:', err);
    });
}

module.exports = { initBlitzChallengeSchema };
