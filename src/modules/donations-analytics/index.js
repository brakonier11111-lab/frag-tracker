'use strict';

/**
 * Только read-only отчётность по донатам: обёртки над analytics.js
 * (/api/analytics/*) и прямые агрегирующие SELECT-запросы по таблице
 * donations/app_state (/api/donations-analytics и соседи). Ничего здесь
 * не пишет в БД и не вызывает processDonation/broadcastToClients/
 * updateAppState — сознательно выбранная безопасная часть донат-ядра.
 *
 * db, normalizeUsername и analytics (инстанс Analytics из ../../../analytics.js)
 * остаются в server.js и приходят как deps. donationsHasNormalizedUsername —
 * примитивный флаг (не объект), поэтому передаётся геттером
 * (getDonationsHasNormalizedUsername), а не значением — иначе модуль
 * зафиксировал бы значение на момент старта сервера и не увидел бы
 * последующее обновление флага после асинхронной проверки схемы БД.
 */

function createDonationsAnalyticsModule(deps) {
    const { db, normalizeUsername, analytics, getDonationsHasNormalizedUsername } = deps;

    function registerRoutes(app) {
        app.get('/api/analytics/stats', (req, res) => {
            const { period = '7d' } = req.query;

            analytics.getStats(period, (err, stats) => {
                if (err) {
                    console.error('❌ Ошибка получения статистики:', err);
                    return res.status(500).json({ error: 'Ошибка получения статистики' });
                }

                res.json({ success: true, stats });
            });
        });

        // API для получения статистики по платформам
        app.get('/api/analytics/platforms', (req, res) => {
            const { period = '7d' } = req.query;

            analytics.getPlatformStats(period, (err, stats) => {
                if (err) {
                    console.error('❌ Ошибка получения статистики платформ:', err);
                    return res.status(500).json({ error: 'Ошибка получения статистики платформ' });
                }

                res.json({ success: true, stats });
            });
        });

        // API для получения топ донатеров
        app.get('/api/analytics/top-donors', (req, res) => {
            const { limit = 10 } = req.query;

            analytics.getTopDonors(parseInt(limit), (err, donors) => {
                if (err) {
                    console.error('❌ Ошибка получения топ донатеров:', err);
                    return res.status(500).json({ error: 'Ошибка получения топ донатеров' });
                }

                res.json({ success: true, donors });
            });
        });

        // API для получения активности по часам
        app.get('/api/analytics/hourly', (req, res) => {
            analytics.getHourlyActivity((err, activity) => {
                if (err) {
                    console.error('❌ Ошибка получения почасовой активности:', err);
                    return res.status(500).json({ error: 'Ошибка получения почасовой активности' });
                }

                res.json({ success: true, activity });
            });
        });

        // API для получения событий аналитики
        app.get('/api/analytics/events', (req, res) => {
            const { eventType, limit = 100 } = req.query;

            analytics.getEvents(eventType, parseInt(limit), (err, events) => {
                if (err) {
                    console.error('❌ Ошибка получения событий:', err);
                    return res.status(500).json({ error: 'Ошибка получения событий' });
                }

                res.json({ success: true, events });
            });
        });

        app.get('/api/donations-analytics', (req, res) => {
            console.log('📊 Запрос аналитики донатов...');

            // Получаем стартовое значение из app_state
            db.get('SELECT total_donated FROM app_state WHERE id = 1', (err, appState) => {
                if (err) {
                    console.error('❌ Ошибка получения стартового значения:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }

                const startingAmount = Math.round(appState.total_donated || 0);

                const excludeName = 'Zhuzhu';
                const excludeNorm = normalizeUsername(excludeName);

                const queries = {
                    // Общая статистика
                    totalStats: `SELECT COUNT(*) as totalCount, SUM(amount) as totalAmount, AVG(amount) as avgAmount, MIN(amount) as minAmount, MAX(amount) as maxAmount
                                 FROM donations
                                 WHERE username != '${excludeName}' AND (normalized_username IS NULL OR normalized_username != '${excludeNorm}')`,

                    // Статистика по часам дня
                    hourlyStats: `SELECT
                        strftime('%H', datetime(created_at, 'localtime')) as hour,
                        COUNT(*) as count,
                        SUM(amount) as totalAmount,
                        AVG(amount) as avgAmount
                        FROM donations
                        WHERE username != '${excludeName}' AND (normalized_username IS NULL OR normalized_username != '${excludeNorm}')
                        GROUP BY strftime('%H', datetime(created_at, 'localtime'))
                        ORDER BY hour`,

                    // Статистика по дням недели
                    dailyStats: `SELECT
                        strftime('%w', datetime(created_at, 'localtime')) as dayOfWeek,
                        COUNT(*) as count,
                        SUM(amount) as totalAmount,
                        AVG(amount) as avgAmount
                        FROM donations
                        WHERE username != '${excludeName}' AND (normalized_username IS NULL OR normalized_username != '${excludeNorm}')
                        GROUP BY strftime('%w', datetime(created_at, 'localtime'))
                        ORDER BY dayOfWeek`,

                    // Статистика по размерам донатов
                    amountRanges: `SELECT
                        CASE
                            WHEN amount < 100 THEN '0-99₽'
                            WHEN amount < 500 THEN '100-499₽'
                            WHEN amount < 1000 THEN '500-999₽'
                            WHEN amount < 2000 THEN '1000-1999₽'
                            ELSE '2000₽+'
                        END as range,
                        COUNT(*) as count,
                        SUM(amount) as totalAmount
                        FROM donations
                        WHERE username != '${excludeName}' AND (normalized_username IS NULL OR normalized_username != '${excludeNorm}')
                        GROUP BY range
                        ORDER BY MIN(amount)`,

                    // Последние донаты
                    recentDonations: `SELECT * FROM donations
                                      WHERE username != '${excludeName}' AND (normalized_username IS NULL OR normalized_username != '${excludeNorm}')
                                      ORDER BY created_at DESC LIMIT 50`
                };

                const results = {};
                let completed = 0;
                const totalQueries = Object.keys(queries).length;

                Object.keys(queries).forEach(key => {
                    db.all(queries[key], (err, rows) => {
                        if (err) {
                            console.error(`❌ Ошибка запроса ${key}:`, err);
                            results[key] = { error: err.message };
                        } else {
                            results[key] = rows;
                        }

                        completed++;
                        if (completed === totalQueries) {
                            // Корректируем общую статистику с учетом стартового значения
                            if (results.totalStats && results.totalStats[0]) {
                                const stats = results.totalStats[0];
                                const donationsAmount = Math.round(stats.totalAmount || 0);
                                const donationsCount = stats.totalCount || 0;

                                // Если стартовое значение больше суммы донатов, корректируем статистику
                                if (startingAmount > donationsAmount) {
                                    results.totalStats[0].totalAmount = startingAmount;
                                    results.totalStats[0].avgAmount = donationsCount > 0 ?
                                        (startingAmount / donationsCount) : startingAmount;
                                    results.totalStats[0].minAmount = Math.min(stats.minAmount || startingAmount, startingAmount);
                                    results.totalStats[0].maxAmount = Math.max(stats.maxAmount || startingAmount, startingAmount);
                                }

                                results.startingAmount = startingAmount;
                                results.donationsAmount = donationsAmount;
                                results.donationsCount = donationsCount;
                            }

                            console.log('✅ Аналитика донатов готова (с учетом стартового значения)');
                            res.json({ success: true, data: results });
                        }
                    });
                });
            });
        });

        // Аналитика донатов - временные интервалы таймера
        app.get('/api/donations-timer-analysis', (req, res) => {
            console.log('⏰ Анализ донатов по времени таймера...');

            // Получаем данные о состоянии таймера и донатах
            const queries = {
                // Донаты с информацией о времени таймера (если есть связь)
                timerDonations: `SELECT
                    d.*,
                    CASE
                        WHEN d.created_at >= datetime('now', '-1 hour') THEN 'Последний час'
                        WHEN d.created_at >= datetime('now', '-6 hours') THEN 'Последние 6 часов'
                        WHEN d.created_at >= datetime('now', '-24 hours') THEN 'Последние 24 часа'
                        ELSE 'Старше суток'
                    END as timeGroup
                    FROM donations d
                    ORDER BY d.created_at DESC`,

                // Статистика по времени суток
                timeOfDay: `SELECT
                    CASE
                        WHEN strftime('%H', datetime(created_at, 'localtime')) BETWEEN '06' AND '11' THEN 'Утро (6-11)'
                        WHEN strftime('%H', datetime(created_at, 'localtime')) BETWEEN '12' AND '17' THEN 'День (12-17)'
                        WHEN strftime('%H', datetime(created_at, 'localtime')) BETWEEN '18' AND '23' THEN 'Вечер (18-23)'
                        ELSE 'Ночь (0-5)'
                    END as timePeriod,
                    COUNT(*) as count,
                    SUM(amount) as totalAmount,
                    AVG(amount) as avgAmount
                    FROM donations
                    GROUP BY timePeriod
                    ORDER BY totalAmount DESC`,

                // Топ донатеры
                topDonors: `SELECT
                    username,
                    COUNT(*) as donationCount,
                    SUM(amount) as totalDonated,
                    AVG(amount) as avgDonation,
                    MAX(amount) as maxDonation,
                    MIN(created_at) as firstDonation,
                    MAX(created_at) as lastDonation
                    FROM donations
                    GROUP BY username
                    ORDER BY totalDonated DESC
                    LIMIT 20`
            };

            const results = {};
            let completed = 0;
            const totalQueries = Object.keys(queries).length;

            Object.keys(queries).forEach(key => {
                db.all(queries[key], (err, rows) => {
                    if (err) {
                        console.error(`❌ Ошибка запроса ${key}:`, err);
                        results[key] = { error: err.message };
                    } else {
                        results[key] = rows;
                    }

                    completed++;
                    if (completed === totalQueries) {
                        console.log('✅ Анализ по времени таймера готов');
                        res.json({ success: true, data: results });
                    }
                });
            });
        });

        app.get('/api/donations-mode-analysis', (req, res) => {
            console.log('🎮 Анализ донатов по режимам таймера...');

            // Получаем данные о режимах из app_state
            db.get('SELECT * FROM app_state WHERE id = 1', (err, appState) => {
                if (err) {
                    console.error('❌ Ошибка получения состояния приложения:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }

                // Анализируем донаты с учетом режимов
                const queries = {
                    // Общая статистика донатов
                    donationStats: `SELECT
                        COUNT(*) as totalCount,
                        SUM(amount) as totalAmount,
                        AVG(amount) as avgAmount,
                        MIN(amount) as minAmount,
                        MAX(amount) as maxAmount,
                        COUNT(DISTINCT username) as uniqueDonors
                        FROM donations`,

                    // Статистика по размерам донатов
                    amountDistribution: `SELECT
                        CASE
                            WHEN amount < 50 THEN '0-49₽'
                            WHEN amount < 100 THEN '50-99₽'
                            WHEN amount < 200 THEN '100-199₽'
                            WHEN amount < 500 THEN '200-499₽'
                            WHEN amount < 1000 THEN '500-999₽'
                            ELSE '1000₽+'
                        END as range,
                        COUNT(*) as count,
                        SUM(amount) as totalAmount,
                        ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM donations), 2) as percentage
                        FROM donations
                        GROUP BY range
                        ORDER BY MIN(amount)`,

                    // Активность по дням
                    dailyActivity: `SELECT
                        DATE(datetime(created_at, 'localtime')) as date,
                        COUNT(*) as donationCount,
                        SUM(amount) as totalAmount,
                        COUNT(DISTINCT username) as uniqueDonors
                        FROM donations
                        GROUP BY DATE(datetime(created_at, 'localtime'))
                        ORDER BY date DESC
                        LIMIT 30`
                };

                const results = { appState };
                let completed = 0;
                const totalQueries = Object.keys(queries).length;

                Object.keys(queries).forEach(key => {
                    db.all(queries[key], (err, rows) => {
                        if (err) {
                            console.error(`❌ Ошибка запроса ${key}:`, err);
                            results[key] = { error: err.message };
                        } else {
                            results[key] = rows;
                        }

                        completed++;
                        if (completed === totalQueries) {
                            console.log('✅ Анализ по режимам готов');
                            res.json({ success: true, data: results });
                        }
                    });
                });
            });
        });

        // Расширенная аналитика режимов таймера
        app.get('/api/timer-modes-analytics', (req, res) => {
            console.log('🎮 Расширенная аналитика режимов таймера...');

            const queries = {
                // Статистика по времени таймера (когда больше всего донатов)
                timerTimeStats: `SELECT
                    CASE
                        WHEN timer_seconds = 0 THEN 'Таймер остановлен'
                        WHEN timer_seconds < 60 THEN 'Менее 1 минуты'
                        WHEN timer_seconds < 300 THEN '1-5 минут'
                        WHEN timer_seconds < 600 THEN '5-10 минут'
                        WHEN timer_seconds < 1800 THEN '10-30 минут'
                        WHEN timer_seconds < 3600 THEN '30-60 минут'
                        WHEN timer_seconds < 7200 THEN '1-2 часа'
                        WHEN timer_seconds < 10800 THEN '2-3 часа'
                        WHEN timer_seconds < 14400 THEN '3-4 часа'
                        WHEN timer_seconds < 18000 THEN '4-5 часов'
                        WHEN timer_seconds < 21600 THEN '5-6 часов'
                        WHEN timer_seconds < 25200 THEN '6-7 часов'
                        WHEN timer_seconds < 28800 THEN '7-8 часов'
                        ELSE 'Более 8 часов'
                    END as timeRange,
                    COUNT(*) as donationCount,
                    SUM(amount) as totalAmount,
                    AVG(amount) as avgAmount,
                    timer_mode,
                    discount_active,
                    slowdown_active,
                    temperature_active
                    FROM donations
                    WHERE timer_seconds IS NOT NULL
                    GROUP BY timeRange, timer_mode, discount_active, slowdown_active, temperature_active
                    ORDER BY totalAmount DESC`,

                // Статистика по последнему часу с интервалами 10 минут
                lastHourStats: `SELECT
                    CASE
                        WHEN timer_seconds >= 3600 THEN '60+ минут'
                        WHEN timer_seconds >= 3300 THEN '55-60 минут'
                        WHEN timer_seconds >= 3000 THEN '50-55 минут'
                        WHEN timer_seconds >= 2700 THEN '45-50 минут'
                        WHEN timer_seconds >= 2400 THEN '40-45 минут'
                        WHEN timer_seconds >= 2100 THEN '35-40 минут'
                        WHEN timer_seconds >= 1800 THEN '30-35 минут'
                        WHEN timer_seconds >= 1500 THEN '25-30 минут'
                        WHEN timer_seconds >= 1200 THEN '20-25 минут'
                        WHEN timer_seconds >= 900 THEN '15-20 минут'
                        WHEN timer_seconds >= 600 THEN '10-15 минут'
                        WHEN timer_seconds >= 300 THEN '5-10 минут'
                        WHEN timer_seconds >= 60 THEN '1-5 минут'
                        WHEN timer_seconds > 0 THEN 'Менее 1 минуты'
                        ELSE 'Таймер остановлен'
                    END as timeRange,
                    COUNT(*) as donationCount,
                    SUM(amount) as totalAmount,
                    AVG(amount) as avgAmount,
                    timer_mode
                    FROM donations
                    WHERE timer_seconds IS NOT NULL AND timer_seconds <= 3600
                    GROUP BY timeRange, timer_mode
                    ORDER BY timer_seconds DESC`,

                // Статистика по режимам таймера
                timerModesStats: `SELECT
                    CASE
                        WHEN timer_mode = 'mode1' THEN 'Фраг-трекер'
                        WHEN timer_mode = 'mode2' THEN 'Таймер'
                        WHEN timer_mode = 'mode3' THEN 'Кастомный трекер'
                        WHEN timer_mode = 'normal' THEN 'Обычный режим'
                        ELSE timer_mode
                    END as modeName,
                    timer_mode,
                    COUNT(*) as donationCount,
                    SUM(amount) as totalAmount,
                    AVG(amount) as avgAmount,
                    SUM(CASE WHEN discount_active = 1 THEN 1 ELSE 0 END) as discountDonations,
                    SUM(CASE WHEN slowdown_active = 1 THEN 1 ELSE 0 END) as slowdownDonations,
                    SUM(CASE WHEN temperature_active = 1 THEN 1 ELSE 0 END) as temperatureDonations
                    FROM donations
                    WHERE timer_mode IS NOT NULL
                    GROUP BY timer_mode
                    ORDER BY totalAmount DESC`,

                // Статистика по режиму температуры
                temperatureStats: `SELECT
                    CASE
                        WHEN temperature_overheated = 1 THEN 'Достигнут перегрев (100%)'
                        WHEN temperature_amount >= 75 THEN 'Высокая температура (75-99%)'
                        WHEN temperature_amount >= 50 THEN 'Средняя температура (50-74%)'
                        WHEN temperature_amount >= 25 THEN 'Низкая температура (25-49%)'
                        WHEN temperature_amount > 0 THEN 'Начальная температура (1-24%)'
                        ELSE 'Температура не активна'
                    END as temperatureRange,
                    COUNT(*) as donationCount,
                    SUM(amount) as totalAmount,
                    AVG(amount) as avgAmount,
                    AVG(temperature_amount) as avgTemperature,
                    AVG(temperature_target) as avgTarget,
                    SUM(temperature_reward_minutes) as totalRewardMinutes
                    FROM donations
                    WHERE temperature_active = 1
                    GROUP BY temperatureRange
                    ORDER BY avgTemperature DESC`,

                // Сессии режима температуры
                temperatureSessions: `SELECT
                    COUNT(*) as totalSessions,
                    SUM(CASE WHEN overheated = 1 THEN 1 ELSE 0 END) as overheatedSessions,
                    SUM(CASE WHEN overheated = 0 THEN 1 ELSE 0 END) as incompleteSessions,
                    AVG(total_donated) as avgDonatedPerSession,
                    AVG(max_temperature) as avgMaxTemperature,
                    SUM(reward_minutes) as totalRewardMinutes,
                    AVG(cooling_rate) as avgCoolingRate
                    FROM temperature_sessions
                    WHERE totalSessions > 0`,

                // Топ донатов по режимам
                topDonationsByMode: `SELECT
                    username,
                    amount,
                    timer_mode,
                    discount_active,
                    slowdown_active,
                    temperature_active,
                    temperature_amount,
                    created_at
                    FROM donations
                    WHERE timer_mode IS NOT NULL
                    ORDER BY amount DESC
                    LIMIT 50`,

                // Статистика по скидкам
                discountStats: `SELECT
                    discount_percentage,
                    COUNT(*) as donationCount,
                    SUM(amount) as totalAmount,
                    AVG(amount) as avgAmount
                    FROM donations
                    WHERE discount_active = 1 AND discount_percentage > 0
                    GROUP BY discount_percentage
                    ORDER BY discount_percentage DESC`,

                // Статистика по замедлению
                slowdownStats: `SELECT
                    slowdown_factor,
                    COUNT(*) as donationCount,
                    SUM(amount) as totalAmount,
                    AVG(amount) as avgAmount
                    FROM donations
                    WHERE slowdown_active = 1 AND slowdown_factor > 0
                    GROUP BY slowdown_factor
                    ORDER BY slowdown_factor DESC`
            };

            const results = {};
            let completed = 0;
            const totalQueries = Object.keys(queries).length;

            Object.keys(queries).forEach(key => {
                db.all(queries[key], (err, rows) => {
                    if (err) {
                        console.error(`❌ Ошибка запроса ${key}:`, err);
                        results[key] = { error: err.message };
                    } else {
                        results[key] = rows;
                    }

                    completed++;
                    if (completed === totalQueries) {
                        console.log('✅ Расширенная аналитика режимов таймера готова');
                        res.json({ success: true, data: results });
                    }
                });
            });
        });

        // API для группировки донатеров по нормализованным никам
        app.get('/api/donors-grouped', (req, res) => {
            console.log('👥 Запрос группировки донатеров по никам...');

            const queries = {
                // Группировка по нормализованным никам
                groupedDonors: `SELECT
                    normalized_username,
                    COUNT(*) as donationCount,
                    SUM(amount) as totalAmount,
                    AVG(amount) as avgAmount,
                    MIN(amount) as minAmount,
                    MAX(amount) as maxAmount,
                    GROUP_CONCAT(DISTINCT username) as originalUsernames,
                    MIN(created_at) as firstDonation,
                    MAX(created_at) as lastDonation
                    FROM donations
                    WHERE normalized_username != ''
                    GROUP BY normalized_username
                    ORDER BY totalAmount DESC`,

                // Статистика по вариациям ников
                usernameVariations: `SELECT
                    normalized_username,
                    COUNT(DISTINCT username) as variationCount,
                    GROUP_CONCAT(DISTINCT username) as variations,
                    SUM(amount) as totalAmount
                    FROM donations
                    WHERE normalized_username != ''
                    GROUP BY normalized_username
                    HAVING variationCount > 1
                    ORDER BY variationCount DESC, totalAmount DESC`,

                // Топ донатеров с группировкой
                topGroupedDonors: `SELECT
                    normalized_username,
                    COUNT(*) as donationCount,
                    SUM(amount) as totalAmount,
                    AVG(amount) as avgAmount,
                    GROUP_CONCAT(DISTINCT username) as originalUsernames,
                    MAX(amount) as maxDonation
                    FROM donations
                    WHERE normalized_username != ''
                    GROUP BY normalized_username
                    ORDER BY totalAmount DESC
                    LIMIT 50`,

                // Статистика по режимам для группированных донатеров
                donorsByModes: `SELECT
                    normalized_username,
                    timer_mode,
                    COUNT(*) as donationCount,
                    SUM(amount) as totalAmount,
                    AVG(amount) as avgAmount
                    FROM donations
                    WHERE normalized_username != '' AND timer_mode IS NOT NULL
                    GROUP BY normalized_username, timer_mode
                    ORDER BY totalAmount DESC`,

                // Общая статистика группировки
                groupingStats: `SELECT
                    COUNT(DISTINCT username) as uniqueOriginalUsernames,
                    COUNT(DISTINCT normalized_username) as uniqueNormalizedUsernames,
                    COUNT(*) as totalDonations,
                    SUM(amount) as totalAmount
                    FROM donations
                    WHERE normalized_username != ''`
            };

            const results = {};
            let completed = 0;
            const totalQueries = Object.keys(queries).length;

            Object.keys(queries).forEach(key => {
                db.all(queries[key], (err, rows) => {
                    if (err) {
                        console.error(`❌ Ошибка запроса ${key}:`, err);
                        results[key] = { error: err.message };
                    } else {
                        results[key] = rows;
                    }

                    completed++;
                    if (completed === totalQueries) {
                        console.log('✅ Группировка донатеров готова');
                        res.json({ success: true, data: results });
                    }
                });
            });
        });

        // Получить общую статистику донатов
        app.get('/api/donations-stats', (req, res) => {
            // Читаем app_state как «источник истины» для суммы
            db.get('SELECT total_donated FROM app_state WHERE id = 1', (appErr, appState) => {
                const totalFromState = Math.round((appState && appState.total_donated) || 0);
                // Проверяем наличие таблицы donations
                db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name='donations'`, (tableErr, tables) => {
                    if (tableErr || !tables || tables.length === 0) {
                        if (tableErr) console.error('❌ Ошибка проверки таблицы donations:', tableErr);
                        // Возвращаем сумму из состояния, даже если таблицы нет
                        return res.json({ success: true, totalAmount: totalFromState, totalCount: 0 });
                    }
                    // Получаем статистику из таблицы donations (только для количества)
                    db.get('SELECT COUNT(*) as totalCount FROM donations WHERE username != ? AND normalized_username != ?', ['Zhuzhu', normalizeUsername('Zhuzhu')], (err, stats) => {
                        if (err) {
                            console.error('❌ Ошибка получения статистики донатов:', err);
                            return res.json({ success: true, totalAmount: totalFromState, totalCount: 0 });
                        }
                        const donationsCount = (stats && stats.totalCount) || 0;
                        // ВАЖНО: Используем total_donated из app_state как единственный источник истины для суммы
                        // Это гарантирует, что корректировки и ручные изменения отражаются в виджетах
                        res.json({ success: true, totalAmount: totalFromState, totalCount: donationsCount });
                    });
                });
            });
        });

        // Тестовый endpoint для диагностики малых донатеров
        app.get('/api/donations-stats-small-donors-debug', (req, res) => {
            const excludeName = 'Zhuzhu';
            const excludeNorm = normalizeUsername(excludeName);
            const normalizedExpr = getDonationsHasNormalizedUsername() ? "NULLIF(normalized_username, '')" : null;
            const groupExpression = normalizedExpr ? `COALESCE(${normalizedExpr}, username)` : 'username';

            // Получаем всех донатеров с их суммами
            db.all(`
                SELECT
                    ${groupExpression} AS aggregated_username,
                    SUM(amount) AS total_amount,
                    COUNT(*) AS donation_count,
                    SUM(COALESCE(time_earned, 0)) AS total_time
                FROM donations
                WHERE username IS NOT NULL
                  AND username != ''
                  AND username != ?
                  AND (${normalizedExpr || "username"} IS NULL OR ${normalizedExpr || "username"} != ?)
                GROUP BY ${groupExpression}
                ORDER BY total_amount ASC
                LIMIT 50
            `, [excludeName, excludeNorm], (err, rows) => {
                if (err) {
                    return res.status(500).json({ success: false, error: err.message });
                }

                const smallDonors = rows.filter(r => r.total_amount <= 2000);

                res.json({
                    success: true,
                    total_donors: rows.length,
                    small_donors_count: smallDonors.length,
                    small_donors: smallDonors,
                    all_donors_sample: rows.slice(0, 10)
                });
            });
        });

        // Получить статистику по донатерам с общей суммой <= 2000₽
        app.get('/api/donations-stats-small-donors', (req, res) => {
            try {
                const topDonorsCount = 10;
                const excludeName = 'Zhuzhu';
                const excludeNorm = normalizeUsername(excludeName);

                console.log(`📊 Запрос статистики донатеров (исключая топ-${topDonorsCount})`);

                // Используем тот же подход, что и в /api/donors
                const normalizedExpr = getDonationsHasNormalizedUsername() ? "NULLIF(normalized_username, '')" : null;
                const groupExpression = normalizedExpr ? `COALESCE(${normalizedExpr}, username)` : 'username';

                // ПРОСТОЙ ПОДХОД: находим топ-10 донатеров, исключаем их, считаем остальных
                // Сначала находим топ-10 донатеров
                const findTopDonorsQuery = `
                    SELECT
                        ${groupExpression} AS aggregated_username,
                        SUM(amount) AS total_amount
                    FROM donations
                    WHERE username IS NOT NULL
                      AND username != ''
                      AND username != ?
                      AND (${normalizedExpr || "username"} IS NULL OR ${normalizedExpr || "username"} != ?)
                    GROUP BY ${groupExpression}
                    ORDER BY total_amount DESC
                    LIMIT ?
                `;

                console.log(`📊 Поиск топ-${topDonorsCount} донатеров...`);
                console.log(`📊 SQL:`, findTopDonorsQuery);
                console.log(`📊 Параметры: [${excludeName}, ${excludeNorm}, ${topDonorsCount}]`);

                db.all(findTopDonorsQuery, [excludeName, excludeNorm, topDonorsCount], (topErr, topDonors) => {
                    if (topErr) {
                        console.error('❌ Ошибка поиска топ-донатеров:', topErr);
                        return res.status(500).json({
                            success: false,
                            error: topErr.message,
                            details: 'Ошибка при поиске топ-донатеров'
                        });
                    }

                    if (!topDonors || topDonors.length === 0) {
                        console.log('📊 Топ-донатеров не найдено, считаем всех');
                        // Если нет топ-донатеров, считаем всех
                        const allQuery = `
                            SELECT
                                COUNT(*) as donation_count,
                                COALESCE(SUM(amount), 0) as total_amount,
                                COALESCE(SUM(COALESCE(time_earned, 0)), 0) as total_time_earned,
                                COUNT(DISTINCT ${groupExpression}) as unique_donors
                            FROM donations d
                            WHERE d.username IS NOT NULL
                              AND d.username != ''
                              AND d.username != ?
                              AND (${normalizedExpr || "d.username"} IS NULL OR ${normalizedExpr || "d.username"} != ?)
                        `;

                        db.get(allQuery, [excludeName, excludeNorm], (allErr, allStats) => {
                            if (allErr) {
                                console.error('❌ Ошибка получения статистики:', allErr);
                                return res.status(500).json({ success: false, error: allErr.message });
                            }

                            const result = {
                                success: true,
                                donation_count: allStats?.donation_count || 0,
                                total_amount: Math.round(allStats?.total_amount || 0),
                                total_time_earned: allStats?.total_time_earned || 0,
                                unique_donors: allStats?.unique_donors || 0,
                                excluded_top_count: 0
                            };

                            console.log(`✅ Статистика (все донатеры):`, result);
                            res.json(result);
                        });
                        return;
                    }

                    const topUsernames = topDonors.map(d => d.aggregated_username).filter(Boolean);
                    console.log(`📊 Найдено ${topUsernames.length} топ-донатеров:`, topUsernames.slice(0, 5));
                    console.log(`📊 Примеры сумм:`, topDonors.slice(0, 5).map(d => `${d.aggregated_username}: ${d.total_amount}₽`));

                    if (topUsernames.length === 0) {
                        console.log('⚠️ Список топ-донатеров пуст, считаем всех');
                        // Если список пуст, считаем всех
                        const allQuery = `
                            SELECT
                                COUNT(*) as donation_count,
                                COALESCE(SUM(amount), 0) as total_amount,
                                COALESCE(SUM(COALESCE(time_earned, 0)), 0) as total_time_earned,
                                COUNT(DISTINCT ${groupExpression}) as unique_donors
                            FROM donations d
                            WHERE d.username IS NOT NULL
                              AND d.username != ''
                              AND d.username != ?
                              AND (${normalizedExpr || "d.username"} IS NULL OR ${normalizedExpr || "d.username"} != ?)
                        `;

                        db.get(allQuery, [excludeName, excludeNorm], (allErr, allStats) => {
                            if (allErr) {
                                console.error('❌ Ошибка получения статистики:', allErr);
                                return res.status(500).json({ success: false, error: allErr.message });
                            }

                            const result = {
                                success: true,
                                donation_count: allStats?.donation_count || 0,
                                total_amount: Math.round(allStats?.total_amount || 0),
                                total_time_earned: allStats?.total_time_earned || 0,
                                unique_donors: allStats?.unique_donors || 0,
                                excluded_top_count: 0
                            };

                            console.log(`✅ Статистика (все донатеры):`, result);
                            res.json(result);
                        });
                        return;
                    }

                    // Теперь считаем статистику по остальным донатерам
                    const placeholders = topUsernames.map(() => '?').join(',');
                    const statsQuery = `
                        SELECT
                            COUNT(*) as donation_count,
                            COALESCE(SUM(amount), 0) as total_amount,
                            COALESCE(SUM(COALESCE(time_earned, 0)), 0) as total_time_earned,
                            COUNT(DISTINCT ${groupExpression}) as unique_donors
                        FROM donations d
                        WHERE d.username IS NOT NULL
                          AND d.username != ''
                          AND d.username != ?
                          AND (${normalizedExpr || "d.username"} IS NULL OR ${normalizedExpr || "d.username"} != ?)
                          AND ${groupExpression} NOT IN (${placeholders})
                    `;

                    const statsParams = [excludeName, excludeNorm, ...topUsernames];

                    console.log(`📊 Запрос статистики (исключая ${topUsernames.length} топ-донатеров)`);
                    console.log(`📊 SQL:`, statsQuery.substring(0, 200) + '...');
                    console.log(`📊 Параметров: ${statsParams.length}`);

                    db.get(statsQuery, statsParams, (err, stats) => {
                        if (err) {
                            console.error('❌ Ошибка получения статистики:', err);
                            console.error('   SQL:', statsQuery);
                            console.error('   Ошибка SQL:', err.message);
                            return res.status(500).json({
                                success: false,
                                error: err.message,
                                details: 'Ошибка при подсчете статистики'
                            });
                        }

                        console.log(`📊 Результат запроса:`, stats);

                        const result = {
                            success: true,
                            donation_count: stats?.donation_count || 0,
                            total_amount: Math.round(stats?.total_amount || 0),
                            total_time_earned: stats?.total_time_earned || 0,
                            unique_donors: stats?.unique_donors || 0,
                            excluded_top_count: topDonorsCount
                        };

                        console.log(`✅ Статистика донатеров (исключая топ-${topDonorsCount}):`);
                        console.log(`   - Количество донатов: ${result.donation_count}`);
                        console.log(`   - Общая сумма: ${result.total_amount}₽`);
                        console.log(`   - Время в таймере: ${result.total_time_earned} сек (${Math.floor(result.total_time_earned / 60)} мин)`);
                        console.log(`   - Уникальных донатеров: ${result.unique_donors}`);

                        res.json(result);
                    });
                });
            } catch (error) {
                console.error('❌ Критическая ошибка в /api/donations-stats-small-donors:', error);
                res.status(500).json({
                    success: false,
                    error: error.message || 'Неизвестная ошибка',
                    details: 'Ошибка при обработке запроса'
                });
            }
        });
    }

    return { registerRoutes };
}

module.exports = { createDonationsAnalyticsModule };
