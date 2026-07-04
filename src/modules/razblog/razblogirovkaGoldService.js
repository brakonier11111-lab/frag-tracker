const {
    calculateGoldDistributed,
    inferBattleOutcomesFromAccountDelta
} = require('./goldCalculator');

/** Событие «РазБЛОГировка 2026» — учитываем бои с 11 июня 2025 (МСК) */
const DEFAULT_EVENT_START_ISO = '2025-06-11T00:00:00+03:00';

/**
 * Синхронизация только по агрегированной статистике аккаунта Lesta:
 * battles, wins, survived_battles. Детали отдельного боя API не отдаёт.
 *
 * @param {import('sqlite3').Database} db
 * @param {Function} getAppState
 * @param {Function} updateAppState
 * @param {() => Promise<object|null>} getLestaPlayerStats
 * @param {(msg: object) => void} broadcastToClients
 */
const MAX_AVG_DAMAGE_PER_BATTLE = 20000;

/** Урон вручную записанных боёв сессии */
const KNOWN_SESSION_DAMAGE = {
    'session-1': 3884,
    'session-2': 5027,
    'session-3': 4351,
    'session-4': 2009
};

function getPrevSyncDamage(state) {
    const lastSync = Number(state.razblog_last_sync_damage_dealt) || 0;
    if (lastSync > 0) return lastSync;
    return Number(state.razblog_baseline_damage_dealt) || 0;
}

function computeAvgDamageFromTotals(totalDamage, battlesWithDamage) {
    if (!battlesWithDamage || battlesWithDamage <= 0 || totalDamage <= 0) {
        return 0;
    }
    const avg = Math.round(totalDamage / battlesWithDamage);
    return avg > MAX_AVG_DAMAGE_PER_BATTLE ? 0 : avg;
}

