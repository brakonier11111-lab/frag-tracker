'use strict';

const express = require('express');

function registerRouletteRoutes(app, db) {
    // Получить состояние рулетки
    app.get('/api/roulette/state', (req, res) => {
        db.get('SELECT * FROM roulette_state WHERE id = 1', (err, row) => {
            if (err) {
                console.error('❌ Ошибка получения состояния рулетки:', err);
                return res.status(500).json({ success: false, error: 'Ошибка базы данных' });
            }
            if (!row) {
                // Создаем запись по умолчанию если её нет
                const defaultText = '750 лайков со всех стримов- крутим';
                db.run('INSERT INTO roulette_state (id, is_active, target_amount, current_amount, text) VALUES (1, 0, 1000, 0, ?)', [defaultText], (err) => {
                    if (err) {
                        return res.status(500).json({ success: false, error: 'Ошибка создания записи' });
                    }
                    return res.json({ success: true, state: { is_active: 0, target_amount: 1000, current_amount: 0, text: defaultText } });
                });
                return;
            }
            // Убеждаемся, что text всегда есть
            if (!row.text) {
                row.text = '750 лайков со всех стримов- крутим';
            }
            res.json({ success: true, state: row });
        });
    });
    
    // Обновить состояние рулетки
    app.post('/api/roulette/update', express.json(), (req, res) => {
        console.log('💾 Запрос на обновление рулетки:', req.body);
        console.log('💾 Тип text:', typeof req.body?.text);
        console.log('💾 text в запросе:', req.body?.text);
        const { is_active, target_amount, current_amount, accumulated_roulettes, text } = req.body || {};
        console.log('💾 Полученный текст:', text);
        
        const updates = [];
        const values = [];
        
        if (is_active !== undefined) {
            const activeValue = is_active ? 1 : 0;
            updates.push('is_active = ?');
            values.push(activeValue);
            console.log('💾 Обновление is_active:', activeValue);
        }
        if (target_amount !== undefined) {
            const targetValue = Math.max(0, parseFloat(target_amount) || 0);
            updates.push('target_amount = ?');
            values.push(targetValue);
            console.log('💾 Обновление target_amount:', targetValue);
        }
        if (current_amount !== undefined) {
            const currentValue = Math.max(0, parseFloat(current_amount) || 0);
            updates.push('current_amount = ?');
            values.push(currentValue);
            console.log('💾 Обновление current_amount:', currentValue);
        }
        if (accumulated_roulettes !== undefined) {
            const accumulatedValue = Math.max(0, parseInt(accumulated_roulettes) || 0);
            updates.push('accumulated_roulettes = ?');
            values.push(accumulatedValue);
            console.log('💾 Обновление accumulated_roulettes:', accumulatedValue);
        }
        // Обрабатываем text отдельно - он может быть пустой строкой
        if (text !== undefined && text !== null) {
            updates.push('text = ?');
            const textValue = String(text);
            values.push(textValue);
            console.log('💾 Обновление text:', textValue);
            console.log('💾 Длина текста:', textValue.length);
        }
        
        if (updates.length === 0) {
            console.error('❌ Нет данных для обновления. Полученные поля:', Object.keys(req.body));
            return res.status(400).json({ success: false, error: 'Нет данных для обновления' });
        }
        
        // Добавляем updated_at в конец updates
        updates.push('updated_at = CURRENT_TIMESTAMP');
        // Добавляем id в конец values
        values.push(1); // id
        
        console.log('💾 Обновление рулетки:', { updates: updates.join(', '), values });
        
        db.run(`UPDATE roulette_state SET ${updates.join(', ')} WHERE id = ?`, values, function(err) {
            if (err) {
                console.error('❌ Ошибка обновления состояния рулетки:', err);
                console.error('❌ SQL:', `UPDATE roulette_state SET ${updates.join(', ')} WHERE id = ?`);
                console.error('❌ Values:', values);
                return res.status(500).json({ success: false, error: 'Ошибка базы данных: ' + err.message });
            }
            
            // Получаем обновленное состояние
            db.get('SELECT * FROM roulette_state WHERE id = 1', (err, row) => {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Ошибка получения обновленного состояния' });
                }
                
                // Убеждаемся, что text всегда есть
                if (!row.text) {
                    row.text = '750 лайков со всех стримов- крутим';
                }
                
                console.log('💾 Отправка обновленного состояния:', row);
                console.log('💾 Текст в состоянии:', row.text);
                
                // Отправляем обновление всем клиентам через WebSocket
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
            
            // Получаем обновленное состояние
            db.get('SELECT * FROM roulette_state WHERE id = 1', (err, row) => {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Ошибка получения состояния' });
                }
                
                // Отправляем обновление всем клиентам
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
                [newAccumulated], function(err) {
                    if (err) {
                        console.error('❌ Ошибка использования рулетки:', err);
                        return res.status(500).json({ success: false, error: 'Ошибка базы данных' });
                    }
                    
                    // Получаем обновленное состояние
                    db.get('SELECT * FROM roulette_state WHERE id = 1', (err, updatedRow) => {
                        if (err) {
                            return res.status(500).json({ success: false, error: 'Ошибка получения состояния' });
                        }
                        
                        console.log(`🎰 Использовано ${useCount} рулеток. Осталось: ${newAccumulated}`);
                        
                        // Отправляем обновление всем клиентам
                        broadcastToClients({
                            type: 'ROULETTE_UPDATE',
                            state: updatedRow
                        });
                        
                        res.json({ success: true, state: updatedRow });
                    });
                });
        });
    });
    
    // ==================== КОНЕЦ API ДЛЯ РУЛЕТКИ ====================
}

module.exports = { registerRouletteRoutes };
