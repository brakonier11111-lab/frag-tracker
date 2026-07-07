'use strict';

/**
 * Цикл опроса донат-платформ (DonationAlerts + DonatePay) — вынесен из
 * server.js 1:1. Владеет своим состоянием опроса (pollingInterval,
 * isPollingInProgress, pollDelayMs, firstPollDone, lastSeenDonationId);
 * processedDonationIds — общий Set с donation-orchestrator, приходит в deps.
 * Имена deps совпадают с прежними именами в server.js — тела функций не менялись.
 */

const { classifyDonationForPolling } = require('./donation-poll-filter');

function createDonationPoller(deps) {
    const {
        db,
        pollLog,
        getAppState,
        updateAppState,
        appStateStore,
        DA_CONFIG,
        DP_CONFIG,
        DONATION_POLLING_ENABLED,
        processedDonationIds,
        processDonation,
        getDonationsFromAPI,
        getDonatePayUser,
        getDonatePayNewTransactions,
        connectDonatePayCentrifugo,
        donationPlatformsModule
    } = deps;

    let pollingInterval = null;
    let isPollingInProgress = false;
    let nextPollTimeout = null;
    let pollDelayMs = 5000;
    const MIN_POLL_MS = 5000;
    const MAX_POLL_MS = 30000;
    let firstPollDone = false;
    let lastSeenDonationId = null; // cached from DB

    function startPollingDonationAlerts() {
        if (!DONATION_POLLING_ENABLED) {
            return;
        }
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
        if (nextPollTimeout) {
            clearTimeout(nextPollTimeout);
            nextPollTimeout = null;
        }

        console.log('🔄 Запуск опроса DonationAlerts и DonatePay...');
        firstPollDone = false;
        
        // Загружаем все ID донатов из базы данных при старте, чтобы не обрабатывать их повторно
        loadProcessedDonationIds(() => {
            firstPollDone = true;
            scheduleNextPoll(MIN_POLL_MS);
        });
        
        pollingInterval = setInterval(() => {
            if (!isPollingInProgress) {
                checkForNewDonations();
            }
            checkDiscountExpiration();
        }, 8000);
    }

    function checkDiscountExpiration() {
        const state = appStateStore.getCachedState();
        if (!state) return;
        const now = Math.floor(Date.now() / 1000);
        const discountUntil = state.timer_discount_until_ts || 0;
        if (state.timer_discount > 0 && discountUntil > 0 && now >= discountUntil) {
            updateAppState({
                timer_discount: 0,
                timer_discount_until_ts: 0
            });
        }
    }

    function scheduleNextPoll(delay) {
        const safeDelay = Math.min(Math.max(delay || pollDelayMs, MIN_POLL_MS), MAX_POLL_MS);
        pollDelayMs = safeDelay;
        if (nextPollTimeout) clearTimeout(nextPollTimeout);
        nextPollTimeout = setTimeout(checkForNewDonations, safeDelay);
    }

    // Загрузка всех ID донатов из базы данных при старте
    function loadProcessedDonationIds(callback) {
        console.log('📋 Загрузка обработанных донатов из базы данных...');
        db.all('SELECT id FROM donations ORDER BY created_at DESC LIMIT 1000', (err, rows) => {
            if (err) {
                console.error('❌ Ошибка загрузки донатов из БД:', err);
                if (callback) callback();
                return;
            }
            
            const count = rows ? rows.length : 0;
            processedDonationIds.clear();
            
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    if (row.id) {
                        processedDonationIds.add(row.id.toString());
                    }
                });
                console.log(`✅ Загружено ${count} ID донатов из базы данных (будут пропущены при первом опросе)`);
            } else {
                console.log('ℹ️ В базе данных нет донатов');
            }
            
            if (callback) callback();
        });
    }

    // checkDonationExists вынесена в src/modules/donation-platforms

    async function checkForNewDonations() {
        if (!DONATION_POLLING_ENABLED) {
            return;
        }
        if (!DA_CONFIG.accessToken && !DP_CONFIG.apiKey) {
            console.log('⏳ Ожидание настройки DonationAlerts или DonatePay...');
            scheduleNextPoll(MAX_POLL_MS);
            return;
        }

        if (isPollingInProgress) {
            console.log('⏭️ Предыдущий опрос ещё выполняется, пропуск');
            scheduleNextPoll(pollDelayMs);
            return;
        }

        isPollingInProgress = true;
        try {
            // Если DonatePay настроен, но userId не получен, пытаемся получить (опционально для Centrifugo)
            // ВАЖНО: Основной способ получения донатов - /newTransactions API (как в RutonyChat)
            // Centrifugo используется только как дополнительный источник
            if (DP_CONFIG.apiKey && !DP_CONFIG.userId) {
                const lastError = DP_CONFIG.lastError;
                const now = Date.now();
                const errorTimestamp = lastError?.timestamp || 0;
                const timeSinceError = lastError && lastError.status === 429 ? (now - errorTimestamp) : Infinity;
                
                // Увеличиваем таймаут до 10 минут для более безопасного подхода
                // Используем экспоненциальный backoff: 5 мин -> 10 мин -> 20 мин
                let timeoutMs = 300000; // 5 минут по умолчанию
                if (lastError && lastError.status === 429) {
                    // Подсчитываем количество ошибок 429 только если это новая ошибка
                    // Проверяем, не была ли уже засчитана эта ошибка
                    const lastErrorTimestamp = lastError.timestamp || 0;
                    const lastCountedErrorTimestamp = DP_CONFIG._last429ErrorTimestamp || 0;
                    
                    // Если это новая ошибка (новый timestamp), увеличиваем счетчик
                    if (lastErrorTimestamp !== lastCountedErrorTimestamp) {
                        const errorCount = (DP_CONFIG._429ErrorCount || 0) + 1;
                        DP_CONFIG._429ErrorCount = errorCount;
                        DP_CONFIG._last429ErrorTimestamp = lastErrorTimestamp;
                        // Экспоненциальный backoff: 5, 10, 20 минут
                        timeoutMs = Math.min(300000 * Math.pow(2, errorCount - 1), 1200000); // Максимум 20 минут
                        console.log(`⏱️ Новая ошибка 429 #${errorCount}, таймаут увеличен до ${timeoutMs / 60000} минут`);
                    } else {
                        // Используем уже установленный таймаут для этой ошибки
                        const errorCount = DP_CONFIG._429ErrorCount || 1;
                        timeoutMs = Math.min(300000 * Math.pow(2, errorCount - 1), 1200000);
                    }
                }
                
                // Детальное логирование для отладки
                if (lastError && lastError.status === 429) {
                    const secondsSinceError = Math.floor(timeSinceError / 1000);
                    const minutesSinceError = Math.floor(secondsSinceError / 60);
                    const secondsRemaining = Math.floor((timeoutMs - timeSinceError) / 1000);
                    const minutesRemaining = Math.ceil(secondsRemaining / 60);
                    
                    console.log(`⏱️ Статус ошибки 429: прошло ${minutesSinceError} мин ${secondsSinceError % 60} сек`);
                    console.log(`⏱️ Осталось ждать: ${minutesRemaining} мин ${secondsRemaining % 60} сек`);
                    console.log(`💡 Используйте кнопку "🔄 СБРОСИТЬ ОШИБКУ 429" в админке для немедленного сброса`);
                }
                
                // Пытаемся получить информацию о пользователе только если не было ошибки 429 недавно
                // И только если прошло достаточно времени с последней попытки (минимум 1 минута между попытками)
                const lastAttempt = DP_CONFIG.lastUserInfoRequest || 0;
                const minIntervalBetweenAttempts = 60000; // 1 минута между попытками
                const canAttempt = (now - lastAttempt) >= minIntervalBetweenAttempts;
                
                if ((!lastError || lastError.status !== 429 || timeSinceError > timeoutMs) && canAttempt) {
                    if (timeSinceError > timeoutMs && lastError && lastError.status === 429) {
                        console.log('✅ Таймаут ошибки 429 истек, пробуем получить userId снова');
                        DP_CONFIG.lastError = null;
                        DP_CONFIG._429ErrorCount = 0; // Сбрасываем счетчик ошибок
                        DP_CONFIG._last429ErrorTimestamp = null; // Сбрасываем timestamp последней ошибки
                        // Очищаем время ошибки в БД
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
                    DP_CONFIG.lastUserInfoRequest = now; // Сохраняем время попытки
                    console.log('🔄 Попытка получить информацию о пользователе DonatePay (только для Centrifugo)...');
                    console.log('⏳ Это может занять несколько секунд...');
                    const userInfo = await getDonatePayUser();
                    if (userInfo && DP_CONFIG.userId && !donationPlatformsModule.isCentrifugoConnected()) {
                        // Подключаемся к Centrifugo если еще не подключены
                        console.log('📡 Подключение к Centrifugo для real-time уведомлений DonatePay...');
                        await connectDonatePayCentrifugo();
                    }
                } else if (!canAttempt) {
                    const secondsUntilNextAttempt = Math.ceil((minIntervalBetweenAttempts - (now - lastAttempt)) / 1000);
                    console.log(`⏸️ Слишком рано для повторной попытки получения userId (осталось: ${secondsUntilNextAttempt} сек)`);
                } else {
                    const minutesLeft = Math.ceil((timeoutMs - timeSinceError) / 60000);
                    const secondsLeft = Math.ceil((timeoutMs - timeSinceError) / 1000) % 60;
                    console.log(`⏸️ Пропуск получения userId из-за недавней ошибки 429 (осталось ждать: ~${minutesLeft} мин ${secondsLeft} сек)`);
                    console.log(`💡 Centrifugo будет подключен автоматически после получения userId`);
                    console.log(`💡 Используйте кнопку "🔄 СБРОСИТЬ ОШИБКУ 429" в админке для немедленного сброса`);
                }
            }
            
            // Проверяем статус Centrifugo подключения
            if (DP_CONFIG.apiKey && DP_CONFIG.userId) {
                if (!donationPlatformsModule.isCentrifugoConnected()) {
                    console.log('⚠️ Centrifugo не подключен, но userId есть. Пытаемся подключиться...');
                    await connectDonatePayCentrifugo();
                } else {
                    // Проверяем состояние подключения (если есть метод state)
                    try {
                        const state = donationPlatformsModule.getCentrifugoState();
                        if (state === 'disconnected' || state === 'closed') {
                            console.log('⚠️ Centrifugo отключен, пытаемся переподключиться...');
                            await connectDonatePayCentrifugo();
                        } else if (state === 'connected') {
                            // Все хорошо, подключение активно
                            // console.log('✅ Centrifugo подключен и активен');
                        }
                    } catch (e) {
                        // Если нет свойства state, просто проверяем наличие объекта
                        // console.log('✅ Centrifugo объект существует');
                    }
                }
            } else if (DP_CONFIG.apiKey && !DP_CONFIG.userId) {
                console.log('⏳ Ожидание получения userId для подключения к Centrifugo...');
                console.log('💡 После получения userId донаты будут приходить в real-time через Centrifugo');
            }
            
            // Получаем донаты из всех источников
            // DonatePay: используем ТОЛЬКО /newTransactions API (как в RutonyChat)
            // Приоритетная проверка DonatePay для быстрого получения донатов
            const dpNewTransactionsPromise = DP_CONFIG.apiKey ? getDonatePayNewTransactions() : Promise.resolve([]);
            const daDonationsPromise = DA_CONFIG.accessToken ? getDonationsFromAPI() : Promise.resolve([]);
            
            // Сначала проверяем DonatePay (приоритет), затем DonationAlerts
            const dpNewTransactions = await dpNewTransactionsPromise;
            const daDonations = await daDonationsPromise;
            
            // DonatePay донаты из /newTransactions API
            const dpDonations = dpNewTransactions || [];
            
            // Логируем количество донатов из каждого источника
            const centrifugoStatus = donationPlatformsModule.isCentrifugoConnected() ?
                (donationPlatformsModule.getCentrifugoState() === 'connected' ? '✅ Подключен' : `⚠️ ${donationPlatformsModule.getCentrifugoState() || 'Не подключен'}`) :
                '❌ Не инициализирован';
            
            const allDonations = [...daDonations, ...dpDonations];
            pollLog(`Poll: DA=${daDonations.length} DP=${dpDonations.length} centrifugo=${centrifugoStatus}`);
            
            if (allDonations.length > 0) {
                // Фильтруем донаты по времени - обрабатываем только за последние 2 дня
                const now = Date.now();
                const maxAgeMs = 2 * 24 * 60 * 60 * 1000; // 2 дня в миллисекундах
                let skippedOldCount = 0;
                let skippedProcessedCount = 0;
                let skippedByTimeCount = 0;
                
                for (let i = allDonations.length - 1; i >= 0; i--) {
                    const donation = allDonations[i];
                    const verdict = classifyDonationForPolling(donation, {
                        processedIds: processedDonationIds,
                        lastSeenDonationId,
                        nowMs: now,
                        maxAgeMs
                    });
                    const donationId = verdict.donationId;
                    const isNumericId = verdict.isNumericId;

                    if (verdict.action === 'skip_old_by_time') {
                        skippedByTimeCount++;
                        continue;
                    }
                    if (verdict.action === 'skip_already_processed') {
                        skippedProcessedCount++;
                        continue;
                    }
                    if (verdict.action === 'skip_old_by_id') {
                        skippedOldCount++;
                        continue;
                    }

                    console.log(`💰 Новый донат: ${donation.username} — ${donation.amount}${donation.currency || '₽'} (${donation.platform || 'unknown'}, ID ${donationId})`);

                    processDonation({
                        id: donationId,
                        username: donation.username,
                        amount: parseFloat(donation.amount),
                        message: donation.message || '',
                        currency: donation.currency || 'RUB',
                        created_at: donation.created_at,
                        platform: donation.platform || 'unknown'
                    }, true);
                    
                    processedDonationIds.add(donationId);
                    
                    // Для DonatePay донатов - немедленная проверка новых донатов для ускорения
                    if (donation.platform === 'donatepay') {
                        setTimeout(() => {
                            if (!isPollingInProgress) {
                                console.log('⚡ Немедленная проверка новых DonatePay донатов после обработки...');
                                checkForNewDonations();
                            }
                        }, 500); // Проверка через 0.5 секунды после обработки доната
                    }
                    
                    // Обновляем lastSeenDonationId только для числовых ID
                    if (isNumericId && (!lastSeenDonationId || parseInt(donationId) > parseInt(lastSeenDonationId))) {
                        lastSeenDonationId = donationId;
                    }
                    
                    if (processedDonationIds.size > 100) {
                        const first = processedDonationIds.values().next().value;
                        processedDonationIds.delete(first);
                    }
                }
                
                // Логируем статистику пропущенных донатов (только если есть что пропускать)
                pollLog(`Skipped donations: old=${skippedByTimeCount} processed=${skippedProcessedCount} id=${skippedOldCount}`);

                // Сохраняем последний увиденный ID
                if (lastSeenDonationId) {
                    getAppState((state) => {
                        if (state) {
                            updateAppState({ last_donation_id: lastSeenDonationId }, () => {});
                        }
                    });
                }
            }
            // успешный опрос — уменьшим задержку до базовой
            scheduleNextPoll(5000);
        } catch (error) {
            const status = error.response?.status;
            if (status === 429) {
                // Превышен лимит запросов - увеличиваем интервал значительно
                console.warn('⚠️ Превышен лимит запросов API. Увеличиваем интервал опроса до 60 секунд.');
                scheduleNextPoll(60000); // 60 секунд при rate limit
            } else {
                console.error('❌ Ошибка опроса донатных платформ:', error.message);
                // экспоненциальный бекофф с ограничением
                const next = Math.min(pollDelayMs * 2, MAX_POLL_MS);
                scheduleNextPoll(next);
            }
        } finally {
            isPollingInProgress = false;
            if (!firstPollDone) firstPollDone = true;
        }
    }

    // Принудительная проверка новых донатов
    async function forceCheckDonations() {
        console.log('🔄 Принудительная проверка донатов...');
        if (!isPollingInProgress) {
            await checkForNewDonations();
        } else {
            console.log('⏭️ Опрос уже выполняется, пропуск принудительной проверки');
        }
    }

    function stopPolling() {
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
        if (nextPollTimeout) {
            clearTimeout(nextPollTimeout);
            nextPollTimeout = null;
        }
    }

    return {
        startPollingDonationAlerts,
        checkForNewDonations,
        forceCheckDonations,
        checkDiscountExpiration,
        stopPolling,
        isPollingInProgress: () => isPollingInProgress,
        hasPollingInterval: () => !!pollingInterval,
        getPollDelayMs: () => pollDelayMs,
        getFirstPollDone: () => firstPollDone,
        setFirstPollDone: (v) => { firstPollDone = !!v; },
        getLastSeenDonationId: () => lastSeenDonationId,
        setLastSeenDonationId: (v) => { lastSeenDonationId = v; }
    };
}

module.exports = { createDonationPoller };
