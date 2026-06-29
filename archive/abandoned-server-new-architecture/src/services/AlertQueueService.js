const logger = require('../utils/logger');

class AlertQueueService {
    constructor(alertQueueModel, donationModel) {
        this.alertQueueModel = alertQueueModel;
        this.donationModel = donationModel;
        this.isProcessing = false;
        this.processingInterval = null;
    }
    
    /**
     * Добавить алерт в очередь
     */
    async addToQueue(alertData) {
        return await this.alertQueueModel.enqueue(alertData);
    }
    
    /**
     * Получить следующий алерт для воспроизведения
     */
    async getNext() {
        return await this.alertQueueModel.getNext();
    }
    
    /**
     * Получить все pending алерты
     */
    async getPending(limit = 50) {
        return await this.alertQueueModel.getPending(limit);
    }
    
    /**
     * Воспроизвести алерт (отметить как playing)
     */
    async playAlert(alertId) {
        await this.alertQueueModel.updateStatus(alertId, 'playing');
        logger.info('Alert playing', { alertId });
    }
    
    /**
     * Отметить алерт как завершенный
     */
    async completeAlert(alertId, durationMs = null) {
        await this.alertQueueModel.markAsPlayed(alertId);
        
        // Получаем алерт для записи в историю
        const alert = await this.alertQueueModel.getById(alertId);
        if (alert) {
            await this.alertQueueModel.recordPlayback(
                alert.donation_id,
                alert.mode,
                'auto',
                durationMs
            );
        }
        
        logger.info('Alert completed', { alertId, durationMs });
    }
    
    /**
     * Отметить алерт как failed
     */
    async failAlert(alertId, errorMessage) {
        await this.alertQueueModel.markAsFailed(alertId, errorMessage);
        logger.error('Alert failed', { alertId, error: errorMessage });
    }
    
    /**
     * Пропустить алерт
     */
    async skipAlert(alertId) {
        await this.alertQueueModel.updateStatus(alertId, 'skipped');
        logger.info('Alert skipped', { alertId });
    }
    
    /**
     * Повторить донат (добавить в очередь заново)
     */
    async replayDonation(donationId, mode = null, priority = 5) {
        const donation = await this.donationModel.getById(donationId);
        
        if (!donation) {
            throw new Error('Donation not found');
        }
        
        // Определяем режим
        const alertMode = mode || this.detectMode(donation);
        
        // Добавляем в очередь с высоким приоритетом
        const alertId = await this.alertQueueModel.enqueue({
            donation_id: donationId,
            mode: alertMode,
            alert_data: {
                type: 'replay',
                donation
            },
            priority
        });
        
        logger.info('Donation replay queued', { 
            donationId, 
            alertId, 
            mode: alertMode 
        });
        
        return alertId;
    }
    
    /**
     * Определить режим по данным доната
     */
    detectMode(donation) {
        if (donation.frags_earned > 0) return 'mode1';
        if (donation.time_earned > 0) return 'mode2';
        if (donation.custom_units_earned > 0) return 'mode3';
        return 'mode1'; // По умолчанию
    }
    
    /**
     * Получить историю воспроизведения доната
     */
    async getPlaybackHistory(donationId = null, limit = 50) {
        return await this.alertQueueModel.getPlaybackHistory(donationId, limit);
    }
    
    /**
     * Очистить старые алерты
     */
    async cleanup(daysOld = 7) {
        const deleted = await this.alertQueueModel.cleanupOld(daysOld);
        logger.info('Alert queue cleaned up', { deleted, daysOld });
        return deleted;
    }
    
    /**
     * Получить статистику очереди
     */
    async getStats() {
        const pending = await this.getPending(1000);
        
        const stats = {
            total_pending: pending.length,
            by_mode: {},
            by_priority: {},
            oldest_pending: pending.length > 0 ? pending[pending.length - 1].created_at : null,
            newest_pending: pending.length > 0 ? pending[0].created_at : null
        };
        
        pending.forEach(alert => {
            stats.by_mode[alert.mode] = (stats.by_mode[alert.mode] || 0) + 1;
            stats.by_priority[alert.priority] = (stats.by_priority[alert.priority] || 0) + 1;
        });
        
        return stats;
    }
    
    /**
     * Запустить автоматическую обработку очереди
     */
    startProcessing(intervalMs = 1000, callback) {
        if (this.isProcessing) {
            logger.warn('Alert queue processing already running');
            return;
        }
        
        this.isProcessing = true;
        
        this.processingInterval = setInterval(async () => {
            try {
                const nextAlert = await this.getNext();
                
                if (nextAlert) {
                    await this.playAlert(nextAlert.id);
                    
                    if (callback) {
                        await callback(nextAlert);
                    }
                }
            } catch (error) {
                logger.error('Error processing alert queue', { error: error.message });
            }
        }, intervalMs);
        
        logger.info('Alert queue processing started', { intervalMs });
    }
    
    /**
     * Остановить автоматическую обработку
     */
    stopProcessing() {
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }
        
        this.isProcessing = false;
        logger.info('Alert queue processing stopped');
    }
}

module.exports = AlertQueueService;







