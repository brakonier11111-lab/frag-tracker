'use strict';

const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Диагностические и тестовые роуты (вынесено из server.js 1:1): статусы
 * DA/DP/БД/Centrifugo, тест-прогоны API DonationAlerts/DonatePay, диагностика
 * опроса донатов и логики боёв/фрагов. Всё read-only или самодостаточные
 * тест-запросы — пайплайн processDonation отсюда не вызывается.
 *
 * DA_CONFIG/DP_CONFIG — по ссылке (как в donation-platforms): server.js
 * продолжает мутировать те же объекты (OAuth, admin config).
 * getPollingState() — снапшот module-scoped переменных цикла опроса,
 * которые остались в server.js.
 *
 * deps: { db, daConfig, dpConfig, getAppState, updateAppState,
 *   getDonationsFromAPI, getDonatePayUser, getLestaPlayerStats,
 *   isCentrifugoConnected, getCentrifugoState, getPollingState }
 */
function createDiagnosticsModule(deps) {
    const DA_CONFIG = deps.daConfig;
    const DP_CONFIG = deps.dpConfig;
    const {
        db, getAppState, updateAppState,
        getDonationsFromAPI, getDonatePayUser, getLestaPlayerStats,
        isCentrifugoConnected, getCentrifugoState, getPollingState
    } = deps;

    function registerRoutes(app) {
        app.get('/api/status', (req, res) => {
            res.json({ 
                status: 'ok', 
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            });
        });

        // Статус подключений для админки (читает реальное состояние из БД)
        app.get('/api/admin/status', (req, res) => {
            db.get('SELECT da_access_token, dp_api_key, lesta_access_token FROM app_state WHERE id = 1', (err, row) => {
                if (err) {
                    return res.status(500).json({ success: false, error: err.message });
                }
                row = row || {};
                res.json({
                    success: true,
                    da:    !!row.da_access_token,
                    dp:    !!row.dp_api_key,
                    lesta: !!row.lesta_access_token
                });
            });
        });

        // API для проверки статуса Centrifugo DonatePay
        app.get('/api/dp-centrifugo-status', (req, res) => {
            const status = {
                apiKey: !!DP_CONFIG.apiKey,
                userId: DP_CONFIG.userId || null,
                centrifugoConnected: isCentrifugoConnected(),
                centrifugoState: isCentrifugoConnected() ? (getCentrifugoState() || 'unknown') : 'not_initialized',
                lastError: DP_CONFIG.lastError,
                lastTransactionId: DP_CONFIG.lastTransactionId,
                channel: DP_CONFIG.userId ? `$public:${DP_CONFIG.userId}` : null
            };
            res.json({ success: true, status });
        });

        app.get('/api/da-status', (req, res) => {
            res.json({ 
                hasToken: !!DA_CONFIG.accessToken,
                clientId: DA_CONFIG.clientId,
                hasClientSecret: !!DA_CONFIG.clientSecret
            });
        });

        app.get('/api/db-status', (req, res) => {
            db.get('SELECT COUNT(*) as count FROM donations', (err, row) => {
                if (err) {
                    res.json({ connected: false, error: err.message });
                } else {
                    res.json({ connected: true, donationsCount: row.count });
                }
            });
        });

        app.get('/api/da-oauth-test', (req, res) => {
            if (!DA_CONFIG.clientId || !DA_CONFIG.clientSecret) {
                return res.json({ 
                    success: false, 
                    error: 'Client ID или Client Secret не настроены' 
                });
            }

            const authUrl = `https://www.donationalerts.com/oauth/authorize?client_id=${DA_CONFIG.clientId}&redirect_uri=${encodeURIComponent(DA_CONFIG.redirectUri)}&response_type=code&scope=oauth-donation-index`;

            res.json({ 
                success: true,
                clientId: DA_CONFIG.clientId,
                clientSecret: DA_CONFIG.clientSecret,
                redirectUri: DA_CONFIG.redirectUri,
                authUrl: authUrl
            });
        });

        app.get('/api/da-api-test', async (req, res) => {
            if (!DA_CONFIG.accessToken) {
                return res.json({ 
                    success: false, 
                    error: 'Access token не настроен. Выполните OAuth авторизацию.' 
                });
            }

            try {
                const donations = await getDonationsFromAPI();
                res.json({ 
                    success: true,
                    donationsCount: donations.length,
                    donations: donations.slice(0, 5) // Первые 5 донатов
                });
            } catch (error) {
                res.json({ 
                    success: false, 
                    error: error.message 
                });
            }
        });

        app.post('/api/test-widget-da', async (req, res) => {
            const { token } = req.body;

            if (!token) {
                return res.json({ success: false, error: 'Токен не предоставлен' });
            }

            try {
                const widgetUrl = `https://www.donationalerts.com/widget/lastdonations?alert_type=1,20,27,28,29,30,31,32&limit=10&token=${token}`;

                const response = await axios.get(widgetUrl, {
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });

                res.json({ 
                    success: true,
                    size: response.data.length,
                    content: response.data,
                    status: response.status
                });
            } catch (error) {
                res.json({ 
                    success: false, 
                    error: error.message 
                });
            }
        });

        // Диагностика донатов
        app.get('/api/debug-donations', async (req, res) => {
            const debugInfo = {
                timestamp: new Date().toISOString(),
                daConfig: {
                    hasToken: !!DA_CONFIG.accessToken,
                    clientId: DA_CONFIG.clientId,
                    hasClientSecret: !!DA_CONFIG.clientSecret
                },
                polling: getPollingState()
            };

            // Проверяем БД
            db.get('SELECT da_access_token FROM app_state WHERE id = 1', (err, row) => {
                if (err) {
                    debugInfo.dbError = err.message;
                } else {
                    debugInfo.dbToken = row ? (row.da_access_token ? 'ЕСТЬ' : 'НЕТ') : 'НЕТ ЗАПИСИ';
                }

                // Проверяем донаты в БД
                db.all('SELECT COUNT(*) as count FROM donations', (err, countRow) => {
                    if (err) {
                        debugInfo.dbCountError = err.message;
                    } else {
                        debugInfo.donationsCount = countRow[0].count;
                    }

                    // Получаем последние донаты
                    db.all('SELECT * FROM donations ORDER BY created_at DESC LIMIT 5', (err, donations) => {
                        if (err) {
                            debugInfo.lastDonationsError = err.message;
                        } else {
                            debugInfo.lastDonations = donations;
                        }

                        // Тестируем API
                        if (DA_CONFIG.accessToken) {
                            getDonationsFromAPI().then(apiDonations => {
                                debugInfo.apiTest = {
                                    success: true,
                                    count: apiDonations.length,
                                    donations: apiDonations.slice(0, 3)
                                };
                                res.json(debugInfo);
                            }).catch(apiError => {
                                debugInfo.apiTest = {
                                    success: false,
                                    error: apiError.message
                                };
                                res.json(debugInfo);
                            });
                        } else {
                            debugInfo.apiTest = {
                                success: false,
                                error: 'Нет access token'
                            };
                            res.json(debugInfo);
                        }
                    });
                });
            });
        });

        app.get('/api/diagnose-polling', async (req, res) => {
            try {
                console.log('🔍 Диагностика опроса донатов...');

                const diagnosis = {
                    timestamp: new Date().toISOString(),
                    daConfig: {
                        hasToken: !!DA_CONFIG.accessToken,
                        tokenPreview: DA_CONFIG.accessToken ? DA_CONFIG.accessToken.substring(0, 20) + '...' : 'НЕТ',
                        clientId: DA_CONFIG.clientId,
                        hasClientSecret: !!DA_CONFIG.clientSecret,
                        apiUrl: DA_CONFIG.apiUrl
                    },
                    polling: getPollingState(),
                    testResults: {}
                };

                // Тест получения донатов
                if (DA_CONFIG.accessToken) {
                    try {
                        const donations = await getDonationsFromAPI();
                        diagnosis.testResults.donationsApi = {
                            success: true,
                            count: donations.length,
                            sample: donations[0] || null
                        };
                    } catch (error) {
                        diagnosis.testResults.donationsApi = {
                            success: false,
                            error: error.message
                        };
                    }
                } else {
                    diagnosis.testResults.donationsApi = {
                        success: false,
                        error: 'Нет токена доступа'
                    };
                }

                res.json(diagnosis);
            } catch (error) {
                console.error('❌ Ошибка диагностики опроса:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        app.post('/api/test-last-events', async (req, res) => {
            try {
                const { lastEventsUrl } = req.body;

                if (!lastEventsUrl) {
                    return res.json({ success: false, error: 'URL last-events не указан' });
                }

                console.log('🧪 Тестовый запрос last-events:', lastEventsUrl);

                const response = await axios.get(lastEventsUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    },
                    timeout: 10000
                });

                const events = response.data || [];
                const donations = events.filter(event => event.type === 'donation' && event.status === 'success');

                res.json({
                    success: true,
                    eventsCount: events.length,
                    donationsCount: donations.length,
                    events: events.slice(0, 10) // Первые 10 событий
                });

            } catch (error) {
                console.error('❌ Ошибка тестирования last-events:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // API для тестирования виджета
        app.post('/api/test-widget', async (req, res) => {
            try {
                const { widgetUrl } = req.body;

                if (!widgetUrl) {
                    return res.json({ success: false, error: 'URL виджета не указан' });
                }

                console.log('🧪 Тестовый запрос виджета:', widgetUrl);

                const response = await axios.get(widgetUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    },
                    timeout: 10000
                });

                const $ = cheerio.load(response.data);
                const elements = $('.donation, .alert, .notification, .donate-item, *').length;
                const text = $.text().trim();

                res.json({
                    success: true,
                    htmlLength: response.data.length,
                    elementsCount: elements,
                    text: text.substring(0, 1000) // Первые 1000 символов
                });

            } catch (error) {
                console.error('❌ Ошибка тестирования виджета:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // API для тестирования DonatePay
        app.get('/api/donatepay-test', async (req, res) => {
            try {
                console.log('🧪 Тестовый запрос DonatePay...');
                console.log('🔍 Текущая конфигурация:', {
                    apiKey: DP_CONFIG.apiKey ? `${DP_CONFIG.apiKey.substring(0, 10)}...` : 'ОТСУТСТВУЕТ',
                    apiKeyFromEnv: process.env.DP_API_KEY ? `${process.env.DP_API_KEY.substring(0, 10)}...` : 'ОТСУТСТВУЕТ В ENV',
                    userId: DP_CONFIG.userId || 'НЕ ПОЛУЧЕН',
                    lastTransactionId: DP_CONFIG.lastTransactionId || 0,
                    lastError: DP_CONFIG.lastError ? {
                        status: DP_CONFIG.lastError.status,
                        message: DP_CONFIG.lastError.message,
                        timestamp: DP_CONFIG.lastError.timestamp ? new Date(DP_CONFIG.lastError.timestamp).toISOString() : 'НЕТ'
                    } : 'НЕТ'
                });

                if (!DP_CONFIG.apiKey) {
                    // Проверяем, есть ли ключ в env, но не загружен в конфиг
                    if (process.env.DP_API_KEY) {
                        console.log('⚠️ API ключ есть в config.env, но не загружен в DP_CONFIG. Загружаем...');
                        DP_CONFIG.apiKey = process.env.DP_API_KEY;
                    } else {
                        return res.json({ 
                            success: false, 
                            error: 'API ключ не настроен',
                            details: 'Настройте API ключ DonatePay в разделе интеграций или в config.env',
                            hasEnvKey: !!process.env.DP_API_KEY,
                            hasConfigKey: !!DP_CONFIG.apiKey
                        });
                    }
                }

                // Проверяем, не было ли недавно ошибки 429
                const lastError = DP_CONFIG.lastError;
                if (lastError && lastError.status === 429) {
                    const timeSinceError = Date.now() - (lastError.timestamp || 0);
                    const timeoutMs = 300000; // 5 минут (как в остальных местах)
                    const timeRemaining = Math.max(0, timeoutMs - timeSinceError);
                    const minutesRemaining = Math.ceil(timeRemaining / 60000);
                    const secondsRemaining = Math.ceil(timeRemaining / 1000);

                    if (timeRemaining > 0) {
                        console.log(`⏰ Слишком рано для повторного запроса. Осталось: ${secondsRemaining} секунд`);
                        return res.json({ 
                            success: false, 
                            error: 'Превышен лимит запросов к DonatePay API',
                            details: `Подождите еще ${minutesRemaining > 0 ? minutesRemaining + ' ' + (minutesRemaining === 1 ? 'минуту' : minutesRemaining < 5 ? 'минуты' : 'минут (рекомендуется 5 минут)') : Math.ceil(secondsRemaining / 60) + ' минут'} перед повторной попыткой`,
                            retryAfter: secondsRemaining,
                            lastErrorTime: lastError.timestamp ? new Date(lastError.timestamp).toISOString() : null,
                            canReset: true // Позволяем сбросить ошибку вручную
                        });
                    } else {
                        console.log('✅ Прошло достаточно времени с последней ошибки 429, можно попробовать снова');
                        DP_CONFIG.lastError = null; // Сбрасываем ошибку
                        // Очищаем время ошибки в БД
                        getAppState((state) => {
                            if (state) {
                                updateAppState({
                                    dp_last_429_error_ts: null
                                }, (err) => {
                                    if (err) console.error('❌ Ошибка очистки времени ошибки 429:', err);
                                });
                            }
                        });
                    }
                }

                // Добавляем задержку перед запросом (увеличена для безопасности)
                console.log('⏳ Ожидание 3 секунды перед запросом к DonatePay API...');
                await new Promise(resolve => setTimeout(resolve, 3000));

                // Тестируем получение информации о пользователе
                const userInfo = await getDonatePayUser();
                if (!userInfo) {
                    const errorDetails = DP_CONFIG.lastError || {};
                    let errorMessage = 'Не удалось получить информацию о пользователе';
                    let details = 'Проверьте логи сервера для подробностей';

                    if (errorDetails.status === 429) {
                        errorMessage = 'Превышен лимит запросов к DonatePay API';
                        details = 'Подождите 1-2 минуты и попробуйте снова';
                    } else if (errorDetails.status === 401) {
                        errorMessage = 'Неверный API ключ';
                        details = 'Проверьте правильность API ключа в настройках DonatePay';
                    } else if (errorDetails.status) {
                        errorMessage = `Ошибка API: ${errorDetails.status}`;
                        details = errorDetails.message || 'Неизвестная ошибка';
                    }

                    return res.json({ 
                        success: false, 
                        error: errorMessage,
                        details: details,
                        lastError: errorDetails.status ? {
                            status: errorDetails.status,
                            message: errorDetails.message
                        } : null
                    });
                }

                // ВАЖНО: Все API запросы для получения донатов ОТКЛЮЧЕНЫ
                // Используем ТОЛЬКО Centrifugo для real-time донатов
                // Это предотвращает ошибки 429 и обеспечивает стабильную работу
                console.log('📌 Все API запросы для получения донатов отключены');
                console.log('📌 Используется ТОЛЬКО Centrifugo для real-time донатов');

                const newTransactionsDonations = [];
                const newTransactionsError = null;
                const widgetDonations = [];
                const lastEventsDonations = [];

                // Проверяем статус Centrifugo
                let centrifugoStatus = 'not_connected';
                let centrifugoConnected = false;
                if (isCentrifugoConnected()) {
                    try {
                        const state = getCentrifugoState();
                        centrifugoStatus = state || 'unknown';
                        centrifugoConnected = (state === 'connected');
                    } catch (e) {
                        centrifugoStatus = 'error_checking';
                    }
                }

                res.json({ 
                    success: true, 
                    message: 'DonatePay API работает корректно',
                    userInfo: {
                        id: userInfo.id,
                        name: userInfo.name
                    },
                    note: 'Используется ТОЛЬКО Centrifugo для real-time донатов. Все API запросы отключены для избежания ошибок 429.',
                    pollingDisabled: true,
                    apiRequestsDisabled: true,
                    centrifugoStatus: centrifugoStatus,
                    centrifugoConnected: centrifugoConnected,
                    newTransactionsCount: 0,
                    newTransactionsError: 'API запросы отключены',
                    lastTransactionId: DP_CONFIG.lastTransactionId || 0,
                    widgetDonationsCount: 0,
                    lastEventsCount: 0,
                    widgetUrl: DP_CONFIG.widgetUrl || 'Не настроен',
                    message: 'Донаты получаются ТОЛЬКО через Centrifugo WebSocket в реальном времени'
                });
            } catch (error) {
                console.error('❌ Ошибка тестирования DonatePay:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // API для сброса ошибки 429 DonatePay
        app.post('/api/donatepay-reset-429', async (req, res) => {
            try {
                console.log('🔄 Сброс ошибки 429 DonatePay...');

                // Сбрасываем ошибку в памяти
                DP_CONFIG.lastError = null;
                DP_CONFIG._429ErrorCount = 0; // Сбрасываем счетчик ошибок
                DP_CONFIG._last429ErrorTimestamp = null; // Сбрасываем timestamp последней ошибки
                DP_CONFIG.lastUserInfoRequest = null; // Сбрасываем время последней попытки

                // Очищаем время ошибки в БД
                getAppState((state) => {
                    if (state) {
                        updateAppState({
                            dp_last_429_error_ts: null
                        }, (err) => {
                            if (err) {
                                console.error('❌ Ошибка очистки времени ошибки 429:', err);
                                return res.status(500).json({ 
                                    success: false, 
                                    error: 'Ошибка очистки времени ошибки 429: ' + err.message 
                                });
                            } else {
                                console.log('✅ Ошибка 429 сброшена (включая счетчик ошибок)');
                                res.json({ 
                                    success: true, 
                                    message: 'Ошибка 429 успешно сброшена. Теперь можно протестировать DonatePay API.' 
                                });
                            }
                        });
                    } else {
                        res.status(500).json({ success: false, error: 'Не удалось получить состояние приложения' });
                    }
                });
            } catch (error) {
                console.error('❌ Ошибка сброса ошибки 429:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        app.get('/api/battle-frag-logic-test', async (req, res) => {
            try {
                console.log('🧪 Тестирование логики подсчета боев и фрагов');

                // Получаем текущее состояние
                db.get('SELECT lesta_last_battles, lesta_last_frags, lesta_previous_frags FROM app_state WHERE id = 1', (err, state) => {
                    if (err) {
                        console.error('❌ Ошибка получения состояния:', err);
                        return res.status(500).json({ success: false, message: 'Ошибка базы данных' });
                    }

                    if (!state) {
                        return res.json({ success: false, message: 'Нет состояния для тестирования' });
                    }

                    // Получаем свежую статистику от Lesta API
                    getLestaPlayerStats().then(stats => {
                        if (!stats) {
                            return res.json({ success: false, message: 'Не удалось получить статистику Lesta Games' });
                        }

                        const currentBattles = stats.battles;
                        const currentFrags = stats.frags;
                        const previousBattles = state.lesta_last_battles || 0;
                        const previousFrags = state.lesta_last_frags || 0;
                        const battlesDifference = currentBattles - previousBattles;
                        const fragsDifference = currentFrags - previousFrags;

                        const result = {
                            success: true,
                            current: {
                                battles: currentBattles,
                                frags: currentFrags
                            },
                            previous: {
                                battles: previousBattles,
                                frags: previousFrags
                            },
                            differences: {
                                battles: battlesDifference,
                                frags: fragsDifference
                            },
                            logic: {
                                newBattles: battlesDifference > 0,
                                newFrags: fragsDifference > 0,
                                battlesToRecord: battlesDifference,
                                fragsToDistribute: fragsDifference
                            },
                            recommendation: ''
                        };

                        // Генерируем рекомендацию
                        if (battlesDifference > 0) {
                            if (fragsDifference > 0) {
                                result.recommendation = `Записать ${battlesDifference} боев: первый бой с ${fragsDifference} фрагами, остальные ${battlesDifference - 1} боев с 0 фрагами`;
                            } else {
                                result.recommendation = `Записать ${battlesDifference} боев с 0 фрагами каждый`;
                            }
                        } else if (fragsDifference > 0) {
                            result.recommendation = `Записать фраг от доната: ${fragsDifference} фрагов`;
                        } else {
                            result.recommendation = 'Изменений нет, ничего записывать не нужно';
                        }

                        res.json(result);
                    }).catch(error => {
                        console.error('❌ Ошибка получения статистики Lesta:', error);
                        res.status(500).json({ success: false, message: 'Ошибка получения статистики Lesta Games' });
                    });
                });
            } catch (error) {
                console.error('❌ Ошибка тестирования логики:', error);
                res.status(500).json({ success: false, message: 'Ошибка сервера' });
            }
        });
    }

    return { registerRoutes };
}

module.exports = { createDiagnosticsModule };
