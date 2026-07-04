'use strict';

const path = require('path');
const { initBossOrdersSchema } = require('./schema');

const STATUSES = ['pending', 'active', 'done', 'failed', 'cancelled'];

/**
 * «Именной босс»: приказ от донатера — ник, сумма, задание — виден на OBS-виджете.
 * Создаётся только вручную стримером/модератором — на виджете одновременно
 * могут быть несколько приказов, ранжируются по сумме, «в процессе» не
 * пропадают после выполнения.
 *
 * deps: { db, appRoot, broadcastToClients, normalizeUsername }
 */
function createBossOrdersModule(deps) {
    const db = deps.db;

    function getConfig(callback) {
        db.get('SELECT * FROM boss_orders_config WHERE id = 1', (err, row) => {
            callback(err, row || { threshold_amount: 500 });
        });
    }

    function normalizeOrderRow(row) {
        return {
            id: row.id,
            donationId: row.donation_id,
            username: row.username,
            amount: Number(row.amount) || 0,
            text: row.order_text || '',
            status: row.status,
            createdAt: row.created_at,
            completedAt: row.completed_at
        };
    }

    function getOrdersSnapshot(callback) {
        getConfig((cfgErr, config) => {
            db.all(
                // created_at у SQLite — секундная точность; id вторым критерием
                // разруливает порядок нескольких приказов, созданных подряд за 1 секунду
                `SELECT * FROM boss_orders WHERE status != 'cancelled' ORDER BY created_at DESC, id DESC LIMIT 50`,
                (err, rows) => {
                    const cfgOut = { thresholdAmount: Number(config.threshold_amount) || 0 };
                    if (err) {
                        console.error('❌ Ошибка чтения boss_orders:', err);
                        return callback({ config: cfgOut, orders: [], active: null, boardOrders: [] });
                    }
                    const orders = (rows || []).map(normalizeOrderRow);
                    const active = orders.find(o => o.status === 'active') || null;
                    // То, что реально показывает виджет: активные + выполненные + проваленные,
                    // отсортированные по сумме — выполненные и проваленные не пропадают из вида,
                    // остаются на доске (провал — темнее, выполнено — зелёный перелив).
                    const boardOrders = orders
                        .filter(o => o.status === 'active' || o.status === 'done' || o.status === 'failed')
                        .sort((a, b) => b.amount - a.amount);
                    callback({ config: cfgOut, orders, active, boardOrders });
                }
            );
        });
    }

    function broadcastUpdate(extra) {
        getOrdersSnapshot((snapshot) => {
            deps.broadcastToClients(Object.assign({ type: 'BOSS_ORDER_UPDATE' }, snapshot, extra || {}));
        });
    }

    function registerRoutes(app) {
        app.get('/api/boss-orders', (req, res) => {
            getOrdersSnapshot((snapshot) => res.json(Object.assign({ success: true }, snapshot)));
        });

        // Цена челленджа — только для плашки на виджете, доната или автосоздания не запускает
        app.put('/api/boss-orders/config', (req, res) => {
            const thresholdAmount = Math.max(0, Number(req.body && req.body.thresholdAmount) || 0);
            db.run(
                `UPDATE boss_orders_config SET threshold_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
                [thresholdAmount],
                (err) => {
                    if (err) return res.status(500).json({ success: false, error: 'Ошибка сохранения' });
                    broadcastUpdate();
                    getOrdersSnapshot((snapshot) => res.json(Object.assign({ success: true }, snapshot)));
                }
            );
        });

        // Ручное создание приказа стримером/модератором — единственный способ
        // добавить челлендж, виджет не считает донаты сам.
        app.post('/api/boss-orders/manual', (req, res) => {
            const username = ((req.body && req.body.username) || '').trim() || 'Аноним';
            const amount = Math.max(0, Number(req.body && req.body.amount) || 0);
            const text = ((req.body && req.body.text) || '').trim();
            if (!text) return res.status(400).json({ success: false, error: 'Укажите задание челленджа' });

            const normalizedUsername = deps.normalizeUsername ? deps.normalizeUsername(username) : null;
            const donationId = `manual_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

            // Сразу 'active' — челлендж сразу попадает в «выполняется», без кнопки «Начать»
            db.run(
                `INSERT INTO boss_orders (donation_id, username, normalized_username, amount, order_text, status)
                 VALUES (?, ?, ?, ?, ?, 'active')`,
                [donationId, username, normalizedUsername, amount, text.slice(0, 300)],
                function (err) {
                    if (err) {
                        console.error('❌ Ошибка ручного создания челленджа:', err);
                        return res.status(500).json({ success: false, error: 'Ошибка создания' });
                    }
                    broadcastUpdate();
                    getOrdersSnapshot((snapshot) => res.json(Object.assign({ success: true }, snapshot)));
                }
            );
        });

        function setStatus(id, status, res) {
            if (!STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'Неизвестный статус' });
            const completedAt = (status === 'done' || status === 'failed') ? "CURRENT_TIMESTAMP" : 'NULL';
            const afterUpdate = () => {
                getOrdersSnapshot((snapshot) => {
                    deps.broadcastToClients(Object.assign({ type: 'BOSS_ORDER_UPDATE' }, snapshot));
                    res.json(Object.assign({ success: true }, snapshot));
                });
            };
            // Несколько приказов могут быть активны одновременно — виджет ранжирует их по сумме
            db.run(`UPDATE boss_orders SET status = ?, completed_at = ${completedAt} WHERE id = ?`, [status, id], (err) => {
                if (err) return res.status(500).json({ success: false, error: 'Ошибка обновления' });
                afterUpdate();
            });
        }

        app.post('/api/boss-orders/:id/activate', (req, res) => setStatus(req.params.id, 'active', res));
        app.post('/api/boss-orders/:id/complete', (req, res) => setStatus(req.params.id, 'done', res));
        app.post('/api/boss-orders/:id/fail', (req, res) => setStatus(req.params.id, 'failed', res));
        app.post('/api/boss-orders/:id/reset', (req, res) => setStatus(req.params.id, 'pending', res));
        app.delete('/api/boss-orders/:id', (req, res) => setStatus(req.params.id, 'cancelled', res));
    }

    function registerPages(app) {
        app.get('/boss-orders', (req, res) => {
            res.sendFile(path.join(deps.appRoot, 'public', 'boss-orders.html'));
        });
        app.get('/widget-boss-orders', (req, res) => {
            res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
            res.sendFile(path.join(deps.appRoot, 'public', 'widget-boss-orders.html'));
        });
    }

    return {
        initSchema: initBossOrdersSchema,
        registerRoutes,
        registerPages
    };
}

module.exports = { createBossOrdersModule };
