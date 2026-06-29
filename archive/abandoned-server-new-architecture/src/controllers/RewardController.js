const { asyncHandler } = require('../middleware/errorHandler');
const { NotFoundError } = require('../utils/AppError');
const logger = require('../utils/logger');

class RewardController {
    constructor(rewardService) {
        this.rewardService = rewardService;
    }
    
    /**
     * Получить все награды
     */
    getAll = asyncHandler(async (req, res) => {
        const { enabled } = req.query;
        
        const rewards = await this.rewardService.getAllRewards(
            enabled === 'true' || enabled === '1'
        );
        
        res.json({
            success: true,
            data: rewards
        });
    });
    
    /**
     * Получить награду по ID
     */
    getById = asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        const reward = await this.rewardService.getRewardById(parseInt(id));
        
        if (!reward) {
            throw new NotFoundError('Reward');
        }
        
        res.json({
            success: true,
            data: reward
        });
    });
    
    /**
     * Создать награду
     */
    create = asyncHandler(async (req, res) => {
        const reward = await this.rewardService.createReward(req.body);
        
        res.status(201).json({
            success: true,
            data: reward,
            message: 'Reward created successfully'
        });
    });
    
    /**
     * Обновить награду
     */
    update = asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        const reward = await this.rewardService.updateReward(parseInt(id), req.body);
        
        res.json({
            success: true,
            data: reward,
            message: 'Reward updated successfully'
        });
    });
    
    /**
     * Удалить награду
     */
    delete = asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        await this.rewardService.deleteReward(parseInt(id));
        
        res.json({
            success: true,
            message: 'Reward deleted successfully'
        });
    });
    
    /**
     * Включить/выключить награду
     */
    toggle = asyncHandler(async (req, res) => {
        const { id } = req.params;
        const { enabled } = req.body;
        
        const reward = await this.rewardService.toggleReward(
            parseInt(id), 
            enabled
        );
        
        res.json({
            success: true,
            data: reward,
            message: `Reward ${enabled ? 'enabled' : 'disabled'} successfully`
        });
    });
    
    /**
     * Получить статистику наград
     */
    getStats = asyncHandler(async (req, res) => {
        const stats = await this.rewardService.getRewardStats();
        
        res.json({
            success: true,
            data: stats
        });
    });
    
    /**
     * Получить историю срабатываний награды
     */
    getTriggerHistory = asyncHandler(async (req, res) => {
        const { id } = req.params;
        const { limit = 50 } = req.query;
        
        const history = await this.rewardService.getRewardTriggerHistory(
            parseInt(id),
            parseInt(limit)
        );
        
        res.json({
            success: true,
            data: history
        });
    });
    
    /**
     * Тестировать награду
     */
    test = asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        const result = await this.rewardService.testReward(parseInt(id));
        
        res.json({
            success: true,
            data: result
        });
    });
}

module.exports = RewardController;







