const { DatabaseError } = require('../utils/AppError');
const logger = require('../utils/logger');

class AppStateModel {
    constructor(db) {
        this.db = db;
    }
    
    /**
     * Получить текущее состояние приложения
     */
    async get() {
        try {
            const state = await this.db.get('SELECT * FROM app_state WHERE id = 1');
            if (!state) {
                throw new DatabaseError('App state not found');
            }
            return state;
        } catch (error) {
            logger.error('Error getting app state', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Обновить состояние приложения
     */
    async update(updates) {
        try {
            const fields = Object.keys(updates);
            const values = Object.values(updates);
            
            const setClause = fields.map(field => `${field} = ?`).join(', ');
            const sql = `UPDATE app_state SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`;
            
            await this.db.run(sql, values);
            
            logger.database('App state updated', { fields });
            
            return await this.get();
        } catch (error) {
            logger.error('Error updating app state', { error: error.message, updates });
            throw new DatabaseError('Failed to update app state', error);
        }
    }
    
    /**
     * Изменить режим
     */
    async changeMode(mode) {
        if (!['mode1', 'mode2', 'mode3'].includes(mode)) {
            throw new ValidationError('Invalid mode');
        }
        
        return await this.update({ current_mode: mode });
    }
    
    /**
     * Обновить токен DonationAlerts
     */
    async updateDAToken(token) {
        return await this.update({ da_access_token: token });
    }
    
    /**
     * Обновить баланс
     */
    async updateBalance(balance, mode = 'mode1') {
        const field = mode === 'mode1' ? 'current_balance' : 
                     mode === 'mode3' ? 'custom_current_balance' : null;
        
        if (!field) {
            throw new Error('Invalid mode for balance update');
        }
        
        return await this.update({ [field]: balance });
    }
    
    /**
     * Добавить к total_donated
     */
    async addToTotalDonated(amount) {
        const state = await this.get();
        const newTotal = (state.total_donated || 0) + amount;
        return await this.update({ total_donated: newTotal });
    }
    
    /**
     * Обновить статистику Lesta Games
     */
    async updateLestaStats(stats) {
        const updates = {};
        const prefix = 'lesta_last_';
        
        for (const [key, value] of Object.entries(stats)) {
            updates[`${prefix}${key}`] = value;
        }
        
        return await this.update(updates);
    }
}

module.exports = AppStateModel;







