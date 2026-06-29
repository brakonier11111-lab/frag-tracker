const { DatabaseError } = require('../utils/AppError');
const logger = require('../utils/logger');

class DonationModel {
    constructor(db) {
        this.db = db;
    }
    
    /**
     * Создать новый донат
     */
    async create(donationData) {
        try {
            const {
                id,
                username,
                amount,
                message = '',
                currency = 'RUB',
                is_realtime = 0,
                frags_earned = 0,
                time_earned = 0,
                custom_units_earned = 0,
                normalized_username = null
            } = donationData;
            
            // Нормализуем имя пользователя если не передано
            const normalizedUsername = normalized_username || (username ? username.toLowerCase().trim() : null);
            
            await this.db.run(
                `INSERT INTO donations 
                (id, username, amount, message, currency, is_realtime, frags_earned, time_earned, custom_units_earned, normalized_username)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, username, amount, message, currency, is_realtime, frags_earned, time_earned, custom_units_earned, normalizedUsername]
            );
            
            logger.donation('Donation created', { id, username, amount });
            
            return await this.getById(id);
        } catch (error) {
            logger.error('Error creating donation', { error: error.message, donationData });
            throw new DatabaseError('Failed to create donation', error);
        }
    }
    
    /**
     * Получить донат по ID
     */
    async getById(id) {
        return await this.db.get('SELECT * FROM donations WHERE id = ?', [id]);
    }
    
    /**
     * Проверить существование доната
     */
    async exists(id) {
        const result = await this.db.get('SELECT 1 FROM donations WHERE id = ? LIMIT 1', [id]);
        return !!result;
    }
    
    /**
     * Получить все донаты с пагинацией
     */
    async getAll(options = {}) {
        const {
            limit = 50,
            offset = 0,
            orderBy = 'created_at',
            orderDir = 'DESC'
        } = options;
        
        const sql = `SELECT * FROM donations ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`;
        return await this.db.all(sql, [limit, offset]);
    }
    
    /**
     * Получить последние донаты
     */
    async getRecent(limit = 10) {
        return await this.db.all(
            'SELECT * FROM donations ORDER BY created_at DESC LIMIT ?',
            [limit]
        );
    }
    
    /**
     * Получить донаты за период
     */
    async getByPeriod(period = '7d') {
        let dateFilter = '';
        
        switch (period) {
            case '1d':
                dateFilter = "datetime('now', '-1 day')";
                break;
            case '7d':
                dateFilter = "datetime('now', '-7 days')";
                break;
            case '30d':
                dateFilter = "datetime('now', '-30 days')";
                break;
            default:
                dateFilter = "datetime('now', '-7 days')";
        }
        
        return await this.db.all(
            `SELECT * FROM donations WHERE created_at >= ${dateFilter} ORDER BY created_at DESC`
        );
    }
    
    /**
     * Получить статистику донатов
     */
    async getStats(period = '7d') {
        let dateFilter = '';
        
        switch (period) {
            case '1d':
                dateFilter = "WHERE created_at >= datetime('now', '-1 day')";
                break;
            case '7d':
                dateFilter = "WHERE created_at >= datetime('now', '-7 days')";
                break;
            case '30d':
                dateFilter = "WHERE created_at >= datetime('now', '-30 days')";
                break;
            case 'all':
                dateFilter = '';
                break;
        }
        
        const stats = await this.db.get(`
            SELECT 
                COUNT(*) as total_count,
                COALESCE(SUM(amount), 0) as total_amount,
                COALESCE(AVG(amount), 0) as avg_amount,
                COALESCE(MAX(amount), 0) as max_amount,
                COALESCE(MIN(amount), 0) as min_amount,
                COUNT(DISTINCT username) as unique_donors
            FROM donations ${dateFilter}
        `);
        
        return stats || {
            total_count: 0,
            total_amount: 0,
            avg_amount: 0,
            max_amount: 0,
            min_amount: 0,
            unique_donors: 0
        };
    }
    
    /**
     * Получить топ донатеров
     */
    async getTopDonors(limit = 10) {
        return await this.db.all(`
            SELECT 
                username,
                COUNT(*) as donation_count,
                SUM(amount) as total_amount,
                AVG(amount) as avg_amount,
                MAX(amount) as max_amount
            FROM donations 
            GROUP BY username 
            ORDER BY total_amount DESC 
            LIMIT ?
        `, [limit]);
    }
    
    /**
     * Удалить все донаты
     */
    async deleteAll() {
        await this.db.run('DELETE FROM donations');
        logger.database('All donations deleted');
    }
    
    /**
     * Подсчет общей суммы донатов
     */
    async getTotalAmount() {
        const result = await this.db.get('SELECT COALESCE(SUM(amount), 0) as total FROM donations');
        return result.total;
    }
}

module.exports = DonationModel;







