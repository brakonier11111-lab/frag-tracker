'use strict';

const path = require('path');

function createRazblogModule(deps, config) {
    let razblogirovkaGoldService = null;

    function razblogArchivedJson(res) {
        res.status(410).json({
            success: false,
            archived: true,
            message: 'РазБЛОГировка 2026 отключена. Для включения уберите RAZBLOG_ENABLED=0 и перезапустите сервер.'
        });
    }

    function initRazblogirovkaGoldService() {
        if (!config.razblogEnabled || !config.createRazblogirovkaGoldService) return;
        razblogirovkaGoldService = config.createRazblogirovkaGoldService({
            db: deps.db,
            getAppState: deps.getAppState,
            updateAppState: deps.updateAppState,
            getLestaPlayerStats: deps.getLestaPlayerStats,
            broadcastToClients: deps.broadcastToClients
        });
    }

    function registerRoutes(app) {
        app.get('/api/razblogirovka/gold-bank', (req, res) => {
            if (!config.razblogEnabled) return razblogArchivedJson(res);
            if (!razblogirovkaGoldService) initRazblogirovkaGoldService();
            razblogirovkaGoldService.loadSummary((err, summary) => {
                if (err) {
                    console.error('❌ razblogirovka loadSummary:', err);
                    return res.status(500).json({ success: false, error: err.message || 'Ошибка сервера' });
                }
                res.json({ success: true, ...summary });
            });
        });

        app.post('/api/razblogirovka/sync', (req, res) => {
            if (!config.razblogEnabled) return razblogArchivedJson(res);
            if (!razblogirovkaGoldService) initRazblogirovkaGoldService();
            razblogirovkaGoldService.syncFromLestaStats({ force: !!(req.body && req.body.force) }, (err, data) => {
                if (err) {
                    return res.status(500).json({ success: false, error: err.message || 'Ошибка синхронизации' });
                }
                res.json({ success: true, ...data });
            });
        });

        app.post('/api/razblogirovka/start', (req, res) => {
            if (!config.razblogEnabled) return razblogArchivedJson(res);
            if (!razblogirovkaGoldService) initRazblogirovkaGoldService();
            razblogirovkaGoldService.startTracking((err, data) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json(data);
            });
        });

        app.post('/api/razblogirovka/stop', (req, res) => {
            if (!config.razblogEnabled) return razblogArchivedJson(res);
            if (!razblogirovkaGoldService) initRazblogirovkaGoldService();
            razblogirovkaGoldService.stopTracking((err, data) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json(data);
            });
        });

        app.post('/api/razblogirovka/reset', (req, res) => {
            if (!config.razblogEnabled) return razblogArchivedJson(res);
            if (!razblogirovkaGoldService) initRazblogirovkaGoldService();
            razblogirovkaGoldService.resetTracking((err, data) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json(data);
            });
        });

        app.post('/api/razblogirovka/widget-settings', require('express').json(), (req, res) => {
            if (!config.razblogEnabled) return razblogArchivedJson(res);
            if (!razblogirovkaGoldService) initRazblogirovkaGoldService();
            razblogirovkaGoldService.updateWidgetSettings(req.body || {}, (err, data) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json(data);
            });
        });
    }

    function registerPages(app) {
        app.get('/razblogirovka', (req, res) => {
            if (!config.razblogEnabled) {
                return res.status(410).send('РазБЛОГировка 2026 отключена. Уберите RAZBLOG_ENABLED=0 и перезапустите сервер.');
            }
            res.sendFile(path.join(__dirname, 'public', 'razblogirovka.html'));
        });
    }

    return {
        initRazblogirovkaGoldService,
        getService: () => razblogirovkaGoldService,
        registerRoutes,
        registerPages
    };
}

module.exports = { createRazblogModule };
