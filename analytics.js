
class Analytics {
    constructor(db) {
        this.db = db;
        this.initTables();
    }

    initTables() {
        // Таблица для хранения аналитики
        this.db.run(`CREATE TABLE IF NOT EXISTS analytics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            event_data TEXT,
            user_id TEXT,
            session_id TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            ip_address TEXT,
            user_agent TEXT
        )`);

        // Таблица для статистики донатов
        this.db.run(`CREATE TABLE IF NOT EXISTS donation_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date DATE NOT NULL,
            total_donations INTEGER DEFAULT 0,
            total_amount REAL DEFAULT 0,
            avg_donation REAL DEFAULT 0,
            max_donation REAL DEFAULT 0,
            min_donation REAL DEFAULT 0,
            unique_donors INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Таблица для статистики по платформам
        this.db.run(`CREATE TABLE IF NOT EXISTS platform_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            date DATE NOT NULL,
            donations_count INTEGER DEFAULT 0,
            total_amount REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }

    // Логирование событий
    logEvent(eventType, eventData = {}, userId = null, sessionId = null, req = null) {
        const data = {
            event_type: eventType,
            event_data: JSON.stringify(eventData),
            user_id: userId,
            session_id: sessionId,
            ip_address: req && req.ip ? req.ip : null,
            user_agent: req && req.headers && req.headers['user-agent'] ? req.headers['user-agent'] : null
        };

        this.db.run(`INSERT INTO analytics (event_type, event_data, user_id, session_id, ip_address, user_agent) 
                     VALUES (?, ?, ?, ?, ?, ?)`,
            [data.event_type, data.event_data, data.user_id, data.session_id, data.ip_address, data.user_agent],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка записи аналитики:', err);
                }
            }
        );
    }

    // Обновление статистики донатов
    updateDonationStats(donation) {
        const today = new Date().toISOString().split('T')[0];
        
        // Получаем текущую статистику за день
        this.db.get(`SELECT * FROM donation_stats WHERE date = ?`, [today], (err, row) => {
            if (err) {
                console.error('❌ Ошибка получения статистики:', err);
                return;
            }

            if (row) {
                // Обновляем существующую запись
                const newTotal = row.total_amount + donation.amount;
                const newCount = row.total_donations + 1;
                const newAvg = newTotal / newCount;
                const newMax = Math.max(row.max_donation, donation.amount);
                const newMin = Math.min(row.min_donation, donation.amount);

                this.db.run(`UPDATE donation_stats SET 
                            total_donations = ?, total_amount = ?, avg_donation = ?, 
                            max_donation = ?, min_donation = ?
                            WHERE date = ?`,
                    [newCount, newTotal, newAvg, newMax, newMin, today]
                );
            } else {
                // Создаем новую запись
                this.db.run(`INSERT INTO donation_stats 
                            (date, total_donations, total_amount, avg_donation, max_donation, min_donation, unique_donors)
                            VALUES (?, 1, ?, ?, ?, ?, 1)`,
                    [today, donation.amount, donation.amount, donation.amount, donation.amount]
                );
            }
        });

        // Обновляем статистику по платформам
        const platform = donation.id.startsWith('dp_') ? 'DonatePay' : 'DonationAlerts';
        this.updatePlatformStats(platform, donation.amount);
    }

    // Обновление статистики по платформам
    updatePlatformStats(platform, amount) {
        const today = new Date().toISOString().split('T')[0];
        
        this.db.get(`SELECT * FROM platform_stats WHERE platform = ? AND date = ?`, 
            [platform, today], (err, row) => {
            if (err) {
                console.error('❌ Ошибка получения статистики платформы:', err);
                return;
            }

            if (row) {
                this.db.run(`UPDATE platform_stats SET 
                            donations_count = donations_count + 1, 
                            total_amount = total_amount + ?
                            WHERE platform = ? AND date = ?`,
                    [amount, platform, today]
                );
            } else {
                this.db.run(`INSERT INTO platform_stats (platform, date, donations_count, total_amount)
                            VALUES (?, ?, 1, ?)`,
                    [platform, today, amount]
                );
            }
        });
    }

    // Получение статистики за период
    getStats(period = '7d', callback) {
        let dateFilter = '';
        let params = [];

        switch (period) {
            case '1d':
                dateFilter = 'WHERE date >= date("now", "-1 day")';
                break;
            case '7d':
                dateFilter = 'WHERE date >= date("now", "-7 days")';
                break;
            case '30d':
                dateFilter = 'WHERE date >= date("now", "-30 days")';
                break;
            case 'all':
                dateFilter = '';
                break;
        }

        const query = `
            SELECT 
                COALESCE(COUNT(*), 0) as total_donations,
                COALESCE(SUM(total_amount), 0) as total_amount,
                COALESCE(AVG(avg_donation), 0) as avg_donation,
                COALESCE(MAX(max_donation), 0) as max_donation,
                COALESCE(MIN(min_donation), 0) as min_donation,
                COALESCE(SUM(unique_donors), 0) as unique_donors
            FROM donation_stats ${dateFilter}
        `;

        this.db.get(query, params, (err, row) => {
            if (err) {
                console.error('❌ Ошибка получения статистики:', err);
                return callback(err, null);
            }
            
            // Если нет данных, возвращаем нулевые значения
            if (!row) {
                return callback(null, {
                    total_donations: 0,
                    total_amount: 0,
                    avg_donation: 0,
                    max_donation: 0,
                    min_donation: 0,
                    unique_donors: 0
                });
            }
            
            callback(null, row);
        });
    }

    // Получение статистики по платформам
    getPlatformStats(period = '7d', callback) {
        let dateFilter = '';
        let params = [];

        switch (period) {
            case '1d':
                dateFilter = 'WHERE date >= date("now", "-1 day")';
                break;
            case '7d':
                dateFilter = 'WHERE date >= date("now", "-7 days")';
                break;
            case '30d':
                dateFilter = 'WHERE date >= date("now", "-30 days")';
                break;
            case 'all':
                dateFilter = '';
                break;
        }

        const query = `
            SELECT 
                platform,
                SUM(donations_count) as total_donations,
                SUM(total_amount) as total_amount,
                AVG(total_amount / donations_count) as avg_donation
            FROM platform_stats ${dateFilter}
            GROUP BY platform
        `;

        this.db.all(query, params, callback);
    }

    // Получение топ донатеров
    getTopDonors(limit = 10, callback) {
        const query = `
            SELECT 
                username,
                COUNT(*) as donation_count,
                SUM(amount) as total_amount,
                AVG(amount) as avg_donation,
                MAX(amount) as max_donation
            FROM donations 
            WHERE username IS NOT NULL AND username != ''
            GROUP BY normalized_username, username
            ORDER BY total_amount DESC 
            LIMIT ?
        `;

        this.db.all(query, [limit], (err, rows) => {
            if (err) {
                console.error('❌ Ошибка получения топ донатеров:', err);
                return callback(err, null);
            }
            // Преобразуем результат для совместимости
            const donors = (rows || []).map(row => ({
                username: row.username,
                donation_count: row.donation_count,
                total_amount: row.total_amount,
                avg_donation: row.avg_donation,
                max_donation: row.max_donation
            }));
            callback(null, donors);
        });
    }

    // Получение активности по часам
    getHourlyActivity(callback) {
        const query = `
            SELECT 
                strftime('%H', created_at) as hour,
                COUNT(*) as donation_count,
                SUM(amount) as total_amount
            FROM donations 
            WHERE created_at >= datetime('now', '-7 days')
            GROUP BY hour
            ORDER BY hour
        `;

        this.db.all(query, callback);
    }

    // Получение событий аналитики
    getEvents(eventType = null, limit = 100, callback) {
        let query = 'SELECT * FROM analytics';
        let params = [];

        if (eventType) {
            query += ' WHERE event_type = ?';
            params.push(eventType);
        }

        query += ' ORDER BY timestamp DESC LIMIT ?';
        params.push(limit);

        this.db.all(query, params, callback);
    }
}

module.exports = Analytics;
