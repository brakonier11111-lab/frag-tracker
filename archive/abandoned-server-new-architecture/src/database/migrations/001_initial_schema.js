/**
 * Migration: Initial Schema
 * Created: 2025-01-25
 */

module.exports = {
    /**
     * Применение миграции
     */
    async up(db) {
        // Основное состояние приложения
        await db.run(`
            CREATE TABLE IF NOT EXISTS app_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                current_mode TEXT DEFAULT 'mode1',
                
                -- Mode 1: Frag Tracker
                frag_cost INTEGER DEFAULT 50,
                frag_amount INTEGER DEFAULT 1,
                frags_needed INTEGER DEFAULT 10,
                frags_done INTEGER DEFAULT 0,
                current_balance INTEGER DEFAULT 0,
                total_donated INTEGER DEFAULT 0,
                frag_name TEXT DEFAULT 'фраг',
                widget_left_label TEXT DEFAULT 'ОСТАЛОСЬ',
                widget_right_label TEXT DEFAULT 'СДЕЛАНО',
                widget_progress_label TEXT DEFAULT 'До +1 фрага:',
                widget_bg_opacity REAL DEFAULT 0.95,
                widget_cost_font_size REAL DEFAULT 1.4,
                
                -- Mode 2: Timer
                timer_seconds INTEGER DEFAULT 0,
                timer_paused BOOLEAN DEFAULT 0,
                cost_per_minute INTEGER DEFAULT 50,
                timer_alert_text TEXT DEFAULT 'добавил времени',
                timer_slowdown_active BOOLEAN DEFAULT 0,
                timer_slowdown_factor REAL DEFAULT 1.0,
                timer_slowdown_until_ts INTEGER DEFAULT 0,
                timer_discount_until_ts INTEGER DEFAULT 0,
                
                -- Mode 3: Custom Tracker
                custom_goal_name TEXT DEFAULT 'единица',
                custom_units_needed INTEGER DEFAULT 10,
                custom_units_done INTEGER DEFAULT 0,
                custom_current_balance INTEGER DEFAULT 0,
                custom_unit_cost INTEGER DEFAULT 50,
                custom_unit_amount INTEGER DEFAULT 1,
                custom_widget_left_label TEXT DEFAULT 'ОСТАЛОСЬ',
                custom_widget_right_label TEXT DEFAULT 'СДЕЛАНО',
                custom_alert_text TEXT DEFAULT 'добавил к цели',
                
                -- Widget settings
                widget_opacity REAL DEFAULT 0.9,
                widget_background_blur INTEGER DEFAULT 0,
                
                -- Common
                theme_mode1 TEXT,
                theme_mode2 TEXT,
                theme_mode3 TEXT,
                last_donation_id TEXT,
                
                -- Integration tokens
                da_access_token TEXT,
                dp_api_key TEXT,
                dp_webhook_secret TEXT,
                dp_widget_url TEXT,
                dp_last_transaction_id TEXT,
                
                -- Lesta Games
                lesta_application_id TEXT,
                lesta_access_token TEXT,
                lesta_token_expires_at INTEGER,
                lesta_account_id TEXT,
                lesta_nickname TEXT,
                lesta_auto_sync INTEGER DEFAULT 0,
                lesta_auto_deduct INTEGER DEFAULT 1,
                
                -- Lesta Stats
                lesta_last_battles INTEGER,
                lesta_last_frags INTEGER,
                lesta_last_wins INTEGER,
                lesta_last_losses INTEGER,
                lesta_last_win_rate REAL,
                lesta_last_frags_per_battle REAL,
                lesta_last_damage_dealt INTEGER,
                lesta_last_xp INTEGER,
                lesta_last_damage_received INTEGER,
                lesta_last_max_frags INTEGER,
                lesta_last_frags8p INTEGER,
                lesta_last_hits INTEGER,
                lesta_last_shots INTEGER,
                lesta_last_spotted INTEGER,
                lesta_last_capture_points INTEGER,
                lesta_last_dropped_capture_points INTEGER,
                lesta_last_survived_battles INTEGER,
                lesta_last_win_and_survived INTEGER,
                lesta_last_max_xp INTEGER,
                lesta_previous_frags INTEGER,
                
                -- Stream timer
                stream_timer_initial_elapsed_sec INTEGER DEFAULT 0,
                stream_timer_last_update_ts INTEGER DEFAULT 0,
                stream_timer_started_ts INTEGER DEFAULT 0,
                
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // История донатов
        await db.run(`
            CREATE TABLE IF NOT EXISTS donations (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                amount REAL NOT NULL,
                message TEXT,
                currency TEXT DEFAULT 'RUB',
                is_realtime BOOLEAN DEFAULT 0,
                frags_earned INTEGER DEFAULT 0,
                time_earned INTEGER DEFAULT 0,
                custom_units_earned INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Статистика фрагов
        await db.run(`
            CREATE TABLE IF NOT EXISTS frag_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                battle_time DATETIME NOT NULL,
                frags INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Сбор донатов (цели)
        await db.run(`
            CREATE TABLE IF NOT EXISTS donation_goals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT 'Сбор на новый контент',
                description TEXT DEFAULT 'Поддержите создание качественного контента!',
                target_amount REAL NOT NULL DEFAULT 10000,
                current_amount REAL NOT NULL DEFAULT 0,
                total_donations INTEGER NOT NULL DEFAULT 0,
                avg_donation REAL NOT NULL DEFAULT 0,
                end_date DATETIME,
                last_donation_time DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // История донатов цели
        await db.run(`
            CREATE TABLE IF NOT EXISTS goal_donations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                goal_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                username TEXT,
                message TEXT,
                is_manual BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (goal_id) REFERENCES donation_goals (id) ON DELETE CASCADE
            )
        `);
        
        // Интеграции стримов
        await db.run(`
            CREATE TABLE IF NOT EXISTS stream_integrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                access_token TEXT,
                refresh_token TEXT,
                expires_at INTEGER,
                channel_name TEXT,
                channel_url TEXT,
                live_title TEXT,
                viewers_count INTEGER DEFAULT 0,
                chat_enabled BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Чат
        await db.run(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                channel_url TEXT,
                user_id INTEGER,
                username TEXT,
                message TEXT,
                is_moderator BOOLEAN DEFAULT 0,
                is_owner BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Аналитика
        await db.run(`
            CREATE TABLE IF NOT EXISTS analytics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                event_data TEXT,
                user_id TEXT,
                session_id TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                ip_address TEXT,
                user_agent TEXT
            )
        `);
        
        // Статистика донатов
        await db.run(`
            CREATE TABLE IF NOT EXISTS donation_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date DATE NOT NULL,
                total_donations INTEGER DEFAULT 0,
                total_amount REAL DEFAULT 0,
                avg_donation REAL DEFAULT 0,
                max_donation REAL DEFAULT 0,
                min_donation REAL DEFAULT 0,
                unique_donors INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Статистика по платформам
        await db.run(`
            CREATE TABLE IF NOT EXISTS platform_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                date DATE NOT NULL,
                donations_count INTEGER DEFAULT 0,
                total_amount REAL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // История статистики Lesta Games
        await db.run(`
            CREATE TABLE IF NOT EXISTS lesta_stats_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                battles INTEGER,
                frags INTEGER,
                wins INTEGER,
                losses INTEGER,
                damage_dealt INTEGER,
                xp INTEGER,
                win_rate REAL,
                frags_per_battle REAL,
                avg_damage INTEGER,
                avg_xp INTEGER
            )
        `);
        
        // Вставляем начальные данные
        await db.run(`INSERT OR IGNORE INTO app_state (id) VALUES (1)`);
        await db.run(`INSERT OR IGNORE INTO donation_goals (id) VALUES (1)`);
        
        // Создаем индексы
        await db.run(`CREATE INDEX IF NOT EXISTS idx_donations_created_at ON donations(created_at)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_donations_username ON donations(username)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_frag_stats_battle_time ON frag_stats(battle_time)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_analytics_event_type ON analytics(event_type)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON analytics(timestamp)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_donation_stats_date ON donation_stats(date)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_platform_stats_date ON platform_stats(date, platform)`);
    },
    
    /**
     * Откат миграции
     */
    async down(db) {
        const tables = [
            'lesta_stats_history',
            'platform_stats',
            'donation_stats',
            'analytics',
            'chat_messages',
            'stream_integrations',
            'goal_donations',
            'donation_goals',
            'frag_stats',
            'donations',
            'app_state'
        ];
        
        for (const table of tables) {
            await db.run(`DROP TABLE IF EXISTS ${table}`);
        }
    }
};







