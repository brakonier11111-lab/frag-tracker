/**
 * Migration: Donor Achievements System
 * Created: 2025-01-25
 * 
 * Создает систему достижений для донатеров на основе добавленного времени
 */

module.exports = {
    /**
     * Применение миграции
     */
    async up(db) {
        // Таблица для уровней достижений
        await db.run(`
            CREATE TABLE IF NOT EXISTS donor_achievement_tiers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                min_minutes INTEGER NOT NULL,
                max_minutes INTEGER,
                icon TEXT DEFAULT '🏆',
                custom_icon_url TEXT,
                color TEXT DEFAULT '#00f0ff',
                description TEXT,
                sort_order INTEGER DEFAULT 0 UNIQUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Добавляем поле custom_icon_url если его нет (для существующих БД)
        try {
            await db.run(`ALTER TABLE donor_achievement_tiers ADD COLUMN custom_icon_url TEXT`);
            console.log('✅ Поле custom_icon_url добавлено в donor_achievement_tiers');
        } catch (err) {
            // Игнорируем ошибку если поле уже существует
            if (!err.message || !err.message.includes('duplicate column name')) {
                console.warn('⚠️ Предупреждение при добавлении custom_icon_url:', err.message);
            }
        }

        // Таблица для достижений донатеров
        await db.run(`
            CREATE TABLE IF NOT EXISTS donor_achievements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                normalized_username TEXT NOT NULL,
                username TEXT NOT NULL,
                total_time_seconds INTEGER DEFAULT 0,
                total_time_minutes INTEGER DEFAULT 0,
                current_tier_id INTEGER,
                last_donation_id TEXT,
                last_donation_time DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (current_tier_id) REFERENCES donor_achievement_tiers (id),
                UNIQUE(normalized_username)
            )
        `);

        // Индексы для быстрого поиска
        await db.run(`CREATE INDEX IF NOT EXISTS idx_donor_achievements_username ON donor_achievements(normalized_username)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_donor_achievements_tier ON donor_achievements(current_tier_id)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_achievement_tiers_minutes ON donor_achievement_tiers(min_minutes)`);
        // Создаем UNIQUE индекс на sort_order для предотвращения дубликатов
        try {
            await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_achievement_tiers_sort_order ON donor_achievement_tiers(sort_order)`);
        } catch (err) {
            // Игнорируем ошибку если индекс уже существует
            if (!err.message || !err.message.includes('already exists')) {
                console.warn('⚠️ Предупреждение при создании UNIQUE индекса:', err.message);
            }
        }

        // Вставляем дефолтные уровни достижений
        const defaultTiers = [
            { name: 'Новичок', min_minutes: 5, max_minutes: 29, icon: '🌱', color: '#00ff47', description: '5-29 минут', sort_order: 1 },
            { name: 'Активный', min_minutes: 30, max_minutes: 59, icon: '⭐', color: '#00f0ff', description: '30-59 минут', sort_order: 2 },
            { name: 'Преданный', min_minutes: 60, max_minutes: 359, icon: '💎', color: '#b300ff', description: '1-5 часов 59 минут', sort_order: 3 },
            { name: 'Верный', min_minutes: 360, max_minutes: 719, icon: '👑', color: '#ff7700', description: '6-11 часов 59 минут', sort_order: 4 },
            { name: 'Легенда', min_minutes: 720, max_minutes: 1439, icon: '🌟', color: '#ffff00', description: '12-23 часа 59 минут', sort_order: 5 },
            { name: 'Мастер', min_minutes: 1440, max_minutes: 4319, icon: '🔥', color: '#ff003c', description: '24-71 час 59 минут', sort_order: 6 },
            { name: 'Божество', min_minutes: 4320, max_minutes: null, icon: '⚡', color: '#ff00ff', description: '72+ часа', sort_order: 7 }
        ];

        for (const tier of defaultTiers) {
            // Проверяем существование перед вставкой, чтобы избежать дубликатов
            const existing = await db.get('SELECT id FROM donor_achievement_tiers WHERE sort_order = ?', [tier.sort_order]);
            if (!existing) {
                await db.run(`
                    INSERT INTO donor_achievement_tiers 
                    (name, min_minutes, max_minutes, icon, color, description, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [tier.name, tier.min_minutes, tier.max_minutes, tier.icon, tier.color, tier.description, tier.sort_order]);
            }
        }

        console.log('✅ Migration 006: Donor achievements system created');
    },

    /**
     * Откат миграции
     */
    async down(db) {
        await db.run('DROP INDEX IF EXISTS idx_donor_achievements_username');
        await db.run('DROP INDEX IF EXISTS idx_donor_achievements_tier');
        await db.run('DROP INDEX IF EXISTS idx_achievement_tiers_minutes');
        await db.run('DROP TABLE IF EXISTS donor_achievements');
        await db.run('DROP TABLE IF EXISTS donor_achievement_tiers');
        console.log('✅ Migration 006: Donor achievements system rolled back');
    }
};

