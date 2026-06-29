const { DatabaseError, ValidationError, ConflictError } = require('../utils/AppError');
const logger = require('../utils/logger');

class WidgetConfigModel {
    constructor(db) {
        this.db = db;
    }
    
    /**
     * Создать slug из названия
     */
    generateSlug(name) {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9а-яё\s-]/gi, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .trim();
    }
    
    /**
     * Создать новую конфигурацию виджета
     */
    async create(widgetData) {
        try {
            const {
                name,
                slug = this.generateSlug(widgetData.name),
                type,
                config,
                is_active = 1,
                is_public = 0,
                thumbnail_url = null
            } = widgetData;
            
            // Проверяем уникальность slug
            const existing = await this.db.get('SELECT id FROM widget_configs WHERE slug = ?', [slug]);
            if (existing) {
                throw new ConflictError('Widget with this slug already exists');
            }
            
            const configJson = typeof config === 'string' ? config : JSON.stringify(config);
            
            const result = await this.db.run(
                `INSERT INTO widget_configs (name, slug, type, config, is_active, is_public, thumbnail_url)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [name, slug, type, configJson, is_active, is_public, thumbnail_url]
            );
            
            logger.info('Widget config created', { id: result.lastID, name, slug });
            
            return await this.getById(result.lastID);
        } catch (error) {
            logger.error('Error creating widget config', { error: error.message, widgetData });
            throw error instanceof ConflictError ? error : new DatabaseError('Failed to create widget config', error);
        }
    }
    
    /**
     * Получить виджет по ID
     */
    async getById(id) {
        const widget = await this.db.get('SELECT * FROM widget_configs WHERE id = ?', [id]);
        
        if (widget && widget.config) {
            try {
                widget.config = JSON.parse(widget.config);
            } catch (e) {
                // ignore
            }
        }
        
        return widget;
    }
    
    /**
     * Получить виджет по slug
     */
    async getBySlug(slug) {
        const widget = await this.db.get('SELECT * FROM widget_configs WHERE slug = ?', [slug]);
        
        if (widget && widget.config) {
            try {
                widget.config = JSON.parse(widget.config);
            } catch (e) {
                // ignore
            }
        }
        
        return widget;
    }
    
    /**
     * Получить все виджеты
     */
    async getAll(options = {}) {
        const { type = null, is_active = null, is_public = null } = options;
        
        let sql = 'SELECT * FROM widget_configs WHERE 1=1';
        const params = [];
        
        if (type) {
            sql += ' AND type = ?';
            params.push(type);
        }
        
        if (is_active !== null) {
            sql += ' AND is_active = ?';
            params.push(is_active ? 1 : 0);
        }
        
        if (is_public !== null) {
            sql += ' AND is_public = ?';
            params.push(is_public ? 1 : 0);
        }
        
        sql += ' ORDER BY created_at DESC';
        
        const widgets = await this.db.all(sql, params);
        
        return widgets.map(widget => {
            if (widget.config) {
                try {
                    widget.config = JSON.parse(widget.config);
                } catch (e) {
                    // ignore
                }
            }
            return widget;
        });
    }
    
    /**
     * Обновить виджет
     */
    async update(id, updates) {
        // Сериализуем config если это объект
        if (updates.config && typeof updates.config === 'object') {
            updates.config = JSON.stringify(updates.config);
        }
        
        // Проверяем уникальность slug если он меняется
        if (updates.slug) {
            const existing = await this.db.get(
                'SELECT id FROM widget_configs WHERE slug = ? AND id != ?',
                [updates.slug, id]
            );
            if (existing) {
                throw new ConflictError('Widget with this slug already exists');
            }
        }
        
        const fields = Object.keys(updates);
        const values = Object.values(updates);
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        
        await this.db.run(
            `UPDATE widget_configs SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [...values, id]
        );
        
        logger.info('Widget config updated', { id, fields });
        
        return await this.getById(id);
    }
    
    /**
     * Удалить виджет
     */
    async delete(id) {
        await this.db.run('DELETE FROM widget_configs WHERE id = ?', [id]);
        logger.info('Widget config deleted', { id });
    }
    
    /**
     * Увеличить счетчик просмотров
     */
    async incrementViews(id) {
        await this.db.run(
            `UPDATE widget_configs 
             SET views_count = views_count + 1, 
                 last_viewed_at = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [id]
        );
    }
    
    /**
     * Получить элементы виджета
     */
    async getElements(widgetId) {
        const elements = await this.db.all(
            'SELECT * FROM widget_elements WHERE widget_id = ? ORDER BY z_index ASC',
            [widgetId]
        );
        
        return elements.map(el => {
            ['styles', 'data', 'animations'].forEach(field => {
                if (el[field]) {
                    try {
                        el[field] = JSON.parse(el[field]);
                    } catch (e) {
                        // ignore
                    }
                }
            });
            return el;
        });
    }
    
    /**
     * Добавить элемент к виджету
     */
    async addElement(widgetId, elementData) {
        const {
            element_type,
            position_x = 0,
            position_y = 0,
            width = 100,
            height = 50,
            z_index = 0,
            styles = null,
            data = null,
            animations = null,
            visibility_condition = null
        } = elementData;
        
        const stylesJson = styles ? JSON.stringify(styles) : null;
        const dataJson = data ? JSON.stringify(data) : null;
        const animationsJson = animations ? JSON.stringify(animations) : null;
        
        const result = await this.db.run(
            `INSERT INTO widget_elements 
             (widget_id, element_type, position_x, position_y, width, height, z_index, 
              styles, data, animations, visibility_condition)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [widgetId, element_type, position_x, position_y, width, height, z_index,
             stylesJson, dataJson, animationsJson, visibility_condition]
        );
        
        logger.info('Widget element added', { id: result.lastID, widgetId, element_type });
        
        return result.lastID;
    }
    
    /**
     * Удалить элемент виджета
     */
    async deleteElement(elementId) {
        await this.db.run('DELETE FROM widget_elements WHERE id = ?', [elementId]);
        logger.info('Widget element deleted', { id: elementId });
    }
}

module.exports = WidgetConfigModel;