function createRazblogirovkaGoldService(deps) {
    const { db, getAppState, updateAppState, getLestaPlayerStats, broadcastToClients } = deps;

    function repairBaselineDamageIfNeeded(state, cb) {
        if (!state || !state.razblog_tracking_active) {
            return cb(null, state);
        }
        if ((Number(state.razblog_baseline_damage_dealt) || 0) > 0) {
            return cb(null, state);
        }
        const baselineBattles = Number(state.razblog_baseline_battles) || 0;
        if (baselineBattles <= 0) {
            return cb(null, state);
        }

        db.get(
            `SELECT damage_dealt FROM lesta_stats_history
             WHERE battles <= ? AND damage_dealt IS NOT NULL AND damage_dealt > 0
             ORDER BY battles DESC, id DESC LIMIT 1`,
            [baselineBattles],
            (histErr, row) => {
                if (histErr) return cb(histErr, state);

                const fromHistory = row ? Number(row.damage_dealt) || 0 : 0;
                if (fromHistory > 0) {
                    return updateAppState({ razblog_baseline_damage_dealt: fromHistory }, (updErr) => {
                        if (updErr) return cb(updErr, state);
                        state.razblog_baseline_damage_dealt = fromHistory;
                        cb(null, state);
                    });
                }

                getLestaPlayerStats().then((stats) => {
                    if (!stats || stats.damage_dealt == null) {
                        return cb(null, state);
                    }
                    const fallback = Number(stats.damage_dealt) || 0;
                    if (fallback <= 0) {
                        return cb(null, state);
                    }
                    updateAppState({ razblog_baseline_damage_dealt: fallback }, (updErr) => {
                        if (updErr) return cb(updErr, state);
                        state.razblog_baseline_damage_dealt = fallback;
                        cb(null, state);
                    });
                }).catch(() => cb(null, state));
            }
        );
    }

    function getEventStartSec(state) {
        const raw = state && state.razblog_event_start_iso;
        const iso = raw && String(raw).trim() ? String(raw).trim() : DEFAULT_EVENT_START_ISO;
        const ms = Date.parse(iso);
        return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.parse(DEFAULT_EVENT_START_ISO) / 1000);
    }

    function insertBattleRow(row, cb) {
        db.run(
            `INSERT OR IGNORE INTO razblogirovka_battles
             (battle_key, played_at, gold_amount, won, survived, damage_dealt)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                row.battleKey,
                row.playedAt,
                row.goldAmount,
                row.won ? 1 : 0,
                row.survived ? 1 : 0,
                row.damageDealt != null ? row.damageDealt : null
            ],
            function(err) {
                if (err) return cb(err);
                cb(null, { inserted: this.changes > 0, id: this.lastID });
            }
        );
    }

    function backfillMissingBattleDamage(state, cb) {
        if (!state || !state.razblog_tracking_active) {
            return cb(null);
        }

        db.all(
            'SELECT id, battle_key, damage_dealt FROM razblogirovka_battles ORDER BY id',
            [],
            (err, rows) => {
                if (err) return cb(err);
                if (!rows || !rows.length) return cb(null);

                const missing = rows.filter((r) => !r.damage_dealt || r.damage_dealt <= 0);
                if (!missing.length) return cb(null);

                const baseline = Number(state.razblog_baseline_damage_dealt) || 0;
                const current = Number(state.lesta_last_damage_dealt) || 0;
                const totalDelta = baseline > 0 && current > baseline
                    ? current - baseline
                    : 0;

                let assigned = 0;
                const updates = [];

                for (const row of rows) {
                    if (row.damage_dealt > 0) {
                        assigned += row.damage_dealt;
                    } else if (KNOWN_SESSION_DAMAGE[row.battle_key]) {
                        const dmg = KNOWN_SESSION_DAMAGE[row.battle_key];
                        updates.push({ id: row.id, damage: dmg });
                        assigned += dmg;
                    }
                }

                const stillMissing = rows.filter((r) => {
                    if (r.damage_dealt > 0) return false;
                    if (KNOWN_SESSION_DAMAGE[r.battle_key]) return false;
                    return true;
                });

                if (stillMissing.length > 0 && totalDelta > assigned) {
                    const share = Math.round((totalDelta - assigned) / stillMissing.length);
                    for (const row of stillMissing) {
                        updates.push({ id: row.id, damage: share });
                    }
                }

                if (!updates.length) return cb(null);

                let idx = 0;
                const runNext = () => {
                    if (idx >= updates.length) return cb(null);
                    const u = updates[idx++];
                    db.run(
                        'UPDATE razblogirovka_battles SET damage_dealt = ? WHERE id = ?',
                        [u.damage, u.id],
                        (updErr) => {
                            if (updErr) return cb(updErr);
                            runNext();
                        }
                    );
                };
                runNext();
            }
        );
    }

    function loadSummary(cb) {
        db.all(
            `SELECT battle_key, played_at, gold_amount, won, survived, created_at
             FROM razblogirovka_battles
             ORDER BY id DESC
             LIMIT 8`,
            [],
            (histErr, historyRows) => {
                if (histErr) return cb(histErr);
                db.get(
                    `SELECT COUNT(*) AS battles_count,
                            COALESCE(SUM(gold_amount), 0) AS total_gold,
                            COALESCE(SUM(CASE WHEN survived = 1 THEN 1 ELSE 0 END), 0) AS survived_count,
                            COALESCE(SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END), 0) AS wins_count,
                            COALESCE(SUM(damage_dealt), 0) AS total_damage,
                            SUM(CASE WHEN damage_dealt IS NOT NULL AND damage_dealt > 0 THEN 1 ELSE 0 END) AS damage_rows
                     FROM razblogirovka_battles`,
                    [],
                    (sumErr, sumRow) => {
                        if (sumErr) return cb(sumErr);
                        getAppState((state) => {
                            const finishSummary = (repairedState, row) => {
                                const dataRow = row || sumRow;
                                const tracking = !!(repairedState && repairedState.razblog_tracking_active);
                                const battlesCount = dataRow ? Number(dataRow.battles_count) || 0 : 0;
                                const winsCount = dataRow ? Number(dataRow.wins_count) || 0 : 0;
                                const damageRows = dataRow ? Number(dataRow.damage_rows) || 0 : 0;
                                const totalDamage = dataRow ? Number(dataRow.total_damage) || 0 : 0;
                                const avgDamage = computeAvgDamageFromTotals(totalDamage, damageRows);
                                const winRatePercent = battlesCount > 0
                                    ? Math.round((winsCount / battlesCount) * 1000) / 10
                                    : 0;
                                cb(null, {
                                    tracking,
                                    eventStartIso: (repairedState && repairedState.razblog_event_start_iso) || DEFAULT_EVENT_START_ISO,
                                    totalGold: dataRow ? Number(dataRow.total_gold) || 0 : 0,
                                    battlesCount,
                                    winsCount,
                                    survivedBattlesCount: dataRow ? Number(dataRow.survived_count) || 0 : 0,
                                    winRatePercent,
                                    avgDamage,
                                    widgetShowWinRate: !!(repairedState && repairedState.razblog_widget_show_win_rate),
                                    widgetShowAvgDamage: !!(repairedState && repairedState.razblog_widget_show_avg_damage),
                                    history: (historyRows || []).map((r) => ({
                                        battleKey: r.battle_key,
                                        playedAt: r.played_at,
                                        goldAmount: r.gold_amount,
                                        won: !!r.won,
                                        survived: !!r.survived,
                                        createdAt: r.created_at
                                    })),
                                    lastSyncAt: repairedState && repairedState.razblog_last_sync_at
                                        ? repairedState.razblog_last_sync_at
                                        : null
                                });
                            };

                            const needsRepair = state
                                && state.razblog_tracking_active
                                && (Number(state.razblog_baseline_damage_dealt) || 0) === 0
                                && (Number(state.razblog_baseline_battles) || 0) > 0;

                            const needsBackfill = sumRow
                                && Number(sumRow.battles_count) > 0
                                && Number(sumRow.damage_rows || 0) < Number(sumRow.battles_count);

                            const afterRepair = (repairedState) => {
                                if (!needsBackfill) {
                                    return finishSummary(repairedState, sumRow);
                                }
                                backfillMissingBattleDamage(repairedState, (bfErr) => {
                                    if (bfErr) return cb(bfErr);
                                    db.get(
                                        `SELECT COUNT(*) AS battles_count,
                                                COALESCE(SUM(gold_amount), 0) AS total_gold,
                                                COALESCE(SUM(CASE WHEN survived = 1 THEN 1 ELSE 0 END), 0) AS survived_count,
                                                COALESCE(SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END), 0) AS wins_count,
                                                COALESCE(SUM(damage_dealt), 0) AS total_damage,
                                                SUM(CASE WHEN damage_dealt IS NOT NULL AND damage_dealt > 0 THEN 1 ELSE 0 END) AS damage_rows
                                         FROM razblogirovka_battles`,
                                        [],
                                        (reSumErr, reSumRow) => {
                                            if (reSumErr) return cb(reSumErr);
                                            finishSummary(repairedState, reSumRow);
                                        }
                                    );
                                });
                            };

                            if (needsRepair) {
                                repairBaselineDamageIfNeeded(state, (repairErr, repairedState) => {
                                    if (repairErr) return cb(repairErr);
                                    afterRepair(repairedState);
                                });
                            } else {
                                afterRepair(state);
                            }
                        });
                    }
                );
            }
        );
    }

    function broadcastSummary() {
        loadSummary((err, summary) => {
            if (!err && summary) {
                broadcastToClients({ type: 'RAZBLOGIROVKA_GOLD_UPDATE', data: summary });
            }
        });
    }

    async function syncFromLestaStats(options, callback) {
        options = options || {};
        let stats = options.stats || null;
        if (!stats) {
            stats = await getLestaPlayerStats();
        }
        if (!stats) {
            return callback(new Error('Не удалось получить статистику Lesta'));
        }

        getAppState((state) => {
            if (!state) return callback(new Error('Нет состояния приложения'));

            if (state.razblog_tracking_active
                && (Number(state.razblog_baseline_damage_dealt) || 0) === 0
                && (Number(state.razblog_baseline_battles) || 0) > 0) {
                return repairBaselineDamageIfNeeded(state, (fixErr, repairedState) => {
                    if (fixErr) return callback(fixErr);
                    state = repairedState;
                    continueSync();
                });
            }

            continueSync();

            function continueSync() {
            if (!state.razblog_tracking_active) {
                return loadSummary((e, summary) => {
                    if (e) return callback(e);
                    callback(null, { ...summary, message: 'Отслеживание не запущено' });
                });
            }

            const eventStartSec = getEventStartSec(state);
            const nowSec = Math.floor(Date.now() / 1000);
            if (nowSec < eventStartSec && !options.force) {
                return loadSummary((e, summary) => callback(e, { ...summary, message: 'Событие ещё не началось' }));
            }

            const prevBattles = state.razblog_last_sync_battles != null
                ? state.razblog_last_sync_battles
                : (state.razblog_baseline_battles || stats.battles);
            const prevWins = state.razblog_last_sync_wins != null
                ? state.razblog_last_sync_wins
                : (state.razblog_baseline_wins || stats.wins);
            const prevSurvived = state.razblog_last_sync_survived != null
                ? state.razblog_last_sync_survived
                : (state.razblog_baseline_survived || stats.survived_battles || 0);

            const battlesDiff = stats.battles - prevBattles;
            const winsDiff = stats.wins - prevWins;
            const survivedDiff = (stats.survived_battles || 0) - prevSurvived;

            if (battlesDiff < 0) {
                return callback(new Error('Счётчик боёв Lesta уменьшился — сбросьте базовую линию отслеживания'));
            }

            const newBattleOutcomes = battlesDiff > 0
                ? inferBattleOutcomesFromAccountDelta(battlesDiff, winsDiff, survivedDiff)
                : [];

            const prevDamage = getPrevSyncDamage(state);
            const damageDiff = Math.max(0, (stats.damage_dealt || 0) - prevDamage);
            const perBattleDamage = newBattleOutcomes.length > 0
                ? Math.round(damageDiff / newBattleOutcomes.length)
                : 0;

            const inserted = [];
            let idx = 0;

            const finishSync = () => {
                const updates = {
                    razblog_last_sync_battles: stats.battles,
                    razblog_last_sync_wins: stats.wins,
                    razblog_last_sync_survived: stats.survived_battles || 0,
                    razblog_last_sync_damage_dealt: stats.damage_dealt || 0,
                    razblog_last_sync_at: Math.floor(Date.now() / 1000)
                };
                updateAppState(updates, (updErr) => {
                    if (updErr) return callback(updErr);
                    broadcastSummary();
                    loadSummary((e, summary) => {
                        if (e) return callback(e);
                        callback(null, { ...summary, newBattles: inserted });
                    });
                });
            };

            const processNext = () => {
                if (idx >= newBattleOutcomes.length) {
                    return finishSync();
                }

                const outcome = newBattleOutcomes[idx];
                const battleNumber = prevBattles + idx + 1;
                const battleKey = `account-${battleNumber}`;
                const playedAt = Math.floor(Date.now() / 1000);
                const goldAmount = calculateGoldDistributed(outcome);

                insertBattleRow({
                    battleKey,
                    playedAt,
                    goldAmount,
                    won: outcome.won,
                    survived: outcome.survived,
                    damageDealt: perBattleDamage > 0 ? perBattleDamage : null
                }, (insErr, insRes) => {
                    if (insErr) return callback(insErr);
                    if (insRes && insRes.inserted) {
                        inserted.push({
                            battleKey,
                            goldAmount,
                            won: outcome.won,
                            survived: outcome.survived,
                            playedAt
                        });
                    }
                    idx++;
                    processNext();
                });
            };

            if (newBattleOutcomes.length === 0) {
                return updateAppState({
                    razblog_last_sync_at: Math.floor(Date.now() / 1000)
                }, (updErr) => {
                    if (updErr) return callback(updErr);
                    loadSummary((e, summary) => callback(e, summary));
                });
            }

            processNext();
            }
        });
    }

    function startTracking(callback) {
        getLestaPlayerStats().then((stats) => {
            if (!stats) return callback(new Error('Не удалось получить статистику Lesta для старта'));
            const updates = {
                razblog_tracking_active: 1,
                razblog_baseline_battles: stats.battles,
                razblog_baseline_wins: stats.wins,
                razblog_baseline_survived: stats.survived_battles || 0,
                razblog_baseline_damage_dealt: stats.damage_dealt || 0,
                razblog_last_sync_battles: stats.battles,
                razblog_last_sync_wins: stats.wins,
                razblog_last_sync_survived: stats.survived_battles || 0,
                razblog_last_sync_damage_dealt: stats.damage_dealt || 0,
                razblog_last_sync_at: Math.floor(Date.now() / 1000)
            };
            updateAppState(updates, (err) => {
                if (err) return callback(err);
                broadcastSummary();
                callback(null, { success: true, baseline: updates });
            });
        }).catch((e) => callback(e));
    }

    function stopTracking(callback) {
        updateAppState({ razblog_tracking_active: 0 }, (err) => {
            if (err) return callback(err);
            broadcastSummary();
            callback(null, { success: true });
        });
    }

    function resetTracking(callback) {
        db.run('DELETE FROM razblogirovka_battles', [], (delErr) => {
            if (delErr) return callback(delErr);
            updateAppState({
                razblog_tracking_active: 0,
                razblog_baseline_battles: 0,
                razblog_baseline_wins: 0,
                razblog_baseline_survived: 0,
                razblog_baseline_damage_dealt: 0,
                razblog_last_sync_battles: 0,
                razblog_last_sync_wins: 0,
                razblog_last_sync_survived: 0,
                razblog_last_sync_damage_dealt: 0,
                razblog_last_sync_at: 0
            }, (err) => {
                if (err) return callback(err);
                broadcastSummary();
                callback(null, { success: true });
            });
        });
    }

    function updateWidgetSettings(body, callback) {
        const updates = {};
        if (typeof body.showWinRate === 'boolean') {
            updates.razblog_widget_show_win_rate = body.showWinRate ? 1 : 0;
        }
        if (typeof body.showAvgDamage === 'boolean') {
            updates.razblog_widget_show_avg_damage = body.showAvgDamage ? 1 : 0;
        }
        if (!Object.keys(updates).length) {
            return callback(new Error('Нет полей для обновления'));
        }
        updateAppState(updates, (err) => {
            if (err) return callback(err);
            broadcastSummary();
            loadSummary((e, summary) => {
                if (e) return callback(e);
                callback(null, summary);
            });
        });
    }

    return {
        DEFAULT_EVENT_START_ISO,
        loadSummary,
        syncFromLestaStats,
        startTracking,
        stopTracking,
        resetTracking,
        updateWidgetSettings,
        broadcastSummary
    };
}

module.exports = { createRazblogirovkaGoldService };
