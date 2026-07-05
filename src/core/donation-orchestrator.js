'use strict';
/**
 * Оркестрация обработки одного доната: дедуп (память + БД), начисления во
 * ВСЕХ трёх режимах одновременно (фраг-трекер/таймер/кастом — математика в
 * donation-math.js), сохранение записи, донат-бас для побочных потребителей
 * (аналитика/виджеты/рулетка/blitz/ачивки), достижение донатера для алерта,
 * атомарный инкремент таймера, финальный broadcast STATE_UPDATE/NEW_DONATION/
 * SHOW_ALERT для всех режимов. Вынесено из server.js 1:1 — самый переплетённый
 * и самый "боевой" кусок ядра донатов (крутится на каждом донате в эфире).
 *
 * Deps: db, getAppState, updateAppState, pollLog, processedDonationIds (Set,
 * общий с polling-кодом — мутируется по ссылке, не переприсваивается),
 * computeFragAward/computeTimerAward/computeCustomAward, heatFromDonation,
 * saveDonation, normalizeUsername, donationBus, broadcastStateUpdate,
 * broadcastToClients, getBroadcastState.
 */

function createDonationOrchestrator({
    db,
    getAppState,
    updateAppState,
    pollLog,
    processedDonationIds,
    computeFragAward,
    computeTimerAward,
    computeCustomAward,
    heatFromDonation,
    saveDonation,
    normalizeUsername,
    donationBus,
    broadcastStateUpdate,
    broadcastToClients,
    getBroadcastState
}) {
    // Форматирование времени для алертов
    function formatTimeDetailed(seconds) {
        if (seconds < 60) {
            return `${seconds} сек`;
        } else if (seconds < 3600) {
            const minutes = Math.floor(seconds / 60);
            const secs = seconds % 60;
            return secs > 0 ? `${minutes}:${secs.toString().padStart(2, '0')} мин` : `${minutes} мин`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return minutes > 0 ? `${hours}:${minutes.toString().padStart(2, '0')} ч` : `${hours} ч`;
        }
    }

    function processDonation(donationData, isRealtime = false) {
        const donationKey = donationData && donationData.id != null ? String(donationData.id) : null;
        if (!donationKey) {
            console.warn('⚠️ processDonation: донат без id, пропуск', donationData);
            return;
        }
        if (processedDonationIds.has(donationKey)) {
            pollLog('processDonation: дубль (память), пропуск', donationKey);
            return;
        }
        processedDonationIds.add(donationKey);
        if (processedDonationIds.size > 500) {
            const first = processedDonationIds.values().next().value;
            processedDonationIds.delete(first);
        }
        db.get('SELECT id FROM donations WHERE id = ?', [donationKey], (dupErr, existing) => {
            if (dupErr) {
                console.warn('⚠️ Дедуп-проверка по БД не удалась, продолжаем обработку:', dupErr.message);
            } else if (existing) {
                console.log(`⏭️ Донат ${donationKey} уже в БД — пропуск повторной обработки`);
                return;
            }
            processDonationCore(donationData, isRealtime);
        });
    }

    function processDonationCore(donationData, isRealtime = false) {
        pollLog('processDonation', isRealtime ? 'RT' : 'poll', donationData.id, donationData.username);

        getAppState((state) => {
            if (!state) {
                console.error('❌ STATE NOT FOUND for donation processing');
                return;
            }

            const amount = donationData.amount;
            const username = donationData.username;
            const message = donationData.message;
            const currentMode = state.current_mode || 'mode1';

            console.log(`🎉 Обработка доната: ${username} - ${amount}₽ в режиме ${currentMode}`);

            let donation = {
                id: donationData.id,
                username: username,
                amount: amount,
                message: message,
                currency: donationData.currency || 'RUB',
                isRealtime: isRealtime,
                timestamp: new Date().toLocaleTimeString('ru-RU')
            };

            let updatedState = {};
            let alertData = { ...donation };

            // ВАЖНО: Обрабатываем донат для ВСЕХ режимов одновременно!

            // Режим 1: Frag Tracker (математика — src/core/donation-math.js)
            const fragAward = computeFragAward(state, amount);
            const fragUnitsEarned = fragAward.unitsEarned;
            const fragRemainingBalance = fragAward.remainingBalance;

            console.log(`💰 Расчет фрагов: (${state.current_balance || 0} + ${amount}) = ${fragUnitsEarned} ${state.frag_name}, остаток: ${fragRemainingBalance}`);

            updatedState.current_balance = fragRemainingBalance;
            const oldTotalDonated = state.total_donated || 0;
            updatedState.total_donated = oldTotalDonated + amount;
            console.log(`💰 Обновление total_donated: ${oldTotalDonated} + ${amount} = ${updatedState.total_donated}`);

            // Нагрев от доната в режиме температуры
            heatFromDonation(amount);

            if (fragUnitsEarned > 0) {
                updatedState.frags_needed = (state.frags_needed || 0) + fragUnitsEarned;
                // Не добавляем запись боя/фрагов в frag_stats от доната, чтобы избежать фантомных боев
                console.log(`📊 Начислено ${fragUnitsEarned} фрагов от доната (без записи боя в frag_stats)`);
            }

            donation.fragsEarned = fragUnitsEarned;

            // Логика отображения в алерте
            if (fragUnitsEarned > 0) {
                // Если донат закрывает полоску до фрага - показываем количество фрагов
                alertData.fragsEarned = fragUnitsEarned;
                alertData.fragUnitName = state.frag_name;
                alertData.fragDisplayType = 'frags'; // Тип отображения: фраги
            } else {
                // Если донат не закрывает полоску - показываем "Добавил до +1 фрага"
                alertData.fragsEarned = 0;
                alertData.fragUnitName = state.frag_name;
                alertData.fragDisplayType = 'amount'; // Тип отображения: сумма
            }

            // Режим 2: Timer (математика — src/core/donation-math.js)
            const timerAward = computeTimerAward(state, amount, Math.floor(Date.now() / 1000));
            const { timeEarned, actualCostPerMinute, discount } = timerAward;
            if (timerAward.discountExpired) {
                // Скидка истекла, отключаем её
                updatedState.timer_discount = 0;
                updatedState.timer_discount_until_ts = 0;
            }

            console.log(`⏰ Расчет времени: ${amount}₽ × ${(60 / actualCostPerMinute).toFixed(2)}сек/₽ = ${timeEarned}сек (Цена: ${actualCostPerMinute}₽/мин, скидка: ${discount}₽)`);

            // ВАЖНО: Используем атомарное обновление SQL для предотвращения гонки условий
            // Вместо чтения и записи используем UPDATE с инкрементом прямо в SQL
            // Это гарантирует, что время будет добавлено даже если таймер обновляется параллельно
            const currentTimerSeconds = state.timer_seconds || 0;
            const newTimerSeconds = currentTimerSeconds + timeEarned;

            // Используем специальный флаг для атомарного инкремента
            // Это гарантирует, что время будет добавлено даже если таймер обновляется параллельно (например, функцией updateTimer)
            updatedState._timer_seconds_increment = timeEarned;
            // Также сохраняем новое значение для логирования и других целей
            updatedState.timer_seconds = newTimerSeconds;

            console.log(`⏰ Обновление таймера: ${currentTimerSeconds} + ${timeEarned} = ${newTimerSeconds} сек (будет применено атомарно через SQL инкремент)`);
            console.log(`⏰ Флаг атомарного обновления установлен: _timer_seconds_increment = ${timeEarned}`);

            donation.timeEarned = timeEarned;
            alertData.timeEarned = timeEarned;
            alertData.timeFormatted = formatTimeDetailed(timeEarned);
            alertData.actualCostPerMinute = actualCostPerMinute;

            // Рулетка и прочие побочные потребители — подписчики donationBus (см. ниже по файлу)

            // Режим 3: Custom Tracker (математика — src/core/donation-math.js)
            const customAward = computeCustomAward(state, amount);
            const customUnitsEarned = customAward.unitsEarned;
            const customRemainingBalance = customAward.remainingBalance;

            console.log(`🎯 Расчет кастомных единиц: (${state.custom_current_balance || 0} + ${amount}) = ${customUnitsEarned} ${state.custom_goal_name}, остаток: ${customRemainingBalance}`);

            updatedState.custom_current_balance = customRemainingBalance;

            if (customUnitsEarned > 0) {
                updatedState.custom_units_needed = (state.custom_units_needed || 0) + customUnitsEarned;
            }

            donation.customUnitsEarned = customUnitsEarned;
            alertData.customUnitsEarned = customUnitsEarned;
            alertData.customUnitName = state.custom_goal_name;

            // Сохраняем донат (не блокируем последующую логику при ошибке)
            saveDonation(donation, (err) => {
                if (err) {
                    console.error('❌ Ошибка сохранения доната (продолжаем обработку):', err);
                }

                // Побочные потребители доната (аналитика, виджеты сбора, рулетка,
                // Blitz Challenge, ачивки) — подписчики donationBus. emit синхронный,
                // порядок и изоляция ошибок те же, что были у прямых вызовов.
                donationBus.emit({ donation, state, fragUnitsEarned, timeEarned, customUnitsEarned });

                // Получаем достижение донатера для отображения в алерте
                const normalizedUsername = normalizeUsername(username);
                const getDonorAchievement = (callback) => {
                    if (!normalizedUsername || timeEarned <= 0) {
                        callback(null);
                        return;
                    }
                    // Получаем достижение после обновления
                    db.get(`SELECT da.*, dat.icon as tier_icon, dat.color as tier_color, dat.name as tier_name, dat.custom_icon_url as tier_custom_icon_url
                            FROM donor_achievements da
                            LEFT JOIN donor_achievement_tiers dat ON da.current_tier_id = dat.id
                            WHERE da.normalized_username = ?`, [normalizedUsername], (err, achievement) => {
                        if (err || !achievement) {
                            callback(null);
                            return;
                        }
                        // Если tier_name не найден, возвращаем null вместо дефолтного "Новичок"
                        callback({
                            icon: achievement.tier_icon || '🏆',
                            color: achievement.tier_color || '#00f0ff',
                            name: achievement.tier_name || null, // Не используем дефолтное значение
                            custom_icon_url: achievement.tier_custom_icon_url || null
                        });
                    });
                };

                // Обновляем состояние
                console.log(`🔄 Вызов updateAppState с обновлениями:`, {
                    timer_seconds_increment: updatedState._timer_seconds_increment,
                    timer_seconds: updatedState.timer_seconds,
                    total_donated: updatedState.total_donated
                });

                updateAppState(updatedState, (err) => {
                    if (err) {
                        console.error('❌ Ошибка обновления состояния:', err);
                        console.error('   Это может привести к потере времени в таймере!');
                        return;
                    }

                    console.log(`✅ Донат обработан для всех режимов`);
                    console.log(`   🎯 Фраги: +${fragUnitsEarned} ${state.frag_name}, остаток: ${fragRemainingBalance}₽`);
                    console.log(`   ⏰ Время: +${timeEarned} сек (должно быть добавлено в таймер)`);
                    console.log(`   🎨 Кастом: +${customUnitsEarned} ${state.custom_goal_name}, остаток: ${customRemainingBalance}₽`);

                    // Проверяем, что время действительно было добавлено (с небольшой задержкой для завершения транзакции)
                    setTimeout(() => {
                        getAppState((updatedStateCheck) => {
                            if (updatedStateCheck) {
                                const actualTimerSeconds = updatedStateCheck.timer_seconds || 0;
                                const expectedTimerSeconds = (state.timer_seconds || 0) + timeEarned;
                                const difference = Math.abs(actualTimerSeconds - expectedTimerSeconds);
                                if (difference > 1) {
                                    console.warn(`⚠️ ВНИМАНИЕ: Возможная проблема с обновлением таймера!`);
                                    console.warn(`   Ожидалось: ${expectedTimerSeconds} сек, фактически: ${actualTimerSeconds} сек`);
                                    console.warn(`   Разница: ${actualTimerSeconds - expectedTimerSeconds} сек`);
                                    console.warn(`   Это может быть вызвано параллельным обновлением таймера или ошибкой в БД`);
                                } else {
                                    console.log(`✅ Проверка таймера: время корректно обновлено (${actualTimerSeconds} сек, ожидалось ${expectedTimerSeconds} сек)`);
                                }
                            }
                        });
                    }, 100);

                    // Получаем достижение донатера и отправляем алерты
                    // Используем небольшую задержку, чтобы дать время БД обновиться после updateDonorAchievement
                    setTimeout(() => {
                        getDonorAchievement((donorAchievement) => {
                            // Получаем полное обновленное состояние для отправки
                            getAppState((fullState) => {
                                // Отправляем обновление состояния всем клиентам
                                broadcastStateUpdate(fullState);

                                // Отправляем информацию о новом донате
                                console.log(`📢 Отправка NEW_DONATION через WebSocket: ID=${donation.id}, username=${donation.username}, amount=${donation.amount}₽`);
                                broadcastToClients({
                                    type: 'NEW_DONATION',
                                    donation: {
                                        ...donation,
                                        donorAchievement: donorAchievement // Добавляем достижение донатера
                                    },
                                    state: getBroadcastState(fullState)
                                });

                                // Показываем алерты ДЛЯ ВСЕХ режимов независимо от текущего
                                const mode1Alert = {
                                    ...alertData,
                                    unitName: state.frag_name,
                                    unitsEarned: fragUnitsEarned,
                                    alertMode: 'mode1',
                                    fragDisplayType: alertData.fragDisplayType
                                };
                                const mode2Alert = {
                                    ...alertData,
                                    unitName: 'времени',
                                    unitsEarned: timeEarned,
                                    alertMode: 'mode2',
                                    donorAchievement: donorAchievement
                                };
                                const mode3Alert = {
                                    ...alertData,
                                    unitName: state.custom_goal_name,
                                    unitsEarned: customUnitsEarned,
                                    alertMode: 'mode3'
                                };

                                console.log('🚨 Отправка алертов для всех режимов:', {
                                    mode1: { units: fragUnitsEarned },
                                    mode2: { seconds: timeEarned, achievement: donorAchievement },
                                    mode3: { units: customUnitsEarned }
                                });
                                broadcastToClients({ type: 'SHOW_ALERT', donation: mode1Alert });
                                broadcastToClients({ type: 'SHOW_ALERT', donation: mode2Alert });
                                broadcastToClients({ type: 'SHOW_ALERT', donation: mode3Alert });
                            });
                        });
                    }, 100);
                });
            });
        });
    }

    return { processDonation, processDonationCore, formatTimeDetailed };
}

module.exports = { createDonationOrchestrator };
