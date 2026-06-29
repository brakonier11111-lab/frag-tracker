const express = require('express');
const { validate, validationRules } = require('../middleware/validator');

module.exports = (widgetController) => {
    const router = express.Router();
    
    // GET /api/widgets - Получить все виджеты
    router.get('/', widgetController.getAll);
    
    // GET /api/widgets/:identifier - Получить виджет
    router.get('/:identifier', widgetController.getOne);
    
    // GET /api/widgets/:id/elements - Получить элементы виджета
    router.get('/:id/elements', widgetController.getElements);
    
    // GET /api/widgets/:id/code - Сгенерировать код виджета
    router.get('/:id/code', widgetController.generateCode);
    
    // POST /api/widgets - Создать виджет
    router.post('/', validationRules.saveWidget, validate, widgetController.create);
    
    // POST /api/widgets/:id/clone - Клонировать виджет
    router.post('/:id/clone', widgetController.clone);
    
    // POST /api/widgets/:id/elements - Добавить элемент
    router.post('/:id/elements', widgetController.addElement);
    
    // POST /api/widgets/:id/view - Отметить просмотр
    router.post('/:id/view', widgetController.trackView);
    
    // PUT /api/widgets/:id - Обновить виджет
    router.put('/:id', widgetController.update);
    
    // DELETE /api/widgets/:id - Удалить виджет
    router.delete('/:id', widgetController.delete);
    
    // DELETE /api/widgets/elements/:elementId - Удалить элемент
    router.delete('/elements/:elementId', widgetController.deleteElement);
    
    return router;
};







