/**
 * Migration: Widget Builder System
 * Created: 2025-01-25
 * Adds tables for custom widget configurations
 */

module.exports = {
    /**
     * Применение миграции
     */
    async up(db) {
        // Сохраненные конфигурации виджетов
        await db.run(`
            CREATE TABLE IF NOT EXISTS widget_configs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE, -- URL-friendly идентификатор
                type TEXT NOT NULL CHECK(type IN ('mode1', 'mode2', 'mode3', 'donation_goal', 'custom')),
                
                -- Конфигурация (JSON)
                config TEXT NOT NULL, -- Полная конфигурация виджета
                
                -- Настройки отображения
                is_active BOOLEAN DEFAULT 1,
                is_public BOOLEAN DEFAULT 0, -- Доступен ли по публичной ссылке
                
                -- Превью
                thumbnail_url TEXT,
                
                -- Метаданные
                views_count INTEGER DEFAULT 0,
                last_viewed_at DATETIME,
                
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Элементы виджета (для конструктора)
        await db.run(`
            CREATE TABLE IF NOT EXISTS widget_elements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                widget_id INTEGER NOT NULL,
                
                -- Тип элемента
                element_type TEXT NOT NULL CHECK(element_type IN ('text', 'progress_bar', 'timer', 'image', 'video', 'custom_html')),
                
                -- Позиция и размер
                position_x INTEGER DEFAULT 0,
                position_y INTEGER DEFAULT 0,
                width INTEGER DEFAULT 100,
                height INTEGER DEFAULT 50,
                z_index INTEGER DEFAULT 0,
                
                -- Стили (JSON)
                styles TEXT, -- CSS стили в JSON
                
                -- Данные элемента (JSON)
                data TEXT, -- Специфичные для типа данные
                
                -- Анимации (JSON)
                animations TEXT, -- Настройки анимаций
                
                -- Условия отображения
                visibility_condition TEXT, -- Условие для показа элемента
                
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                
                FOREIGN KEY (widget_id) REFERENCES widget_configs (id) ON DELETE CASCADE
            )
        `);
        
        // Темы виджетов (предустановленные и кастомные)
        await db.run(`
            CREATE TABLE IF NOT EXISTS widget_themes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                
                -- Цветовая схема (JSON)
                colors TEXT NOT NULL, -- primary, secondary, background, text, etc.
                
                -- Шрифты (JSON)
                fonts TEXT, -- font-family, sizes, weights
                
                -- Дополнительные стили (JSON)
                custom_css TEXT,
                
                -- Настройки
                is_preset BOOLEAN DEFAULT 0, -- Предустановленная тема
                is_public BOOLEAN DEFAULT 0,
                
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Индексы
        await db.run(`CREATE INDEX IF NOT EXISTS idx_widget_configs_slug ON widget_configs(slug)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_widget_configs_type ON widget_configs(type)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_widget_elements_widget_id ON widget_elements(widget_id)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_widget_themes_is_preset ON widget_themes(is_preset)`);
        
        // Вставляем предустановленные темы
        const defaultThemes = [
            {
                name: 'Dark Modern',
                description: 'Современная темная тема',
                colors: JSON.stringify({
                    primary: '#6366f1',
                    secondary: '#8b5cf6',
                    background: '#1a1a1a',
                    text: '#ffffff',
                    accent: '#ec4899'
                }),
                fonts: JSON.stringify({
                    primary: 'Inter, sans-serif',
                    sizes: { small: '12px', medium: '16px', large: '24px' }
                }),
                is_preset: 1
            },
            {
                name: 'Light Clean',
                description: 'Чистая светлая тема',
                colors: JSON.stringify({
                    primary: '#3b82f6',
                    secondary: '#10b981',
                    background: '#ffffff',
                    text: '#1f2937',
                    accent: '#f59e0b'
                }),
                fonts: JSON.stringify({
                    primary: 'Roboto, sans-serif',
                    sizes: { small: '12px', medium: '16px', large: '24px' }
                }),
                is_preset: 1
            },
            {
                name: 'Neon Cyberpunk',
                description: 'Киберпанк тема с неоновыми цветами',
                colors: JSON.stringify({
                    primary: '#ff00ff',
                    secondary: '#00ffff',
                    background: '#0a0a0a',
                    text: '#00ff00',
                    accent: '#ffff00'
                }),
                fonts: JSON.stringify({
                    primary: 'Orbitron, sans-serif',
                    sizes: { small: '12px', medium: '16px', large: '24px' }
                }),
                is_preset: 1
            }
        ];
        
        for (const theme of defaultThemes) {
            await db.run(
                `INSERT INTO widget_themes (name, description, colors, fonts, is_preset) VALUES (?, ?, ?, ?, ?)`,
                [theme.name, theme.description, theme.colors, theme.fonts, theme.is_preset]
            );
        }
    },
    
    /**
     * Откат миграции
     */
    async down(db) {
        await db.run(`DROP TABLE IF EXISTS widget_elements`);
        await db.run(`DROP TABLE IF EXISTS widget_themes`);
        await db.run(`DROP TABLE IF EXISTS widget_configs`);
    }
};







