'use strict';

/**
 * CRUD-роуты донатов и донатеров — вынесены из server.js 1:1:
 * GET /api/donations, POST /api/donations/adjust|add-for-top|delete,
 * GET /api/donors, /api/top-donors, /api/donors/top, /api/donors/top/today,
 * POST /api/clear-donations, /api/reset-stats, /api/admin/delete-donor.
 * Имена deps совпадают с прежними именами server.js — тела не менялись.
 */

const express = require('express');

function createDonationsCrudModule(deps) {
    const {
        db,
        getAppState,
        updateAppState,
        getDonations,
        normalizeUsername,
        processedDonationIds,
        broadcastStateUpdate,
        broadcastToClients,
        getDonationsHasNormalizedUsername,
        setDonationsHasNormalizedUsername
    } = deps;

    function registerRoutes(app) {
        // Получить историю донатов
        app.get('/api/donations', (req, res) => {
            const requestedLimit = parseInt(req.query.limit, 10);
            const requestedOffset = parseInt(req.query.offset, 10);
            const limit = Math.min(Math.max(requestedLimit && requestedLimit > 0 ? requestedLimit : 200, 1), 1000);
            const offset = Math.max(requestedOffset && requestedOffset > 0 ? requestedOffset : 0, 0);

            getDonations(limit, offset, (err, donations) => {
                if (err) {
                    if (err.message && err.message.includes('no such table')) {
                        return res.json({ donations: [], total: 0, offset, limit, nextOffset: offset });
                    }
                    return res.status(500).json({ error: 'Не удалось получить донаты' });
                }
                res.json({
                    donations: (donations || []).map(d => ({
                        ...d,
                        isRealtime: d.is_realtime === 1,
                        timestamp: new Date(d.created_at).toLocaleTimeString('ru-RU')
                    })),
                    total: (donations || []).length,
                    offset,
                    limit,
                    nextOffset: offset + (donations || []).length
                });
            });
        });

        // Корректировка суммы донатора и общей суммы
        app.post('/api/donations/adjust', express.json(), (req, res) => {
            const { username, amount } = req.body || {};
            
            if (!username || amount === undefined || amount === 0) {
                return res.status(400).json({ success: false, error: 'Укажите username и amount (может быть отрицательным)' });
            }
            
            const adjustAmount = parseFloat(amount);
            console.log(`🔧 Корректировка суммы донатора: ${username}, сумма: ${adjustAmount}₽`);
            
            // Получаем текущее состояние
            db.get('SELECT timer_seconds, total_donated FROM app_state WHERE id = 1', (err, state) => {
                if (err) {
                    console.error('❌ Ошибка получения состояния:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка получения состояния' });
                }
                
                const currentTotalDonated = state.total_donated || 0;
                const newTotalDonated = Math.max(0, currentTotalDonated - adjustAmount);
                
                console.log(`📊 Текущая общая сумма: ${currentTotalDonated}₽`);
                console.log(`📊 Новая общая сумма: ${newTotalDonated}₽ (изменение: ${-adjustAmount}₽)`);
                
                // Создаем корректирующий донат с отрицательной суммой
                const correctionId = `correction_${Date.now()}`;
                const normalizedUsername = normalizeUsername(username);
                
                // Вычисляем время, которое нужно вычесть (если adjustAmount отрицательный, то время тоже отрицательное)
                // Используем текущую стоимость минуты из состояния
                db.get('SELECT cost_per_minute FROM app_state WHERE id = 1', (err, costState) => {
                    if (err) {
                        console.error('❌ Ошибка получения стоимости:', err);
                        return res.status(500).json({ success: false, error: 'Ошибка получения стоимости' });
                    }
                    
                    const costPerMinute = costState?.cost_per_minute || 50;
                    const secondsPerRuble = 60 / costPerMinute;
                    const timeAdjustment = Math.floor(adjustAmount * secondsPerRuble);
                    
                    // Вставляем корректирующий донат
                    db.run(
                        `INSERT INTO donations (id, username, amount, message, currency, is_realtime, time_earned, normalized_username, created_at) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
                        [correctionId, username, -adjustAmount, `Корректировка суммы: ${adjustAmount > 0 ? '+' : ''}${adjustAmount}₽`, 'RUB', 0, -timeAdjustment, normalizedUsername],
                        function(err) {
                            if (err) {
                                console.error('❌ Ошибка создания корректирующего доната:', err);
                                return res.status(500).json({ success: false, error: 'Ошибка создания корректирующего доната' });
                            }
                            
                            console.log(`✅ Корректирующий донат создан (ID: ${correctionId})`);
                            
                            // Обновляем общую сумму в состоянии
                            db.run(
                                'UPDATE app_state SET total_donated = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
                                [newTotalDonated],
                                function(err) {
                                    if (err) {
                                        console.error('❌ Ошибка обновления общей суммы:', err);
                                        return res.status(500).json({ success: false, error: 'Ошибка обновления общей суммы' });
                                    }
                                    
                                    console.log('✅ Общая сумма обновлена');
                                    
                                    // Получаем полное состояние для отправки клиентам
                                    getAppState((fullState) => {
                                        if (fullState) {
                                            // Отправляем обновление состояния
                                            broadcastStateUpdate();
                                            // Отправляем специальное сообщение о корректировке
                                            broadcastToClients({ 
                                                type: 'DONATION_ADJUSTED',
                                                username,
                                                adjustAmount,
                                                newTotalDonated,
                                                state: fullState
                                            });
                                        } else {
                                            // Если не удалось получить состояние, отправляем хотя бы сообщение
                                            broadcastToClients({ 
                                                type: 'DONATION_ADJUSTED',
                                                username,
                                                adjustAmount,
                                                newTotalDonated
                                            });
                                        }
                                    });
                                    
                                    res.json({ 
                                        success: true,
                                        message: 'Сумма скорректирована',
                                        username,
                                        adjustAmount,
                                        newTotalDonated,
                                        correctionDonationId: correctionId
                                    });
                                }
                            );
                        }
                    );
                });
            });
        });

        // Добавление доната только для топа дня (без изменения общей суммы)
        app.post('/api/donations/add-for-top', express.json(), (req, res) => {
            const { username, amount, message } = req.body || {};
            
            if (!username || amount === undefined || amount <= 0) {
                return res.status(400).json({ success: false, error: 'Укажите username и amount (должен быть положительным)' });
            }
            
            const donationAmount = parseFloat(amount);
            console.log(`📊 Добавление доната для топа дня: ${username}, сумма: ${donationAmount}₽`);
            
            const donationId = `manual_top_${Date.now()}`;
            const normalizedUsername = normalizeUsername(username);
            const donationMessage = message || `Донат для топа дня: ${donationAmount}₽`;
            
            console.log(`📅 Создание доната для топа дня:`);
            console.log(`   - Пользователь: ${username} (normalized: ${normalizedUsername})`);
            console.log(`   - Сумма: ${donationAmount}₽`);
            
            // Используем datetime('now') в SQLite для получения локального времени сервера
            // Это гарантирует, что дата будет в том же формате, что и CURRENT_TIMESTAMP
            db.run(
                `INSERT INTO donations (id, username, amount, message, currency, is_realtime, time_earned, normalized_username, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
                [donationId, username, donationAmount, donationMessage, 'RUB', 0, 0, normalizedUsername],
                function(err) {
                    if (err) {
                        console.error('❌ Ошибка создания доната для топа:', err);
                        return res.status(500).json({ success: false, error: 'Ошибка создания доната' });
                    }
                    
                    console.log(`✅ Донат для топа дня создан (ID: ${donationId})`);
                    
                    // Получаем созданную дату из базы для проверки
                    db.get(
                        `SELECT created_at FROM donations WHERE id = ?`,
                        [donationId],
                        (dateErr, row) => {
                            if (!dateErr && row) {
                                console.log(`   - Дата создания (из БД): ${row.created_at}`);
                            }
                            
                            // Проверяем, что донат попал в топ дня
                            const now = new Date();
                            const todayStart = new Date(now);
                            todayStart.setHours(0, 0, 0, 0);
                            const todayEnd = new Date(todayStart.getTime() + 86400000);
                            
                            // SQLite datetime('now') возвращает локальное время в формате 'YYYY-MM-DD HH:MM:SS'
                            // Используем тот же формат для сравнения
                            const formatSqlDate = (date) => {
                                const year = date.getFullYear();
                                const month = String(date.getMonth() + 1).padStart(2, '0');
                                const day = String(date.getDate()).padStart(2, '0');
                                const hours = String(date.getHours()).padStart(2, '0');
                                const minutes = String(date.getMinutes()).padStart(2, '0');
                                const seconds = String(date.getSeconds()).padStart(2, '0');
                                return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
                            };
                            
                            const todayStartStr = formatSqlDate(todayStart);
                            const todayEndStr = formatSqlDate(todayEnd);
                            
                            console.log(`🔍 Проверка доната в топе дня:`);
                            console.log(`   - Дата начала дня (локальное): ${todayStartStr}`);
                            console.log(`   - Дата конца дня (локальное): ${todayEndStr}`);
                            console.log(`   - Normalized username: ${normalizedUsername}`);
                            
                            // Проверяем все донаты пользователя за сегодня
                            db.all(
                                `SELECT id, amount, created_at FROM donations 
                                 WHERE normalized_username = ? AND created_at >= ? AND created_at < ?
                                 ORDER BY created_at DESC`,
                                [normalizedUsername, todayStartStr, todayEndStr],
                                (checkErr, rows) => {
                                    if (!checkErr && rows) {
                                        const total = rows.reduce((sum, r) => sum + (r.amount || 0), 0);
                                        console.log(`📊 Проверка: найдено ${rows.length} донатов ${username} за сегодня, сумма: ${total}₽`);
                                        rows.forEach(r => {
                                            console.log(`   - ${r.id}: ${r.amount}₽, дата: ${r.created_at}`);
                                        });
                                    } else if (checkErr) {
                                        console.error('❌ Ошибка проверки донатов:', checkErr);
                                    }
                                }
                            );
                        }
                    );
                    
                    // Отправляем обновление для виджетов топа
                    broadcastToClients({ 
                        type: 'TOP_DONORS_UPDATE',
                        message: 'Обновление топа донатеров'
                    });
                    
                    res.json({ 
                        success: true,
                        message: 'Донат добавлен для топа дня',
                        username,
                        amount: donationAmount,
                        donationId: donationId
                    });
                }
            );
        });

        // Удаление конкретного доната по ID
        app.post('/api/donations/delete', express.json(), (req, res) => {
            const { donationId } = req.body || {};
            
            if (!donationId) {
                return res.status(400).json({ success: false, error: 'Не указан ID доната' });
            }
            
            console.log(`🗑️ Удаление доната ID: ${donationId}`);
            
            // Сначала получаем информацию о донате
            db.get('SELECT id, username, amount, time_earned FROM donations WHERE id = ?', [donationId], (err, donation) => {
                if (err) {
                    console.error('❌ Ошибка получения доната:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка получения доната' });
                }
                
                if (!donation) {
                    return res.status(404).json({ success: false, error: 'Донат не найден' });
                }
                
                const amountToRemove = donation.amount || 0;
                const timeToRemove = donation.time_earned || 0;
                
                console.log(`📊 Донат найден: ${donation.username} - ${amountToRemove}₽, время: ${timeToRemove}с`);
                
                // Получаем текущее состояние
                db.get('SELECT timer_seconds, total_donated FROM app_state WHERE id = 1', (err, state) => {
                    if (err) {
                        console.error('❌ Ошибка получения состояния:', err);
                        return res.status(500).json({ success: false, error: 'Ошибка получения состояния' });
                    }
                    
                    const currentTimerSeconds = state.timer_seconds || 0;
                    const currentTotalDonated = state.total_donated || 0;
                    
                    const newTimerSeconds = Math.max(0, currentTimerSeconds - timeToRemove);
                    const newTotalDonated = Math.max(0, currentTotalDonated - amountToRemove);
                    
                    console.log(`📊 Текущее состояние: таймер=${currentTimerSeconds}с, донатов=${currentTotalDonated}₽`);
                    console.log(`📊 Новое состояние: таймер=${newTimerSeconds}с, донатов=${newTotalDonated}₽`);
                    
                    // Удаляем донат
                    db.run('DELETE FROM donations WHERE id = ?', [donationId], function(err) {
                        if (err) {
                            console.error('❌ Ошибка удаления доната:', err);
                            return res.status(500).json({ success: false, error: 'Ошибка удаления доната' });
                        }
                        
                        if (this.changes === 0) {
                            return res.status(404).json({ success: false, error: 'Донат не найден' });
                        }
                        
                        console.log(`✅ Донат удален (ID: ${donationId})`);
                        
                        // Обновляем состояние
                        db.run(
                            'UPDATE app_state SET timer_seconds = ?, total_donated = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
                            [newTimerSeconds, newTotalDonated],
                            function(err) {
                                if (err) {
                                    console.error('❌ Ошибка обновления состояния:', err);
                                    return res.status(500).json({ success: false, error: 'Ошибка обновления состояния' });
                                }
                                
                                console.log('✅ Состояние обновлено');
                                
                                // Отправляем обновление клиентам
                                broadcastStateUpdate();
                                broadcastToClients({ 
                                    type: 'DONATION_DELETED',
                                    donationId,
                                    newTimerSeconds,
                                    newTotalDonated
                                });
                                
                                res.json({ 
                                    success: true,
                                    message: 'Донат удален',
                                    removedAmount: amountToRemove,
                                    removedTime: timeToRemove,
                                    newTimerSeconds,
                                    newTotalDonated
                                });
                            }
                        );
                    });
                });
            });
        });

        app.get('/api/donors', (req, res) => {
            const requestedLimit = parseInt(req.query.limit, 10);
            const requestedOffset = parseInt(req.query.offset, 10);
            const limit = Math.min(Math.max(requestedLimit && requestedLimit > 0 ? requestedLimit : 100, 1), 1000);
            const offset = Math.max(requestedOffset && requestedOffset > 0 ? requestedOffset : 0, 0);

            function queryDonors(tryFallback = false) {
                const normalizedExpr = getDonationsHasNormalizedUsername() ? "NULLIF(normalized_username, '')" : null;
                const groupExpression = normalizedExpr ? `COALESCE(${normalizedExpr}, username)` : 'username';
                const donorsQuery = `
                    SELECT
                        ${groupExpression} AS normalized_username,
                        MAX(username) AS username,
                        COUNT(*) AS donations_count,
                        SUM(amount) AS total_amount,
                        SUM(time_earned) AS total_time_seconds,
                        MAX(created_at) AS last_donation
                    FROM donations
                    WHERE username IS NOT NULL 
                      AND username != '' 
                      AND username != 'Zhuzhu'
                      AND (${normalizedExpr || "username"} IS NULL OR ${normalizedExpr || "username"} != '${normalizeUsername('Zhuzhu')}')
                    GROUP BY ${groupExpression}
                    ORDER BY total_amount DESC
                    LIMIT ? OFFSET ?
                `;

                db.all(donorsQuery, [limit, offset], (err, donors) => {
                    if (err) {
                        if (!tryFallback && err.message && err.message.includes('normalized_username')) {
                            console.warn('⚠️ normalized_username не найден, пробуем без него');
                            setDonationsHasNormalizedUsername(false);
                            return queryDonors(true);
                        }
                        if (err.message && err.message.includes('no such table')) {
                            return res.json({
                                success: true,
                                donors: [],
                                totalUnique: 0,
                                offset,
                                limit,
                                nextOffset: offset
                            });
                        }

                        console.error('❌ Ошибка получения донатеров:', err);
                        return res.status(500).json({ success: false, error: 'Не удалось получить донатеров' });
                    }

                    const distinctExpr = normalizedExpr ? `DISTINCT ${groupExpression}` : 'DISTINCT username';
                    db.get(`SELECT COUNT(${distinctExpr}) AS total_unique FROM donations`, (countErr, row) => {
                        if (countErr) {
                            if (countErr.message && countErr.message.includes('no such table')) {
                                return res.json({
                                    success: true,
                                    donors: [],
                                    totalUnique: 0,
                                    offset,
                                    limit,
                                    nextOffset: offset
                                });
                            }
                            console.error('❌ Ошибка подсчета донатеров:', countErr);
                        }

                        res.json({
                            success: true,
                            donors: (donors || []).map(donor => ({
                                normalized_username: donor.normalized_username,
                                username: donor.username,
                                donations_count: donor.donations_count || 0,
                                total_amount: Math.round(donor.total_amount || 0),
                                total_time_seconds: donor.total_time_seconds || 0,
                                last_donation: donor.last_donation || null
                            })),
                            totalUnique: row?.total_unique || (donors || []).length,
                            offset,
                            limit,
                            nextOffset: offset + (donors || []).length
                        });
                    });
                });
            }

            queryDonors();
        });

        app.get('/api/top-donors', (req, res) => {
            const requestedLimit = parseInt(req.query.limit, 10);
            const limit = Math.min(Math.max(!isNaN(requestedLimit) ? requestedLimit : 10, 1), 20);
            const isDaily = req.query.daily === '1' || req.query.daily === 'true';

            const normalizeDateInput = (value) => {
                if (!value) return null;
                const date = new Date(value);
                if (isNaN(date.getTime())) return null;
                return date;
            };

            let startDate = null;
            let endDate = null;

            // Функция для форматирования даты в формат SQLite (локальное время)
            const formatSqlDate = (date) => {
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const hours = String(date.getHours()).padStart(2, '0');
                const minutes = String(date.getMinutes()).padStart(2, '0');
                const seconds = String(date.getSeconds()).padStart(2, '0');
                return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
            };

            if (isDaily) {
                const now = new Date();
                startDate = new Date(now);
                startDate.setHours(0, 0, 0, 0);
                endDate = new Date(startDate.getTime() + 86400000);
                
                // Логируем для отладки
                console.log(`📅 Топ дня: начало дня = ${formatSqlDate(startDate)}, конец дня = ${formatSqlDate(endDate)}`);
            } else {
                startDate = normalizeDateInput(req.query.startDate);
                endDate = normalizeDateInput(req.query.endDate);
            }

            // Определяем выражение для нормализованного имени ДО использования
            const normalizedExpr = "CASE WHEN d.normalized_username IS NULL OR TRIM(d.normalized_username) = '' THEN d.username ELSE d.normalized_username END";
            const aggregatedAlias = 'aggregated_username';

            const conditions = [];
            const params = [];
            if (startDate) {
                conditions.push('d.created_at >= ?');
                params.push(formatSqlDate(startDate));
            }
            if (endDate) {
                conditions.push('d.created_at <= ?');
                params.push(formatSqlDate(endDate));
            }

            // Исключаем Zhuzhu из топов (проверяем и username, и normalized_username)
            conditions.push(`d.username != ? AND (d.normalized_username IS NULL OR d.normalized_username = '' OR d.normalized_username != ?)`);
            params.push('Zhuzhu');
            const excludedNorm = normalizeUsername('Zhuzhu');
            params.push(excludedNorm);

            const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

            const query = `
                SELECT 
                    ${normalizedExpr} AS ${aggregatedAlias},
                    MAX(d.username) AS username,
                    COUNT(*) AS donation_count,
                    SUM(d.amount) AS total_amount,
                    SUM(d.time_earned) AS total_time_seconds,
                    dat.id AS tier_id,
                    dat.name AS tier_name,
                    dat.icon AS tier_icon,
                    dat.custom_icon_url AS tier_custom_icon_url,
                    dat.color AS tier_color
                FROM donations d
                LEFT JOIN donor_achievements da ON da.normalized_username = ${normalizedExpr}
                LEFT JOIN donor_achievement_tiers dat ON dat.id = da.current_tier_id
                    ${whereClause}
                GROUP BY ${aggregatedAlias}
                ORDER BY total_amount DESC
                LIMIT ?
            `;

            params.push(limit);

            // Логируем запрос для отладки
            if (isDaily) {
                console.log(`🔍 Запрос топа дня: WHERE created_at >= '${formatSqlDate(startDate)}' AND created_at <= '${formatSqlDate(endDate)}'`);
            }

            db.all(query, params, (err, rows) => {
                if (err) {
                    console.error('❌ Ошибка получения топ-донатеров:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }

                const donors = (rows || []).map(row => ({
                    normalized_username: row[aggregatedAlias],
                    username: row.username,
                    donations_count: row.donation_count || 0,
                    total_amount: Math.round(row.total_amount || 0),
                    total_time_seconds: row.total_time_seconds || 0,
                    tier_id: row.tier_id,
                    tier_name: row.tier_name,
                    tier_icon: row.tier_icon,
                    tier_custom_icon_url: row.tier_custom_icon_url,
                    tier_color: row.tier_color || '#f5f5f5'
                }));

                // Логируем топ донатеров для отладки
                if (isDaily) {
                    console.log(`📊 Топ дня (api/top-donors, daily=1): найдено ${donors.length} донатеров`);
                    donors.slice(0, 5).forEach(d => {
                        console.log(`   - ${d.username} (${d.normalized_username}): ${d.total_amount}₽, ${d.donations_count} донатов`);
                    });
                } else {
                    console.log('📊 Топ донатеров (api/top-donors):', donors.slice(0, 5).map(d => `${d.username} (${d.normalized_username}): ${d.total_amount}₽, ${d.donations_count} донатов`).join(', '));
                }
                
                // Проверяем, есть ли Бетмен в топе
                const batman = donors.find(d => d.normalized_username && d.normalized_username.toLowerCase().includes('бетмен'));
                if (batman) {
                    console.log(`🦇 Бетмен найден в топе: ${batman.username} (${batman.normalized_username}) - ${batman.total_amount}₽, ${batman.donations_count} донатов`);
                } else {
                    console.log('⚠️ Бетмен НЕ найден в топе донатеров');
                }

                res.json({
                    success: true,
                    donors,
                    period: {
                        type: isDaily ? 'daily' : 'range',
                        start: startDate ? startDate.toISOString() : null,
                        end: endDate ? endDate.toISOString() : null
                    }
                });
            });
        });

        // Endpoint для общего топа донатеров (используется виджетом)
        app.get('/api/donors/top', (req, res) => {
            const requestedLimit = parseInt(req.query.limit, 10);
            const limit = Math.min(Math.max(!isNaN(requestedLimit) ? requestedLimit : 10, 1), 100);
            const fromDate = req.query.from_date;

            const formatSqlDate = (date) => date.toISOString().replace('T', ' ').split('.')[0];

            // Определяем выражение для нормализованного имени ДО использования
            const normalizedExpr = "CASE WHEN d.normalized_username IS NULL OR TRIM(d.normalized_username) = '' THEN d.username ELSE d.normalized_username END";
            const aggregatedAlias = 'aggregated_username';

            const conditions = [];
            const params = [];
            if (fromDate) {
                conditions.push('d.created_at >= ?');
                params.push(formatSqlDate(new Date(fromDate)));
            }

            // Исключаем Zhuzhu из топов
            conditions.push(`d.username != ? AND (d.normalized_username IS NULL OR d.normalized_username = '' OR d.normalized_username != ?)`);
            params.push('Zhuzhu');
            const excludedNorm = normalizeUsername('Zhuzhu');
            params.push(excludedNorm);

            const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

            const query = `
                SELECT 
                    ${normalizedExpr} AS ${aggregatedAlias},
                    MAX(d.username) AS username,
                    COUNT(*) AS donation_count,
                    SUM(d.amount) AS total_amount,
                    SUM(d.time_earned) AS total_time_seconds,
                    dat.id AS tier_id,
                    dat.name AS tier_name,
                    dat.icon AS tier_icon,
                    dat.custom_icon_url AS tier_custom_icon_url,
                    dat.color AS tier_color
                FROM donations d
                LEFT JOIN donor_achievements da ON da.normalized_username = ${normalizedExpr}
                LEFT JOIN donor_achievement_tiers dat ON dat.id = da.current_tier_id
                    ${whereClause}
                GROUP BY ${aggregatedAlias}
                ORDER BY total_amount DESC
                LIMIT ?
            `;

            params.push(limit);

            db.all(query, params, (err, rows) => {
                if (err) {
                    console.error('❌ Ошибка получения топ-донатеров:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }

                const donors = (rows || []).map(row => ({
                    normalized_username: row[aggregatedAlias],
                    username: row.username,
                    donations_count: row.donation_count || 0,
                    total_amount: Math.round(row.total_amount || 0),
                    total_time_seconds: row.total_time_seconds || 0,
                    display_amount: Math.round(row.total_amount || 0),
                    display_time_earned: row.total_time_seconds || 0,
                    period_time_earned: row.total_time_seconds || 0,
                    tier_info: row.tier_id ? {
                        id: row.tier_id,
                        title: row.tier_name,
                        icon: row.tier_icon,
                        icon_path: row.tier_custom_icon_url,
                        color: row.tier_color || '#f5f5f5'
                    } : null
                }));

                res.json({
                    success: true,
                    donors
                });
            });
        });

        // Endpoint для топа донатеров за сутки
        app.get('/api/donors/top/today', (req, res) => {
            const requestedLimit = parseInt(req.query.limit, 10);
            const limit = Math.min(Math.max(!isNaN(requestedLimit) ? requestedLimit : 10, 1), 100);

            const now = new Date();
            const todayStart = new Date(now);
            todayStart.setHours(0, 0, 0, 0);
            
            // Используем локальное время для совместимости с datetime('now') в SQLite
            const formatSqlDate = (date) => {
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const hours = String(date.getHours()).padStart(2, '0');
                const minutes = String(date.getMinutes()).padStart(2, '0');
                const seconds = String(date.getSeconds()).padStart(2, '0');
                return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
            };

            // Определяем выражение для нормализованного имени ДО использования
            const normalizedExpr = "CASE WHEN d.normalized_username IS NULL OR TRIM(d.normalized_username) = '' THEN d.username ELSE d.normalized_username END";
            const aggregatedAlias = 'aggregated_username';

            // Исключаем Zhuzhu из топов
            const excludedNorm = normalizeUsername('Zhuzhu');

            const query = `
                SELECT 
                    ${normalizedExpr} AS ${aggregatedAlias},
                    MAX(d.username) AS username,
                    COUNT(*) AS donation_count,
                    SUM(d.amount) AS today_amount,
                    SUM(d.time_earned) AS today_time_earned,
                    dat.id AS tier_id,
                    dat.name AS tier_name,
                    dat.icon AS tier_icon,
                    dat.custom_icon_url AS tier_custom_icon_url,
                    dat.color AS tier_color
                FROM donations d
                LEFT JOIN donor_achievements da ON da.normalized_username = ${normalizedExpr}
                LEFT JOIN donor_achievement_tiers dat ON dat.id = da.current_tier_id
                WHERE d.created_at >= ?
                  AND d.username != ?
                  AND (d.normalized_username IS NULL OR d.normalized_username = '' OR d.normalized_username != ?)
                GROUP BY ${aggregatedAlias}
                ORDER BY today_amount DESC
                LIMIT ?
            `;

            db.all(query, [formatSqlDate(todayStart), 'Zhuzhu', excludedNorm, limit], (err, rows) => {
                if (err) {
                    console.error('❌ Ошибка получения топа за сутки:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }

                const donors = (rows || []).map(row => ({
                    normalized_username: row[aggregatedAlias],
                    username: row.username,
                    donations_count: row.donation_count || 0,
                    today_amount: Math.round(row.today_amount || 0),
                    today_time_earned: row.today_time_earned || 0,
                    display_amount: Math.round(row.today_amount || 0),
                    display_time_earned: row.today_time_earned || 0,
                    tier_info: row.tier_id ? {
                        id: row.tier_id,
                        title: row.tier_name,
                        icon: row.tier_icon,
                        icon_path: row.tier_custom_icon_url,
                        color: row.tier_color || '#f5f5f5'
                    } : null
                }));

                res.json({
                    success: true,
                    donors
                });
            });
        });

        // Ручное добавление доната (для добавления записей в топ)
        // Очистка истории донатов
        app.post('/api/clear-donations', (req, res) => {
            db.run('DELETE FROM donations', (err) => {
                if (err) {
                    console.error('❌ Ошибка очистки донатов:', err);
                    res.status(500).json({ error: 'Не удалось очистить донаты' });
                } else {
                    console.log('✅ История донатов очищена');
                    processedDonationIds.clear();
                    db.run('DELETE FROM donor_achievements', (achievementErr) => {
                        if (achievementErr) {
                            console.error('❌ Не удалось очистить достижения донатеров:', achievementErr);
                        } else {
                            console.log('✅ Достижения донатеров также очищены');
                        }
                    });
                    res.json({ success: true });
                }
            });
        });

        // Сброс статистики
        app.post('/api/reset-stats', (req, res) => {
            const { mode } = req.body;
            
            console.log('🔄 Сброс статистики для режима:', mode);
            
            let resetState = {
                total_donated: 0,
                timer_discount: 0,
                stream_timer_initial_elapsed_sec: 0,
                stream_timer_last_update_ts: 0,
                stream_timer_started_ts: 0
            };
            
            if (mode === 'mode1' || mode === 'all') {
                resetState = {
                    ...resetState,
                    frags_needed: 10,
                    frags_done: 0,
                    current_balance: 0,
                    frag_cost: 50,
                    frag_amount: 1,
                    frag_name: "фраг",
                    widget_left_label: "ОСТАЛОСЬ",
                    widget_right_label: "СДЕЛАНО",
                    widget_progress_label: "До +1 фрага:"
                };
            }
            
            if (mode === 'mode2' || mode === 'all') {
                resetState = {
                    ...resetState,
                    timer_seconds: 0,
                    timer_paused: 0,
                    cost_per_minute: 50,
                    timer_alert_text: "добавил времени",
                    timer_slowdown_active: 0,
                    timer_slowdown_factor: 1.0,
                    timer_slowdown_until_ts: 0
                };
            }
            
            if (mode === 'mode3' || mode === 'all') {
                resetState = {
                    ...resetState,
                    custom_units_needed: 10,
                    custom_units_done: 0,
                    custom_current_balance: 0,
                    custom_unit_cost: 50,
                    custom_unit_amount: 1,
                    custom_goal_name: "единица",
                    custom_widget_left_label: "ОСТАЛОСЬ",
                    custom_widget_right_label: "СДЕЛАНО",
                    custom_alert_text: "добавил к цели"
                };
            }
            
            updateAppState(resetState, (err) => {
                if (err) {
                    console.error('❌ Ошибка сброса статистики:', err);
                    return res.status(500).json({ error: 'Не удалось сбросить статистику' });
                }
                
                // Очищаем историю донатов если полный сброс
                if (mode === 'all') {
                    db.run('DELETE FROM donations', (err) => {
                        if (err) {
                            console.error('❌ Ошибка очистки донатов:', err);
                        } else {
                            console.log('✅ История донатов очищена');
                        }
                        
                        processedDonationIds.clear();
                        console.log('✅ Множество обработанных донатов очищено');
                    db.run('DELETE FROM donor_achievements', (achievementErr) => {
                        if (achievementErr) {
                            console.error('❌ Не удалось очистить достижения донатеров при сбросе', achievementErr);
                        } else {
                            console.log('✅ Достижения донатеров очищены при сбросе');
                        }
                    });
                        
                        console.log('✅ Статистика сброшена для режима:', mode);
                        res.json({ success: true });
                    });
                } else {
                    processedDonationIds.clear();
                    console.log('✅ Статистика сброшена для режима:', mode);
                    res.json({ success: true });
                }
            });
        });

        // Удаление донатора и всех его донатов по имени
        app.post('/api/admin/delete-donor', (req, res) => {
            const { username } = req.body || {};

            if (!username || typeof username !== 'string' || !username.trim()) {
                return res.status(400).json({ success: false, error: 'Некорректное имя донатера' });
            }

            const rawName = username.trim();
            const normalizedName = normalizeUsername(rawName);

            console.log(`🧹 Запрос на удаление донатора: "${rawName}" (normalized: "${normalizedName}")`);

            db.serialize(() => {
                db.run('BEGIN TRANSACTION');

                // Сначала получаем все донаты этого пользователя, чтобы скорректировать цель сбора
                db.all(
                    'SELECT amount FROM donations WHERE username = ? OR normalized_username = ?',
                    [rawName, normalizedName],
                    (selectErr, rows) => {
                        if (selectErr) {
                            console.error('❌ Ошибка выборки донатов донатора:', selectErr);
                            db.run('ROLLBACK');
                            return res.status(500).json({ success: false, error: 'Ошибка выборки донатов' });
                        }

                        const totalAmountToRemove = (rows || []).reduce((sum, row) => sum + (row.amount || 0), 0);
                        const donationCountToRemove = (rows || []).length;

                        // Удаляем из основной таблицы донатов
                        db.run(
                            'DELETE FROM donations WHERE username = ? OR normalized_username = ?',
                            [rawName, normalizedName],
                            function (err) {
                                if (err) {
                                    console.error('❌ Ошибка удаления донатов донатора:', err);
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ success: false, error: 'Ошибка удаления донатов' });
                                }

                                const deletedDonations = this.changes || 0;
                                console.log(`🧹 Удалено донатов из таблицы donations: ${deletedDonations}`);

                                // Корректируем цель сбора и историю цели
                                db.get('SELECT * FROM donation_goals WHERE id = 1', (goalErr, goal) => {
                                    if (goalErr) {
                                        console.error('❌ Ошибка получения цели сбора при удалении донатора:', goalErr);
                                    } else if (goal && donationCountToRemove > 0 && totalAmountToRemove > 0) {
                                        const newCurrent = Math.max(0, (goal.current_amount || 0) - totalAmountToRemove);
                                        const newTotalCount = Math.max(0, (goal.total_donations || 0) - donationCountToRemove);
                                        const newAvg = newTotalCount > 0 ? newCurrent / newTotalCount : 0;

                                        db.run(
                                            `UPDATE donation_goals SET 
                                                current_amount = ?, 
                                                total_donations = ?, 
                                                avg_donation = ?, 
                                                updated_at = ?
                                             WHERE id = 1`,
                                            [newCurrent, newTotalCount, newAvg, new Date().toISOString()],
                                            (updErr) => {
                                                if (updErr) {
                                                    console.error('❌ Ошибка корректировки цели сбора при удалении донатора:', updErr);
                                                } else {
                                                    console.log(`🧹 Цель сбора скорректирована: -${totalAmountToRemove}₽, -${donationCountToRemove} донатов`);
                                                }
                                            }
                                        );
                                    }
                                });

                                // Удаляем донаты этого пользователя из истории цели
                                db.run(
                                    'DELETE FROM goal_donations WHERE username = ?',
                                    [rawName],
                                    (goalDonErr) => {
                                        if (goalDonErr) {
                                            console.error('❌ Ошибка удаления донатов донатора из goal_donations:', goalDonErr);
                                        } else {
                                            console.log('🧹 Удалены записи донатора из goal_donations');
                                        }
                                    }
                                );

                                // Удаляем достижения донатора
                                db.run(
                                    'DELETE FROM donor_achievements WHERE normalized_username = ?',
                                    [normalizedName],
                                    function (achErr) {
                                        if (achErr) {
                                            console.error('❌ Ошибка удаления достижений донатора:', achErr);
                                            db.run('ROLLBACK');
                                            return res.status(500).json({ success: false, error: 'Ошибка удаления достижений донатора' });
                                        }

                                        console.log(`🧹 Удалены достижения донатора "${rawName}"`);

                                        db.run('COMMIT', (commitErr) => {
                                            if (commitErr) {
                                                console.error('❌ Ошибка фиксации транзакции при удалении донатора:', commitErr);
                                                return res.status(500).json({ success: false, error: 'Ошибка фиксации изменений' });
                                            }

                                            console.log(`✅ Донатор "${rawName}" полностью удалён из базы (донаты, топы, статистика сбора)`);
                                            res.json({
                                                success: true,
                                                deletedDonations,
                                                removedFromGoalAmount: totalAmountToRemove,
                                                removedFromGoalCount: donationCountToRemove
                                            });
                                        });
                                    }
                                );
                            }
                        );
                    }
                );
            });
        });
    }

    return { registerRoutes };
}

module.exports = { createDonationsCrudModule };
