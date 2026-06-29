const { asyncHandler } = require('../middleware/errorHandler');
const { NotFoundError } = require('../utils/AppError');
const logger = require('../utils/logger');

class AlertController {
    constructor(alertQueueService) {
        this.alertQueueService = alertQueueService;
    }
    
    /**
     * Получить очередь pending алертов
     */
    getPending = asyncHandler(async (req, res) => {
        const { limit = 50 } = req.query;
        
        const alerts = await this.alertQueueService.getPending(parseInt(limit));
        
        res.json({
            success: true,
            data: alerts
        });
    });
    
    /**
     * Получить следующий алерт
     */
    getNext = asyncHandler(async (req, res) => {
        const alert = await this.alertQueueService.getNext();
        
        res.json({
            success: true,
            data: alert
        });
    });
    
    /**
     * Повторить донат
     */
    replayDonation = asyncHandler(async (req, res) => {
        const { donationId } = req.params;
        const { mode = null, priority = 5 } = req.body;
        
        const alertId = await this.alertQueueService.replayDonation(
            donationId,
            mode,
            parseInt(priority)
        );
        
        res.json({
            success: true,
            data: { alertId },
            message: 'Donation replay queued successfully'
        });
    });
    
    /**
     * Отметить алерт как завершенный
     */
    complete = asyncHandler(async (req, res) => {
        const { id } = req.params;
        const { durationMs = null } = req.body;
        
        await this.alertQueueService.completeAlert(parseInt(id), durationMs);
        
        res.json({
            success: true,
            message: 'Alert marked as completed'
        });
    });
    
    /**
     * Пропустить алерт
     */
    skip = asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        await this.alertQueueService.skipAlert(parseInt(id));
        
        res.json({
            success: true,
            message: 'Alert skipped'
        });
    });
    
    /**
     * Получить историю воспроизведения
     */
    getHistory = asyncHandler(async (req, res) => {
        const { donationId = null, limit = 50 } = req.query;
        
        const history = await this.alertQueueService.getPlaybackHistory(
            donationId,
            parseInt(limit)
        );
        
        res.json({
            success: true,
            data: history
        });
    });
    
    /**
     * Получить статистику очереди
     */
    getStats = asyncHandler(async (req, res) => {
        const stats = await this.alertQueueService.getStats();
        
        res.json({
            success: true,
            data: stats
        });
    });
    
    /**
     * Очистить старые алерты
     */
    cleanup = asyncHandler(async (req, res) => {
        const { daysOld = 7 } = req.query;
        
        const deleted = await this.alertQueueService.cleanup(parseInt(daysOld));
        
        res.json({
            success: true,
            data: { deleted },
            message: `${deleted} old alerts cleaned up`
        });
    });
}

module.exports = AlertController;







