const { DatabaseError, ValidationError } = require('../utils/AppError');
const logger = require('../utils/logger');

class RewardModel {
    constructor(db) {
        this.db = db;
    }
    
    /**
     * Создать новую награду
     */
    async create(rewardData) {
        try {
            const {
                name,
                description = null,
                enabled = 1,
                trigger_type,
                trigger_value,
                trigger_mode = null,
                action_type,
                action_data,
                repeat_enabled = 0,
                cooldown_seconds = 0,
                max_triggers = 0
            } = rewardData;
            
            // Валидация
            const validTriggerTypes = ['donation_amount', 'donation_goal', 'frag_count', 'timer_expired', 'custom_goal'];
            const validActionTypes = ['alert', 'webhook', 'command', 'sound', 'chat_message'];
            
            if (!validTriggerTypes.includes(trigger_type)) {
                throw new ValidationError('Invalid trigger_type');
            }
            
            if (!validActionTypes.includes(action_type)) {
                throw new ValidationError('Invalid action_type');
            }
            
            const result = await this.db.run(
                `INSERT INTO rewards 
                (name, description, enabled, trigger_type, trigger_value, trigger_mode, 
                 action_type, action_data, repeat_enabled, cooldown_seconds, max_triggers)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [name, description, enabled, trigger_type, trigger_value, trigger_mode,
                 action_type, action_data, repeat_enabled, cooldown_seconds, max_triggers]
            );
            
            logger.info('Reward created', { id: result.lastID, name, trigger_type });
            
            return await this.getById(result.lastID);
        } catch (error) {
            logger.error('Error creating reward', { error: error.message, rewardData });
            throw new DatabaseError('Failed to create reward', error);
        }
    }
    
    /**
     * Получить награду по ID
     */
    async getById(id) {
        const reward = await this.db.get('SELECT * FROM rewards WHERE id = ?', [id]);
        
        if (reward && reward.action_data) {
            try {
                reward.action_data = JSON.parse(reward.action_data);
            } catch (e) {
                // Если не JSON, оставляем как есть
            }
        }
        
        return reward;
    }
    
    /**
     * Получить все награды
     */
    async getAll(options = {}) {
        const { enabled = null } = options;
        
        let sql = 'SELECT * FROM rewards';
        const params = [];
        
        if (enabled !== null) {
            sql += ' WHERE enabled = ?';
            params.push(enabled ? 1 : 0);
        }
        
        sql += ' ORDER BY created_at DESC';
        
        const rewards = await this.db.all(sql, params);
        
        return rewards.map(reward => {
            if (reward.action_data) {
                try {
                    reward.action_data = JSON.parse(reward.action_data);
                } catch (e) {
                    // ignore
                }
            }
            return reward;
        });
    }
    
    /**
     * Получить активные награды по типу триггера
     */
    async getByTriggerType(triggerType, mode = null) {
        let sql = 'SELECT * FROM rewards WHERE enabled = 1 AND trigger_type = ?';
        const params = [triggerType];
        
        if (mode) {
            sql += ' AND (trigger_mode = ? OR trigger_mode IS NULL)';
            params.push(mode);
        } else {
            sql += ' AND trigger_mode IS NULL';
        }
        
        const rewards = await this.db.all(sql, params);
        
        return rewards.map(reward => {
            if (reward.action_data) {
                try {
                    reward.action_data = JSON.parse(reward.action_data);
                } catch (e) {
                    // ignore
                }
            }
            return reward;
        });
    }
    
    /**
     * Обновить награду
     */
    async update(id, updates) {
        const fields = Object.keys(updates);
        const values = Object.values(updates);
        
        // Сериализуем action_data если это объект
        if (updates.action_data && typeof updates.action_data === 'object') {
            updates.action_data = JSON.stringify(updates.action_data);
        }
        
        const setClause = fields.map(field => `${field} = ?`).join(', ');
        const sql = `UPDATE rewards SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
        
        await this.db.run(sql, [...values, id]);
        
        logger.info('Reward updated', { id, fields });
        
        return await this.getById(id);
    }
    
    /**
     * Удалить награду
     */
    async delete(id) {
        await this.db.run('DELETE FROM rewards WHERE id = ?', [id]);
        logger.info('Reward deleted', { id });
    }
    
    /**
     * Проверить, можно ли сработать награду
     */
    async canTrigger(rewardId) {
        const reward = await this.getById(rewardId);
        
        if (!reward || !reward.enabled) {
            return false;
        }
        
        // Проверяем максимальное количество срабатываний
        if (reward.max_triggers > 0 && reward.times_triggered >= reward.max_triggers) {
            return false;
        }
        
        // Проверяем cooldown
        if (reward.cooldown_seconds > 0 && reward.last_triggered_at) {
            const lastTrigger = new Date(reward.last_triggered_at);
            const now = new Date();
            const diffSeconds = (now - lastTrigger) / 1000;
            
            if (diffSeconds < reward.cooldown_seconds) {
                return false;
            }
        }
        
        return true;
    }
    
    /**
     * Зарегистрировать срабатывание награды
     */
    async recordTrigger(rewardId, triggerValue, donationId = null, success = true, errorMessage = null) {
        await this.db.transaction(async (db) => {
            // Записываем в историю
            await db.run(
                `INSERT INTO reward_triggers (reward_id, trigger_value, donation_id, success, error_message)
                 VALUES (?, ?, ?, ?, ?)`,
                [rewardId, triggerValue, donationId, success ? 1 : 0, errorMessage]
            );
            
            // Обновляем счетчик и время последнего срабатывания
            if (success) {
                await db.run(
                    `UPDATE rewards 
                     SET times_triggered = times_triggered + 1, 
                         last_triggered_at = CURRENT_TIMESTAMP 
                     WHERE id = ?`,
                    [rewardId]
                );
            }
        });
        
        logger.info('Reward trigger recorded', { 
            rewardId, 
            triggerValue, 
            success, 
            donationId 
        });
    }
    
    /**
     * Получить историю срабатываний награды
     */
    async getTriggerHistory(rewardId, limit = 50) {
        return await this.db.all(
            `SELECT * FROM reward_triggers 
             WHERE reward_id = ? 
             ORDER BY created_at DESC 
             LIMIT ?`,
            [rewardId, limit]
        );
    }
}

module.exports = RewardModel;







