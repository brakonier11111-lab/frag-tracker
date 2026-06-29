const logger = require('../utils/logger');
const { ValidationError } = require('../utils/AppError');

class RewardService {
    constructor(rewardModel) {
        this.rewardModel = rewardModel;
    }
    
    /**
     * Создать новую награду
     */
    async createReward(rewardData) {
        // Валидация action_data в зависимости от action_type
        this.validateActionData(rewardData.action_type, rewardData.action_data);
        
        // Сериализуем action_data в JSON
        const actionDataJson = typeof rewardData.action_data === 'string' 
            ? rewardData.action_data 
            : JSON.stringify(rewardData.action_data);
        
        const reward = await this.rewardModel.create({
            ...rewardData,
            action_data: actionDataJson
        });
        
        logger.info('Reward created via service', { 
            id: reward.id, 
            name: reward.name 
        });
        
        return reward;
    }
    
    /**
     * Валидация action_data
     */
    validateActionData(actionType, actionData) {
        const data = typeof actionData === 'string' ? JSON.parse(actionData) : actionData;
        
        switch (actionType) {
            case 'alert':
                if (!data.title && !data.message) {
                    throw new ValidationError('Alert action requires title or message');
                }
                break;
                
            case 'webhook':
                if (!data.url) {
                    throw new ValidationError('Webhook action requires url');
                }
                if (data.url && !data.url.startsWith('http')) {
                    throw new ValidationError('Invalid webhook URL');
                }
                break;
                
            case 'sound':
                if (!data.sound_url) {
                    throw new ValidationError('Sound action requires sound_url');
                }
                break;
                
            case 'chat_message':
                if (!data.message) {
                    throw new ValidationError('Chat message action requires message');
                }
                break;
                
            case 'command':
                if (!data.command) {
                    throw new ValidationError('Command action requires command');
                }
                break;
        }
    }
    
    /**
     * Получить все награды
     */
    async getAllRewards(enabledOnly = false) {
        return await this.rewardModel.getAll({ 
            enabled: enabledOnly ? 1 : null 
        });
    }
    
    /**
     * Получить награду по ID
     */
    async getRewardById(id) {
        return await this.rewardModel.getById(id);
    }
    
    /**
     * Обновить награду
     */
    async updateReward(id, updates) {
        // Валидация action_data если он обновляется
        if (updates.action_type && updates.action_data) {
            this.validateActionData(updates.action_type, updates.action_data);
        }
        
        return await this.rewardModel.update(id, updates);
    }
    
    /**
     * Удалить награду
     */
    async deleteReward(id) {
        await this.rewardModel.delete(id);
        logger.info('Reward deleted via service', { id });
    }
    
    /**
     * Включить/выключить награду
     */
    async toggleReward(id, enabled) {
        return await this.rewardModel.update(id, { enabled: enabled ? 1 : 0 });
    }
    
    /**
     * Получить статистику наград
     */
    async getRewardStats() {
        const rewards = await this.rewardModel.getAll();
        
        const stats = {
            total: rewards.length,
            enabled: rewards.filter(r => r.enabled).length,
            disabled: rewards.filter(r => !r.enabled).length,
            by_trigger_type: {},
            by_action_type: {},
            total_triggers: rewards.reduce((sum, r) => sum + (r.times_triggered || 0), 0),
            most_triggered: rewards
                .sort((a, b) => (b.times_triggered || 0) - (a.times_triggered || 0))
                .slice(0, 5)
                .map(r => ({
                    id: r.id,
                    name: r.name,
                    times_triggered: r.times_triggered,
                    last_triggered_at: r.last_triggered_at
                }))
        };
        
        // Группировка по типам
        rewards.forEach(reward => {
            stats.by_trigger_type[reward.trigger_type] = 
                (stats.by_trigger_type[reward.trigger_type] || 0) + 1;
            stats.by_action_type[reward.action_type] = 
                (stats.by_action_type[reward.action_type] || 0) + 1;
        });
        
        return stats;
    }
    
    /**
     * Получить историю срабатываний награды
     */
    async getRewardTriggerHistory(rewardId, limit = 50) {
        return await this.rewardModel.getTriggerHistory(rewardId, limit);
    }
    
    /**
     * Тестовое срабатывание награды
     */
    async testReward(rewardId) {
        const reward = await this.rewardModel.getById(rewardId);
        
        if (!reward) {
            throw new ValidationError('Reward not found');
        }
        
        logger.info('Testing reward', { rewardId, name: reward.name });
        
        // Создаем тестовый донат
        const testDonation = {
            id: `test_${Date.now()}`,
            username: 'Test User',
            amount: reward.trigger_value,
            message: 'Test reward trigger',
            created_at: new Date().toISOString()
        };
        
        // Записываем срабатывание
        await this.rewardModel.recordTrigger(
            rewardId,
            reward.trigger_value,
            testDonation.id,
            true,
            null
        );
        
        return {
            success: true,
            reward,
            testDonation,
            message: `Reward "${reward.name}" tested successfully`
        };
    }
}

module.exports = RewardService;







