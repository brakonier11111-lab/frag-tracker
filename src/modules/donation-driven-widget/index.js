'use strict';

/**
 * Виджет «параметр от донатов» (процент/единицы, растущие за N₽, лимит,
 * опциональная сессия по винрейту Lesta). Вынесено из server.js вторым шагом
 * разбора монолита — раньше это были глобальные функции/роуты, перемешанные
 * с остальным кодом донат-виджетов.
 */

function createDonationDrivenWidgetModule({ db, broadcastToClients, getAppState, updateAppState }) {
    function getDonationDrivenWidgetById(widgetId, cb) {
        db.get('SELECT * FROM donation_driven_widgets WHERE id = ?', [widgetId], (err, row) => {
            if (err) return cb(err);
            cb(null, row);
        });
    }

    function computeDdLestaSessionFields(state) {
        const empty = {
            lesta_session_active: 0,
            lesta_session_battles: 0,
            lesta_session_wins: 0,
            lesta_session_winrate: 0,
            lesta_session_avg_damage: 0,
            lesta_session_started_at: 0
        };
        if (!state || !state.dd_lesta_session_started_at || state.dd_lesta_session_started_at <= 0) {
            return empty;
        }
        const startBattles = state.dd_lesta_session_start_battles || 0;
        const startWins = state.dd_lesta_session_start_wins || 0;
        const startDamage = state.dd_lesta_session_start_damage || 0;
        const lastBattles = state.lesta_last_battles || 0;
        const lastWins = state.lesta_last_wins || 0;
        const lastDamage = state.lesta_last_damage_dealt || 0;
        const battlesDiff = Math.max(lastBattles - startBattles, 0);
        const winsDiff = Math.max(lastWins - startWins, 0);
        const damageDiff = Math.max(lastDamage - startDamage, 0);
        return {
            lesta_session_active: 1,
            lesta_session_battles: battlesDiff,
            lesta_session_wins: winsDiff,
            lesta_session_winrate: battlesDiff > 0 ? (winsDiff / battlesDiff) * 100 : 0,
            lesta_session_avg_damage: battlesDiff > 0 ? Math.round(damageDiff / battlesDiff) : 0,
            lesta_session_started_at: state.dd_lesta_session_started_at
        };
    }

    function normalizeDonationDrivenWidgetRow(row) {
        if (!row) return row;
        var p = { ...row };
        p.fallback_text = String(row.fallback_text ?? row['fallback_text'] ?? '');
        p.info_window_title = String(row.info_window_title ?? row['info_window_title'] ?? '');
        p.infoWindowTitle = p.info_window_title;
        if (p.info_window_enabled == null) p.info_window_enabled = 1;
        if (p.widget_bg_opacity == null) p.widget_bg_opacity = 1;
        if (p.fallback_threshold == null) p.fallback_threshold = 50;
        if (p.timer_enabled == null) p.timer_enabled = 0;
        if (p.timer_duration_seconds == null) p.timer_duration_seconds = 300;
        return p;
    }

    function enrichDonationDrivenWidgetWithLesta(payload, callback) {
        if (typeof getAppState !== 'function') {
            return callback(payload);
        }
        getAppState((state) => {
            try {
                callback({ ...payload, ...computeDdLestaSessionFields(state) });
            } catch (e) {
                console.error('❌ Ошибка расчёта сессионного винрейта Lesta для donation-driven виджета:', e);
                callback(payload);
            }
        });
    }

    function broadcastDonationDrivenWidgetUpdate(row) {
        const payload = normalizeDonationDrivenWidgetRow(row);
        enrichDonationDrivenWidgetWithLesta(payload, (enriched) => {
            broadcastToClients({ type: 'DONATION_DRIVEN_UPDATE', widget: enriched });
        });
    }

    function registerRoutes(app) {
        app.get('/api/donation-driven-widget', (req, res) => {
            getDonationDrivenWidgetById(1, (err, row) => {
                if (err) {
                    console.error('❌ Ошибка чтения donation_driven_widget:', err);
                    return res.status(500).json({ error: 'Ошибка сервера' });
                }
                if (!row) {
                    const payload = normalizeDonationDrivenWidgetRow({
                        id: 1,
                        name: 'Цель по донатам',
                        goal_text: '',
                        unit_label: '%',
                        start_value: 70,
                        current_value: 70,
                        cap_value: 100,
                        per_amount: 100,
                        add_value: 0.1,
                        enabled: 1,
                        widget_bg_opacity: 1,
                        info_window_enabled: 1,
                        fallback_text: '',
                        info_window_title: '',
                        fallback_threshold: 50,
                        timer_enabled: 0,
                        timer_duration_seconds: 300
                    });
                    return enrichDonationDrivenWidgetWithLesta(payload, (enriched) => res.json(enriched));
                }
                enrichDonationDrivenWidgetWithLesta(normalizeDonationDrivenWidgetRow(row), (enriched) => res.json(enriched));
            });
        });

        app.put('/api/donation-driven-widget', (req, res) => {
            const body = req.body || {};
            const name = body.name != null ? String(body.name).trim() : undefined;
            const goal_text = body.goal_text != null ? String(body.goal_text).trim() : undefined;
            const unit_label = body.unit_label != null ? String(body.unit_label).trim() : undefined;
            const start_value = body.start_value != null ? parseFloat(body.start_value) : undefined;
            const current_value = body.current_value != null ? parseFloat(body.current_value) : undefined;
            const cap_value = body.cap_value != null ? parseFloat(body.cap_value) : undefined;
            const per_amount = body.per_amount != null ? parseFloat(body.per_amount) : undefined;
            const add_value = body.add_value != null ? parseFloat(body.add_value) : undefined;
            const enabled = body.enabled != null ? (body.enabled ? 1 : 0) : undefined;
            const fallback_text = body.fallback_text != null ? String(body.fallback_text).trim() : undefined;
            const fallback_threshold = body.fallback_threshold != null ? parseFloat(body.fallback_threshold) : undefined;
            const widget_bg_opacity = body.widget_bg_opacity != null ? parseFloat(body.widget_bg_opacity) : undefined;
            const info_window_enabled = body.info_window_enabled != null ? (body.info_window_enabled ? 1 : 0) : undefined;
            const info_window_title = body.info_window_title != null ? String(body.info_window_title).trim() : undefined;
            const timer_enabled = body.timer_enabled != null ? (body.timer_enabled ? 1 : 0) : undefined;
            const timer_duration_seconds = body.timer_duration_seconds != null ? parseInt(body.timer_duration_seconds, 10) : undefined;

            var combinedFallback = undefined;
            if (info_window_title !== undefined || fallback_text !== undefined) {
                var titleStr = info_window_title !== undefined ? String(info_window_title).trim() : '';
                var bodyStr = fallback_text !== undefined ? String(fallback_text).trim() : '';
                combinedFallback = titleStr + '|||' + bodyStr;
            }

            const updates = [];
            const values = [];
            if (name !== undefined) { updates.push('name = ?'); values.push(name); }
            if (goal_text !== undefined) { updates.push('goal_text = ?'); values.push(goal_text); }
            if (unit_label !== undefined) { updates.push('unit_label = ?'); values.push(unit_label); }
            if (start_value !== undefined && !isNaN(start_value)) {
                updates.push('start_value = ?'); values.push(start_value);
                updates.push('current_value = ?'); values.push(start_value);
            }
            if (cap_value !== undefined) { updates.push('cap_value = ?'); values.push(cap_value); }
            if (per_amount !== undefined) { updates.push('per_amount = ?'); values.push(per_amount); }
            if (add_value !== undefined) { updates.push('add_value = ?'); values.push(add_value); }
            if (enabled !== undefined) { updates.push('enabled = ?'); values.push(enabled); }
            if (combinedFallback !== undefined) { updates.push('fallback_text = ?'); values.push(combinedFallback); }
            if (fallback_threshold !== undefined && !isNaN(fallback_threshold)) { updates.push('fallback_threshold = ?'); values.push(fallback_threshold); }
            if (widget_bg_opacity !== undefined && !isNaN(widget_bg_opacity)) { updates.push('widget_bg_opacity = ?'); values.push(Math.min(1, Math.max(0, widget_bg_opacity))); }
            if (info_window_enabled !== undefined) { updates.push('info_window_enabled = ?'); values.push(info_window_enabled); }
            if (timer_enabled !== undefined) { updates.push('timer_enabled = ?'); values.push(timer_enabled); }
            if (timer_duration_seconds !== undefined && !isNaN(timer_duration_seconds) && timer_duration_seconds > 0) { updates.push('timer_duration_seconds = ?'); values.push(timer_duration_seconds); }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'Нет полей для обновления' });
            }
            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(1);

            db.run(
                `UPDATE donation_driven_widgets SET ${updates.join(', ')} WHERE id = ?`,
                values,
                function (err) {
                    if (err) {
                        console.error('❌ Ошибка обновления donation_driven_widget:', err);
                        return res.status(500).json({ error: 'Ошибка обновления' });
                    }
                    getDonationDrivenWidgetById(1, (e, row) => {
                        if (!e && row) {
                            const payload = normalizeDonationDrivenWidgetRow(row);
                            enrichDonationDrivenWidgetWithLesta(payload, (enriched) => {
                                broadcastToClients({ type: 'DONATION_DRIVEN_UPDATE', widget: enriched });
                                res.json(enriched);
                            });
                        } else {
                            res.json({ success: true });
                        }
                    });
                }
            );
        });

        // Сессионный винрейт Lesta для виджета «параметр от донатов» — старт сессии
        // Важно: опираемся на уже сохранённое состояние Lesta (lesta_last_* в app_state),
        // чтобы сессия жила независимо от текущей доступности внешнего API.
        app.post('/api/donation-driven-widget/lesta-session/start', (req, res) => {
            getAppState((state) => {
                if (!state) {
                    return res.status(500).json({ success: false, error: 'Нет состояния приложения (app_state)' });
                }

                const startBattles = state.lesta_last_battles || 0;
                const startWins = state.lesta_last_wins || 0;
                const startLosses = state.lesta_last_losses || 0;
                const startDamage = state.lesta_last_damage_dealt || 0;
                const startedAt = Math.floor(Date.now() / 1000);

                const updates = {
                    dd_lesta_session_active: 1,
                    dd_lesta_session_start_battles: startBattles,
                    dd_lesta_session_start_wins: startWins,
                    dd_lesta_session_start_losses: startLosses,
                    dd_lesta_session_start_damage: startDamage,
                    dd_lesta_session_started_at: startedAt
                };

                updateAppState(updates, (err) => {
                    if (err) {
                        console.error('❌ Ошибка сохранения сессии Lesta для donation-driven виджета:', err);
                        return res.status(500).json({ success: false, error: 'Ошибка сохранения сессии' });
                    }
                    getDonationDrivenWidgetById(1, (e, row) => {
                        if (!e && row) broadcastDonationDrivenWidgetUpdate(row);
                    });
                    res.json({
                        success: true,
                        session: {
                            started_at: startedAt,
                            startBattles,
                            startWins,
                            startLosses,
                            startDamage
                        }
                    });
                });
            });
        });

        // Сброс сессии Lesta для виджета «параметр от донатов»
        app.post('/api/donation-driven-widget/lesta-session/reset', (req, res) => {
            const updates = {
                dd_lesta_session_active: 0,
                dd_lesta_session_start_battles: 0,
                dd_lesta_session_start_wins: 0,
                dd_lesta_session_start_losses: 0,
                dd_lesta_session_start_damage: 0,
                dd_lesta_session_started_at: 0
            };
            updateAppState(updates, (err) => {
                if (err) {
                    console.error('❌ Ошибка сброса сессии Lesta для donation-driven виджета:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка сброса сессии' });
                }
                getDonationDrivenWidgetById(1, (e, row) => {
                    if (!e && row) broadcastDonationDrivenWidgetUpdate(row);
                });
                res.json({ success: true });
            });
        });

        app.post('/api/donation-driven-widget/reset', (req, res) => {
            const body = req.body || {};
            const startFromBody = body.start_value != null ? parseFloat(body.start_value) : null;
            db.get('SELECT start_value FROM donation_driven_widgets WHERE id = 1', (err, row) => {
                if (err) {
                    return res.status(500).json({ error: 'Ошибка сервера' });
                }
                const start = startFromBody != null && !isNaN(startFromBody)
                    ? startFromBody
                    : (row ? parseFloat(row.start_value) : 70);
                const updates = startFromBody != null && !isNaN(startFromBody)
                    ? 'UPDATE donation_driven_widgets SET start_value = ?, current_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
                    : 'UPDATE donation_driven_widgets SET current_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1';
                const values = startFromBody != null && !isNaN(startFromBody) ? [start, start] : [start];
                db.run(updates, values, function (updateErr) {
                    if (updateErr) {
                        return res.status(500).json({ error: 'Ошибка сброса' });
                    }
                    db.get('SELECT * FROM donation_driven_widgets WHERE id = 1', (e, updated) => {
                        if (!e && updated) {
                            enrichDonationDrivenWidgetWithLesta(normalizeDonationDrivenWidgetRow(updated), (enriched) => {
                                broadcastToClients({ type: 'DONATION_DRIVEN_UPDATE', widget: enriched });
                                res.json(enriched);
                            });
                        } else {
                            res.json({ success: true, current_value: start });
                        }
                    });
                });
            });
        });

        app.post('/api/donation-driven-widget/add', (req, res) => {
            const amount = req.body && req.body.amount != null ? parseFloat(req.body.amount) : null;
            if (amount == null || isNaN(amount) || amount <= 0) {
                return res.status(400).json({ error: 'Укажите сумму (amount) больше 0' });
            }
            db.get('SELECT * FROM donation_driven_widgets WHERE id = 1', (err, row) => {
                if (err || !row) {
                    return res.status(500).json({ error: 'Виджет не найден' });
                }
                const perAmount = parseFloat(row.per_amount) || 100;
                const addValue = parseFloat(row.add_value) || 0.1;
                const cap = parseFloat(row.cap_value);
                const current = parseFloat(row.current_value) || parseFloat(row.start_value);
                const increment = (amount / perAmount) * addValue;
                let newValue = current + increment;
                if (cap != null && !isNaN(cap)) newValue = Math.min(newValue, cap);
                newValue = Math.round(newValue * 1e6) / 1e6;
                db.run(
                    'UPDATE donation_driven_widgets SET current_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
                    [newValue],
                    function (updateErr) {
                        if (updateErr) {
                            return res.status(500).json({ error: 'Ошибка обновления' });
                        }
                        db.get('SELECT * FROM donation_driven_widgets WHERE id = 1', (e, updated) => {
                            if (!e && updated) {
                                enrichDonationDrivenWidgetWithLesta(normalizeDonationDrivenWidgetRow(updated), (enriched) => {
                                    broadcastToClients({ type: 'DONATION_DRIVEN_UPDATE', widget: enriched });
                                    res.json(enriched);
                                });
                            } else {
                                res.json({ success: true, current_value: newValue });
                            }
                        });
                    }
                );
            });
        });
    }

    return {
        getDonationDrivenWidgetById,
        normalizeDonationDrivenWidgetRow,
        enrichDonationDrivenWidgetWithLesta,
        broadcastDonationDrivenWidgetUpdate,
        registerRoutes
    };
}

module.exports = { createDonationDrivenWidgetModule };
