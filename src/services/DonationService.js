const logger = require('../utils/logger');
const { ValidationError } = require('../utils/AppError');

class DonationService {
    constructor(donationModel, appStateModel, rewardModel, alertQueueModel, analytics) {
        this.donationModel = donationModel;
        this.appStateModel = appStateModel;
        this.rewardModel = rewardModel;
        this.alertQueueModel = alertQueueModel;
        this.analytics = analytics;
    }
    
    /**
     * Обработка доната
     */
    async processDonation(donationData, isRealtime = false) {
        try {
            logger.donation('Processing donation', { 
                id: donationData.id, 
                username: donationData.username, 
                amount: donationData.amount,
                isRealtime 
            });
            
            // Проверяем, не обработан ли уже донат
            const exists = await this.donationModel.exists(donationData.id);
            if (exists) {
                logger.warn('Donation already processed', { id: donationData.id });
                return null;
            }
            
            // Получаем текущее состояние
            const state = await this.appStateModel.get();
            const amount = donationData.amount;
            const currentMode = state.current_mode || 'mode1';
            
            // Расчеты для всех режимов
            const modeUpdates = await this.calculateModeUpdates(state, amount);
            
            // Нормализуем имя пользователя для группировки
            const normalizedUsername = donationData.username 
                ? donationData.username.toLowerCase().trim() 
                : null;
            
            // Создаем запись доната
            const donation = await this.donationModel.create({
                id: donationData.id,
                username: donationData.username,
                amount: amount,
                message: donationData.message || '',
                currency: donationData.currency || 'RUB',
                is_realtime: isRealtime ? 1 : 0,
                frags_earned: modeUpdates.mode1.fragsEarned,
                time_earned: modeUpdates.mode2.timeEarned,
                custom_units_earned: modeUpdates.mode3.unitsEarned,
                normalized_username: normalizedUsername
            });
            
            // Обновляем состояние приложения
            await this.appStateModel.update(modeUpdates[currentMode].stateUpdates);
            
            // Добавляем к total_donated
            await this.appStateModel.addToTotalDonated(amount);
            
            // Обновляем аналитику
            if (this.analytics) {
                this.analytics.updateDonationStats(donation);
            }
            
            // Проверяем награды
            await this.checkRewards(donation, currentMode, state);
            
            // Добавляем алерт в очередь
            await this.enqueueAlert(donation, currentMode, modeUpdates[currentMode]);
            
            logger.donation('Donation processed successfully', { 
                id: donation.id, 
                mode: currentMode 
            });
            
            return {
                donation,
                mode: currentMode,
                updates: modeUpdates[currentMode]
            };
            
        } catch (error) {
            logger.error('Error processing donation', { 
                error: error.message, 
                donationData 
            });
            throw error;
        }
    }
    
    /**
     * Рассчитать обновления для всех режимов
     */
    async calculateModeUpdates(state, amount) {
        // Mode 1: Frag Tracker
        const fragCostPerUnit = state.frag_cost / state.frag_amount;
        const currentBalance1 = state.current_balance || 0;
        const totalAmount1 = currentBalance1 + amount;
        const fragsEarned = Math.floor(totalAmount1 / fragCostPerUnit);
        const fragRemainingBalance = totalAmount1 % fragCostPerUnit;
        
        // Mode 2: Timer
        const secondsPerRuble = 60 / state.cost_per_minute;
        const timeEarned = Math.floor(amount * secondsPerRuble);
        
        // Mode 3: Custom Tracker
        const customCostPerUnit = state.custom_unit_cost / state.custom_unit_amount;
        const currentBalance3 = state.custom_current_balance || 0;
        const totalAmount3 = currentBalance3 + amount;
        const unitsEarned = Math.floor(totalAmount3 / customCostPerUnit);
        const customRemainingBalance = totalAmount3 % customCostPerUnit;
        
        return {
            mode1: {
                fragsEarned,
                stateUpdates: {
                    frags_done: (state.frags_done || 0) + fragsEarned,
                    current_balance: fragRemainingBalance
                }
            },
            mode2: {
                timeEarned,
                stateUpdates: {
                    timer_seconds: (state.timer_seconds || 0) + timeEarned
                }
            },
            mode3: {
                unitsEarned,
                stateUpdates: {
                    custom_units_done: (state.custom_units_done || 0) + unitsEarned,
                    custom_current_balance: customRemainingBalance
                }
            }
        };
    }
    
