const express = require('express');
const { validate, validationRules } = require('../middleware/validator');

module.exports = (donationController) => {
    const router = express.Router();
    
    // GET /api/donations - Получить все донаты
    router.get('/', donationController.getAll);
    
    // GET /api/donations/recent - Получить последние донаты
    router.get('/recent', donationController.getRecent);
    
    // GET /api/donations/stats - Получить статистику
    router.get('/stats', validationRules.fragStats, validate, donationController.getStats);
    
    // GET /api/donations/top-donors - Топ донатеры
    router.get('/top-donors', donationController.getTopDonors);
    
    // GET /api/donations/:id - Получить донат по ID
    router.get('/:id', donationController.getById);
    
    // POST /api/donations/manual - Создать ручной донат
    router.post('/manual', validationRules.donation, validate, donationController.createManual);
    
    // POST /api/donations/test - Создать тестовый донат
    router.post('/test', donationController.createTest);
    
    // DELETE /api/donations - Удалить все донаты
    router.delete('/', donationController.deleteAll);
    
    return router;
};







