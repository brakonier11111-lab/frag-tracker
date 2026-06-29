/**
 * Migration: Rewards System
 * Created: 2025-01-25
 * Adds tables for automated rewards/actions when goals are reached
 */

module.exports = {
    /**
     * Применение миграции
     */
    async up(db) {
        // Таблица наград
        await db.run(`
            CREATE TABLE IF NOT EXISTS rewards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                enabled BOOLEAN DEFAULT 1,
                
                -- Тригер награды
                trigger_type TEXT NOT NULL CHECK(trigger_type IN ('donation_amount', 'donation_goal', 'frag_count', 'timer_expired', 'custom_goal')),
                trigger_value REAL NOT NULL,
                trigger_mode TEXT, -- mode1, mode2, mode3 или NULL для глобальных
                
                -- Действие при достижении
                action_type TEXT NOT NULL CHECK(action_type IN ('alert', 'webhook', 'command', 'sound', 'chat_message')),
                action_data TEXT NOT NULL, -- JSON с параметрами действия
                
                -- Настройки
                repeat_enabled BOOLEAN DEFAULT 0, -- Может ли награда срабатывать несколько раз
                cooldown_seconds INTEGER DEFAULT 0, -- Минимальное время между срабатываниями
                max_triggers INTEGER DEFAULT 0, -- Максимальное количество срабатываний (0 = без лимита)
                
                -- Статистика
                times_triggered INTEGER DEFAULT 0,
                last_triggered_at DATETIME,
                
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // История срабатываний наград
        await db.run(`
            CREATE TABLE IF NOT EXISTS reward_triggers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                reward_id INTEGER NOT NULL,
                trigger_value REAL NOT NULL, -- Значение, при котором сработало
                donation_id TEXT, -- Ссылка на донат, если применимо
                success BOOLEAN DEFAULT 1,
                error_message TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (reward_id) REFERENCES rewards (id) ON DELETE CASCADE
            )
        `);
        
        // Индексы
        await db.run(`CREATE INDEX IF NOT EXISTS idx_rewards_enabled ON rewards(enabled)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_rewards_trigger_type ON rewards(trigger_type)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_reward_triggers_reward_id ON reward_triggers(reward_id)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_reward_triggers_created_at ON reward_triggers(created_at)`);
    },
    
    /**
     * Откат миграции
     */
    async down(db) {
        await db.run(`DROP TABLE IF EXISTS reward_triggers`);
        await db.run(`DROP TABLE IF EXISTS rewards`);
    }
};







