/**
 * Migration: Donor Tiers System and Widget Token
 * Created: 2025-01-XX
 */

module.exports = {
    /**
     * Применение миграции
     */
    async up(db) {
        // Таблица достижений донатеров
        await db.run(`
            CREATE TABLE IF NOT EXISTS donor_tiers (
                tier INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                min_amount REAL NOT NULL DEFAULT 0,
                max_amount REAL,
                icon TEXT,
                icon_path TEXT,
                color TEXT DEFAULT '#ffffff',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Вставляем начальные достижения
        const defaultTiers = [
            { tier: 1, title: 'Обычный донатер', min_amount: 0, max_amount: 499, icon: '⭐', color: '#ffffff' },
            { tier: 2, title: 'Поддерживающий', min_amount: 500, max_amount: 2999, icon: '🌟', color: '#00ff00' },
            { tier: 3, title: 'Верный спонсор', min_amount: 3000, max_amount: 4999, icon: '✨', color: '#00aaff' },
            { tier: 4, title: 'Золотой спонсор', min_amount: 5000, max_amount: 14999, icon: '💎', color: '#ffaa00' },
            { tier: 5, title: 'Платиновый спонсор', min_amount: 15000, max_amount: 49999, icon: '👑', color: '#ff00ff' },
            { tier: 6, title: 'Легендарный спонсор', min_amount: 50000, max_amount: 99999, icon: '🔥', color: '#ff0000' },
            { tier: 7, title: 'ТОП спонсор', min_amount: 100000, max_amount: null, icon: '💫', color: '#ffff00' }
        ];
        
        for (const tier of defaultTiers) {
            await db.run(`
                INSERT OR IGNORE INTO donor_tiers (tier, title, min_amount, max_amount, icon, color)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [tier.tier, tier.title, tier.min_amount, tier.max_amount, tier.icon, tier.color]);
        }
        
        // Добавляем поле для токена виджета DonationAlerts
        await db.run(`
            ALTER TABLE app_state ADD COLUMN da_widget_token TEXT
        `).catch(() => {
            // Поле уже существует, игнорируем ошибку
        });
        
        // Добавляем поле normalized_username в таблицу donations для группировки донатеров
        await db.run(`
            ALTER TABLE donations ADD COLUMN normalized_username TEXT
        `).catch(() => {
            // Поле уже существует, игнорируем ошибку
        });
        
        // Обновляем normalized_username для существующих записей (нормализация: lowercase, trim)
        await db.run(`
            UPDATE donations 
            SET normalized_username = LOWER(TRIM(username))
            WHERE normalized_username IS NULL
        `).catch(() => {
            // Игнорируем ошибки при обновлении
        });
        
        // Создаем индексы
        await db.run(`CREATE INDEX IF NOT EXISTS idx_donor_tiers_min_amount ON donor_tiers(min_amount)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_donor_tiers_max_amount ON donor_tiers(max_amount)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_donations_normalized_username ON donations(normalized_username)`);
    },
    
    /**
     * Откат миграции
     */
    async down(db) {
        await db.run(`DROP TABLE IF EXISTS donor_tiers`);
        // Удаление поля da_widget_token не поддерживается в SQLite напрямую
        // Нужно пересоздать таблицу без этого поля
    }
};