    /**
     * Проверка наград
     */
    async checkRewards(donation, mode, state) {
        try {
            // Получаем награды для donation_amount
            const amountRewards = await this.rewardModel.getByTriggerType('donation_amount', mode);
            
            for (const reward of amountRewards) {
                if (donation.amount >= reward.trigger_value) {
                    const canTrigger = await this.rewardModel.canTrigger(reward.id);
                    
                    if (canTrigger) {
                        await this.triggerReward(reward, donation);
                    }
                }
            }
            
            // Проверяем достижение целей
            await this.checkGoalRewards(mode, state, donation);
            
        } catch (error) {
            logger.error('Error checking rewards', { 
                error: error.message, 
                donationId: donation.id 
            });
        }
    }
    
    /**
     * Проверка наград за достижение целей
     */
    async checkGoalRewards(mode, state, donation) {
        let triggerType, currentValue;
        
        switch (mode) {
            case 'mode1':
                triggerType = 'frag_count';
                currentValue = state.frags_done || 0;
                break;
            case 'mode3':
                triggerType = 'custom_goal';
                currentValue = state.custom_units_done || 0;
                break;
            default:
                return;
        }
        
        const goalRewards = await this.rewardModel.getByTriggerType(triggerType, mode);
        
        for (const reward of goalRewards) {
            if (currentValue >= reward.trigger_value) {
                const canTrigger = await this.rewardModel.canTrigger(reward.id);
                
                if (canTrigger) {
                    await this.triggerReward(reward, donation);
                }
            }
        }
    }
    
    /**
     * Выполнить действие награды
     */
    async triggerReward(reward, donation) {
        try {
            logger.info('Triggering reward', { 
                rewardId: reward.id, 
                rewardName: reward.name, 
                actionType: reward.action_type 
            });
            
            let success = true;
            let errorMessage = null;
            
            switch (reward.action_type) {
                case 'alert':
                    // Добавляем специальный алерт в очередь
                    await this.alertQueueModel.enqueue({
                        donation_id: donation.id,
                        mode: reward.trigger_mode || 'mode1',
                        alert_data: {
                            type: 'reward',
                            reward_name: reward.name,
                            ...reward.action_data
                        },
                        priority: 10 // Высокий приоритет для наград
                    });
                    break;
                    
                case 'webhook':
                    // Отправляем webhook
                    await this.sendWebhook(reward.action_data, donation);
                    break;
                    
                case 'chat_message':
                    // Отправляем сообщение в чат (через WebSocket)
                    // Будет реализовано в WebSocket сервисе
                    break;
                    
                case 'sound':
                    // Воспроизводим звук через алерт
                    await this.alertQueueModel.enqueue({
                        donation_id: donation.id,
                        mode: reward.trigger_mode || 'mode1',
                        alert_data: {
                            type: 'sound',
                            sound_url: reward.action_data.sound_url
                        }
                    });
                    break;
                    
                default:
                    logger.warn('Unknown reward action type', { actionType: reward.action_type });
            }
            
            // Записываем срабатывание
            await this.rewardModel.recordTrigger(
                reward.id,
                donation.amount,
                donation.id,
                success,
                errorMessage
            );
            
        } catch (error) {
            logger.error('Error triggering reward', { 
                error: error.message, 
                rewardId: reward.id 
            });
            
            await this.rewardModel.recordTrigger(
                reward.id,
                donation.amount,
                donation.id,
                false,
                error.message
            );
        }
    }
    
    /**
     * Отправка webhook
     */
    async sendWebhook(actionData, donation) {
        const axios = require('axios');
        
        try {
            const { url, method = 'POST', headers = {} } = actionData;
            
            await axios({
                method,
                url,
                headers,
                data: {
                    donation,
                    timestamp: new Date().toISOString()
                },
                timeout: 5000
            });
            
            logger.info('Webhook sent successfully', { url });
        } catch (error) {
            logger.error('Error sending webhook', { 
                error: error.message, 
                url: actionData.url 
            });
            throw error;
        }
    }
    
    /**
     * Добавление алерта в очередь
     */
    async enqueueAlert(donation, mode, modeUpdate) {
        await this.alertQueueModel.enqueue({
            donation_id: donation.id,
            mode: mode,
            alert_data: {
                type: 'donation',
                donation,
                ...modeUpdate
            }
        });
    }
    
    /**
     * Ручное добавление доната
     */
    async createManualDonation(username, amount, message = '') {
        const donationId = `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        return await this.processDonation({
            id: donationId,
            username,
            amount,
            message,
            currency: 'RUB'
        }, false);
    }
}

module.exports = DonationService;







