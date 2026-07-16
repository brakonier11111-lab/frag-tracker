'use strict';

const axios = require('axios');

/**
 * HTTP-роуты Lesta: аккаунт/конфиг/сброс, статистика, достижения, техника,
 * периоды/сессия/история. Вынос из server.js с телами 1:1; вся общая логика
 * (getLestaPlayerStats, applyLestaStats, хелперы истории и танко-снапшотов)
 * приходит через deps. Роуты автосинка защищены npm run test-lesta.
 */
function createLestaRoutesModule(deps) {
    const {
        lestaConfig: LESTA_CONFIG, db, dbRead, analytics,
        getAppState, updateAppState, broadcastStateUpdate,
        getLestaPlayerStats, prolongateLestaToken, applyLestaStats,
        startLestaAutoSync, stopLestaAutoSync,
        getLestaCountersFromState, computeLestaPeriodDelta,
        fetchLestaHistoryWindow, computeLestaPeriodStatsFromRows, buildLestaDailyActivity,
        fetchAccountTanksForAccount, scheduleLestaTankSnapshot, ensureLestaConfigFromState,
        tanksToSnapshotMap, fetchTankSnapshotBaseline, insertLestaTankSnapshot,
        parseTankSnapshotMap, computeTankPeriodChanges, fetchNewestTankSnapshotInPeriod
    } = deps;

    // Единая логика Lesta-сессии — используется и здесь, и в blitz-challenge
    // (/api/blitz-challenge/session/*) через moduleDeps, чтобы не было двух копий
    function startLestaSession(callback) {
        getAppState((state) => {
            if (!state || !state.lesta_account_id) {
                return callback({ status: 400, error: 'Сначала привяжите аккаунт Lesta' });
            }
            const nowSec = Math.floor(Date.now() / 1000);
            updateAppState({
                lesta_session_started_at: nowSec,
                lesta_session_baseline_battles: state.lesta_last_battles || 0,
                lesta_session_baseline_wins: state.lesta_last_wins || 0,
                lesta_session_baseline_losses: state.lesta_last_losses || 0,
                lesta_session_baseline_frags: state.lesta_last_frags || 0,
                lesta_session_baseline_damage: state.lesta_last_damage_dealt || 0,
                lesta_session_baseline_xp: state.lesta_last_xp || 0
            }, (err) => {
                if (err) return callback({ status: 500, error: err.message });
                callback(null, { startedAt: nowSec });
            });
        });
    }

    function resetLestaSession(callback) {
        updateAppState({
            lesta_session_started_at: 0,
            lesta_session_baseline_battles: 0,
            lesta_session_baseline_wins: 0,
            lesta_session_baseline_losses: 0,
            lesta_session_baseline_frags: 0,
            lesta_session_baseline_damage: 0,
            lesta_session_baseline_xp: 0
        }, (err) => {
            if (err) return callback({ status: 500, error: err.message });
            callback(null, {});
        });
    }

    function registerRoutes(app) {
        app.post('/api/lesta-set-account', async (req, res) => {
            const accountId = req.body && req.body.accountId != null ? String(req.body.accountId).trim() : '';
            const nickname = req.body && req.body.nickname != null ? String(req.body.nickname).trim() : '';

            if (!accountId) {
                return res.status(400).json({ success: false, error: 'Укажите accountId' });
            }
            if (!LESTA_CONFIG.applicationId) {
                return res.status(400).json({ success: false, error: 'Application ID Lesta не настроен (админка)' });
            }

            LESTA_CONFIG.accountId = accountId;
            if (nickname) LESTA_CONFIG.nickname = nickname;

            try {
                const stats = await getLestaPlayerStats();
                const resolvedNickname = (stats && stats.nickname) || nickname || LESTA_CONFIG.nickname || 'Игрок';

                updateAppState({
                    lesta_account_id: accountId,
                    lesta_nickname: resolvedNickname,
                    lesta_last_sync_time: Math.floor(Date.now() / 1000)
                }, (err) => {
                    if (err) {
                        return res.status(500).json({ success: false, error: 'Ошибка сохранения аккаунта' });
                    }
                    LESTA_CONFIG.nickname = resolvedNickname;
                    startLestaAutoSync();
                    if (typeof broadcastStateUpdate === 'function') broadcastStateUpdate();
                    res.json({
                        success: true,
                        accountId,
                        nickname: resolvedNickname,
                        stats,
                        message: 'Аккаунт для отслеживания установлен'
                    });
                });
            } catch (error) {
                console.error('❌ lesta-set-account:', error);
                res.status(500).json({ success: false, error: error.message || 'Ошибка получения статистики' });
            }
        });

        // Полный сброс привязки Lesta (токен, аккаунт, кэш статистики; application_id сохраняется)
        app.post('/api/reset-lesta', (req, res) => {
            stopLestaAutoSync();
            LESTA_CONFIG.accessToken = null;
            LESTA_CONFIG.accountId = null;
            LESTA_CONFIG.nickname = null;
            LESTA_CONFIG.tokenExpiresAt = null;

            const resetFields = {
                lesta_access_token: null,
                lesta_token_expires_at: 0,
                lesta_account_id: null,
                lesta_nickname: null,
                lesta_last_battles: null,
                lesta_last_frags: null,
                lesta_last_wins: null,
                lesta_last_losses: null,
                lesta_last_win_rate: null,
                lesta_last_frags_per_battle: null,
                lesta_last_damage_dealt: null,
                lesta_last_xp: null,
                lesta_last_damage_received: null,
                lesta_last_max_frags: null,
                lesta_last_frags8p: null,
                lesta_last_hits: null,
                lesta_last_shots: null,
                lesta_last_spotted: null,
                lesta_last_capture_points: null,
                lesta_last_dropped_capture_points: null,
                lesta_last_survived_battles: null,
                lesta_last_win_and_survived: null,
                lesta_last_max_xp: null,
                lesta_previous_frags: null,
                lesta_last_sync_time: 0
            };

            updateAppState(resetFields, (err) => {
                if (err) {
                    console.error('❌ reset-lesta:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка сброса' });
                }
                if (typeof broadcastStateUpdate === 'function') broadcastStateUpdate();
                res.json({ success: true, message: 'Данные Lesta сброшены' });
            });
        });

        // API для настройки Lesta Games
        app.post('/api/lesta-config', (req, res) => {
            const { applicationId } = req.body;

            console.log('🔧 Настройка Lesta Games:', { applicationId: applicationId ? 'ЕСТЬ' : 'НЕТ' });

            // Логируем событие настройки
            analytics.logEvent('lesta_config', { hasApplicationId: !!applicationId }, null, null, req);

            // Сохраняем в переменные окружения
            if (applicationId) {
                LESTA_CONFIG.applicationId = applicationId;
            }

            updateAppState({
                lesta_application_id: applicationId || ''
            }, (err) => {
                if (err) {
                    console.error('❌ Ошибка сохранения настроек Lesta Games:', err);
                    res.status(500).json({ success: false, error: 'Ошибка сохранения' });
                } else {
                    console.log('✅ Настройки Lesta Games сохранены в БД');
                    res.json({ success: true, message: 'Lesta Games настроен и сохранен' });
                }
            });
        });

        // API для получения статистики Lesta Games
        app.get('/api/lesta-stats', async (req, res) => {
            try {
                // Сначала пытаемся получить свежую статистику
                const freshStats = await getLestaPlayerStats();

                if (freshStats) {
                    res.json({ success: true, stats: freshStats, source: 'api' });
                } else {
                    // Если не удалось получить свежую статистику, берем из БД
                    getAppState((state) => {
                        if (state && state.lesta_last_battles !== null) {
                            const savedStats = {
                                nickname: state.lesta_nickname || 'Неизвестный игрок',
                                battles: state.lesta_last_battles || 0,
                                frags: state.lesta_last_frags || 0,
                                wins: Math.round((state.lesta_last_win_rate || 0) * (state.lesta_last_battles || 0) / 100),
                                losses: (state.lesta_last_battles || 0) - Math.round((state.lesta_last_win_rate || 0) * (state.lesta_last_battles || 0) / 100),
                                damage_dealt: state.lesta_last_damage_dealt || 0,
                                xp: state.lesta_last_xp || 0,
                                winRate: state.lesta_last_win_rate || 0,
                                fragsPerBattle: state.lesta_last_frags_per_battle || 0,
                                avgDamage: state.lesta_last_battles > 0 ? Math.round((state.lesta_last_damage_dealt || 0) / state.lesta_last_battles) : 0,
                                avgXp: state.lesta_last_battles > 0 ? Math.round((state.lesta_last_xp || 0) / state.lesta_last_battles) : 0,
                                gold: state.lesta_last_gold,
                                credits: state.lesta_last_credits,
                                free_xp: state.lesta_last_free_xp
                            };
                            res.json({ success: true, stats: savedStats, source: 'database' });
                        } else {
                            res.status(404).json({ success: false, error: 'Статистика не найдена' });
                        }
                    });
                }
            } catch (error) {
                console.error('❌ Ошибка получения статистики Lesta Games:', error);
                res.status(500).json({ success: false, error: 'Ошибка получения статистики' });
            }
        });

        // Синхронизация счётчиков Lesta с локальной статистикой боёв
        app.post('/api/sync-lesta-state', (req, res) => {
            try {
                console.log('🔄 Синхронизация состояния Lesta Games с локальной статистикой...');

                db.all('SELECT frags FROM frag_stats', (err, rows) => {
                    if (err) {
                        console.error('❌ Ошибка получения локальной статистики:', err);
                        return res.status(500).json({ success: false, message: 'Ошибка получения статистики' });
                    }

                    const totalBattles = rows.length;
                    const totalFrags = rows.reduce((sum, row) => sum + row.frags, 0);

                    console.log(`📊 Локальная статистика: ${totalBattles} боев, ${totalFrags} фрагов`);

                    // Через updateAppState (не сырой SQL), чтобы кэш app_state не устаревал
                    updateAppState({
                        lesta_last_battles: totalBattles,
                        lesta_last_frags: totalFrags,
                        lesta_previous_frags: totalFrags
                    }, (updErr) => {
                        if (updErr) {
                            console.error('❌ Ошибка обновления состояния Lesta Games:', updErr);
                            return res.status(500).json({ success: false, message: 'Ошибка обновления состояния' });
                        }

                        console.log('✅ Состояние Lesta Games синхронизировано с локальной статистикой');

                        res.json({
                            success: true,
                            message: 'Состояние Lesta Games синхронизировано с локальной статистикой',
                            stats: { totalBattles, totalFrags },
                            note: 'Теперь система будет отслеживать изменения от этих значений'
                        });
                    });
                });
            } catch (error) {
                console.error('❌ Ошибка синхронизации:', error);
                res.status(500).json({ success: false, message: 'Ошибка сервера' });
            }
        });

        app.get('/api/lesta-achievements', async (req, res) => {
            const { account_id, fields, language } = req.query;

            if (!account_id) {
                return res.status(400).json({
                    success: false,
                    error: 'ACCOUNT_ID_NOT_SPECIFIED',
                    message: 'Не заполнено обязательное поле account_id'
                });
            }

            if (!LESTA_CONFIG.applicationId) {
                return res.status(400).json({
                    success: false,
                    error: 'INVALID_APPLICATION_ID',
                    message: 'Application ID не настроен'
                });
            }

            try {
                console.log('🏆 Запрос достижений Lesta Games для игрока:', account_id);

                const params = {
                    application_id: LESTA_CONFIG.applicationId,
                    account_id: account_id,
                    fields: fields || 'achievements,max_series',
                    language: language || 'ru'
                };

                const response = await axios.get(`${LESTA_CONFIG.apiUrl}/account/achievements/`, {
                    params,
                    timeout: 10000
                });

                console.log('🏆 Ответ достижений Lesta Games:', response.data);

                if (response.data.status === 'ok') {
                    let payload = response.data.data;
                    const accKey = String(account_id);
                    if (payload && payload[accKey]) {
                        payload = payload[accKey];
                    }
                    res.json({ success: true, data: payload });
                } else {
                    res.status(404).json({
                        success: false,
                        error: response.data.error?.code || 'UNKNOWN_ERROR',
                        message: response.data.error?.message || 'Ошибка получения достижений'
                    });
                }
            } catch (error) {
                console.error('❌ Ошибка получения достижений Lesta Games:', error.response?.data || error.message);

                const errorCode = error.response?.data?.error?.code || 'SOURCE_NOT_AVAILABLE';
                const errorMessage = error.response?.data?.error?.message || 'Источник данных не доступен';

                res.status(500).json({
                    success: false,
                    error: errorCode,
                    message: errorMessage
                });
            }
        });

        // API для получения статистики по технике Lesta Games
        app.get('/api/lesta-tankstats', async (req, res) => {
            const { account_id, tank_id, fields, language } = req.query;

            if (!account_id) {
                return res.status(400).json({
                    success: false,
                    error: 'ACCOUNT_ID_NOT_SPECIFIED',
                    message: 'Не заполнено обязательное поле account_id'
                });
            }

            if (!LESTA_CONFIG.applicationId) {
                return res.status(400).json({
                    success: false,
                    error: 'INVALID_APPLICATION_ID',
                    message: 'Application ID не настроен'
                });
            }

            try {
                console.log('🚗 Запрос статистики по технике Lesta Games (tanks/stats):', { account_id, tank_id });

                const params = {
                    application_id: LESTA_CONFIG.applicationId,
                    account_id: account_id,
                    fields: fields || 'all,mark_of_mastery,battle_life_time,last_battle_time',
                    language: language || 'ru'
                };

                // Добавляем tank_id, если указан (для фильтрации по конкретному танку)
                if (tank_id) {
                    params.tank_id = tank_id;
                }

                // Добавляем access_token, если он есть
                if (LESTA_CONFIG.accessToken) {
                    params.access_token = LESTA_CONFIG.accessToken;
                }

                // Используем endpoint /tanks/stats/ согласно документации:
                // "Статистика по технике игрока" — account_id обязателен, tank_id выступает как опциональный фильтр
                const response = await axios.get(`${LESTA_CONFIG.apiUrl}/tanks/stats/`, {
                    params,
                    timeout: 10000,
                    validateStatus: function (status) {
                        return status < 500; // Не выбрасывать ошибку для статусов < 500
                    }
                });

                console.log('🚗 Ответ статистики по технике Lesta Games:', response.status, response.data?.status);

                // Проверяем, что ответ - это JSON, а не HTML
                if (typeof response.data === 'string' && response.data.startsWith('<!')) {
                    console.error('❌ API вернул HTML вместо JSON.');
                    return res.status(500).json({
                        success: false,
                        error: 'INVALID_RESPONSE',
                        message: 'Сервер вернул неверный формат данных.'
                    });
                }

                if (response.data.status === 'ok' && response.data.data) {
                    // Если указан tank_id, возвращаем данные по конкретному танку
                    let result = response.data.data[account_id];
                    if (tank_id && Array.isArray(result)) {
                        result = result.find(tank => tank.tank_id === parseInt(tank_id)) || result;
                    }
                    res.json({ success: true, data: result });
                } else {
                    res.status(404).json({
                        success: false,
                        error: response.data.error?.code || 'UNKNOWN_ERROR',
                        message: response.data.error?.message || 'Ошибка получения статистики по технике'
                    });
                }
            } catch (error) {
                console.error('❌ Ошибка получения статистики по технике Lesta Games:', error.message);

                // Проверяем, если это ошибка парсинга JSON (HTML ответ)
                if (error.response && typeof error.response.data === 'string' && error.response.data.startsWith('<!')) {
                    return res.status(500).json({
                        success: false,
                        error: 'INVALID_RESPONSE',
                        message: 'Сервер вернул HTML вместо JSON. Проверьте endpoint и параметры запроса.'
                    });
                }

                const errorCode = error.response?.data?.error?.code || error.response?.status === 404 ? 'NOT_FOUND' : 'SOURCE_NOT_AVAILABLE';
                const errorMessage = error.response?.data?.error?.message || 'Источник данных не доступен';

                res.status(error.response?.status || 500).json({
                    success: false,
                    error: errorCode,
                    message: errorMessage
                });
            }
        });

        // API для получения списка техники Lesta Games
        app.get('/api/lesta-vehicles', async (req, res) => {
            const { fields, language, nation, tank_id } = req.query;

            if (!LESTA_CONFIG.applicationId) {
                return res.status(400).json({
                    success: false,
                    error: 'INVALID_APPLICATION_ID',
                    message: 'Application ID не настроен'
                });
            }

            try {
                console.log('🚗 Запрос списка техники Lesta Games');

                const params = {
                    application_id: LESTA_CONFIG.applicationId,
                    fields: fields || 'tank_id,name,tier,type,nation,is_premium',
                    language: language || 'ru'
                };

                if (nation) params.nation = nation;
                if (tank_id) params.tank_id = tank_id;

                const response = await axios.get(`${LESTA_CONFIG.apiUrl}/encyclopedia/vehicles/`, {
                    params,
                    timeout: 10000
                });

                console.log('🚗 Ответ списка техники Lesta Games:', response.data);

                if (response.data.status === 'ok') {
                    res.json({ success: true, data: response.data.data });
                } else {
                    res.status(404).json({
                        success: false,
                        error: response.data.error?.code || 'UNKNOWN_ERROR',
                        message: response.data.error?.message || 'Ошибка получения списка техники'
                    });
                }
            } catch (error) {
                console.error('❌ Ошибка получения списка техники Lesta Games:', error.response?.data || error.message);

                const errorCode = error.response?.data?.error?.code || 'SOURCE_NOT_AVAILABLE';
                const errorMessage = error.response?.data?.error?.message || 'Источник данных не доступен';

                res.status(500).json({
                    success: false,
                    error: errorCode,
                    message: errorMessage
                });
            }
        });

        // API для получения статистики по всей технике игрока
        app.get('/api/lesta-player-tanks', async (req, res) => {
            const { account_id, language } = req.query;
            const searchQueryRaw = req.query.search || req.query.query || '';
            const searchQuery = typeof searchQueryRaw === 'string' ? searchQueryRaw.toLowerCase().trim() : '';

            const targetAccountId = String(account_id || LESTA_CONFIG.accountId || '');
            if (!targetAccountId) {
                return res.status(400).json({
                    success: false,
                    error: 'ACCOUNT_ID_NOT_SPECIFIED',
                    message: 'Account ID не указан'
                });
            }

            try {
                const result = await fetchAccountTanksForAccount(targetAccountId, language || 'ru');
                if (result.error === 'NO_ACCOUNT') {
                    return res.status(400).json({ success: false, error: 'INVALID_APPLICATION_ID', message: 'Application ID не настроен' });
                }
                if (result.error === 'STATS_HIDDEN') {
                    return res.json({
                        success: true,
                        data: [],
                        count: 0,
                        code: 'STATS_HIDDEN',
                        message: 'Lesta не отдаёт статистику по танкам для этого аккаунта. В настройках игры включите доступ к данным аккаунта или войдите через OAuth (/auth/lesta).'
                    });
                }
                if (result.error) {
                    return res.status(400).json({ success: false, error: result.error, message: result.message || 'Ошибка Lesta API' });
                }

                let tanks = result.tanks || [];
                if (searchQuery) {
                    tanks = tanks.filter((tank) => (tank.name || '').toLowerCase().includes(searchQuery));
                }
                tanks.sort((a, b) => (b.statistics?.all?.battles || 0) - (a.statistics?.all?.battles || 0));

                scheduleLestaTankSnapshot(targetAccountId);

                res.json({ success: true, data: tanks, count: tanks.length });
            } catch (error) {
                console.error('❌ lesta-player-tanks:', error.response?.data || error.message);
                res.status(error.response?.status || 500).json({
                    success: false,
                    error: error.response?.data?.error?.code || 'SOURCE_NOT_AVAILABLE',
                    message: error.response?.data?.error?.message || error.message || 'Ошибка загрузки техники'
                });
            }
        });

        app.get('/api/lesta-tank-period', async (req, res) => {
            const period = req.query.period || '7d';

            try {
                const state = await ensureLestaConfigFromState();
                const accountId = state?.lesta_account_id;
                if (!accountId) {
                    return res.json({ success: true, hasData: false, changes: [], message: 'Привяжите аккаунт Lesta' });
                }

                const tankResult = await fetchAccountTanksForAccount(accountId);
                if (tankResult.hidden || tankResult.error === 'STATS_HIDDEN') {
                    return res.json({
                        success: true,
                        hasData: false,
                        hidden: true,
                        changes: [],
                        message: 'Статистика по танкам скрыта в Lesta'
                    });
                }
                if (tankResult.error) {
                    return res.status(400).json({ success: false, error: tankResult.error, message: tankResult.message });
                }

                const currentMap = tanksToSnapshotMap(tankResult.tanks);
                const reliableSince = Number(state.lesta_reliable_since) || 0;

                fetchTankSnapshotBaseline(period, accountId, reliableSince, (err, baselineRow) => {
                    if (err) {
                        return res.status(500).json({ success: false, error: 'Ошибка чтения снимков техники' });
                    }

                    if (!baselineRow) {
                        insertLestaTankSnapshot(accountId, currentMap, () => {
                            res.json({
                                success: true,
                                hasData: false,
                                hasBaseline: false,
                                changes: [],
                                message: 'Базовый снимок сохранён. После боёв здесь появятся изменения по танкам.'
                            });
                        });
                        return;
                    }

                    const baselineMap = parseTankSnapshotMap(baselineRow);
                    let changes = computeTankPeriodChanges(currentMap, baselineMap);
                    let baselineAt = baselineRow.timestamp;

                    const finish = () => {
                        res.json({
                            success: true,
                            hasData: changes.length > 0,
                            hasBaseline: true,
                            baselineAt,
                            changes
                        });
                    };

                    if (changes.length > 0) return finish();

                    fetchNewestTankSnapshotInPeriod(period, accountId, reliableSince, (snapErr, newestRow) => {
                        if (snapErr || !newestRow || newestRow.id === baselineRow.id) return finish();
                        const newestMap = parseTankSnapshotMap(newestRow);
                        const snapChanges = computeTankPeriodChanges(newestMap, baselineMap);
                        if (snapChanges.length > 0) {
                            changes = snapChanges;
                            baselineAt = baselineRow.timestamp;
                        }
                        finish();
                    });
                });
            } catch (error) {
                console.error('❌ lesta-tank-period:', error.message);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // API для продления токена Lesta Games
        app.post('/api/lesta-prolongate', async (req, res) => {
            try {
                const prolonged = await prolongateLestaToken();
                if (prolonged) {
                    res.json({ success: true, message: 'Токен успешно продлен' });
                } else {
                    res.json({ success: false, error: 'Не удалось продлить токен' });
                }
            } catch (error) {
                console.error('❌ Ошибка продления токена:', error);
                res.json({ success: false, error: error.message });
            }
        });

        // API для тестирования получения статистики
        app.get('/api/lesta-test-stats', async (req, res) => {
            try {
                console.log('🧪 Тестовый запрос статистики Lesta Games...');
                console.log('🔍 Текущая конфигурация:', {
                    applicationId: LESTA_CONFIG.applicationId,
                    accountId: LESTA_CONFIG.accountId,
                    accessToken: LESTA_CONFIG.accessToken ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ'
                });

                const stats = await getLestaPlayerStats();
                if (stats) {
                    res.json({ success: true, stats: stats, message: 'Статистика получена успешно' });
                } else {
                    res.json({ success: false, error: 'Не удалось получить статистику', message: 'Проверьте логи сервера' });
                }
            } catch (error) {
                console.error('❌ Ошибка тестового запроса:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Тестовая инъекция статистики (только NODE_ENV=test или LESTA_TEST_INJECT=1):
        // прогоняет applyLestaStats — дельты, бои, автосписание — без реального Lesta API
        if (process.env.NODE_ENV === 'test' || process.env.LESTA_TEST_INJECT === '1') {
            app.post('/api/lesta-test-stats/inject', (req, res) => {
                const s = req.body || {};
                const num = (v) => Number(v) || 0;
                const battles = num(s.battles), wins = num(s.wins), losses = num(s.losses), frags = num(s.frags);
                const damage = num(s.damage_dealt), xp = num(s.xp);
                const stats = {
                    nickname: s.nickname || 'TEST',
                    battles, frags, wins, losses,
                    damage_dealt: damage,
                    damage_received: num(s.damage_received),
                    xp,
                    max_frags: num(s.max_frags), frags8p: num(s.frags8p),
                    hits: num(s.hits), shots: num(s.shots), spotted: num(s.spotted),
                    capture_points: 0, dropped_capture_points: 0,
                    survived_battles: num(s.survived_battles), win_and_survived: num(s.win_and_survived),
                    max_xp: num(s.max_xp),
                    winRate: battles > 0 ? (wins / battles * 100).toFixed(1) : 0,
                    fragsPerBattle: battles > 0 ? (frags / battles).toFixed(2) : 0,
                    avgDamage: battles > 0 ? (damage / battles).toFixed(0) : 0,
                    avgXp: battles > 0 ? (xp / battles).toFixed(0) : 0,
                    accuracy: 0
                };
                applyLestaStats(stats);
                res.json({ success: true, injected: { battles, frags } });
            });
        }

        app.post('/api/lesta-sync', async (req, res) => {
            try {
                const stats = await getLestaPlayerStats();
                if (stats) {
                    // Обновляем время последней синхронизации
                    updateAppState({
                        lesta_last_sync_time: Math.floor(Date.now() / 1000)
                    }, (err) => {
                        if (err) {
                            console.error('❌ Ошибка обновления времени синхронизации:', err);
                        } else {
                            console.log('✅ Время последней синхронизации обновлено');
                        }
                    });

                    // Логируем событие ручной синхронизации
                    analytics.logEvent('lesta_manual_sync', {
                        battles: stats.battles,
                        frags: stats.frags,
                        winRate: stats.winRate,
                        fragsPerBattle: stats.fragsPerBattle
                    });

                    // Отправляем обновление состояния через WebSocket
                    broadcastStateUpdate();

                    res.json({ success: true, stats, message: 'Синхронизация выполнена' });
                } else {
                    res.status(404).json({ success: false, error: 'Не удалось получить статистику' });
                }
            } catch (error) {
                console.error('❌ Ошибка ручной синхронизации Lesta Games:', error);
                res.status(500).json({ success: false, error: 'Ошибка синхронизации' });
            }
        });

        // API для статистики за период (как на BlitzStats — дельта счётчиков)
        app.get('/api/lesta-period', (req, res) => {
            const period = req.query.period || '1d';
            const includeDaily = req.query.daily !== '0';

            getAppState((state) => {
                const current = getLestaCountersFromState(state);
                if (!current || !state.lesta_account_id) {
                    return res.json({
                        success: true,
                        hasData: false,
                        period,
                        message: 'Привяжите аккаунт Lesta для отслеживания периодов'
                    });
                }

                const reliableSince = Number(state.lesta_reliable_since) || 0;

                fetchLestaHistoryWindow(period, current.battles, reliableSince, (err, windowData) => {
                    if (err) {
                        return res.status(500).json({ success: false, error: 'Ошибка чтения истории' });
                    }

                    const baselineRow = windowData.anchorRow || (windowData.rows.length ? windowData.rows[0] : null);
                    const baseline = baselineRow ? {
                        battles: baselineRow.battles,
                        frags: baselineRow.frags,
                        wins: baselineRow.wins,
                        losses: baselineRow.losses,
                        damage_dealt: baselineRow.damage_dealt,
                        xp: baselineRow.xp,
                        at: baselineRow.timestamp
                    } : null;

                    const periodStats = computeLestaPeriodStatsFromRows(windowData.rows, current.battles);

                    const finish = (daily) => {
                        res.json({
                            success: true,
                            hasData: periodStats.battlesPlayed > 0,
                            period,
                            baselineAt: baseline ? baseline.at : null,
                            trackingSince: reliableSince > 0
                                ? new Date(reliableSince * 1000).toISOString()
                                : (baselineRow ? baselineRow.timestamp : null),
                            reliableSince: reliableSince > 0 ? reliableSince : null,
                            current,
                            baseline,
                            periodStats,
                            daily: daily || []
                        });
                    };

                    if (!includeDaily) return finish([]);
                    buildLestaDailyActivity(period === '1d' ? 7 : 14, current.battles, reliableSince, (dailyErr, daily) => {
                        if (dailyErr) return finish([]);
                        finish(daily);
                    });
                });
            });
        });

        // API сессии — от ручного «Начать сессию» или за сегодня
        app.get('/api/lesta-session', (req, res) => {
            getAppState((state) => {
                const current = getLestaCountersFromState(state);
                if (!current) {
                    return res.json({ success: false, error: 'Нет данных Lesta' });
                }

                const hasManualSession = Number(state.lesta_session_started_at) > 0;
                const baseline = hasManualSession ? {
                    battles: Number(state.lesta_session_baseline_battles) || 0,
                    wins: Number(state.lesta_session_baseline_wins) || 0,
                    losses: Number(state.lesta_session_baseline_losses) || 0,
                    frags: Number(state.lesta_session_baseline_frags) || 0,
                    damage_dealt: Number(state.lesta_session_baseline_damage) || 0,
                    xp: Number(state.lesta_session_baseline_xp) || 0,
                    startedAt: state.lesta_session_started_at
                } : null;

                if (hasManualSession && baseline) {
                    return res.json({
                        success: true,
                        mode: 'manual',
                        startedAt: baseline.startedAt,
                        session: computeLestaPeriodDelta(baseline, current)
                    });
                }

                const reliableSince = Number(state.lesta_reliable_since) || 0;

                fetchLestaHistoryWindow('1d', current.battles, reliableSince, (err, windowData) => {
                    if (err || !windowData.rows.length) {
                        return res.json({
                            success: true,
                            mode: 'today',
                            hasData: false,
                            session: null
                        });
                    }
                    const session = computeLestaPeriodStatsFromRows(windowData.rows, current.battles);
                    const baselineRow = windowData.anchorRow;
                    res.json({
                        success: true,
                        mode: 'today',
                        hasData: session.battlesPlayed > 0,
                        baselineAt: baselineRow ? baselineRow.timestamp : null,
                        session
                    });
                });
            });
        });

        // Танки, на которых были бои за текущую сессию (ручную или авто за сутки):
        // текущие показатели с Lesta API против ближайшего танко-снапшота к началу сессии
        app.get('/api/lesta-session-tanks', async (req, res) => {
            try {
                const state = await ensureLestaConfigFromState();
                const accountId = state?.lesta_account_id;
                if (!accountId) {
                    return res.json({ success: true, hasData: false, changes: [], message: 'Привяжите аккаунт Lesta' });
                }

                const tankResult = await fetchAccountTanksForAccount(accountId);
                if (tankResult.hidden || tankResult.error === 'STATS_HIDDEN') {
                    return res.json({
                        success: true, hasData: false, hidden: true, changes: [],
                        message: 'Статистика по танкам скрыта в Lesta'
                    });
                }
                if (tankResult.error) {
                    return res.status(400).json({ success: false, error: tankResult.error, message: tankResult.message });
                }

                const currentMap = tanksToSnapshotMap(tankResult.tanks);
                const startedAt = Number(state.lesta_session_started_at) || 0;

                const respond = (baselineRow, mode) => {
                    if (!baselineRow) {
                        insertLestaTankSnapshot(accountId, currentMap, () => {
                            res.json({
                                success: true, mode, hasData: false, hasBaseline: false, changes: [],
                                message: 'Базовый снимок техники сохранён — после боёв здесь появятся танки сессии.'
                            });
                        });
                        return;
                    }
                    const changes = computeTankPeriodChanges(currentMap, parseTankSnapshotMap(baselineRow));
                    res.json({
                        success: true, mode, hasData: changes.length > 0, hasBaseline: true,
                        baselineAt: baselineRow.timestamp, changes
                    });
                };

                if (startedAt > 0) {
                    dbRead.get(
                        `SELECT * FROM lesta_tank_snapshots
                         WHERE account_id = ? AND timestamp <= datetime(?, 'unixepoch')
                         ORDER BY timestamp DESC LIMIT 1`,
                        [String(accountId), startedAt],
                        (err, row) => {
                            if (err) return res.status(500).json({ success: false, error: 'Ошибка чтения снимков техники' });
                            if (row) return respond(row, 'manual');
                            dbRead.get(
                                `SELECT * FROM lesta_tank_snapshots
                                 WHERE account_id = ? AND timestamp >= datetime(?, 'unixepoch')
                                 ORDER BY timestamp ASC LIMIT 1`,
                                [String(accountId), startedAt],
                                (err2, row2) => {
                                    if (err2) return res.status(500).json({ success: false, error: 'Ошибка чтения снимков техники' });
                                    respond(row2, 'manual');
                                }
                            );
                        }
                    );
                } else {
                    const reliableSince = Number(state.lesta_reliable_since) || 0;
                    fetchTankSnapshotBaseline('1d', accountId, reliableSince, (err, row) => {
                        if (err) return res.status(500).json({ success: false, error: 'Ошибка чтения снимков техники' });
                        respond(row, 'today');
                    });
                }
            } catch (error) {
                console.error('❌ lesta-session-tanks:', error.message);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        app.post('/api/lesta-session/start', (req, res) => {
            startLestaSession((err, data) => {
                if (err) return res.status(err.status).json({ success: false, error: err.error });
                res.json({ success: true, startedAt: data.startedAt });
            });
        });

        app.post('/api/lesta-session/reset', (req, res) => {
            resetLestaSession((err) => {
                if (err) return res.status(err.status).json({ success: false, error: err.error });
                res.json({ success: true });
            });
        });

        // Трекер золота за сессию (открытие контейнеров). Lesta API отдаёт только
        // снимок текущего баланса, без истории транзакций — спенд и приход в
        // рамках одного открытия контейнера списываются/зачисляются атомарно на
        // стороне Lesta, поэтому раздельно их увидеть нельзя. Показываем честный
        // чистый итог: баланс сейчас минус баланс на момент старта.
        app.post('/api/gold-tracker/start', (req, res) => {
            getAppState((state) => {
                if (!state || !state.lesta_account_id) {
                    return res.status(400).json({ success: false, error: 'Сначала привяжите аккаунт Lesta' });
                }
                // Повторный старт при уже активной сессии не должен переставлять baseline —
                // иначе случайный повторный клик/запрос обнуляет весь накопленный net.
                if (state.gold_tracker_active) {
                    return res.json({
                        success: true,
                        startedAt: state.gold_tracker_started_at || 0,
                        baselineGold: state.gold_tracker_baseline_gold || 0
                    });
                }
                const nowSec = Math.floor(Date.now() / 1000);
                const currentGold = state.lesta_last_gold || 0;
                updateAppState({
                    gold_tracker_active: 1,
                    gold_tracker_started_at: nowSec,
                    gold_tracker_baseline_gold: currentGold
                }, (err) => {
                    if (err) return res.status(500).json({ success: false, error: err.message });
                    res.json({ success: true, startedAt: nowSec, baselineGold: currentGold });
                });
            });
        });

        app.post('/api/gold-tracker/stop', (req, res) => {
            updateAppState({ gold_tracker_active: 0 }, (err) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json({ success: true });
            });
        });

        app.get('/api/gold-tracker/status', (req, res) => {
            getAppState((state) => {
                if (!state) return res.status(500).json({ success: false, error: 'Не удалось получить состояние' });
                const currentGold = state.lesta_last_gold || 0;
                const baselineGold = state.gold_tracker_baseline_gold || 0;
                res.json({
                    success: true,
                    active: !!state.gold_tracker_active,
                    startedAt: state.gold_tracker_started_at || 0,
                    baselineGold,
                    currentGold,
                    net: currentGold - baselineGold
                });
            });
        });

        // API для получения истории изменений статистики Lesta Games
        app.get('/api/lesta-history', (req, res) => {
            const { period = '1d' } = req.query;

            let dateFilter = '';
            let params = [];

            switch (period) {
                case '1d':
                    dateFilter = 'WHERE timestamp >= datetime("now", "-1 day")';
                    break;
                case '7d':
                    dateFilter = 'WHERE timestamp >= datetime("now", "-7 days")';
                    break;
                case '30d':
                    dateFilter = 'WHERE timestamp >= datetime("now", "-30 days")';
                    break;
                case '180d':
                    dateFilter = 'WHERE timestamp >= datetime("now", "-180 days")';
                    break;
                case '365d':
                    dateFilter = 'WHERE timestamp >= datetime("now", "-365 days")';
                    break;
                default:
                    dateFilter = 'WHERE timestamp >= datetime("now", "-1 day")';
            }

            const query = `
                SELECT
                    id,
                    timestamp AS created_at,
                    battles,
                    frags,
                    wins,
                    losses,
                    damage_dealt,
                    xp,
                    win_rate,
                    frags_per_battle,
                    avg_damage,
                    avg_xp,
                    frags_difference,
                    auto_deducted
                FROM lesta_stats_history
                ${dateFilter}
                ORDER BY timestamp DESC
                LIMIT 1000
            `;

            dbRead.all(query, params, (err, rows) => {
                if (err) {
                    console.error('❌ Ошибка получения истории Lesta Games:', err);
                    res.status(500).json({ success: false, error: 'Ошибка получения истории' });
                } else {
                    const list = rows || [];
                    getAppState((state) => {
                        const refBattles = Number(state?.lesta_last_battles) || 0;
                        const reliableSince = Number(state?.lesta_reliable_since) || 0;
                        fetchLestaHistoryWindow(period, refBattles, reliableSince, (winErr, windowData) => {
                            const periodDelta = !winErr && windowData
                                ? computeLestaPeriodStatsFromRows(windowData.rows, refBattles)
                                : { battlesPlayed: 0, frags: 0, wins: 0 };
                            const daysForDaily = period === '30d' ? 30 : period === '7d' ? 7 : 14;
                            buildLestaDailyActivity(daysForDaily, refBattles, reliableSince, (dailyErr, daily) => {
                                const stats = {
                                    total_records: list.length,
                                    total_frags_gained: list.reduce((sum, row) => sum + (row.frags_difference || 0), 0),
                                    total_frags_deducted: list.reduce((sum, row) => sum + (row.auto_deducted || 0), 0),
                                    total_battles_played: periodDelta.battlesPlayed,
                                    avg_frags_per_update: list.length > 0 ? (list.reduce((sum, row) => sum + (row.frags_difference || 0), 0) / list.length).toFixed(2) : 0,
                                    period: period
                                };

                                res.json({
                                    success: true,
                                    history: list,
                                    stats: stats,
                                    daily: dailyErr ? [] : (daily || [])
                                });
                            });
                        });
                    });
                }
            });
        });
    }

    return { registerRoutes, startLestaSession, resetLestaSession };
}

module.exports = { createLestaRoutesModule };
