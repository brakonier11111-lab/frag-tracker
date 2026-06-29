const express = require('express');

module.exports = (alertController) => {
    const router = express.Router();
    
    // GET /api/alerts/pending - Получить pending алерты
    router.get('/pending', alertController.getPending);
    
    // GET /api/alerts/next - Получить следующий алерт
    router.get('/next', alertController.getNext);
    
    // GET /api/alerts/stats - Статистика очереди
    router.get('/stats', alertController.getStats);
    
    // GET /api/alerts/history - История воспроизведения
    router.get('/history', alertController.getHistory);
    
    // POST /api/alerts/:id/complete - Отметить как завершенный
    router.post('/:id/complete', alertController.complete);
    
    // POST /api/alerts/:id/skip - Пропустить алерт
    router.post('/:id/skip', alertController.skip);
    
    // POST /api/alerts/replay/:donationId - Повторить донат
    router.post('/replay/:donationId', alertController.replayDonation);
    
    // DELETE /api/alerts/cleanup - Очистить старые алерты
    router.delete('/cleanup', alertController.cleanup);
    
    return router;
};







