'use strict';

const axios = require('axios');
const { Centrifuge } = require('centrifuge');

/**
 * HTTP/WebSocket-интеграции с DonationAlerts и DonatePay: получение донатов
 * опросом (DA REST, DP /newTransactions) и realtime через Centrifugo.
 * Вынос из server.js с телами 1:1 — вся логика решений (что считать новым
 * донатом, дедуп) остаётся снаружи в checkForNewDonations/classifyDonationForPolling,
 * здесь только сетевой слой.
 *
 * DA_CONFIG/DP_CONFIG передаются ПО ССЫЛКЕ (как LESTA_CONFIG) — сервер и модуль
 * мутируют один и тот же объект (OAuth callback, admin config и т.д. остаются
 * в server.js и продолжают писать в тот же объект).
 *
 * deps: { daConfig, dpConfig, getAppState, updateAppState, db, processDonation, pollLog }
 */
function createDonationPlatformsModule(deps) {
    const DA_CONFIG = deps.daConfig;
    const DP_CONFIG = deps.dpConfig;
    const { getAppState, updateAppState, db, processDonation, pollLog } = deps;

    let centrifuge = null;

    async function getDonationsFromAPI() {
        if (!DA_CONFIG.accessToken) {
            console.log('⚠️ Токен DonationAlerts не настроен');
            return [];
        }

        try {
            pollLog('DonationAlerts: запрос донатов...');

            // Запрашиваем только последние 5 донатов для уменьшения нагрузки
            // Старые донаты будут отфильтрованы по времени при обработке
            const response = await axios.get(`${DA_CONFIG.apiUrl}/alerts/donations`, {
                headers: {
                    'Authorization': `Bearer ${DA_CONFIG.accessToken}`,
                    'Content-Type': 'application/json'
                },
                params: {
                    page: 1,
                    per_page: 5  // Уменьшено с 10 до 5 для оптимизации
                },
                timeout: 10000
            });

            pollLog('DonationAlerts: получено', response.data.data?.length || 0);

            if (response.data.data && response.data.data.length > 0) {
                console.log('📊 Пример доната:', response.data.data[0]);
                console.log('📊 Всего донатов в ответе:', response.data.data.length);
            } else {
                console.log('⚠️ Донатов в ответе API нет');
            }

            return response.data.data || [];
        } catch (error) {
            console.error('❌ Ошибка API DonationAlerts:', error.response?.status, error.response?.data || error.message);

            if (error.response?.status === 401) {
                DA_CONFIG.accessToken = null;
                console.log('🔑 Токен устарел, требуется повторная авторизация');

                getAppState((state) => {
                    if (state) {
                        updateAppState({
                            da_access_token: null
                        }, () => {});
                    }
                });
            }

            return [];
        }
    }

    // API для получения информации о пользователе DonatePay
    async function getDonatePayUser() {
        if (!DP_CONFIG.apiKey) {
            console.log('⚠️ API ключ DonatePay не настроен');
            return null;
        }

        try {
            console.log('🔍 Запрос информации о пользователе DonatePay...');
            console.log('📋 Параметры запроса:', {
                url: `${DP_CONFIG.apiUrl}/user`,
                apiKey: DP_CONFIG.apiKey ? `${DP_CONFIG.apiKey.substring(0, 10)}...` : 'ОТСУТСТВУЕТ'
            });

            const response = await axios.get(`${DP_CONFIG.apiUrl}/user`, {
                params: {
                    access_token: DP_CONFIG.apiKey
                },
                timeout: 10000,
                validateStatus: function (status) {
                    return status < 500; // Разрешаем все статусы кроме 5xx
                }
            });

            console.log('📥 Ответ от DonatePay API:', {
                status: response.status,
                statusText: response.statusText,
                hasData: !!response.data,
                dataKeys: response.data ? Object.keys(response.data) : []
            });

            if (response.status === 429) {
                const errorTimestamp = Date.now();
                DP_CONFIG.lastError = { status: 429, message: 'Too Many Requests', timestamp: errorTimestamp };
                // Сохраняем время ошибки в БД
                getAppState((state) => {
                    if (state) {
                        updateAppState({
                            dp_last_429_error_ts: errorTimestamp
                        }, (err) => {
                            if (err) {
                                console.error('❌ Ошибка сохранения времени ошибки 429:', err);
                            } else {
                                console.log('✅ Время ошибки 429 сохранено в БД');
                            }
                        });
                    }
                });
                console.warn('⚠️ DonatePay API: Превышен лимит запросов (Too Many Attempts).');
                console.warn('💡 Подождите 5 минут перед повторной попыткой. Запросы будут автоматически возобновлены.');
                console.warn('📋 Ответ сервера:', JSON.stringify(response.data, null, 2));
                return null;
            }

            if (response.status === 401) {
                DP_CONFIG.lastError = { status: 401, message: 'Unauthorized', timestamp: Date.now() };
                console.warn('⚠️ DonatePay API: Неавторизован. Проверьте API ключ.');
                console.warn('📋 Ответ сервера:', JSON.stringify(response.data, null, 2));
                return null;
            }

            if (response.status !== 200) {
                console.error('❌ DonatePay API вернул ошибку:', {
                    status: response.status,
                    statusText: response.statusText,
                    data: response.data
                });
                return null;
            }

            if (response.data && response.data.data) {
                DP_CONFIG.userId = response.data.data.id;

                // Сохраняем userId в БД для будущих запусков
                getAppState((state) => {
                    if (state) {
                        updateAppState({
                            dp_user_id: DP_CONFIG.userId
                        }, (err) => {
                            if (!err) {
                                console.log('✅ userId сохранен в БД для будущих запусков:', DP_CONFIG.userId);
                            } else {
                                console.error('❌ Ошибка сохранения userId в БД:', err);
                            }
                        });
                    }
                });

                // Сбрасываем ошибку при успешном запросе
                if (DP_CONFIG.lastError && DP_CONFIG.lastError.status === 429) {
                    console.log('✅ Успешный запрос /user после ошибки 429, сбрасываем флаг ошибки');
                    DP_CONFIG.lastError = null;
                    // Очищаем время ошибки в БД
                    getAppState((state) => {
                        if (state) {
                            updateAppState({
                                dp_last_429_error_ts: null
                            }, (err) => {
                                if (err) {
                                    console.error('❌ Ошибка очистки времени ошибки 429:', err);
                                } else {
                                    console.log('✅ Время ошибки 429 очищено из БД');
                                }
                            });
                        }
                    });
                }

                console.log('✅ Получена информация о пользователе DonatePay:', {
                    id: response.data.data.id,
                    name: response.data.data.name,
                    avatar: response.data.data.avatar,
                    balance: response.data.data.balance
                });
                return response.data.data;
            }

            console.warn('⚠️ DonatePay API: Неожиданный формат ответа:', JSON.stringify(response.data, null, 2));
            return null;
        } catch (error) {
            const status = error.response?.status;
            const errorData = error.response?.data;

            console.error('❌ Ошибка API DonatePay /user:', {
                status: status || 'НЕТ СТАТУСА',
                statusText: error.response?.statusText || 'НЕТ',
                message: error.message,
                data: errorData ? JSON.stringify(errorData, null, 2) : 'НЕТ ДАННЫХ',
                code: error.code,
                url: error.config?.url,
                apiKey: DP_CONFIG.apiKey ? `${DP_CONFIG.apiKey.substring(0, 10)}...` : 'ОТСУТСТВУЕТ'
            });

            if (status === 429) {
                const errorTimestamp = Date.now();
                DP_CONFIG.lastError = { status: 429, message: 'Too Many Requests', timestamp: errorTimestamp };
                // Сохраняем время ошибки в БД
                getAppState((state) => {
                    if (state) {
                        updateAppState({
                            dp_last_429_error_ts: errorTimestamp
                        }, (err) => {
                            if (err) {
                                console.error('❌ Ошибка сохранения времени ошибки 429:', err);
                            } else {
                                console.log('✅ Время ошибки 429 сохранено в БД');
                            }
                        });
                    }
                });
                console.warn('⚠️ DonatePay API: Превышен лимит запросов (Too Many Attempts).');
                console.warn('💡 Подождите 5 минут перед повторной попыткой. Запросы будут автоматически возобновлены.');
            } else if (status === 401) {
                DP_CONFIG.lastError = { status: 401, message: 'Unauthorized', timestamp: Date.now() };
                console.warn('⚠️ DonatePay API: Неавторизован. Проверьте API ключ.');
                console.warn('💡 Убедитесь, что API ключ правильный и активный');
            } else if (status === 404) {
                console.warn('⚠️ DonatePay API: Endpoint не найден. Проверьте URL API.');
            } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                console.warn('⚠️ DonatePay API: Проблема с подключением к серверу.');
            } else {
                console.error('❌ Неизвестная ошибка API DonatePay');
            }
            return null;
        }
    }

    // Проверка существования доната в базе данных
    function checkDonationExists(donationId) {
        return new Promise((resolve) => {
            db.get('SELECT id FROM donations WHERE id = ?', [donationId], (err, row) => {
                if (err) {
                    console.error('❌ Ошибка проверки доната в БД:', err);
                    resolve(false);
                    return;
                }
                resolve(!!row);
            });
        });
    }

    // ПРОСТАЯ функция для получения донатов через newTransactions API (как в RutonyChat)
    // Использует endpoint /newTransactions с параметром after для получения только новых транзакций
    // Работает точно так же, как в RutonyChat - простой polling без сложной логики
    async function getDonatePayNewTransactions() {
        if (!DP_CONFIG.apiKey) {
            return [];
        }

        try {
            // Используем lastTransactionId для получения только новых транзакций
            // Если был флаг ошибки "after incorrect", не используем after
            let afterId = DP_CONFIG.lastTransactionId || 0;
            const skipAfter = DP_CONFIG._skipAfter || false;

            if (skipAfter) {
                console.log('⚠️ Пропуск параметра "after" из-за предыдущей ошибки "after incorrect"');
                afterId = 0;
            }

            // Проверяем, что токен есть
            if (!DP_CONFIG.apiKey || DP_CONFIG.apiKey.trim() === '') {
                console.error('❌ DonatePay API ключ отсутствует или пустой!');
                return [];
            }

            // Простой запрос к API (как в RutonyChat)
            // Если afterId вызывает ошибку "after incorrect", не передаем его
            const params = {
                access_token: DP_CONFIG.apiKey.trim(),
                type: 'donation'
            };

            // Передаем after только если он больше 0 и не вызывает ошибку
            // Если API вернул "after incorrect", в следующий раз не передаем after
            if (afterId > 0) {
                params.after = afterId;
            }

            pollLog('DonatePay /newTransactions after=', afterId || 0);

            const response = await axios.get(`${DP_CONFIG.widgetApiUrl}/newTransactions`, {
                params: params,
                timeout: 10000
            });

            pollLog('DonatePay response', response.status, Array.isArray(response.data) ? response.data.length : 'obj');

            // Проверяем ответ на ошибки
            if (response.data && response.data.status === 'error') {
                const errorMessage = response.data.message || 'Неизвестная ошибка';
                console.error('❌ DonatePay API ошибка:', errorMessage);

                if (errorMessage.includes('after incorrect')) {
                    console.warn('⚠️ Параметр "after" неправильный. В следующий раз запросим без него.');
                    // Устанавливаем флаг, чтобы в следующий раз не передавать after
                    DP_CONFIG._skipAfter = true;
                    // Сбрасываем lastTransactionId
                    DP_CONFIG.lastTransactionId = 0;
                    getAppState((state) => {
                        if (state) {
                            updateAppState({
                                dp_last_transaction_id: 0
                            }, (err) => {
                                if (!err) {
                                    console.log('✅ lastTransactionId сброшен в БД');
                                }
                            });
                        }
                    });
                } else if (errorMessage.includes('token')) {
                    console.error('💡 Проблема с токеном. Проверьте, что API ключ правильный и загружен из config.env');
                    console.error('   Текущий API ключ:', DP_CONFIG.apiKey ? `${DP_CONFIG.apiKey.substring(0, 10)}...` : 'ОТСУТСТВУЕТ');
                }
                return [];
            }

            // Простая обработка ошибок (как в RutonyChat)
            if (response.status !== 200) {
                console.error('❌ DonatePay API вернул статус:', response.status);
                console.error('   Полный ответ:', JSON.stringify(response.data, null, 2));
                if (response.status === 429) {
                    console.warn('⚠️ DonatePay API: Превышен лимит запросов. Пропускаем этот запрос.');
                } else if (response.status === 401) {
                    console.warn('⚠️ DonatePay API: Неавторизован. Проверьте API ключ.');
                } else {
                    console.warn(`⚠️ DonatePay API: Ошибка ${response.status}. Продолжаем работу.`);
                }
                return [];
            }

            // Обрабатываем ответ API (простая логика, как в RutonyChat)
            let transactions = [];
            if (Array.isArray(response.data)) {
                transactions = response.data;
                console.log('✅ Найден массив транзакций в response.data, количество:', transactions.length);
            } else if (response.data?.data && Array.isArray(response.data.data)) {
                transactions = response.data.data;
                console.log('✅ Найден массив транзакций в response.data.data, количество:', transactions.length);
            } else if (response.data?.transactions && Array.isArray(response.data.transactions)) {
                transactions = response.data.transactions;
                console.log('✅ Найден массив транзакций в response.data.transactions, количество:', transactions.length);
            } else {
                // Если формат неожиданный, логируем для отладки
                console.warn('⚠️ Неожиданный формат ответа DonatePay API');
                console.warn('   Структура ответа:', JSON.stringify(response.data, null, 2));
                return [];
            }

            // Преобразуем формат DonatePay в стандартный
            const processedDonations = [];
            let maxTransactionId = parseInt(afterId) || 0;

            console.log('🔍 Обработка транзакций, всего:', transactions.length);

            // Используем for...of вместо forEach, чтобы можно было использовать await
            for (let index = 0; index < transactions.length; index++) {
                const transaction = transactions[index];

                // Логируем первые 3 транзакции для отладки
                if (index < 3) {
                    console.log(`📋 Транзакция #${index + 1}:`, {
                        id: transaction.id,
                        type: transaction.type,
                        status: transaction.status,
                        what: transaction.what,
                        sum: transaction.sum,
                        comment: transaction.comment,
                        created_at: transaction.created_at
                    });
                }

                // Обрабатываем донаты - статус может быть 'success', 'user', 'paid' и т.д.
                // Главное - это тип 'donation' и наличие суммы
                const isDonation = transaction.type === 'donation';
                // Статусы, которые означают успешный/обработанный донат
                const validStatuses = ['success', 'user', 'paid', 'complete', 'done'];
                const isValidStatus = validStatuses.includes(transaction.status);

                if (isDonation && isValidStatus) {
                    const transactionId = parseInt(transaction.id) || 0;
                    const amount = parseFloat(transaction.sum || 0);

                    if (amount > 0 && transactionId > 0) {
                        // Обрабатываем комментарий - убираем префикс "Комментарий: " если есть
                        let message = transaction.comment || '';
                        if (message.startsWith('Комментарий: ')) {
                            message = message.substring('Комментарий: '.length).trim();
                        }

                        const donationId = `dp_${transaction.id}`;

                        // ВАЖНО: Проверяем, не был ли этот донат уже обработан (есть в базе)
                        const donationExists = await checkDonationExists(donationId);
                        if (donationExists) {
                            console.log(`⏭️ Пропуск DonatePay доната (уже в базе): ID=${donationId}, transactionId=${transactionId}, username=${transaction.what}, amount=${amount}₽`);
                            // Все равно обновляем максимальный ID, чтобы не проверять этот донат снова
                            if (transactionId > maxTransactionId) {
                                maxTransactionId = transactionId;
                            }
                            continue;
                        }

                        const donation = {
                            id: donationId,
                            username: transaction.what || 'Аноним',
                            amount: amount,
                            message: message,
                            currency: transaction.currency || 'RUB',
                            platform: 'donatepay',
                            created_at: transaction.created_at || new Date().toISOString(),
                            original_id: transaction.id
                        };

                        processedDonations.push(donation);
                        console.log(`✅ Новый донат DonatePay: ${donation.username} - ${donation.amount}₽ (ID: ${donation.id}, transactionId: ${transactionId}, статус: ${transaction.status})`);

                        // Обновляем максимальный ID
                        if (transactionId > maxTransactionId) {
                            maxTransactionId = transactionId;
                        }
                    } else {
                        if (index < 3) {
                            console.log(`⏭️ Пропуск транзакции #${index + 1}: amount=${amount}, transactionId=${transactionId}`);
                        }
                    }
                } else {
                    if (index < 3) {
                        console.log(`⏭️ Пропуск транзакции #${index + 1}: type=${transaction.type}, status=${transaction.status} (не подходит под критерии)`);
                    }
                }
            }

            // Сохраняем ID последней транзакции (как в RutonyChat)
            if (maxTransactionId > parseInt(afterId || 0)) {
                DP_CONFIG.lastTransactionId = maxTransactionId;
                // Сбрасываем флаг skipAfter, так как теперь у нас есть валидный ID
                if (DP_CONFIG._skipAfter) {
                    DP_CONFIG._skipAfter = false;
                    console.log('✅ Флаг skipAfter сброшен, теперь будем использовать after');
                }
                // Сохраняем в БД
                getAppState((state) => {
                    if (state) {
                        updateAppState({
                            dp_last_transaction_id: maxTransactionId
                        }, (err) => {
                            if (err) {
                                console.error('❌ Ошибка сохранения lastTransactionId:', err);
                            } else {
                                console.log('✅ lastTransactionId сохранен:', maxTransactionId);
                            }
                        });
                    }
                });
            }

            if (processedDonations.length > 0) {
                console.log(`✅ DonatePay: получено ${processedDonations.length} новых донатов`);
            }

            return processedDonations;

        } catch (error) {
            // Детальная обработка ошибок для диагностики
            const status = error.response?.status;
            const errorData = error.response?.data;

            if (errorData && errorData.status === 'error') {
                console.error('❌ DonatePay API ошибка:', errorData.message || 'Неизвестная ошибка');
                if (errorData.message && errorData.message.includes('token')) {
                    console.error('💡 Проблема с токеном! Проверьте:');
                    console.error('   1. API ключ в config.env: DP_API_KEY=...');
                    console.error('   2. Текущий API ключ:', DP_CONFIG.apiKey ? `${DP_CONFIG.apiKey.substring(0, 10)}...` : 'ОТСУТСТВУЕТ');
                    console.error('   3. Длина ключа:', DP_CONFIG.apiKey ? DP_CONFIG.apiKey.length : 0);
                }
            } else if (status === 429) {
                console.warn('⚠️ DonatePay API: Превышен лимит запросов. Пропускаем этот запрос.');
            } else if (status === 401) {
                console.warn('⚠️ DonatePay API: Неавторизован. Проверьте API ключ.');
            } else {
                // Только для неожиданных ошибок логируем детали
                if (status && status >= 500) {
                    console.error('❌ Ошибка сервера DonatePay:', status, error.message);
                } else if (errorData) {
                    console.error('❌ DonatePay API ответ:', JSON.stringify(errorData, null, 2));
                }
            }
            return [];
        }
    }

    async function connectDonatePayCentrifugo() {
        if (!DP_CONFIG.apiKey) {
            console.log('⚠️ DonatePay не настроен для Centrifugo (нет API ключа)');
            return;
        }

        // Если userId не получен, пытаемся получить информацию о пользователе
        if (!DP_CONFIG.userId) {
            console.log('⚠️ UserId не получен, пытаемся получить информацию о пользователе...');
            const userInfo = await getDonatePayUser();
            if (!userInfo || !DP_CONFIG.userId) {
                console.log('⚠️ Не удалось получить информацию о пользователе, Centrifugo не подключен');
                return;
            }
        }

        try {
            console.log('🔗 Подключение к Centrifugo DonatePay...');
            console.log('📋 Параметры:', {
                userId: DP_CONFIG.userId,
                apiKey: DP_CONFIG.apiKey ? `${DP_CONFIG.apiKey.substring(0, 10)}...` : 'ОТСУТСТВУЕТ',
                centrifugoUrl: DP_CONFIG.centrifugoUrl,
                socketTokenUrl: DP_CONFIG.socketTokenUrl
            });

            // Получаем токен для подключения
            const tokenResponse = await axios.post(DP_CONFIG.socketTokenUrl, {
                access_token: DP_CONFIG.apiKey
            }, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            console.log('📥 Ответ от socket/token:', {
                status: tokenResponse.status,
                hasToken: !!tokenResponse.data?.token
            });

            if (!tokenResponse.data || !tokenResponse.data.token) {
                console.error('❌ Не удалось получить токен для Centrifugo');
                console.error('📋 Ответ:', JSON.stringify(tokenResponse.data, null, 2));
                return;
            }

            const connectionToken = tokenResponse.data.token;
            console.log('✅ Токен для Centrifugo получен');

            // Создаем подключение к Centrifugo с новым API (v4+)
            // Используем subscribeEndpoint и subscribeParams согласно документации
            centrifuge = new Centrifuge(DP_CONFIG.centrifugoUrl, {
                token: connectionToken,
                subscribeEndpoint: DP_CONFIG.socketTokenUrl,
                subscribeParams: {
                    access_token: DP_CONFIG.apiKey
                },
                disableWithCredentials: true
            });

            // Подписываемся на канал пользователя
            const channel = `$public:${DP_CONFIG.userId}`;
            console.log('📡 Подписка на канал:', channel);
            console.log('📋 Канал для получения донатов DonatePay в real-time');

            const subscription = centrifuge.newSubscription(channel);

            subscription.on('publication', (ctx) => {
                console.log('💰💰💰 DonatePay real-time уведомление получено через Centrifugo! 💰💰💰');
                console.log('📨 Полные данные:', JSON.stringify(ctx.data, null, 2));

                // Обрабатываем донат - проверяем разные форматы данных
                const data = ctx.data || {};
                let donationData = null;

                // Формат 1: прямое поле type === 'donation'
                if (data.type === 'donation') {
                    donationData = {
                        id: `dp_${data.id || Date.now()}`,
                        username: data.what || data.name || 'Аноним',
                        amount: parseFloat(data.sum || data.amount || 0),
                        message: data.comment || data.message || '',
                        currency: 'RUB',
                        created_at: data.created_at || new Date().toISOString(),
                        platform: 'donatepay'
                    };
                }
                // Формат 2: в vars может быть информация о донате
                else if (data.vars) {
                    const vars = data.vars;
                    if (vars.type === 'donation' || vars.sum) {
                        donationData = {
                            id: `dp_${data.id || vars.id || Date.now()}`,
                            username: vars.what || vars.name || 'Аноним',
                            amount: parseFloat(vars.sum || vars.amount || 0),
                            message: vars.comment || vars.message || '',
                            currency: 'RUB',
                            created_at: vars.created_at || data.created_at || new Date().toISOString(),
                            platform: 'donatepay'
                        };
                    }
                }
                // Формат 3: если есть поля what и sum, это донат
                else if (data.what && data.sum) {
                    donationData = {
                        id: `dp_${data.id || Date.now()}`,
                        username: data.what || 'Аноним',
                        amount: parseFloat(data.sum || 0),
                        message: data.comment || data.message || '',
                        currency: 'RUB',
                        created_at: data.created_at || new Date().toISOString(),
                        platform: 'donatepay'
                    };
                }

                // Обрабатываем донат если он найден
                if (donationData && donationData.amount > 0) {
                    console.log('✅ Обработка доната из Centrifugo (real-time):', donationData);

                    // Обновляем lastTransactionId если есть реальный ID
                    if (data.id) {
                        const transactionId = parseInt(data.id) || 0;
                        if (transactionId > (parseInt(DP_CONFIG.lastTransactionId) || 0)) {
                            DP_CONFIG.lastTransactionId = transactionId;
                            // Сохраняем в БД
                            getAppState((state) => {
                                if (state) {
                                    updateAppState({
                                        dp_last_transaction_id: transactionId
                                    }, (err) => {
                                        if (err) {
                                            console.error('❌ Ошибка сохранения ID последней транзакции:', err);
                                        } else {
                                            console.log('✅ ID последней транзакции сохранен:', transactionId);
                                        }
                                    });
                                }
                            });
                        }
                    }

                    processDonation(donationData, true); // true = realtime
                } else {
                    console.log('⚠️ Получено уведомление, но не удалось извлечь данные доната');
                }
            });

            subscription.on('subscribed', (ctx) => {
                console.log('✅ Подписка на DonatePay канал активна:', channel);
                console.log('🎉 Готов к получению донатов DonatePay в real-time через Centrifugo!');
                console.log('📡 Все новые донаты будут приходить мгновенно через WebSocket');
            });

            subscription.on('subscribing', (ctx) => {
                console.log('🔄 Подписка на DonatePay канал в процессе...');
            });

            subscription.on('unsubscribed', (ctx) => {
                console.log('⚠️ Отписка от DonatePay канала:', ctx);
            });

            subscription.on('error', (ctx) => {
                console.error('❌ Ошибка подписки DonatePay:', ctx);
            });

            // Обработчики событий подключения
            centrifuge.on('connecting', (ctx) => {
                console.log('🔄 Подключение к Centrifugo DonatePay...');
            });

            centrifuge.on('connected', (ctx) => {
                console.log('✅ Подключение к Centrifugo DonatePay установлено');
            });

            centrifuge.on('disconnected', (ctx) => {
                console.log('⚠️ Отключение от Centrifugo DonatePay:', ctx);
            });

            centrifuge.on('error', (ctx) => {
                console.error('❌ Ошибка Centrifugo DonatePay:', ctx);
            });

            // Подключаемся и подписываемся
            subscription.subscribe();
            centrifuge.connect();

            console.log('✅ Инициализация Centrifugo DonatePay завершена');

        } catch (error) {
            console.error('❌ Ошибка подключения к Centrifugo DonatePay:', error.message);
            console.error('📋 Детали ошибки:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status
            });
        }
    }

    function isCentrifugoConnected() {
        return !!centrifuge;
    }

    function getCentrifugoState() {
        if (!centrifuge) return null;
        try {
            return centrifuge.state || 'unknown';
        } catch (e) {
            return 'unknown';
        }
    }

    return {
        getDonationsFromAPI,
        getDonatePayUser,
        checkDonationExists,
        getDonatePayNewTransactions,
        connectDonatePayCentrifugo,
        isCentrifugoConnected,
        getCentrifugoState
    };
}

module.exports = { createDonationPlatformsModule };
