'use strict';

const path = require('path');

/**
 * HTML-страницы и OBS-оверлеи, отдаваемые сервером (вынесено из server.js 1:1).
 *
 * Разбито на две регистрации, потому что порядок относительно express.static('public')
 * в server.js — семантика, а не случайность:
 *  - registerEarlyPages() — ДО static: эти роуты переопределяют Cache-Control
 *    (no-store) для файлов, которые иначе бы отдал static со своим кэшированием;
 *  - registerPages() — ПОСЛЕ static: обычные страницы/режимы/виджеты по чистым URL.
 *
 * deps: { appRoot, razblogEnabled, razblogPublicDir }
 */
function createPagesModule(deps) {
    const { appRoot, razblogEnabled, razblogPublicDir } = deps;

    function sendNoCachePublic(res, filename) {
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.sendFile(path.join(appRoot, 'public', filename));
    }

    function sendPublic(res, filename) {
        res.sendFile(path.join(appRoot, 'public', filename));
    }

    // --- До express.static('public') ---
    function registerEarlyPages(app) {
        app.get('/widget-donors-top.html', (req, res) => sendNoCachePublic(res, 'widget-donors-top.html'));
        app.get('/donation-driven-widget', (req, res) => sendPublic(res, 'donation-driven-widget.html'));

        app.get('/replay-live', (req, res) => sendNoCachePublic(res, 'replay-live.html'));
        app.get('/widget-replay-live', (req, res) => sendNoCachePublic(res, 'widget-replay-live.html'));
        app.get('/widget-replay-summary', (req, res) => sendNoCachePublic(res, 'widget-replay-summary.html'));
        app.get('/widget-replay-summary-carousel', (req, res) => sendNoCachePublic(res, 'widget-replay-summary-carousel.html'));
        app.get('/widget-replay-summary-carousel-cards', (req, res) => sendNoCachePublic(res, 'widget-replay-summary-carousel-cards.html'));
        app.get('/replay-summary.css', (req, res) => sendNoCachePublic(res, 'replay-summary.css'));
        app.get('/replay-summary-ui.js', (req, res) => sendNoCachePublic(res, 'replay-summary-ui.js'));
    }

    // --- После express.static('public') ---
    function registerPages(app) {
        app.get('/', (req, res) => sendPublic(res, 'index.html'));
        app.get('/admin', (req, res) => sendPublic(res, 'admin.html'));
        app.get('/analytics', (req, res) => sendPublic(res, 'analytics.html'));

        // /lesta-test, /lesta-api-test, /lesta-stats — в src/modules/lesta-oauth

        app.get('/donatepay-test', (req, res) => sendPublic(res, 'donatepay-test.html'));

        app.get('/dashboard/:mode', (req, res) => {
            const mode = req.params.mode;
            let file = 'mode1-frag-tracker.html';
            if (mode === 'mode2') file = 'mode2-timer.html';
            sendPublic(res, file);
        });

        app.get('/mode1-frag-tracker', (req, res) => sendPublic(res, 'mode1-frag-tracker.html'));
        app.get('/mode2-timer', (req, res) => sendPublic(res, 'mode2-timer.html'));

        app.get('/widget/:mode', (req, res) => {
            const mode = req.params.mode;
            let file = 'widget-mode1.html';
            let filePath = path.join(appRoot, 'public');

            if (mode === 'mode2') file = 'widget-mode2.html';
            else if (mode === 'mode3') file = 'widget-mode3.html';
            else if (mode === 'marathon') file = 'widget-marathon.html';
            else if (mode === 'donation-goal') {
                file = 'donation-goal.html';
                filePath = path.join(appRoot, 'public', 'widget');
            }
            else if (mode === 'donation-bar') file = 'widget-donation-bar.html';
            else if (mode === 'donation-driven') file = 'widget-donation-driven.html';
            else if (mode === 'tanks-blitz-challenge') file = 'widget-tanks-blitz-challenge.html';
            else if (mode === 'blitz-activity') file = 'widget-blitz-activity.html';
            else if (mode === 'battle') file = 'widget-battle.html';
            else if (mode === 'battle-promo') file = 'widget-battle-promo.html';
            else if (mode === 'battle-arena') file = 'widget-battle-arena.html';
            else if (mode === 'battle-arena-promo') file = 'widget-battle-arena-promo.html';
            else if (mode === 'razblogirovka-gold') {
                if (!razblogEnabled) {
                    return res.status(410).send('РазБЛОГировка 2026 отключена');
                }
                file = 'widget-razblogirovka-gold.html';
                filePath = razblogPublicDir;
            }

            // Отключаем кэширование для виджетов
            res.set({
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });

            res.sendFile(path.join(filePath, file));
        });

        app.get('/alert/:mode', (req, res) => {
            const mode = req.params.mode;
            let file = 'alert-mode1.html';
            if (mode === 'mode2') file = 'alert-mode2.html';
            else if (mode === 'mode3') file = 'alert-mode3.html';
            sendPublic(res, file);
        });
    }

    return { registerEarlyPages, registerPages };
}

module.exports = { createPagesModule };
