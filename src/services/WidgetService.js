const logger = require('../utils/logger');
const { ValidationError, NotFoundError } = require('../utils/AppError');

class WidgetService {
    constructor(widgetConfigModel) {
        this.widgetConfigModel = widgetConfigModel;
    }
    
    /**
     * Создать новый виджет
     */
    async createWidget(widgetData) {
        // Валидация конфигурации
        this.validateConfig(widgetData.type, widgetData.config);
        
        const widget = await this.widgetConfigModel.create(widgetData);
        
        logger.info('Widget created via service', { 
            id: widget.id, 
            name: widget.name, 
            slug: widget.slug 
        });
        
        return widget;
    }
    
    /**
     * Валидация конфигурации виджета
     */
    validateConfig(type, config) {
        const cfg = typeof config === 'string' ? JSON.parse(config) : config;
        
        // Базовые поля
        if (!cfg.width || !cfg.height) {
            throw new ValidationError('Widget config must include width and height');
        }
        
        // Специфичная валидация по типу
        switch (type) {
            case 'mode1':
            case 'mode2':
            case 'mode3':
                // Проверяем наличие основных полей
                if (!cfg.colors && !cfg.theme) {
                    throw new ValidationError('Widget config must include colors or theme');
                }
                break;
                
            case 'donation_goal':
                // Проверяем для виджета цели
                break;
                
            case 'custom':
                // Для кастомного виджета валидация мягче
                break;
                
            default:
                throw new ValidationError('Unknown widget type');
        }
    }
    
    /**
     * Получить виджет
     */
    async getWidget(identifier) {
        // Пробуем как ID
        if (Number.isInteger(parseInt(identifier))) {
            return await this.widgetConfigModel.getById(parseInt(identifier));
        }
        
        // Пробуем как slug
        return await this.widgetConfigModel.getBySlug(identifier);
    }
    
    /**
     * Получить все виджеты
     */
    async getAllWidgets(filters = {}) {
        return await this.widgetConfigModel.getAll(filters);
    }
    
    /**
     * Обновить виджет
     */
    async updateWidget(id, updates) {
        // Валидация если обновляется config
        if (updates.config) {
            const widget = await this.widgetConfigModel.getById(id);
            if (!widget) {
                throw new NotFoundError('Widget');
            }
            
            const type = updates.type || widget.type;
            this.validateConfig(type, updates.config);
        }
        
        return await this.widgetConfigModel.update(id, updates);
    }
    
    /**
     * Удалить виджет
     */
    async deleteWidget(id) {
        await this.widgetConfigModel.delete(id);
        logger.info('Widget deleted via service', { id });
    }
    
    /**
     * Клонировать виджет
     */
    async cloneWidget(id, newName = null) {
        const widget = await this.widgetConfigModel.getById(id);
        
        if (!widget) {
            throw new NotFoundError('Widget');
        }
        
        const clonedName = newName || `${widget.name} (Copy)`;
        
        const clonedWidget = await this.widgetConfigModel.create({
            name: clonedName,
            type: widget.type,
            config: widget.config,
            is_active: 0, // Копии неактивны по умолчанию
            is_public: 0
        });
        
        // Копируем элементы
        const elements = await this.widgetConfigModel.getElements(id);
        
        for (const element of elements) {
            await this.widgetConfigModel.addElement(clonedWidget.id, {
                element_type: element.element_type,
                position_x: element.position_x,
                position_y: element.position_y,
                width: element.width,
                height: element.height,
                z_index: element.z_index,
                styles: element.styles,
                data: element.data,
                animations: element.animations,
                visibility_condition: element.visibility_condition
            });
        }
        
        logger.info('Widget cloned', { 
            originalId: id, 
            clonedId: clonedWidget.id 
        });
        
        return clonedWidget;
    }
    
    /**
     * Получить виджет с элементами
     */
    async getWidgetWithElements(identifier) {
        const widget = await this.getWidget(identifier);
        
        if (!widget) {
            throw new NotFoundError('Widget');
        }
        
        const elements = await this.widgetConfigModel.getElements(widget.id);
        
        return {
            ...widget,
            elements
        };
    }
    
    /**
     * Добавить элемент к виджету
     */
    async addElement(widgetId, elementData) {
        // Валидация elementData
        if (!elementData.element_type) {
            throw new ValidationError('Element must have element_type');
        }
        
        const validTypes = ['text', 'progress_bar', 'timer', 'image', 'video', 'custom_html'];
        if (!validTypes.includes(elementData.element_type)) {
            throw new ValidationError('Invalid element_type');
        }
        
        return await this.widgetConfigModel.addElement(widgetId, elementData);
    }
    
    /**
     * Обновить элемент
     */
    async updateElement(elementId, updates) {
        // TODO: Реализовать в модели
        logger.info('Element updated', { elementId });
    }
    
    /**
     * Удалить элемент
     */
    async deleteElement(elementId) {
        await this.widgetConfigModel.deleteElement(elementId);
        logger.info('Element deleted via service', { elementId });
    }
    
    /**
     * Генерация HTML/CSS для виджета
     */
    async generateWidgetCode(widgetId) {
        const widget = await this.getWidgetWithElements(widgetId);
        
        if (!widget) {
            throw new NotFoundError('Widget');
        }
        
        // Генерируем HTML
        let html = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>${widget.name}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            width: ${widget.config.width}px; 
            height: ${widget.config.height}px; 
            overflow: hidden;
            font-family: ${widget.config.fontFamily || 'Arial, sans-serif'};
        }
        .widget-container {
            position: relative;
            width: 100%;
            height: 100%;
        }
`;
        
        // Генерируем CSS для элементов
        widget.elements.forEach((el, index) => {
            html += `
        .element-${index} {
            position: absolute;
            left: ${el.position_x}px;
            top: ${el.position_y}px;
            width: ${el.width}px;
            height: ${el.height}px;
            z-index: ${el.z_index};
        }`;
            
            // Добавляем кастомные стили
            if (el.styles) {
                for (const [key, value] of Object.entries(el.styles)) {
                    html += `\n            ${key}: ${value};`;
                }
            }
        });
        
        html += `
    </style>
</head>
<body>
    <div class="widget-container">
`;
        
        // Генерируем HTML элементов
        widget.elements.forEach((el, index) => {
            html += `        <div class="element-${index}" data-type="${el.element_type}">
`;
            
            switch (el.element_type) {
                case 'text':
                    html += `            ${el.data?.text || ''}
`;
                    break;
                case 'image':
                    html += `            <img src="${el.data?.src || ''}" alt="${el.data?.alt || ''}">
`;
                    break;
                // TODO: Другие типы элементов
            }
            
            html += `        </div>
`;
        });
        
        html += `    </div>
    <script>
        // WebSocket подключение для обновлений в реальном времени
        const ws = new WebSocket('ws://localhost:3000/ws');
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            // Обновление виджета
            console.log('Widget update:', data);
        };
    </script>
</body>
</html>`;
        
        return {
            html,
            widget
        };
    }
    
    /**
     * Увеличить счетчик просмотров
     */
    async trackView(widgetId) {
        await this.widgetConfigModel.incrementViews(widgetId);
    }
}

module.exports = WidgetService;







