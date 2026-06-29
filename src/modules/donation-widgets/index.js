'use strict';

/**
 * Виджеты "цель сбора донатов" и "полоска сбора донатов".
 * Вынесено из server.js как первый шаг разбора монолита — раньше это были
 * глобальные функции/роуты, перемешанные с остальным кодом. Сейчас модуль
 * получает зависимости (db, broadcastToClients) явно и отдаёт как
 * registerRoutes(app), так и сами хелперы — они нужны коду обработки
 * донатов в server.js (updateDonationGoal/updateDonationBar).
 */

const DONATION_WIDGET_SETTINGS_VERSION = 2;

function defaultDonationWidgetSettings() {
    return {
        schemaVersion: DONATION_WIDGET_SETTINGS_VERSION,
        showTitle: true,
        showCurrent: true,
        showCurrentInsideBar: true,
        textDisplayMode: 'default',
        barWidthPercent: 100,
        showTarget: true,
        showPercentage: true,
        preset: 'classic',
        customDesign: null,
        theme: {
            palette: {
                primary: '#667eea',
                secondary: '#764ba2',
                accent: '#00f2fe'
            }
        },
        layout: {
            orientation: 'horizontal',
            compact: false,
            barHeight: 50,
            barRadius: 25
        },
        typography: {
            family: 'Inter',
            titleWeight: 700,
            amountWeight: 700,
            letterSpacing: 0
        },
        media: {
            enabled: false,
            type: 'none',
            url: '',
            overlayOpacity: 0.2,
            fit: 'cover'
        },
        effects: {
            glow: 'medium',
            particles: false,
            blur: 0
        },
        animations: {
            onDonation: 'fill-wave',
            onGoalReach: 'celebration',
            loop: 'none',
            speed: 1
        },
        obsProfiles: [
            { id: 'default', name: 'Default', description: 'Base profile', overrides: {} }
        ]
    };
}

