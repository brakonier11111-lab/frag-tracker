const { asyncHandler } = require('../middleware/errorHandler');
const { ValidationError } = require('../utils/AppError');
const logger = require('../utils/logger');

class DonationController {
    constructor(donationService, donationModel) {
        this.donationService = donationService;
        this.donationModel = donationModel;
    }
    
    /**
     * Получить все донаты
     */
    getAll = asyncHandler(async (req, res) => {
        const { limit = 50, offset = 0, period } = req.query;
        
        let donations;
        if (period) {
            donations = await this.donationModel.getByPeriod(period);
        } else {
            donations = await this.donationModel.getAll({ 
                limit: parseInt(limit), 
                offset: parseInt(offset) 
            });
        }
        
        res.json({
            success: true,
            data: donations
        });
    });
    
    /**
     * Получить последние донаты
     */
    getRecent = asyncHandler(async (req, res) => {
        const { limit = 10 } = req.query;
        
        const donations = await this.donationModel.getRecent(parseInt(limit));
        
        res.json({
            success: true,
            data: donations
        });
    });
    
    /**
     * Получить статистику донатов
     */
    getStats = asyncHandler(async (req, res) => {
        const { period = '7d' } = req.query;
        
        const stats = await this.donationModel.getStats(period);
        
        res.json({
            success: true,
            data: stats
        });
    });
    
    /**
     * Получить топ донатеров
     */
    getTopDonors = asyncHandler(async (req, res) => {
        const { limit = 10 } = req.query;
        
        const topDonors = await this.donationModel.getTopDonors(parseInt(limit));
        
        res.json({
            success: true,
            data: topDonors
        });
    });
    
    /**
     * Создать ручной донат
     */
    createManual = asyncHandler(async (req, res) => {
        const { username, amount, message = '' } = req.body;
        
        const result = await this.donationService.createManualDonation(
            username,
            amount,
            message
        );
        
        logger.donation('Manual donation created', { username, amount });
        
        res.json({
            success: true,
            data: result
        });
    });
    
    /**
     * Тестовый донат
     */
    createTest = asyncHandler(async (req, res) => {
        const { username = 'Тестовый донатер', amount = 100, message = 'Тестовый донат' } = req.body;
        
        const result = await this.donationService.createManualDonation(
            username,
            amount,
            message
        );
        
        logger.donation('Test donation created', { username, amount });
        
        res.json({
            success: true,
            data: result,
            message: 'Test donation created'
        });
    });
    
    /**
     * Удалить все донаты
     */
    deleteAll = asyncHandler(async (req, res) => {
        await this.donationModel.deleteAll();
        
        logger.warn('All donations deleted');
        
        res.json({
            success: true,
            message: 'All donations deleted'
        });
    });
    
    /**
     * Получить донат по ID
     */
    getById = asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        const donation = await this.donationModel.getById(id);
        
        if (!donation) {
            throw new NotFoundError('Donation');
        }
        
        res.json({
            success: true,
            data: donation
        });
    });
}

module.exports = DonationController;







