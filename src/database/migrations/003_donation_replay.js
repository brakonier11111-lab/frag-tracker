/**
 * Migration: Donation Replay System
 * Created: 2025-01-25
 * Adds tables for replaying donation alerts
 */

module.exports = {
    /**
     * Применение миграции
     */
    async up(db) {
        // Очередь алертов для повтора
        await db.run(`
            CREATE TABLE IF NOT EXISTS alert_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                donation_id TEXT NOT NULL,
                mode TEXT NOT NULL,
                status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'playing', 'completed', 'failed', 'skipped')),
                
                -- Данные для воспроизведения
                alert_data TEXT NOT NULL, -- JSON с данными алерта
                
                -- Управление
                play_at DATETIME, -- Когда воспроизвести (NULL = сразу)
                priority INTEGER DEFAULT 0, -- Приоритет (выше = раньше)
                
                -- Результат
                played_at DATETIME,
                error_message TEXT,
                
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                
                FOREIGN KEY (donation_id) REFERENCES donations (id) ON DELETE CASCADE
            )
        `);
        
        // История воспроизведения алертов
        await db.run(`
            CREATE TABLE IF NOT EXISTS alert_playback_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                donation_id TEXT NOT NULL,
                mode TEXT NOT NULL,
                source TEXT DEFAULT 'auto' CHECK(source IN ('auto', 'manual_replay', 'scheduled')),
                duration_ms INTEGER, -- Длительность воспроизведения
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (donation_id) REFERENCES donations (id) ON DELETE CASCADE
            )
        `);
        
        // Добавляем поле в donations для отслеживания воспроизведения
        await db.run(`ALTER TABLE donations ADD COLUMN alert_played BOOLEAN DEFAULT 0`);
        await db.run(`ALTER TABLE donations ADD COLUMN alert_played_at DATETIME`);
        
        // Индексы
        await db.run(`CREATE INDEX IF NOT EXISTS idx_alert_queue_status ON alert_queue(status)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_alert_queue_play_at ON alert_queue(play_at)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_alert_queue_priority ON alert_queue(priority DESC)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_alert_playback_donation ON alert_playback_history(donation_id)`);
    },
    
    /**
     * Откат миграции
     */
    async down(db) {
        await db.run(`DROP TABLE IF EXISTS alert_playback_history`);
        await db.run(`DROP TABLE IF EXISTS alert_queue`);
        // Note: Can't easily remove columns in SQLite, would need table recreation
    }
};







