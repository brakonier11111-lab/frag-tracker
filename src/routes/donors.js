const express = require('express');
const router = express.Router();

module.exports = function(database) {
    /**
     * Получить топ донатеров за все время
     */
    router.get('/top', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 10;
            const fromDate = req.query.from_date;
            
            let query = `
                SELECT 
                    username,
                    normalized_username,
                    SUM(amount) as total_amount,
                    COUNT(*) as donation_count,
                    AVG(amount) as avg_amount,
                    MAX(amount) as max_amount,
                    MIN(created_at) as first_donation,
                    MAX(created_at) as last_donation,
                    SUM(time_earned) as period_time_earned
                FROM donations
                WHERE username IS NOT NULL AND username != ''
            `;
            
            const params = [];
            
            if (fromDate) {
                query += ' AND created_at >= ?';
                params.push(fromDate);
            }
            
            // Группируем по normalized_username если есть, иначе по username
            query += `
                GROUP BY COALESCE(normalized_username, username)
                ORDER BY total_amount DESC
                LIMIT ?
            `;
            params.push(limit);
            
            const donors = await database.all(query, params);
            
            // Получаем информацию о тирах для каждого донатера
            const tiers = await database.all('SELECT * FROM donor_tiers ORDER BY min_amount ASC');
            
            res.json({ 
                success: true, 
                donors: donors.map(donor => {
                    // Определяем тир донатера
                    let tierInfo = null;
                    const totalAmount = donor.total_amount || 0;
                    
                    for (let i = tiers.length - 1; i >= 0; i--) {
                        const tier = tiers[i];
                        const maxAmount = tier.max_amount === null || tier.max_amount === 999999999 ? Infinity : tier.max_amount;
                        if (totalAmount >= tier.min_amount && totalAmount <= maxAmount) {
                            tierInfo = {
                                tier: tier.tier,
                                title: tier.title,
                                icon: tier.icon,
                                icon_path: tier.icon_path,
                                color: tier.color
                            };
                            break;
                        }
                    }
                    
                    return {
                        username: donor.username,
                        total_amount: donor.total_amount,
                        donation_count: donor.donation_count,
                        avg_amount: donor.avg_amount,
                        max_amount: donor.max_amount,
                        first_donation: donor.first_donation,
                        last_donation: donor.last_donation,
                        period_time_earned: donor.period_time_earned || 0,
                        tier_info: tierInfo
                    };
                })
            });
        } catch (error) {
            console.error('Ошибка получения топа донатеров:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    /**
     * Получить топ донатеров за сегодня
     */
    router.get('/top/today', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 10;
            
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayStartISO = todayStart.toISOString();
            
            const query = `
                SELECT 
                    username,
                    normalized_username,
                    SUM(amount) as today_amount,
                    COUNT(*) as donation_count,
                    AVG(amount) as avg_amount,
                    MAX(amount) as max_amount,
                    SUM(time_earned) as today_time_earned
                FROM donations
                WHERE username IS NOT NULL AND username != ''
                    AND created_at >= ?
                GROUP BY COALESCE(normalized_username, username)
                ORDER BY today_amount DESC
                LIMIT ?
            `;
            
            const donors = await database.all(query, [todayStartISO, limit]);
            
            // Получаем информацию о тирах для каждого донатера
            const tiers = await database.all('SELECT * FROM donor_tiers ORDER BY min_amount ASC');
            
            // Получаем общую сумму каждого донатера для определения тира
            const donorTotals = await database.all(`
                SELECT 
                    COALESCE(normalized_username, username) as normalized_username,
                    SUM(amount) as total_amount
                FROM donations
                WHERE username IS NOT NULL AND username != ''
                GROUP BY COALESCE(normalized_username, username)
            `);
            
            const totalsMap = new Map();
            donorTotals.forEach(d => {
                totalsMap.set(d.normalized_username, d.total_amount);
            });
            
            res.json({ 
                success: true, 
                donors: donors.map(donor => {
                    // Определяем тир донатера по общей сумме (не только за сегодня)
                    let tierInfo = null;
                    const normalizedUsername = donor.normalized_username || donor.username;
                    const totalAmount = totalsMap.get(normalizedUsername) || donor.today_amount || 0;
                    
                    for (let i = tiers.length - 1; i >= 0; i--) {
                        const tier = tiers[i];
                        const maxAmount = tier.max_amount === null || tier.max_amount === 999999999 ? Infinity : tier.max_amount;
                        if (totalAmount >= tier.min_amount && totalAmount <= maxAmount) {
                            tierInfo = {
                                tier: tier.tier,
                                title: tier.title,
                                icon: tier.icon,
                                icon_path: tier.icon_path,
                                color: tier.color
                            };
                            break;
                        }
                    }
                    
                    return {
                        username: donor.username,
                        today_amount: donor.today_amount,
                        total_amount: totalAmount, // Добавляем общую сумму для виджета
                        donation_count: donor.donation_count,
                        avg_amount: donor.avg_amount,
                        max_amount: donor.max_amount,
                        today_time_earned: donor.today_time_earned || 0,
                        tier_info: tierInfo
                    };
                })
            });
        } catch (error) {
            console.error('Ошибка получения топа донатеров за сегодня:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    /**
     * Получить информацию о донатере
     */
    router.get('/:username', async (req, res) => {
        try {
            const username = decodeURIComponent(req.params.username);
            
            // Получаем статистику донатера
            const stats = await database.get(`
                SELECT 
                    username,
                    normalized_username,
                    SUM(amount) as total_amount,
                    COUNT(*) as donation_count,
                    AVG(amount) as avg_amount,
                    MAX(amount) as max_amount,
                    MIN(created_at) as first_donation,
                    MAX(created_at) as last_donation,
                    SUM(time_earned) as total_time_earned
                FROM donations
                WHERE username = ? OR normalized_username = ?
                GROUP BY COALESCE(normalized_username, username)
            `, [username, username]);
            
            if (!stats) {
                return res.status(404).json({ success: false, error: 'Донатер не найден' });
            }
            
            // Получаем информацию о тире донатера
            const tier = await database.get(`
                SELECT * FROM donor_tiers
                WHERE min_amount <= ? AND (max_amount IS NULL OR max_amount >= ? OR max_amount = 999999999)
                ORDER BY min_amount DESC
                LIMIT 1
            `, [stats.total_amount, stats.total_amount]);
            
            res.json({ 
                success: true, 
                donor: {
                    username: stats.username,
                    total_amount: stats.total_amount,
                    donation_count: stats.donation_count,
                    avg_amount: stats.avg_amount,
                    max_amount: stats.max_amount,
                    first_donation: stats.first_donation,
                    last_donation: stats.last_donation,
                    total_time_earned: stats.total_time_earned || 0,
                    tier_info: tier ? {
                        tier: tier.tier,
                        title: tier.title,
                        icon: tier.icon,
                        icon_path: tier.icon_path,
                        color: tier.color
                    } : null
                }
            });
        } catch (error) {
            console.error('Ошибка получения информации о донатере:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    return router;
};

