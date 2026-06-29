const { asyncHandler } = require('../middleware/errorHandler');
const { NotFoundError } = require('../utils/AppError');
const logger = require('../utils/logger');

class WidgetController {
    constructor(widgetService) {
        this.widgetService = widgetService;
    }
    
    /**
     * Получить все виджеты
     */
    getAll = asyncHandler(async (req, res) => {
        const { type, is_active, is_public } = req.query;
        
        const filters = {};
        if (type) filters.type = type;
        if (is_active !== undefined) filters.is_active = is_active === 'true' ? 1 : 0;
        if (is_public !== undefined) filters.is_public = is_public === 'true' ? 1 : 0;
        
        const widgets = await this.widgetService.getAllWidgets(filters);
        
        res.json({
            success: true,
            data: widgets
        });
    });
    
    /**
     * Получить виджет по ID или slug
     */
    getOne = asyncHandler(async (req, res) => {
        const { identifier } = req.params;
        const { includeElements = false } = req.query;
        
        let widget;
        if (includeElements === 'true') {
            widget = await this.widgetService.getWidgetWithElements(identifier);
        } else {
            widget = await this.widgetService.getWidget(identifier);
        }
        
        if (!widget) {
            throw new NotFoundError('Widget');
        }
        
        res.json({
            success: true,
            data: widget
        });
    });
    
    /**
     * Создать новый виджет
     */
    create = asyncHandler(async (req, res) => {
        const widget = await this.widgetService.createWidget(req.body);
        
        res.status(201).json({
            success: true,
            data: widget,
            message: 'Widget created successfully'
        });
    });
    
    /**
     * Обновить виджет
     */
    update = asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        const widget = await this.widgetService.updateWidget(parseInt(id), req.body);
        
        res.json({
            success: true,
            data: widget,
            message: 'Widget updated successfully'
        });
    });
    
    /**
     * Удалить виджет
     */
    delete = asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        await this.widgetService.deleteWidget(parseInt(id));
        
        res.json({
            success: true,
            message: 'Widget deleted successfully'
        });
    });
    
    /**
     * Клонировать виджет
     */
    clone = asyncHandler(async (req, res) => {
        const { id } = req.params;
        const { name = null } = req.body;
        
        const widget = await this.widgetService.cloneWidget(parseInt(id), name);
        
        res.json({
            success: true,
            data: widget,
            message: 'Widget cloned successfully'
        });
    });
    
    /**
     * Получить элементы виджета
     */
    getElements = asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        const widget = await this.widgetService.getWidgetWithElements(parseInt(id));
        
        res.json({
            success: true,
            data: widget.elements
        });
    });
    
    /**
     * Добавить элемент к виджету
     */
    addElement = asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        const elementId = await this.widgetService.addElement(parseInt(id), req.body);
        
        res.status(201).json({
            success: true,
            data: { elementId },
            message: 'Element added successfully'
        });
    });
    
    /**
     * Удалить элемент
     */
    deleteElement = asyncHandler(async (req, res) => {
        const { elementId } = req.params;
        
        await this.widgetService.deleteElement(parseInt(elementId));
        
        res.json({
            success: true,
            message: 'Element deleted successfully'
        });
    });
    
    /**
     * Генерировать код виджета
     */
    generateCode = asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        const result = await this.widgetService.generateWidgetCode(parseInt(id));
        
        res.json({
            success: true,
            data: result
        });
    });
    
    /**
     * Трек просмотра виджета
     */
    trackView = asyncHandler(async (req, res) => {
        const { id } = req.params;
        
        await this.widgetService.trackView(parseInt(id));
        
        res.json({
            success: true,
            message: 'View tracked'
        });
    });
}

module.exports = WidgetController;







