'use strict';

const path = require('path');
const { initBossOrdersSchema } = require('./schema');

const STATUSES = ['pending', 'active', 'done', 'failed', 'cancelled'];

/**
 * «Именной босс»: донат с комментарием выше порога становится «приказом» от
 * зрителя — стример/модератор отмечает его выполнение, ник и текст видны на
 * OBS-виджете. Один активный приказ за раз (ясная картинка на стриме).
 *
 * deps: { db, appRoot, broadcastToClients, normalizeUsername }
 */
function createBossOrdersModule(deps) {
    const db = deps.db;

    function getConfig(callback) {
        db.get('SELECT * FROM boss_orders_config WHERE id = 1', (err, row) => {
            callback(err, row || { enabled: 1, threshold_amount: 500, header_text: 'ПРИКАЗ ОТ ЗРИТЕЛЯ' });
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
                `SELECT * FROM boss_orders WHERE status != 'cancelled' ORDER BY created_at DESC LIMIT 50`,
                (err, rows) => {
                    if (err) {
                        console.error('❌ Ошибка чтения boss_orders:', err);
                        return callback({ config, orders: [], active: null });
                    }
                    const orders = (rows || []).map(normalizeOrderRow);
                    const active = orders.find(o => o.status === 'active') || null;
                    callback({
                        config: {
                            enabled: !!config.enabled,
                            thresholdAmount: Number(config.threshold_amount) || 0,
                            headerText: config.header_text || 'ПРИКАЗ ОТ ЗРИТЕЛЯ'
                        },
                        orders,
                        active
                    });
                }
            );
        });
    }

    function broadcastUpdate(extra) {
        getOrdersSnapshot((snapshot) => {
            deps.broadcastToClients(Object.assign({ type: 'BOSS_ORDER_UPDATE' }, snapshot, extra || {}));
        });
    }

    // Вызывается подписчиком donationBus на каждый донат — решает, создавать ли приказ
    function addDonationOrder(donation) {
        const amount = Number(donation.amount) || 0;
        const text = (donation.message || '').trim();
        if (!text) return;

        getConfig((err, config) => {
            if (err || !config.enabled) return;
            const threshold = Number(config.threshold_amount) || 0;
            if (amount < threshold) return;

            const username = donation.username || 'Аноним';
            const normalizedUsername = deps.normalizeUsername ? deps.normalizeUsername(username) : null;

            db.run(
                `INSERT OR IGNORE INTO boss_orders (donation_id, username, normalized_username, amount, order_text, status)
                 VALUES (?, ?, ?, ?, ?, 'pending')`,
                [donation.id != null ? String(donation.id) : null, username, normalizedUsername, amount, text.slice(0, 300)],
                function (insErr) {
                    if (insErr) {
                        console.error('❌ Ошибка создания приказа босса:', insErr);
                        return;
                    }
                    if (this.changes > 0) {
                        console.log(`⚔️ Новый приказ от ${username} (${amount}₽): "${text.slice(0, 60)}"`);
                        broadcastUpdate();
                    }
                }
            );
        });
    }

    function registerRoutes(app) {
        app.get('/api/boss-orders', (req, res) => {
            getOrdersSnapshot((snapshot) => res.json(Object.assign({ success: true }, snapshot)));
        });

        app.put('/api/boss-orders/config', (req, res) => {
            const b = req.body || {};
            const updates = [];
            const values = [];
            if (b.enabled != null) { updates.push('enabled = ?'); values.push(b.enabled ? 1 : 0); }
            if (b.thresholdAmount != null) { updates.push('threshold_amount = ?'); values.push(Math.max(0, Number(b.thresholdAmount) || 0)); }
            if (b.headerText != null) { updates.push('header_text = ?'); values.push(String(b.headerText).slice(0, 100)); }
            if (!updates.length) return res.status(400).json({ success: false, error: 'Нет полей для обновления' });
            updates.push('updated_at = CURRENT_TIMESTAMP');
            db.run(`UPDATE boss_orders_config SET ${updates.join(', ')} WHERE id = 1`, values, (err) => {
                if (err) return res.status(500).json({ success: false, error: 'Ошибка сохранения' });
                broadcastUpdate();
                getOrdersSnapshot((snapshot) => res.json(Object.assign({ success: true }, snapshot)));
            });
        });

        // Тестовый приказ (кнопка в управлении, без реального доната)
        app.post('/api/boss-orders/test', (req, res) => {
            const username = (req.body && req.body.username) || 'Тестовый Донатер';
            const amount = Number(req.body && req.body.amount) || 500;
            const text = (req.body && req.body.text) || 'Убей 3 танка в этом бою!';
            addDonationOrder({ id: `test_${Date.now()}`, username, amount, message: text });
            res.json({ success: true });
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
            if (status === 'active') {
                // Один активный приказ за раз — деактивируем остальные
                db.run(`UPDATE boss_orders SET status = 'pending' WHERE status = 'active' AND id != ?`, [id], (deactErr) => {
                    if (deactErr) return res.status(500).json({ success: false, error: 'Ошибка обновления' });
                    db.run(`UPDATE boss_orders SET status = 'active' WHERE id = ?`, [id], (err) => {
                        if (err) return res.status(500).json({ success: false, error: 'Ошибка обновления' });
                        afterUpdate();
                    });
                });
                return;
            }
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
        registerPages,
        addDonationOrder
    };
}

module.exports = { createBossOrdersModule };
