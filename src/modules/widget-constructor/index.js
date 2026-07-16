'use strict';

const { getDataRegistry } = require('../../core/data-registry');

/**
 * Конструктор виджетов (public/widget-builder.html): хранит произвольные
 * виджеты как JSON-набор элементов (text/progress_bar/image/timer) с
 * привязкой к источникам данных из src/core/data-registry.js и стилями,
 * отдаёт их рендереру /widget/custom/:id (см. src/modules/pages).
 */
function createWidgetConstructorModule(deps) {
    const { db } = deps;

    db.run(`CREATE TABLE IF NOT EXISTS widgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        canvas_width INTEGER DEFAULT 800,
        canvas_height INTEGER DEFAULT 200,
        elements TEXT NOT NULL DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания таблицы widgets:', err);
    });
    // OBS-профили (альтернативные наборы стилей на элемент, выбираемые через ?profile=)
    // добавлены позже — миграция мягкая, ошибку "duplicate column" на существующих БД игнорируем.
    db.run(`ALTER TABLE widgets ADD COLUMN obs_profiles TEXT NOT NULL DEFAULT '[]'`, () => {});

    function rowToWidget(row) {
        if (!row) return row;
        let elements = [];
        try { elements = JSON.parse(row.elements || '[]'); } catch (e) { elements = []; }
        let obsProfiles = [];
        try { obsProfiles = JSON.parse(row.obs_profiles || '[]'); } catch (e) { obsProfiles = []; }
        return {
            id: row.id,
            name: row.name,
            canvasWidth: row.canvas_width,
            canvasHeight: row.canvas_height,
            elements,
            obsProfiles,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    function registerRoutes(app) {
        // Источники данных, доступные конструктору (без секретов/токенов)
        app.get('/api/widgets/data-sources', (req, res) => {
            res.json({ success: true, sources: getDataRegistry() });
        });

        app.get('/api/widgets', (req, res) => {
            db.all('SELECT id, name, canvas_width, canvas_height, created_at, updated_at FROM widgets ORDER BY id DESC', (err, rows) => {
                if (err) {
                    console.error('❌ Ошибка чтения списка виджетов:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка сервера' });
                }
                res.json({ success: true, data: (rows || []).map(r => ({
                    id: r.id, name: r.name, canvasWidth: r.canvas_width, canvasHeight: r.canvas_height,
                    createdAt: r.created_at, updatedAt: r.updated_at
                })) });
            });
        });

        app.get('/api/widgets/:id', (req, res) => {
            db.get('SELECT * FROM widgets WHERE id = ?', [req.params.id], (err, row) => {
                if (err) {
                    console.error('❌ Ошибка чтения виджета:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка сервера' });
                }
                if (!row) return res.status(404).json({ success: false, error: 'Виджет не найден' });
                res.json({ success: true, data: rowToWidget(row) });
            });
        });

        app.post('/api/widgets', (req, res) => {
            const { name, config, elements, obsProfiles } = req.body || {};
            if (!name || typeof name !== 'string') {
                return res.status(400).json({ success: false, error: 'Укажите название виджета' });
            }
            const width = parseInt((config && config.width) || 800, 10) || 800;
            const height = parseInt((config && config.height) || 200, 10) || 200;
            const elementsJson = JSON.stringify(Array.isArray(elements) ? elements : []);
            const obsProfilesJson = JSON.stringify(Array.isArray(obsProfiles) ? obsProfiles : []);

            db.run(
                `INSERT INTO widgets (name, canvas_width, canvas_height, elements, obs_profiles) VALUES (?, ?, ?, ?, ?)`,
                [name, width, height, elementsJson, obsProfilesJson],
                function (err) {
                    if (err) {
                        console.error('❌ Ошибка создания виджета:', err);
                        return res.status(500).json({ success: false, error: 'Ошибка сервера' });
                    }
                    db.get('SELECT * FROM widgets WHERE id = ?', [this.lastID], (err2, row) => {
                        if (err2 || !row) return res.json({ success: true, data: { id: this.lastID, name } });
                        res.json({ success: true, data: rowToWidget(row) });
                    });
                }
            );
        });

        app.put('/api/widgets/:id', (req, res) => {
            const { name, config, elements, obsProfiles } = req.body || {};
            const width = parseInt((config && config.width) || 800, 10) || 800;
            const height = parseInt((config && config.height) || 200, 10) || 200;
            const elementsJson = JSON.stringify(Array.isArray(elements) ? elements : []);
            const obsProfilesJson = JSON.stringify(Array.isArray(obsProfiles) ? obsProfiles : []);

            db.run(
                `UPDATE widgets SET name = ?, canvas_width = ?, canvas_height = ?, elements = ?, obs_profiles = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [name, width, height, elementsJson, obsProfilesJson, req.params.id],
                function (err) {
                    if (err) {
                        console.error('❌ Ошибка обновления виджета:', err);
                        return res.status(500).json({ success: false, error: 'Ошибка сервера' });
                    }
                    if (this.changes === 0) return res.status(404).json({ success: false, error: 'Виджет не найден' });
                    db.get('SELECT * FROM widgets WHERE id = ?', [req.params.id], (err2, row) => {
                        res.json({ success: true, data: rowToWidget(row) });
                    });
                }
            );
        });

        app.delete('/api/widgets/:id', (req, res) => {
            db.run('DELETE FROM widgets WHERE id = ?', [req.params.id], function (err) {
                if (err) {
                    console.error('❌ Ошибка удаления виджета:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка сервера' });
                }
                if (this.changes === 0) return res.status(404).json({ success: false, error: 'Виджет не найден' });
                res.json({ success: true });
            });
        });
    }

    return { registerRoutes };
}

module.exports = { createWidgetConstructorModule };