function parseDonationWidgetSettings(rawSettings) {
    if (!rawSettings) return {};
    if (typeof rawSettings === 'object') return rawSettings;
    if (typeof rawSettings === 'string') {
        try {
            const parsed = JSON.parse(rawSettings);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (e) {
            console.warn('⚠️ Не удалось распарсить settings donation widget:', e.message);
        }
    }
    return {};
}

function normalizeDonationWidgetSettings(rawSettings) {
    const base = defaultDonationWidgetSettings();
    const parsed = parseDonationWidgetSettings(rawSettings);
    const normalized = {
        ...base,
        ...parsed,
        theme: { ...base.theme, ...(parsed.theme || {}) },
        layout: { ...base.layout, ...(parsed.layout || {}) },
        typography: { ...base.typography, ...(parsed.typography || {}) },
        media: { ...base.media, ...(parsed.media || {}) },
        effects: { ...base.effects, ...(parsed.effects || {}) },
        animations: { ...base.animations, ...(parsed.animations || {}) }
    };

    if (parsed.customDesign && typeof parsed.customDesign === 'object') {
        normalized.customDesign = {
            fillType: parsed.customDesign.fillType || 'gradient',
            color1: parsed.customDesign.color1 || '#667eea',
            color2: parsed.customDesign.color2 || '#764ba2',
            barHeight: Number(parsed.customDesign.barHeight) || normalized.layout.barHeight,
            barRadius: Number(parsed.customDesign.barRadius) || normalized.layout.barRadius,
            glowEffect: parsed.customDesign.glowEffect || 'medium',
            trackColor: parsed.customDesign.trackColor || '#0b1328',
            borderColor: parsed.customDesign.borderColor || '#b7cdff',
            borderWidth: Number(parsed.customDesign.borderWidth) || 2,
            textColor: parsed.customDesign.textColor || '#eaf2ff',
            animationSpeed: Number(parsed.customDesign.animationSpeed) || 1,
            barShape: parsed.customDesign.barShape || 'capsule',
            fillTexture: parsed.customDesign.fillTexture || 'glass',
            outerGlowEffect: parsed.customDesign.outerGlowEffect || parsed.customDesign.glowEffect || 'medium',
            innerGlowEffect: parsed.customDesign.innerGlowEffect || 'soft',
            fillGlowEffect: parsed.customDesign.fillGlowEffect || 'medium'
        };
        normalized.layout.barHeight = normalized.customDesign.barHeight;
        normalized.layout.barRadius = normalized.customDesign.barRadius;
        normalized.effects.glow = normalized.customDesign.glowEffect;
    }

    const hasLegacyBar = typeof parsed.barHeight === 'number' || typeof parsed.barRadius === 'number';
    if (hasLegacyBar) {
        normalized.layout.barHeight = Number(parsed.barHeight) || normalized.layout.barHeight;
        normalized.layout.barRadius = Number(parsed.barRadius) || normalized.layout.barRadius;
    }

    if (!Array.isArray(parsed.obsProfiles) || parsed.obsProfiles.length === 0) {
        normalized.obsProfiles = base.obsProfiles;
    } else {
        normalized.obsProfiles = parsed.obsProfiles
            .filter((p) => p && typeof p === 'object')
            .map((p, idx) => ({
                id: String(p.id || `profile-${idx + 1}`),
                name: String(p.name || `Profile ${idx + 1}`),
                description: String(p.description || ''),
                overrides: p.overrides && typeof p.overrides === 'object' ? p.overrides : {}
            }));
    }

    normalized.barWidthPercent = Math.max(55, Math.min(100, Number(parsed.barWidthPercent) || 100));
    normalized.schemaVersion = DONATION_WIDGET_SETTINGS_VERSION;
    return normalized;
}

function encodeDonationWidgetSettings(settings) {
    return JSON.stringify(normalizeDonationWidgetSettings(settings));
}

function buildDonationGoalPayload(row) {
    const settings = normalizeDonationWidgetSettings(row?.settings || null);
    return {
        title: row?.title || 'Сбор на новый контент',
        description: row?.description || 'Поддержите создание качественного контента!',
        targetAmount: Number(row?.target_amount || 10000),
        currentAmount: Number(row?.current_amount || 0),
        totalDonations: Number(row?.total_donations || 0),
        avgDonation: Number(row?.avg_donation || 0),
        endDate: row?.end_date || null,
        lastDonationTime: row?.last_donation_time || null,
        settings
    };
}

function buildDonationBarPayload(row) {
    const settings = normalizeDonationWidgetSettings(row?.settings || null);
    return {
        title: row?.title || 'Сбор донатов',
        target_amount: Number(row?.target_amount || 1000),
        current_amount: Number(row?.current_amount || 0),
        settings
    };
}

function createDonationWidgetsModule({ db, broadcastToClients }) {
    function broadcastDonationWidgetState(goalRow, barRow) {
        if (goalRow) {
            broadcastToClients({
                type: 'DONATION_GOAL_UPDATE',
                goal: buildDonationGoalPayload(goalRow)
            });
        }
        if (barRow) {
            broadcastToClients({
                type: 'DONATION_BAR_UPDATE',
                state: buildDonationBarPayload(barRow)
            });
        }
    }

    function persistDonationGoalSnapshot(action, goalRow, cb = () => {}) {
        if (!goalRow) return cb();
        const snapshotPayload = {
            action: action || 'manual',
            createdAt: new Date().toISOString(),
            goal: buildDonationGoalPayload(goalRow)
        };
        db.run(
            `INSERT INTO donation_goal_snapshots (action, payload, created_at)
             VALUES (?, ?, ?)`,
            [snapshotPayload.action, JSON.stringify(snapshotPayload), new Date().toISOString()],
            (err) => {
                if (err) {
                    console.warn('⚠️ Не удалось сохранить snapshot donation-goal:', err.message);
                }
                cb();
            }
        );
    }

    function processManualDonation(goal, amount, res) {
        console.log('💰 Обработка ручного доната:', { goal: goal.id, amount });

        const newCurrentAmount = goal.current_amount + amount;
        const newTotalDonations = goal.total_donations + 1;
        const newAvgDonation = newCurrentAmount / newTotalDonations;

        db.run(`UPDATE donation_goals SET
            current_amount = ?,
            total_donations = ?,
            avg_donation = ?,
            last_donation_time = ?,
            updated_at = ?
            WHERE id = 1`,
            [newCurrentAmount, newTotalDonations, newAvgDonation,
                new Date().toISOString(), new Date().toISOString()],
            function (err) {
                if (err) {
                    console.error('❌ Ошибка обновления цели:', err);
                    return res.status(500).json({ error: 'Ошибка обновления цели' });
                }

                db.run(`INSERT INTO goal_donations (goal_id, amount, username, message, is_manual)
                        VALUES (1, ?, 'Администратор', 'Ручной донат', 1)`,
                    [amount], (err) => {
                        if (err) {
                            console.error('❌ Ошибка добавления доната в цель:', err);
                        }

                        db.get('SELECT * FROM donation_goals WHERE id = 1', (goalErr, updatedGoal) => {
                            if (goalErr || !updatedGoal) {
                                return res.status(500).json({ error: 'Ошибка получения обновленной цели' });
                            }
                            persistDonationGoalSnapshot('manual-donation', updatedGoal);
                            broadcastDonationWidgetState(updatedGoal, null);
                            res.json(buildDonationGoalPayload(updatedGoal));
                        });
                    });
            }
        );
    }

    function registerRoutes(app) {
        // ==================== API для цели сбора донатов ====================

        app.get('/api/donation-goal', (req, res) => {
            db.get('SELECT * FROM donation_goals WHERE id = 1', (err, row) => {
                if (err) {
                    console.error('❌ Ошибка получения цели сбора:', err);
                    return res.status(500).json({ error: 'Ошибка получения данных цели' });
                }

                if (!row) {
                    db.run(`INSERT INTO donation_goals (id) VALUES (1)`, (err) => {
                        if (err) {
                            console.error('❌ Ошибка создания цели:', err);
                            return res.status(500).json({ error: 'Ошибка создания цели' });
                        }

                        db.get('SELECT * FROM donation_goals WHERE id = 1', (createdErr, createdGoal) => {
                            if (createdErr || !createdGoal) {
                                return res.json(buildDonationGoalPayload(null));
                            }
                            res.json(buildDonationGoalPayload(createdGoal));
                        });
                    });
                } else {
                    res.json(buildDonationGoalPayload(row));
                }
            });
        });

        app.put('/api/donation-goal', (req, res) => {
            const { title, description, targetAmount, currentAmount, endDate, settings } = req.body;
            const normalizedSettings = normalizeDonationWidgetSettings(settings);

            const updateData = {
                title: title || 'Сбор на новый контент',
                description: description || 'Поддержите создание качественного контента!',
                target_amount: targetAmount || 10000,
                current_amount: currentAmount || 0,
                end_date: endDate || null,
                settings: encodeDonationWidgetSettings(normalizedSettings),
                updated_at: new Date().toISOString()
            };

            db.run(`UPDATE donation_goals SET
                title = ?,
                description = ?,
                target_amount = ?,
                current_amount = ?,
                end_date = ?,
                settings = ?,
                updated_at = ?
                WHERE id = 1`,
                [updateData.title, updateData.description, updateData.target_amount,
                updateData.current_amount, updateData.end_date, updateData.settings, updateData.updated_at],
                function (err) {
                    if (err) {
                        console.error('❌ Ошибка обновления цели:', err);
                        return res.status(500).json({ error: 'Ошибка обновления цели' });
                    }

                    db.get('SELECT * FROM donation_goals WHERE id = 1', (err, row) => {
                        if (err) {
                            console.error('❌ Ошибка получения обновленной цели:', err);
                            return res.status(500).json({ error: 'Ошибка получения данных' });
                        }

                        persistDonationGoalSnapshot('save-settings', row);
                        broadcastDonationWidgetState(row, null);
                        broadcastToClients({
                            type: 'WIDGET_SETTINGS_UPDATE',
                            scope: 'donation-goal',
                            settings: normalizeDonationWidgetSettings(row.settings)
                        });
                        res.json(buildDonationGoalPayload(row));
                    });
                }
            );
        });

        app.post('/api/donation-goal/manual-donation', (req, res) => {
            const { amount } = req.body;

            console.log('🎯 Получен запрос на добавление ручного доната:', { amount });

            if (!amount || amount <= 0) {
                console.log('❌ Некорректная сумма доната:', amount);
                return res.status(400).json({ error: 'Некорректная сумма доната' });
            }

            db.get('SELECT * FROM donation_goals WHERE id = 1', (err, goal) => {
                if (err) {
                    console.error('❌ Ошибка получения цели:', err);
                    return res.status(500).json({ error: 'Ошибка получения данных цели' });
                }

                if (!goal) {
                    db.run(`INSERT INTO donation_goals (id) VALUES (1)`, (err) => {
                        if (err) {
                            console.error('❌ Ошибка создания цели:', err);
                            return res.status(500).json({ error: 'Ошибка создания цели' });
                        }

                        db.get('SELECT * FROM donation_goals WHERE id = 1', (err, newGoal) => {
                            if (err) {
                                console.error('❌ Ошибка получения новой цели:', err);
                                return res.status(500).json({ error: 'Ошибка получения данных цели' });
                            }
                            processManualDonation(newGoal, amount, res);
                        });
                    });
                    return;
                }

                processManualDonation(goal, amount, res);
            });
        });

        app.post('/api/donation-goal/reset', (req, res) => {
            db.run(`UPDATE donation_goals SET
                current_amount = 0,
                total_donations = 0,
                avg_donation = 0,
                last_donation_time = NULL,
                updated_at = ?
                WHERE id = 1`,
                [new Date().toISOString()],
                function (err) {
                    if (err) {
                        console.error('❌ Ошибка обнуления цели:', err);
                        return res.status(500).json({ error: 'Ошибка обнуления цели' });
                    }

                    db.run('DELETE FROM goal_donations WHERE goal_id = 1', (err) => {
                        if (err) {
                            console.error('❌ Ошибка очистки истории донатов:', err);
                        }

                        db.get('SELECT * FROM donation_goals WHERE id = 1', (err, row) => {
                            if (err) {
                                console.error('❌ Ошибка получения обновленной цели:', err);
                                return res.status(500).json({ error: 'Ошибка получения данных' });
                            }

                            persistDonationGoalSnapshot('reset', row);
                            broadcastDonationWidgetState(row, null);
                            res.json(buildDonationGoalPayload(row));
                        });
                    });
                }
            );
        });

        // ==================== API для полоски сбора донатов ====================

        app.get('/api/donation-bar/state', (req, res) => {
            db.get('SELECT * FROM donation_bars WHERE id = 1', (err, row) => {
                if (err) {
                    console.error('❌ Ошибка получения состояния полоски:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка получения данных' });
                }

                if (!row) {
                    db.run(`INSERT INTO donation_bars (id) VALUES (1)`, (err) => {
                        if (err) {
                            console.error('❌ Ошибка создания полоски:', err);
                            return res.status(500).json({ success: false, error: 'Ошибка создания полоски' });
                        }

                        res.json({
                            success: true,
                            state: buildDonationBarPayload(null)
                        });
                    });
                } else {
                    res.json({
                        success: true,
                        state: buildDonationBarPayload(row)
                    });
                }
            });
        });

        app.put('/api/donation-bar/state', (req, res) => {
            const { title, target_amount, current_amount, settings } = req.body;

            const updateData = {};
            if (title !== undefined) updateData.title = title;
            if (target_amount !== undefined) updateData.target_amount = target_amount;
            if (current_amount !== undefined) updateData.current_amount = current_amount;
            if (settings !== undefined) updateData.settings = encodeDonationWidgetSettings(settings);
            updateData.updated_at = new Date().toISOString();

            db.get('SELECT * FROM donation_bars WHERE id = 1', (err, row) => {
                if (err) {
                    console.error('❌ Ошибка проверки полоски:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка проверки данных' });
                }

                if (!row) {
                    db.run(`INSERT INTO donation_bars (id, title, target_amount, current_amount, updated_at)
                            VALUES (1, ?, ?, ?, ?)`,
                        [updateData.title || 'Сбор донатов',
                        updateData.target_amount || 1000,
                        updateData.current_amount || 0,
                        updateData.updated_at],
                        function (err) {
                            if (err) {
                                console.error('❌ Ошибка создания полоски:', err);
                                return res.status(500).json({ success: false, error: 'Ошибка создания полоски' });
                            }

                            db.get('SELECT * FROM donation_bars WHERE id = 1', (err, newRow) => {
                                if (err) {
                                    console.error('❌ Ошибка получения созданной полоски:', err);
                                    return res.status(500).json({ success: false, error: 'Ошибка получения данных' });
                                }

                                const state = buildDonationBarPayload(newRow);
                                broadcastDonationWidgetState(null, newRow);
                                broadcastToClients({
                                    type: 'WIDGET_SETTINGS_UPDATE',
                                    scope: 'donation-bar',
                                    settings: normalizeDonationWidgetSettings(newRow.settings)
                                });
                                res.json({ success: true, state });
                            });
                        });
                } else {
                    const setClause = Object.keys(updateData).map(key => `${key} = ?`).join(', ');
                    const values = Object.values(updateData);
                    values.push(1);

                    db.run(`UPDATE donation_bars SET ${setClause} WHERE id = ?`, values, function (err) {
                        if (err) {
                            console.error('❌ Ошибка обновления полоски:', err);
                            return res.status(500).json({ success: false, error: 'Ошибка обновления полоски' });
                        }

                        db.get('SELECT * FROM donation_bars WHERE id = 1', (err, updatedRow) => {
                            if (err) {
                                console.error('❌ Ошибка получения обновленной полоски:', err);
                                return res.status(500).json({ success: false, error: 'Ошибка получения данных' });
                            }

                            const state = buildDonationBarPayload(updatedRow);
                            broadcastDonationWidgetState(null, updatedRow);
                            broadcastToClients({
                                type: 'WIDGET_SETTINGS_UPDATE',
                                scope: 'donation-bar',
                                settings: normalizeDonationWidgetSettings(updatedRow.settings)
                            });
                            res.json({ success: true, state });
                        });
                    });
                }
            });
        });

        app.post('/api/donation-bar/add', (req, res) => {
            const { amount } = req.body;

            if (!amount || amount <= 0) {
                return res.status(400).json({ success: false, error: 'Некорректная сумма' });
            }

            db.get('SELECT * FROM donation_bars WHERE id = 1', (err, row) => {
                if (err) {
                    console.error('❌ Ошибка получения полоски:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка получения данных' });
                }

                if (!row) {
                    db.run(`INSERT INTO donation_bars (id, current_amount) VALUES (1, ?)`,
                        [amount], function (err) {
                            if (err) {
                                console.error('❌ Ошибка создания полоски:', err);
                                return res.status(500).json({ success: false, error: 'Ошибка создания полоски' });
                            }

                            const state = {
                                title: 'Сбор донатов',
                                target_amount: 1000,
                                current_amount: amount
                            };
                            db.get('SELECT * FROM donation_bars WHERE id = 1', (barErr, updatedBar) => {
                                if (barErr || !updatedBar) {
                                    return res.json({ success: true, state });
                                }
                                broadcastDonationWidgetState(null, updatedBar);
                                res.json({ success: true, state: buildDonationBarPayload(updatedBar) });
                            });
                        });
                } else {
                    const newAmount = row.current_amount + amount;

                    db.run(`UPDATE donation_bars SET current_amount = ?, updated_at = ? WHERE id = 1`,
                        [newAmount, new Date().toISOString()], function (err) {
                            if (err) {
                                console.error('❌ Ошибка обновления полоски:', err);
                                return res.status(500).json({ success: false, error: 'Ошибка обновления полоски' });
                            }

                            db.get('SELECT * FROM donation_bars WHERE id = 1', (barErr, updatedBar) => {
                                if (barErr || !updatedBar) {
                                    const state = {
                                        title: row.title,
                                        target_amount: row.target_amount,
                                        current_amount: newAmount
                                    };
                                    return res.json({ success: true, state });
                                }
                                broadcastDonationWidgetState(null, updatedBar);
                                res.json({ success: true, state: buildDonationBarPayload(updatedBar) });
                            });
                        });
                }
            });
        });

        app.get('/api/donation-goal/history', (req, res) => {
            db.all(`SELECT * FROM goal_donations WHERE goal_id = 1
                    ORDER BY created_at DESC LIMIT 100`, (err, rows) => {
                if (err) {
                    console.error('❌ Ошибка получения истории донатов:', err);
                    return res.status(500).json({ error: 'Ошибка получения истории' });
                }

                res.json(rows.map(row => ({
                    id: row.id,
                    amount: row.amount,
                    username: row.username,
                    message: row.message,
                    isManual: row.is_manual,
                    createdAt: row.created_at
                })));
            });
        });

        app.get('/api/donation-goal/export', (req, res) => {
            db.get('SELECT * FROM donation_goals WHERE id = 1', (err, goalRow) => {
                if (err) return res.status(500).json({ error: 'Ошибка экспорта' });
                db.get('SELECT * FROM donation_bars WHERE id = 1', (barErr, barRow) => {
                    if (barErr) return res.status(500).json({ error: 'Ошибка экспорта' });
                    res.json({
                        exportedAt: new Date().toISOString(),
                        schemaVersion: DONATION_WIDGET_SETTINGS_VERSION,
                        donationGoal: buildDonationGoalPayload(goalRow),
                        donationBar: buildDonationBarPayload(barRow)
                    });
                });
            });
        });

        app.post('/api/donation-goal/import', (req, res) => {
            const payload = req.body || {};
            const importedGoal = payload.donationGoal || {};
            const importedBar = payload.donationBar || {};
            const settings = encodeDonationWidgetSettings(importedGoal.settings || importedBar.settings || {});
            const nowIso = new Date().toISOString();

            db.run('INSERT OR IGNORE INTO donation_goals (id) VALUES (1)');
            db.run('INSERT OR IGNORE INTO donation_bars (id) VALUES (1)');

            db.run(
                `UPDATE donation_goals SET
                    title = ?, description = ?, target_amount = ?, current_amount = ?,
                    total_donations = ?, avg_donation = ?, end_date = ?, settings = ?, updated_at = ?
                 WHERE id = 1`,
                [
                    importedGoal.title || 'Сбор на новый контент',
                    importedGoal.description || 'Поддержите создание качественного контента!',
                    Number(importedGoal.targetAmount || importedGoal.target_amount || 10000),
                    Number(importedGoal.currentAmount || importedGoal.current_amount || 0),
                    Number(importedGoal.totalDonations || importedGoal.total_donations || 0),
                    Number(importedGoal.avgDonation || importedGoal.avg_donation || 0),
                    importedGoal.endDate || importedGoal.end_date || null,
                    settings,
                    nowIso
                ],
                (goalErr) => {
                    if (goalErr) return res.status(500).json({ error: 'Ошибка импорта цели' });
                    db.run(
                        `UPDATE donation_bars SET
                            title = ?, target_amount = ?, current_amount = ?, settings = ?, updated_at = ?
                         WHERE id = 1`,
                        [
                            importedBar.title || importedGoal.title || 'Сбор донатов',
                            Number(importedBar.target_amount || importedBar.targetAmount || importedGoal.targetAmount || 1000),
                            Number(importedBar.current_amount || importedBar.currentAmount || importedGoal.currentAmount || 0),
                            settings,
                            nowIso
                        ],
                        (barErr) => {
                            if (barErr) return res.status(500).json({ error: 'Ошибка импорта полоски' });
                            db.get('SELECT * FROM donation_goals WHERE id = 1', (fetchErr, goalRow) => {
                                if (fetchErr || !goalRow) return res.status(500).json({ error: 'Ошибка после импорта' });
                                db.get('SELECT * FROM donation_bars WHERE id = 1', (fetchBarErr, barRow) => {
                                    if (fetchBarErr) return res.status(500).json({ error: 'Ошибка после импорта' });
                                    persistDonationGoalSnapshot('import', goalRow);
                                    broadcastDonationWidgetState(goalRow, barRow);
                                    broadcastToClients({
                                        type: 'WIDGET_SETTINGS_UPDATE',
                                        scope: 'donation-goal',
                                        settings: normalizeDonationWidgetSettings(goalRow.settings)
                                    });
                                    res.json({ success: true, goal: buildDonationGoalPayload(goalRow), bar: buildDonationBarPayload(barRow) });
                                });
                            });
                        }
                    );
                }
            );
        });

        app.get('/api/donation-goal/snapshots', (req, res) => {
            db.all(
                `SELECT id, action, payload, created_at FROM donation_goal_snapshots ORDER BY id DESC LIMIT 30`,
                (err, rows) => {
                    if (err) return res.status(500).json({ error: 'Ошибка получения snapshots' });
                    const snapshots = (rows || []).map((row) => {
                        let parsed = null;
                        try { parsed = JSON.parse(row.payload); } catch (e) {}
                        return {
                            id: row.id,
                            action: row.action,
                            createdAt: row.created_at,
                            payload: parsed
                        };
                    });
                    res.json(snapshots);
                }
            );
        });

        app.post('/api/donation-goal/snapshots', (req, res) => {
            db.get('SELECT * FROM donation_goals WHERE id = 1', (err, goalRow) => {
                if (err || !goalRow) return res.status(500).json({ error: 'Ошибка создания snapshot' });
                persistDonationGoalSnapshot(req.body?.action || 'manual', goalRow, () => {
                    res.json({ success: true });
                });
            });
        });

        app.post('/api/donation-goal/snapshots/:id/restore', (req, res) => {
            const snapshotId = Number(req.params.id);
            if (!snapshotId) return res.status(400).json({ error: 'Некорректный id snapshot' });

            db.get('SELECT payload FROM donation_goal_snapshots WHERE id = ?', [snapshotId], (err, row) => {
                if (err || !row) return res.status(404).json({ error: 'Snapshot не найден' });
                let parsed = null;
                try { parsed = JSON.parse(row.payload); } catch (e) {}
                const goal = parsed?.goal;
                if (!goal) return res.status(400).json({ error: 'Snapshot поврежден' });

                db.run(
                    `UPDATE donation_goals SET title = ?, description = ?, target_amount = ?, current_amount = ?,
                        total_donations = ?, avg_donation = ?, end_date = ?, settings = ?, updated_at = ?
                     WHERE id = 1`,
                    [
                        goal.title || 'Сбор на новый контент',
                        goal.description || 'Поддержите создание качественного контента!',
                        Number(goal.targetAmount || 10000),
                        Number(goal.currentAmount || 0),
                        Number(goal.totalDonations || 0),
                        Number(goal.avgDonation || 0),
                        goal.endDate || null,
                        encodeDonationWidgetSettings(goal.settings || {}),
                        new Date().toISOString()
                    ],
                    (updateErr) => {
                        if (updateErr) return res.status(500).json({ error: 'Ошибка восстановления snapshot' });
                        db.get('SELECT * FROM donation_goals WHERE id = 1', (fetchErr, goalRow) => {
                            if (fetchErr || !goalRow) return res.status(500).json({ error: 'Ошибка после восстановления' });
                            broadcastDonationWidgetState(goalRow, null);
                            res.json({ success: true, goal: buildDonationGoalPayload(goalRow) });
                        });
                    }
                );
            });
        });
    }

    return {
        DONATION_WIDGET_SETTINGS_VERSION,
        normalizeDonationWidgetSettings,
        encodeDonationWidgetSettings,
        buildDonationGoalPayload,
        buildDonationBarPayload,
        broadcastDonationWidgetState,
        persistDonationGoalSnapshot,
        registerRoutes
    };
}

module.exports = { createDonationWidgetsModule };
