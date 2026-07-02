'use strict';

const express = require('express');

const DEFAULT_TEXT = '750 лайков со всех стримов- крутим';

/**
 * Модуль рулетки: API-роуты + пополнение полоски от донатов.
 * deps: { db, broadcastToClients }
 */
function createRouletteModule(deps) {
    const db = deps.db;
    const broadcastToClients = deps.broadcastToClients;

    // Донат добавляет сумму к полоске рулетки (если рулетка активна).
    // Логика перенесена из processDonation (server.js) без изменений поведения.
    function addDonationToRoulette(amount) {
        if (!amount || amount <= 0) return;
        console.log(`🎰 Проверка рулетки: донат ${amount}₽`);
        db.get('SELECT * FROM roulette_state WHERE id = 1', (err, rouletteState) => {
            if (err) {
                console.error('❌ Ошибка получения состояния рулетки:', err);
                return;
            }
            if (!rouletteState) {
                console.log('⚠️ Состояние рулетки не найдено, создаем...');
                db.run('INSERT INTO roulette_state (id, is_active, target_amount, current_amount, accumulated_roulettes) VALUES (1, 0, 1000, 0, 0)', (insertErr) => {
                    if (insertErr) {
                        console.error('❌ Ошибка создания состояния рулетки:', insertErr);
                    } else {
                        console.log('✅ Состояние рулетки создано');
                    }
                });
                return;
            }
            const isActive = rouletteState.is_active === 1 || rouletteState.is_active === true || rouletteState.is_active === '1' || parseInt(rouletteState.is_active) === 1;
            if (!isActive) {
                console.log('⚠️ Рулетка неактивна (is_active=' + rouletteState.is_active + '), пропускаем добавление доната');
                return;
            }
            console.log(`✅ Рулетка активна! Добавляем ${amount}₽ к текущей сумме ${rouletteState.current_amount || 0}₽`);
            const currentAmount = parseFloat(rouletteState.current_amount || 0);
            const targetAmount = parseFloat(rouletteState.target_amount || 1000);
            const accumulatedRoulettes = parseInt(rouletteState.accumulated_roulettes || 0);

            let newCurrentAmount = currentAmount + amount;
            let newAccumulatedRoulettes = accumulatedRoulettes;

            // Если полоска заполнена или переполнена, накапливаем рулетки
            while (newCurrentAmount >= targetAmount && targetAmount > 0) {
                newAccumulatedRoulettes++;
                newCurrentAmount -= targetAmount;
                console.log(`🎰 Накоплена рулетка! Всего: ${newAccumulatedRoulettes}, остаток: ${newCurrentAmount.toFixed(2)}₽`);
            }

            const wasComplete = currentAmount >= targetAmount;
            const isNowComplete = newCurrentAmount >= targetAmount || newAccumulatedRoulettes > accumulatedRoulettes;

            db.run('UPDATE roulette_state SET current_amount = ?, accumulated_roulettes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
                [newCurrentAmount, newAccumulatedRoulettes], (updErr) => {
                    if (updErr) {
                        console.error('❌ Ошибка обновления рулетки:', updErr);
                        return;
                    }
                    db.get('SELECT * FROM roulette_state WHERE id = 1', (selErr, updatedRoulette) => {
                        if (selErr || !updatedRoulette) return;
                        console.log(`🎰 Рулетка обновлена: текущая сумма=${updatedRoulette.current_amount.toFixed(2)}₽, накоплено рулеток=${updatedRoulette.accumulated_roulettes}`);
                        broadcastToClients({
                            type: 'ROULETTE_UPDATE',
                            state: updatedRoulette
                        });
                        if (!wasComplete && isNowComplete) {
                            console.log('🎰 Рулетка заполнена! Отправка уведомления о необходимости крутить барабан');
                            broadcastToClients({
                                type: 'ROULETTE_COMPLETE',
                                state: updatedRoulette,
                                message: `Полоска рулетки заполнена! Пора крутить барабан!`
                            });
                        }
                    });
                });
        });
    }

    function registerRoutes(app) {
        // Получить состояние рулетки
        app.get('/api/roulette/state', (req, res) => {
            db.get('SELECT * FROM roulette_state WHERE id = 1', (err, row) => {
                if (err) {
                    console.error('❌ Ошибка получения состояния рулетки:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка базы данных' });
                }
                if (!row) {
                    db.run('INSERT INTO roulette_state (id, is_active, target_amount, current_amount, text) VALUES (1, 0, 1000, 0, ?)', [DEFAULT_TEXT], (insErr) => {
                        if (insErr) {
                            return res.status(500).json({ success: false, error: 'Ошибка создания записи' });
                        }
                        return res.json({ success: true, state: { is_active: 0, target_amount: 1000, current_amount: 0, text: DEFAULT_TEXT } });
                    });
                    return;
                }
                if (!row.text) {
                    row.text = DEFAULT_TEXT;
                }
                res.json({ success: true, state: row });
            });
        });

        // Обновить состояние рулетки
        app.post('/api/roulette/update', express.json(), (req, res) => {
            const { is_active, target_amount, current_amount, accumulated_roulettes, text } = req.body || {};

            const updates = [];
            const values = [];

            if (is_active !== undefined) {
                updates.push('is_active = ?');
                values.push(is_active ? 1 : 0);
            }
            if (target_amount !== undefined) {
                updates.push('target_amount = ?');
                values.push(Math.max(0, parseFloat(target_amount) || 0));
            }
            if (current_amount !== undefined) {
                updates.push('current_amount = ?');
                values.push(Math.max(0, parseFloat(current_amount) || 0));
            }
            if (accumulated_roulettes !== undefined) {
                updates.push('accumulated_roulettes = ?');
                values.push(Math.max(0, parseInt(accumulated_roulettes) || 0));
            }
            // text может быть пустой строкой — это валидное значение
            if (text !== undefined && text !== null) {
                updates.push('text = ?');
                values.push(String(text));
            }

            if (updates.length === 0) {
                return res.status(400).json({ success: false, error: 'Нет данных для обновления' });
            }

            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(1); // id

            db.run(`UPDATE roulette_state SET ${updates.join(', ')} WHERE id = ?`, values, function(err) {
                if (err) {
                    console.error('❌ Ошибка обновления состояния рулетки:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка базы данных: ' + err.message });
                }
                db.get('SELECT * FROM roulette_state WHERE id = 1', (selErr, row) => {
                    if (selErr) {
                        return res.status(500).json({ success: false, error: 'Ошибка получения обновленного состояния' });
                    }
                    if (!row.text) {
                        row.text = DEFAULT_TEXT;
                    }
                    broadcastToClients({
                        type: 'ROULETTE_UPDATE',
                        state: row
                    });
                    res.json({ success: true, state: row });
                });
            });
        });

        // Сбросить прогресс рулетки (только текущую полоску)
        app.post('/api/roulette/reset', (req, res) => {
            db.run('UPDATE roulette_state SET current_amount = 0, last_reset_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = 1', function(err) {
                if (err) {
                    console.error('❌ Ошибка сброса рулетки:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка базы данных' });
                }
                db.get('SELECT * FROM roulette_state WHERE id = 1', (selErr, row) => {
                    if (selErr) {
                        return res.status(500).json({ success: false, error: 'Ошибка получения состояния' });
                    }
                    broadcastToClients({
                        type: 'ROULETTE_UPDATE',
                        state: row
                    });
                    res.json({ success: true, state: row });
                });
            });
        });

        // Уменьшить количество накопленных рулеток (когда крутишь барабан)
        app.post('/api/roulette/use', (req, res) => {
            const { count = 1 } = req.body;
            const useCount = Math.max(1, parseInt(count) || 1);

            db.get('SELECT * FROM roulette_state WHERE id = 1', (err, row) => {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Ошибка получения состояния' });
                }
                const currentAccumulated = parseInt(row.accumulated_roulettes || 0);
                const newAccumulated = Math.max(0, currentAccumulated - useCount);

                db.run('UPDATE roulette_state SET accumulated_roulettes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
                    [newAccumulated], function(updErr) {
                        if (updErr) {
                            console.error('❌ Ошибка использования рулетки:', updErr);
                            return res.status(500).json({ success: false, error: 'Ошибка базы данных' });
                        }
                        db.get('SELECT * FROM roulette_state WHERE id = 1', (selErr, updatedRow) => {
                            if (selErr) {
                                return res.status(500).json({ success: false, error: 'Ошибка получения состояния' });
                            }
                            console.log(`🎰 Использовано ${useCount} рулеток. Осталось: ${newAccumulated}`);
                            broadcastToClients({
                                type: 'ROULETTE_UPDATE',
                                state: updatedRow
                            });
                            res.json({ success: true, state: updatedRow });
                        });
                    });
            });
        });
    }

    return { registerRoutes, addDonationToRoulette };
}

module.exports = { createRouletteModule };
