'use strict';

const axios = require('axios');

/**
 * Синхронизация с Lesta API: получение статистики аккаунта, продление токена,
 * применение дельт (запись боёв + АВТОСПИСАНИЕ фрагов из режима 1) и цикл
 * автосинка. Вынос из server.js с семантикой 1:1 — поведение закреплено
 * регресс-тестом scripts/test-lesta-sync.js (npm run test-lesta).
 *
 * deps:
 *   lestaConfig            — LESTA_CONFIG по ссылке (мутируется и здесь, и в server.js)
 *   withLestaApiLock       — очередь внешних API-вызовов
 *   getAppState/updateAppState, db, analytics, broadcastStateUpdate
 *   safeLestaCounterDelta, maxBattlesDelta, historyHeartbeatSec
 *   addBattleForce         — запись боя в frag_stats
 *   insertLestaStatsSnapshot — снапшот в lesta_stats_history
 *   ensureLestaReliableSince — детект «надёжной» границы истории
 *   afterSync(stats, state) — хук после применения статистики (razblog)
 */
function createLestaSyncModule(deps) {
    const LESTA_CONFIG = deps.lestaConfig;
    let lestaSyncTimer = null;

    async function prolongateLestaToken() {
        if (!LESTA_CONFIG.accessToken) {
            console.log('⚠️ Нет access_token для продления');
            return false;
        }

        try {
            console.log('🔄 Продление access_token Lesta Games...');

            const response = await axios.get('https://api.tanki.su/wot/auth/prolongate/', {
                params: {
                    application_id: LESTA_CONFIG.applicationId,
                    access_token: LESTA_CONFIG.accessToken
                },
                timeout: 10000
            });

            if (response.data.status === 'ok') {
                const newToken = response.data.data.access_token;
                const expiresAt = response.data.data.expires_at;

                LESTA_CONFIG.accessToken = newToken;

                deps.updateAppState({
                    lesta_access_token: newToken,
                    lesta_token_expires_at: expiresAt
                }, (err) => {
                    if (err) {
                        console.error('❌ Ошибка сохранения нового токена:', err);
                    } else {
                        console.log('✅ Access_token продлен и сохранен');
                    }
                });

                return true;
            } else {
                console.error('❌ Ошибка продления токена:', response.data.error);
                return false;
            }
        } catch (error) {
            console.error('❌ Ошибка запроса продления токена:', error.message);
            return false;
        }
    }

    async function getLestaPlayerStats() {
        if (!LESTA_CONFIG.applicationId || !LESTA_CONFIG.accountId) {
            return null;
        }

        return deps.withLestaApiLock(async () => {
            // Проверяем срок действия токена и продлеваем при необходимости
            const now = Math.floor(Date.now() / 1000);
            const tokenExpiresAt = LESTA_CONFIG.tokenExpiresAt || 0;

            if (tokenExpiresAt > 0 && (tokenExpiresAt - now) < 3600) { // Продлеваем если осталось меньше часа
                const prolonged = await prolongateLestaToken();
                if (!prolonged) {
                    console.log('⚠️ Не удалось продлить токен Lesta, продолжаем с текущим');
                }
            }

            try {
                const response = await axios.get(`${LESTA_CONFIG.apiUrl}/account/info/`, {
                    params: {
                        application_id: LESTA_CONFIG.applicationId,
                        account_id: LESTA_CONFIG.accountId,
                        access_token: LESTA_CONFIG.accessToken, // Опциональный параметр для приватных данных
                        extra: 'statistics.rating', // Запрашиваем рейтинговую статистику (клановые/турнирные доступны по умолчанию)
                        fields: 'statistics.all.battles,statistics.all.frags,statistics.all.wins,statistics.all.losses,statistics.all.damage_dealt,statistics.all.damage_received,statistics.all.xp,statistics.all.max_frags,statistics.all.frags8p,statistics.all.hits,statistics.all.shots,statistics.all.spotted,statistics.all.capture_points,statistics.all.dropped_capture_points,statistics.all.survived_battles,statistics.all.win_and_survived,statistics.all.max_xp,statistics.rating.battles,statistics.rating.wins,statistics.rating.losses,statistics.rating.frags,statistics.rating.damage_dealt,statistics.rating.xp,statistics.clan.battles,statistics.clan.wins,statistics.clan.losses,statistics.clan.frags,statistics.clan.damage_dealt,statistics.clan.damage_received,statistics.clan.xp,nickname'
                    },
                    timeout: 8000
                });

                if (response.data.status === 'ok' && response.data.data) {
                    const playerData = response.data.data[LESTA_CONFIG.accountId];

                    if (playerData && playerData.statistics && playerData.statistics.all) {
                        const stats = playerData.statistics.all;
                        const ratingStats = playerData.statistics.rating || {};
                        const clanStats = playerData.statistics.clan || {};

                        if (process.env.DEBUG_LESTA === '1') {
                            console.log('📊 Детальная статистика по типам боёв:', {
                                all_battles: stats.battles || 0,
                                rating_battles: ratingStats.battles || 0,
                                clan_battles: clanStats.battles || 0
                            });
                        }

                        // Суммируем все типы боёв: обычные (all) + рейтинговые (rating) + клановые/турнирные (clan)
                        // По документации API, statistics.all.battles может не включать рейтинговые и клановые бои
                        const totalBattles = (stats.battles || 0) + (ratingStats.battles || 0) + (clanStats.battles || 0);
                        const totalWins = (stats.wins || 0) + (ratingStats.wins || 0) + (clanStats.wins || 0);
                        const totalLosses = (stats.losses || 0) + (ratingStats.losses || 0) + (clanStats.losses || 0);
                        const totalFrags = (stats.frags || 0) + (ratingStats.frags || 0) + (clanStats.frags || 0);
                        const totalDamageDealt = (stats.damage_dealt || 0) + (ratingStats.damage_dealt || 0) + (clanStats.damage_dealt || 0);
                        const totalXp = (stats.xp || 0) + (ratingStats.xp || 0) + (clanStats.xp || 0);

                        if (process.env.DEBUG_LESTA === '1') {
                            console.log('✅ Lesta sync:', playerData.nickname, 'battles', totalBattles, 'frags', totalFrags);
                        }

                        return {
                            nickname: playerData.nickname || LESTA_CONFIG.nickname,
                            battles: totalBattles,
                            frags: totalFrags,
                            wins: totalWins,
                            losses: totalLosses,
                            damage_dealt: totalDamageDealt,
                            damage_received: stats.damage_received || 0,
                            xp: totalXp,
                            max_frags: stats.max_frags || 0,
                            frags8p: stats.frags8p || 0,
                            hits: stats.hits || 0,
                            shots: stats.shots || 0,
                            spotted: stats.spotted || 0,
                            capture_points: stats.capture_points || 0,
                            dropped_capture_points: stats.dropped_capture_points || 0,
                            survived_battles: stats.survived_battles || 0,
                            win_and_survived: stats.win_and_survived || 0,
                            max_xp: stats.max_xp || 0,
                            winRate: totalBattles > 0 ? (totalWins / totalBattles * 100).toFixed(1) : 0,
                            fragsPerBattle: totalBattles > 0 ? (totalFrags / totalBattles).toFixed(2) : 0,
                            avgDamage: totalBattles > 0 ? (totalDamageDealt / totalBattles).toFixed(0) : 0,
                            avgXp: totalBattles > 0 ? (totalXp / totalBattles).toFixed(0) : 0,
                            accuracy: stats.shots > 0 ? (stats.hits / stats.shots * 100).toFixed(1) : 0
                        };
                    } else {
                        console.log('⚠️ Статистика не найдена в ответе API');
                        console.log('🔍 Структура данных:', JSON.stringify(playerData, null, 2));
                    }
                } else if (response.data.status === 'error') {
                    console.error('❌ Ошибка Lesta Games API:', response.data.error);
                } else {
                    console.log('⚠️ Неожиданный статус ответа:', response.data.status);
                }

                console.log('⚠️ Не удалось получить статистику Lesta Games');
                return null;
            } catch (error) {
                console.error('❌ Ошибка API Lesta Games:', error.response?.status, error.response?.data || error.message);

                // Обработка ошибок согласно документации Lesta Games API
                if (error.response?.data?.error) {
                    const apiError = error.response.data.error;
                    console.error('API Error:', apiError.code, apiError.message);

                    switch (apiError.code) {
                        case 'ACCOUNT_ID_NOT_SPECIFIED':
                            console.error('❌ Не заполнено обязательное поле account_id');
                            break;
                        case 'INVALID_APPLICATION_ID':
                            console.error('❌ Неверный идентификатор приложения');
                            break;
                        case 'REQUEST_LIMIT_EXCEEDED':
                            console.error('❌ Превышены лимиты квотирования');
                            break;
                        case 'SOURCE_NOT_AVAILABLE':
                            console.error('❌ Источник данных не доступен');
                            break;
                        default:
                            console.error('❌ Неизвестная ошибка API:', apiError.code);
                    }
                }

                return null;
            }
        });
    }

    // Применение свежей статистики: дельты боёв/фрагов, запись боёв,
    // АВТОСПИСАНИЕ фрагов из режима 1, снапшот истории, broadcast, afterSync-хук.
    function applyLestaStats(stats) {
        deps.analytics.logEvent('lesta_sync', {
            battles: stats.battles,
            frags: stats.frags,
            winRate: stats.winRate,
            fragsPerBattle: stats.fragsPerBattle
        });

        deps.getAppState((state) => {
            if (!state) return;

            const previousFrags = state.lesta_previous_frags || 0;
            const currentFrags = stats.frags;
            const fragsDifference = currentFrags - previousFrags;

            const previousCounters = {
                battles: state.lesta_last_battles || 0,
                frags: state.lesta_last_frags || 0,
                wins: state.lesta_last_wins || 0,
                losses: state.lesta_last_losses || 0,
                damage_dealt: state.lesta_last_damage_dealt || 0,
                xp: state.lesta_last_xp || 0
            };

            const battlesSafe = deps.safeLestaCounterDelta(previousCounters.battles, stats.battles);
            const battlesDifference = battlesSafe.resync ? 0 : battlesSafe.delta;
            const effectiveFragsDifference = battlesSafe.resync ? 0 : fragsDifference;

            if (battlesDifference > 0) {
                console.log(`📊 Новых боев от Lesta API: ${battlesDifference}, изменение фрагов: ${effectiveFragsDifference}`);

                let remainingFrags = effectiveFragsDifference;

                for (let i = 0; i < battlesDifference; i++) {
                    let battleFrags = 0;

                    if (remainingFrags > 0) {
                        battleFrags = remainingFrags;
                        remainingFrags = 0;
                    }

                    deps.addBattleForce(new Date().toISOString(), battleFrags, 'lesta');
                    console.log(`✅ Записан бой ${i + 1}/${battlesDifference}: ${battleFrags} фрагов`);
                }
            } else if (effectiveFragsDifference > 0) {
                console.log(`ℹ️ Изменение фрагов без новых боев: +${effectiveFragsDifference} (боев не добавляем)`);
            } else if (battlesSafe.resync) {
                console.log(`ℹ️ Lesta: пересчёт статистики API (${previousCounters.battles} → ${stats.battles}), бои не добавляем`);
            }

            const statsChanged =
                stats.battles !== (state.lesta_last_battles || 0) ||
                stats.frags !== (state.lesta_last_frags || 0) ||
                stats.wins !== (state.lesta_last_wins || 0) ||
                stats.damage_dealt !== (state.lesta_last_damage_dealt || 0);

            const nowSec = Math.floor(Date.now() / 1000);
            const lastHistoryAt = Number(state.lesta_last_history_at) || 0;
            const needsHeartbeat = (nowSec - lastHistoryAt) >= deps.historyHeartbeatSec;
            const hasActivity = statsChanged || effectiveFragsDifference > 0 || battlesDifference > 0;

            if (!hasActivity) {
                if (needsHeartbeat) {
                    deps.updateAppState({ lesta_last_sync_time: nowSec }, (err) => {
                        if (!err) deps.insertLestaStatsSnapshot(stats, 0, previousCounters, state.lesta_account_id);
                    });
                } else {
                    deps.updateAppState({ lesta_last_sync_time: nowSec }, () => {});
                }
                return;
            }

            const updates = {
                lesta_last_battles: stats.battles,
                lesta_last_frags: stats.frags,
                lesta_last_wins: stats.wins,
                lesta_last_losses: stats.losses,
                lesta_last_win_rate: parseFloat(stats.winRate),
                lesta_last_frags_per_battle: parseFloat(stats.fragsPerBattle),
                lesta_last_damage_dealt: stats.damage_dealt,
                lesta_last_damage_received: stats.damage_received,
                lesta_last_xp: stats.xp,
                lesta_last_max_frags: stats.max_frags,
                lesta_last_frags8p: stats.frags8p,
                lesta_last_hits: stats.hits,
                lesta_last_shots: stats.shots,
                lesta_last_spotted: stats.spotted,
                lesta_last_capture_points: stats.capture_points,
                lesta_last_dropped_capture_points: stats.dropped_capture_points,
                lesta_last_survived_battles: stats.survived_battles,
                lesta_last_win_and_survived: stats.win_and_survived,
                lesta_last_max_xp: stats.max_xp,
                lesta_previous_frags: currentFrags,
                lesta_last_sync_time: nowSec
            };

            deps.updateAppState(updates, (err) => {
                if (err) {
                    console.error('❌ Ошибка обновления статистики Lesta Games:', err);
                } else if (process.env.DEBUG_LESTA === '1') {
                    console.log('✅ Статистика Lesta Games обновлена в БД');
                }

                if (err) {
                    // skip history/broadcast on error
                } else if (statsChanged || effectiveFragsDifference !== 0) {
                    deps.insertLestaStatsSnapshot(stats, effectiveFragsDifference, previousCounters, state.lesta_account_id);
                    // Если фраги увеличились, автоматически списываем фраги
                    if (effectiveFragsDifference > 0) {
                        console.log(`🎯 Обнаружено увеличение фрагов: +${effectiveFragsDifference}`);
                        console.log(`   Было: ${previousFrags}, Стало: ${currentFrags}`);

                        // Списываем фраги из режима 1 (фраг-трекер)
                        deps.getAppState((currentState) => {
                            if (currentState) {
                                const currentNeeded = currentState.frags_needed || 0;
                                const currentDone = currentState.frags_done || 0;

                                const toComplete = Math.min(currentNeeded, effectiveFragsDifference);

                                if (toComplete > 0) {
                                    const newNeeded = currentNeeded - toComplete;
                                    const newDone = currentDone + toComplete;

                                    deps.updateAppState({
                                        frags_needed: newNeeded,
                                        frags_done: newDone
                                    }, (dErr) => {
                                        if (dErr) {
                                            console.error('❌ Ошибка списания фрагов:', dErr);
                                        } else {
                                            console.log(`✅ Автоматически списано ${toComplete} фрагов из режима 1`);
                                            console.log(`   Нужно сделать: ${newNeeded}, Сделано: ${newDone}`);

                                            // Обновляем последнюю запись в истории с информацией о списанных фрагах
                                            deps.db.run(`UPDATE lesta_stats_history
                                                    SET auto_deducted = ?
                                                    WHERE id = (SELECT MAX(id) FROM lesta_stats_history)`,
                                                [toComplete],
                                                function(uErr) {
                                                    if (uErr) {
                                                        console.error('❌ Ошибка обновления истории автосписания:', uErr);
                                                    }
                                                }
                                            );

                                            // Логируем событие автосписания
                                            deps.analytics.logEvent('lesta_auto_deduct', {
                                                frags_difference: fragsDifference,
                                                frags_deducted: toComplete,
                                                previous_frags: previousFrags,
                                                current_frags: currentFrags
                                            });
                                        }
                                    });
                                } else {
                                    console.log(`ℹ️ Нет фрагов для списания (нужно сделать: ${currentNeeded})`);
                                }
                            }
                        });
                    }
                }

                if (!err && (statsChanged || fragsDifference !== 0)) {
                    Object.assign(state, updates);
                    deps.broadcastStateUpdate(state);
                }

                if (!err && deps.afterSync) {
                    try {
                        deps.afterSync(stats, state);
                    } catch (hookErr) {
                        console.warn('⚠️ afterSync-хук Lesta упал:', hookErr.message);
                    }
                }
            });
        });
    }

    async function startLestaAutoSync() {
        if (lestaSyncTimer) {
            clearTimeout(lestaSyncTimer);
        }
        if (process.env.LESTA_AUTOSYNC === '0') {
            console.log('⏸️ Автосинхронизация Lesta отключена (LESTA_AUTOSYNC=0)');
            return;
        }

        console.log('🔄 Запуск автосинхронизации Lesta Games...');
        deps.ensureLestaReliableSince();

        const syncLesta = async () => {
            try {
                const stats = await getLestaPlayerStats();
                if (stats) applyLestaStats(stats);
            } catch (error) {
                console.error('❌ Ошибка автосинхронизации Lesta Games:', error.message);
            } finally {
                // Повторяем каждые 20 секунд (реже — меньше нагрузка на Lesta и SQLite)
                lestaSyncTimer = setTimeout(syncLesta, 20 * 1000);
            }
        };

        // Запускаем первую синхронизацию
        syncLesta();
    }

    function stopLestaAutoSync() {
        if (lestaSyncTimer) {
            clearTimeout(lestaSyncTimer);
            lestaSyncTimer = null;
        }
        console.log('⏹️ Автосинхронизация Lesta Games остановлена');
    }

    return { prolongateLestaToken, getLestaPlayerStats, applyLestaStats, startLestaAutoSync, stopLestaAutoSync };
}

module.exports = { createLestaSyncModule };
