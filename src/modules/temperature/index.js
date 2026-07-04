'use strict';
/**
 * Режим «температуры»: донаты греют шкалу, она остывает раз в секунду;
 * при достижении пика — разово награда временем в таймер (режим 2).
 * Вынесено из server.js 1:1. Deps: getAppState, updateAppState, broadcastToClients.
 */

function createTemperatureModule({ getAppState, updateAppState, broadcastToClients }) {
    let temperatureMode = {
        active: false,
        currentAmount: 0, // текущая сумма в рублях
        targetAmount: 10000, // целевая сумма для пика
        coolingRate: 50, // скорость охлаждения в рублях в секунду
        peakRewardMinutes: 5, // минут добавляется при достижении пика
        lastHeatUpdate: Date.now(),
        // Таймер автоотключения режима перегрева
        autoOffDurationSec: 0, // 0 = без автоотключения, иначе длительность в секундах
        autoOffUntilTs: 0,      // unix‑время, когда нужно выключить режим
        peakReached: false      // флаг, что пик уже достигнут (чтобы награда выдавалась только один раз)
    };

    // Нагрев от доната
    function heatFromDonation(amount) {
        console.log(`🔥🔥🔥 heatFromDonation вызвана с суммой: ${amount}₽, режим активен: ${temperatureMode.active}`);
        console.log(`🔥🔥🔥 Текущая сумма до нагрева: ${temperatureMode.currentAmount}₽`);

        if (!temperatureMode.active) {
            console.log('🔥🔥🔥 Режим температуры неактивен, пропускаем нагрев');
            return;
        }

        // Добавляем сумму доната к текущей сумме
        temperatureMode.currentAmount += amount;

        console.log(`🔥🔥🔥 Донат ${amount}₽ добавил к температуре. Текущая сумма: ${temperatureMode.currentAmount.toFixed(0)}₽`);

        // Уведомляем клиентов
        broadcastToClients({
            type: 'temperature_update',
            currentAmount: temperatureMode.currentAmount,
            targetAmount: temperatureMode.targetAmount,
            coolingRate: temperatureMode.coolingRate,
            peakRewardMinutes: temperatureMode.peakRewardMinutes,
            autoOffDurationSec: temperatureMode.autoOffDurationSec,
            autoOffUntilTs: temperatureMode.autoOffUntilTs
        });

        console.log(`🔥🔥🔥 Отправлено обновление температуры клиентам`);
    }

    // Обновление температуры (охлаждение)
    function updateTemperature() {
        if (!temperatureMode.active) return;

        const now = Date.now();
        const nowSec = Math.floor(now / 1000);

        // Проверяем таймер автоотключения режима перегрева
        if (temperatureMode.autoOffUntilTs && nowSec >= temperatureMode.autoOffUntilTs) {
            temperatureMode.active = false;
            temperatureMode.currentAmount = 0;
            temperatureMode.autoOffUntilTs = 0;
            temperatureMode.lastHeatUpdate = now;
            temperatureMode.peakReached = false; // Сбрасываем флаг при выключении

            console.log('🔥 Режим температуры автоматически выключен по таймеру');

            broadcastToClients({
                type: 'temperature_mode_toggle',
                active: temperatureMode.active,
                currentAmount: temperatureMode.currentAmount,
                targetAmount: temperatureMode.targetAmount,
                coolingRate: temperatureMode.coolingRate,
                peakRewardMinutes: temperatureMode.peakRewardMinutes,
                autoOffDurationSec: temperatureMode.autoOffDurationSec,
                autoOffUntilTs: temperatureMode.autoOffUntilTs
            });

            return;
        }
        const deltaTime = (now - temperatureMode.lastHeatUpdate) / 1000; // секунды
        temperatureMode.lastHeatUpdate = now;

        // Охлаждение (уменьшение суммы)
        temperatureMode.currentAmount = Math.max(0, temperatureMode.currentAmount - (temperatureMode.coolingRate * deltaTime));

        // Отправляем обновление клиентам при остывании
        broadcastToClients({
            type: 'temperature_update',
            currentAmount: temperatureMode.currentAmount,
            targetAmount: temperatureMode.targetAmount,
            coolingRate: temperatureMode.coolingRate,
            peakRewardMinutes: temperatureMode.peakRewardMinutes,
            autoOffDurationSec: temperatureMode.autoOffDurationSec,
            autoOffUntilTs: temperatureMode.autoOffUntilTs
        });

        // Проверка достижения пика (только если еще не достигли)
        if (temperatureMode.currentAmount >= temperatureMode.targetAmount && !temperatureMode.peakReached) {
            // Получаем текущее состояние и добавляем время к таймеру
            getAppState((state) => {
                if (!state) return;

                // Добавляем время к таймеру
                const rewardSeconds = temperatureMode.peakRewardMinutes * 60;
                const newTimerSeconds = (state.timer_seconds || 0) + rewardSeconds;

                // Устанавливаем флаг, что пик достигнут
                temperatureMode.peakReached = true;

                console.log(`🔥 Температура достигла пика! Добавлено ${temperatureMode.peakRewardMinutes} минут к таймеру`);
                console.log(`🔥 Таймер: ${state.timer_seconds}с + ${rewardSeconds}с = ${newTimerSeconds}с`);

                // Обновляем состояние в БД
                updateAppState({
                    timer_seconds: newTimerSeconds
                }, (err) => {
                    if (err) {
                        console.error('❌ Ошибка обновления состояния после пика температуры:', err);
                    } else {
                        console.log('✅ Состояние обновлено после пика температуры');
                    }
                });

                // Уведомляем клиентов
                broadcastToClients({
                    type: 'temperature_peak',
                    rewardMinutes: temperatureMode.peakRewardMinutes,
                    newTimerSeconds: newTimerSeconds
                });
            });
        }

        // Сбрасываем флаг достижения пика, если температура упала ниже целевой
        if (temperatureMode.currentAmount < temperatureMode.targetAmount && temperatureMode.peakReached) {
            temperatureMode.peakReached = false;
            console.log('🔥 Температура упала ниже пика, флаг сброшен');
        }
    }

    function registerRoutes(app) {
        // API для управления режимом температуры
        app.post('/api/temperature/toggle', (req, res) => {
            const body = req.body || {};
            const durationSecondsRaw = parseInt(body.durationSeconds, 10);
            const durationSeconds = Number.isFinite(durationSecondsRaw) && durationSecondsRaw > 0
                ? Math.min(durationSecondsRaw, 360 * 60) // максимум 6 часов
                : 0;

            const nowSec = Math.floor(Date.now() / 1000);

            // Переключаем режим
            temperatureMode.active = !temperatureMode.active;
            temperatureMode.currentAmount = 0;
            temperatureMode.lastHeatUpdate = Date.now();
            temperatureMode.peakReached = false; // Сбрасываем флаг при переключении

            if (temperatureMode.active) {
                // Включили режим: стартуем таймер автоотключения (если задан)
                if (durationSeconds > 0) {
                    temperatureMode.autoOffDurationSec = durationSeconds;
                    temperatureMode.autoOffUntilTs = nowSec + durationSeconds;
                } else if (temperatureMode.autoOffDurationSec > 0) {
                    // Используем сохранённую длительность
                    temperatureMode.autoOffUntilTs = nowSec + temperatureMode.autoOffDurationSec;
                } else {
                    // Автоотключение отключено
                    temperatureMode.autoOffUntilTs = 0;
                }
            } else {
                // Выключили режим вручную — очищаем таймер автоотключения
                temperatureMode.autoOffUntilTs = 0;
            }

            console.log(`🔥 Режим температуры ${temperatureMode.active ? 'включен' : 'выключен'}`);

            broadcastToClients({
                type: 'temperature_mode_toggle',
                active: temperatureMode.active,
                currentAmount: temperatureMode.currentAmount,
                targetAmount: temperatureMode.targetAmount,
                coolingRate: temperatureMode.coolingRate,
                peakRewardMinutes: temperatureMode.peakRewardMinutes,
                autoOffDurationSec: temperatureMode.autoOffDurationSec,
                autoOffUntilTs: temperatureMode.autoOffUntilTs
            });

            res.json({
                success: true,
                active: temperatureMode.active,
                autoOffDurationSec: temperatureMode.autoOffDurationSec,
                autoOffUntilTs: temperatureMode.autoOffUntilTs
            });
        });

        app.post('/api/temperature/settings', (req, res) => {
            const { targetAmount, coolingRate, peakRewardMinutes, autoOffMinutes } = req.body;

            if (targetAmount !== undefined) temperatureMode.targetAmount = Math.max(100, Math.min(1000000, parseInt(targetAmount) || 10000));
            if (coolingRate !== undefined) temperatureMode.coolingRate = Math.max(1, Math.min(1000, parseInt(coolingRate) || 50));
            if (peakRewardMinutes !== undefined) temperatureMode.peakRewardMinutes = Math.max(1, Math.min(60, parseInt(peakRewardMinutes) || 5));

            if (autoOffMinutes !== undefined) {
                const minutesRaw = parseInt(autoOffMinutes, 10);
                const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0
                    ? Math.min(minutesRaw, 360) // максимум 6 часов
                    : 0;
                temperatureMode.autoOffDurationSec = minutes * 60;

                // Если режим активен, обновляем время автоотключения
                if (temperatureMode.active && temperatureMode.autoOffDurationSec > 0) {
                    const nowSec = Math.floor(Date.now() / 1000);
                    temperatureMode.autoOffUntilTs = nowSec + temperatureMode.autoOffDurationSec;
                }
            }

            console.log(`🔥 Настройки температуры обновлены:`, {
                targetAmount: temperatureMode.targetAmount,
                coolingRate: temperatureMode.coolingRate,
                peakRewardMinutes: temperatureMode.peakRewardMinutes,
                autoOffDurationSec: temperatureMode.autoOffDurationSec
            });

            res.json({
                success: true,
                settings: {
                    targetAmount: temperatureMode.targetAmount,
                    coolingRate: temperatureMode.coolingRate,
                    peakRewardMinutes: temperatureMode.peakRewardMinutes,
                    autoOffDurationSec: temperatureMode.autoOffDurationSec
                }
            });
        });

        app.post('/api/temperature/hide-all', (req, res) => {
            console.log('👁️ Скрытие всех виджетов температуры');

            // Отправляем команду скрытия всем виджетам температуры
            broadcastToClients({
                type: 'temperature_hide_all',
                hide: true
            });

            res.json({ success: true });
        });

        app.get('/api/temperature/status', (req, res) => {
            res.json({
                success: true,
                temperatureMode: {
                    active: temperatureMode.active,
                    currentAmount: temperatureMode.currentAmount,
                    targetAmount: temperatureMode.targetAmount,
                    coolingRate: temperatureMode.coolingRate,
                    peakRewardMinutes: temperatureMode.peakRewardMinutes,
                    autoOffDurationSec: temperatureMode.autoOffDurationSec,
                    autoOffUntilTs: temperatureMode.autoOffUntilTs
                }
            });
        });
    }

    function start() {
        // Запускаем обновление температуры каждую секунду
        setInterval(updateTemperature, 1000);
    }

    return { heatFromDonation, registerRoutes, start };
}

module.exports = { createTemperatureModule };
