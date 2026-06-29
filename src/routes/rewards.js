const express = require('express');
const { validate, validationRules } = require('../middleware/validator');

module.exports = (rewardController) => {
    const router = express.Router();
    
    // GET /api/rewards - Получить все награды
    router.get('/', rewardController.getAll);
    
    // GET /api/rewards/stats - Статистика наград
    router.get('/stats', rewardController.getStats);
    
    // GET /api/rewards/:id - Получить награду по ID
    router.get('/:id', rewardController.getById);
    
    // GET /api/rewards/:id/history - История срабатываний награды
    router.get('/:id/history', rewardController.getTriggerHistory);
    
    // POST /api/rewards - Создать награду
    router.post('/', validationRules.createReward, validate, rewardController.create);
    
    // POST /api/rewards/:id/test - Тестировать награду
    router.post('/:id/test', rewardController.test);
    
    // POST /api/rewards/:id/toggle - Включить/выключить награду
    router.post('/:id/toggle', rewardController.toggle);
    
    // PUT /api/rewards/:id - Обновить награду
    router.put('/:id', rewardController.update);
    
    // DELETE /api/rewards/:id - Удалить награду
    router.delete('/:id', rewardController.delete);
    
    return router;
};







