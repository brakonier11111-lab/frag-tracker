'use strict';

/**
 * Lesta: история снапшотов статистики и танко-снапшоты — вынесено из
 * server.js 1:1. Два кластера: (A) insertLestaStatsSnapshot /
 * fetchLestaHistoryWindow / buildLestaDailyActivity / ensureLestaReliableSince,
 * (B) танко-снапшоты (normalizeTankStatsList..scheduleLestaTankSnapshot).
 * A зовёт B (scheduleLestaTankSnapshot после вставки снапшота).
 * Чистая дельта-математика — в ./lesta-delta (require ниже).
 * Имена deps совпадают с прежними именами server.js — тела не менялись.
 */

const axios = require('axios');
const {
    LESTA_MAX_BATTLES_DELTA,
    aggregateDeltasList,
    buildDeltaSeries,
    deriveSnapshotDeltas,
    isHistoryRowInTrackingWindow,
    isReliableSnapshotRow,
    getLestaPeriodDateFilter
} = require('./lesta-delta');

function createLestaHistory(deps) {
    const {
        db,
        dbRead,
        getAppState,
        updateAppState,
        LESTA_CONFIG
    } = deps;

    function insertLestaStatsSnapshot(stats, fragsDifference, previousCounters, accountId, callback) {
        if (typeof previousCounters === 'function') {
            callback = previousCounters;
            previousCounters = null;
            accountId = null;
        } else if (typeof accountId === 'function') {
            callback = accountId;
            accountId = null;
        }
        callback = callback || (() => {});

        const prev = previousCounters || {};
        const deltas = deriveSnapshotDeltas(
            {
                battles: prev.battles,
                frags: prev.frags,
                wins: prev.wins,
                losses: prev.losses,
                damage_dealt: prev.damage_dealt,
                xp: prev.xp
            },
            stats
        );

        if (deltas.is_resync && deltas.battles_delta === 0) {
            console.log('ℹ️ Lesta: скачок статистики (пересчёт API), дельта боёв не учитывается');
            updateAppState({ lesta_reliable_since: Math.floor(Date.now() / 1000) }, () => {});
        }

        const historyData = {
            battles: stats.battles,
            frags: stats.frags,
            wins: stats.wins,
            losses: stats.losses,
            damage_dealt: stats.damage_dealt,
            xp: stats.xp,
            win_rate: parseFloat(stats.winRate),
            frags_per_battle: parseFloat(stats.fragsPerBattle),
            avg_damage: Math.round(stats.damage_dealt / Math.max(stats.battles, 1)),
            avg_xp: Math.round(stats.xp / Math.max(stats.battles, 1)),
            frags_difference: fragsDifference || 0,
            account_id: accountId || LESTA_CONFIG.accountId || null,
            ...deltas
        };

        db.run(`INSERT INTO lesta_stats_history
                (battles, frags, wins, losses, damage_dealt, xp, win_rate, frags_per_battle, avg_damage, avg_xp, frags_difference,
                 battles_delta, wins_delta, losses_delta, frags_delta, damage_delta, xp_delta, account_id, is_resync)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [historyData.battles, historyData.frags, historyData.wins, historyData.losses,
                historyData.damage_dealt, historyData.xp, historyData.win_rate, historyData.frags_per_battle,
                historyData.avg_damage, historyData.avg_xp, historyData.frags_difference,
                historyData.battles_delta, historyData.wins_delta, historyData.losses_delta,
                historyData.frags_delta, historyData.damage_delta, historyData.xp_delta,
                historyData.account_id, historyData.is_resync],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка сохранения истории Lesta:', err);
                    return callback(err);
                }
                updateAppState({ lesta_last_history_at: Math.floor(Date.now() / 1000) }, () => {
                    if (historyData.account_id) scheduleLestaTankSnapshot(historyData.account_id);
                    callback(null);
                });
            }
        );
    }


    function fetchLestaHistoryWindow(period, referenceBattles, reliableSinceSec, callback) {
        if (typeof reliableSinceSec === 'function') {
            callback = reliableSinceSec;
            reliableSinceSec = 0;
        } else if (typeof referenceBattles === 'function') {
            callback = referenceBattles;
            referenceBattles = 0;
            reliableSinceSec = 0;
        }
        const dateFilter = getLestaPeriodDateFilter(period);
        const ref = Number(referenceBattles) || 0;
        const reliableSince = Number(reliableSinceSec) || 0;
        const keepRow = (row) => isHistoryRowInTrackingWindow(row, ref, reliableSince);

        dbRead.all(
            `SELECT * FROM lesta_stats_history
             WHERE timestamp <= datetime('now', ?)
             ORDER BY timestamp DESC LIMIT 500`,
            [dateFilter],
            (err, beforeRows) => {
                if (err) return callback(err);
                const anchorRow = (beforeRows || []).find(keepRow) || null;

                dbRead.all(
                    `SELECT * FROM lesta_stats_history
                     WHERE timestamp >= datetime('now', ?)
                     ORDER BY timestamp ASC`,
                    [dateFilter],
                    (err2, periodRows) => {
                        if (err2) return callback(err2);

                        const reliablePeriod = (periodRows || []).filter(keepRow);
                        const rows = [];
                        if (anchorRow) rows.push(anchorRow);
                        reliablePeriod.forEach((row) => {
                            if (!anchorRow || row.id !== anchorRow.id) rows.push(row);
                        });

                        callback(null, {
                            anchorRow,
                            periodRows: reliablePeriod,
                            rows,
                            referenceBattles: ref,
                            reliableSince
                        });
                    }
                );
            }
        );
    }

    function buildLestaDailyActivity(days, referenceBattles, reliableSinceSec, callback) {
        if (typeof reliableSinceSec === 'function') {
            callback = reliableSinceSec;
            reliableSinceSec = 0;
        } else if (typeof referenceBattles === 'function') {
            callback = referenceBattles;
            referenceBattles = 0;
            reliableSinceSec = 0;
        }
        const safeDays = Math.min(Math.max(Number(days) || 14, 1), 90);
        const ref = Number(referenceBattles) || 0;
        const reliableSince = Number(reliableSinceSec) || 0;
        const keepRow = (row) => isHistoryRowInTrackingWindow(row, ref, reliableSince);

        dbRead.all(
            `SELECT * FROM lesta_stats_history
             WHERE timestamp < datetime('now', ?)
             ORDER BY timestamp DESC LIMIT 500`,
            [`-${safeDays} days`],
            (err, beforeRows) => {
                if (err) return callback(err);
                const anchorRow = (beforeRows || []).find(keepRow) || null;

                dbRead.all(
                    `SELECT * FROM lesta_stats_history
                     WHERE timestamp >= datetime('now', ?)
                     ORDER BY timestamp ASC`,
                    [`-${safeDays} days`],
                    (err2, periodRows) => {
                        if (err2) return callback(err2);

                        const reliablePeriod = (periodRows || []).filter(keepRow);
                        const rows = [];
                        if (anchorRow) rows.push(anchorRow);
                        reliablePeriod.forEach((row) => {
                            if (!anchorRow || row.id !== anchorRow.id) rows.push(row);
                        });
                        if (rows.length < 2) return callback(null, []);

                        const deltas = buildDeltaSeries(rows, ref);
                        const byDay = {};
                        for (let i = 1; i < rows.length; i++) {
                            const day = String(rows[i].timestamp).slice(0, 10);
                            if (!byDay[day]) byDay[day] = [];
                            byDay[day].push(deltas[i]);
                        }
                        const daily = Object.keys(byDay).sort().map((day) => ({
                            date: day,
                            ...aggregateDeltasList(byDay[day])
                        }));
                        callback(null, daily);
                    }
                );
            }
        );
    }

    // lestaSyncTimer/stopLestaAutoSync живут в src/modules/lesta-sync
    function detectLestaReliableSinceTimestamp(referenceBattles, callback) {
        const ref = Number(referenceBattles) || 0;
        if (ref < 5000) return callback(null, 0);

        dbRead.all(
            `SELECT id, timestamp, battles FROM lesta_stats_history ORDER BY id ASC`,
            (err, rows) => {
                if (err) return callback(err);
                let lastEnterReliableAt = null;
                let wasUnreliable = true;
                for (const row of rows || []) {
                    const reliable = isReliableSnapshotRow(row, ref);
                    if (reliable && wasUnreliable) {
                        lastEnterReliableAt = row.timestamp;
                        wasUnreliable = false;
                    } else if (!reliable) {
                        wasUnreliable = true;
                    }
                }
                if (!lastEnterReliableAt) return callback(null, 0);
                const ts = Math.floor(new Date(String(lastEnterReliableAt).replace(' ', 'T')).getTime() / 1000);
                callback(null, Number.isFinite(ts) ? ts : 0);
            }
        );
    }

    function ensureLestaReliableSince(callback) {
        callback = callback || (() => {});
        getAppState((state) => {
            if (!state || !state.lesta_account_id) return callback();
            const ref = Number(state.lesta_last_battles) || 0;

            detectLestaReliableSinceTimestamp(ref, (err, detectedTs) => {
                if (err || !detectedTs) return callback();
                const current = Number(state.lesta_reliable_since) || 0;
                if (detectedTs <= current) return callback();
                updateAppState({ lesta_reliable_since: detectedTs }, () => {
                    console.log('✅ Lesta: надёжная статистика с', new Date(detectedTs * 1000).toLocaleString('ru-RU'));
                    callback();
                });
            });
        });
    }

    // --- Lesta: техника и достижения (хелперы) ---
    const LESTA_TANK_STATS_FIELDS = 'tank_id,all,mark_of_mastery,last_battle_time,battle_life_time';

    function ensureLestaConfigFromState() {
        return new Promise((resolve) => {
            getAppState((state) => {
                if (state?.lesta_application_id) LESTA_CONFIG.applicationId = state.lesta_application_id;
                if (state?.lesta_access_token) LESTA_CONFIG.accessToken = state.lesta_access_token;
                if (state?.lesta_account_id) LESTA_CONFIG.accountId = state.lesta_account_id;
                if (state?.lesta_nickname) LESTA_CONFIG.nickname = state.lesta_nickname;
                resolve(state);
            });
        });
    }

    function normalizeTankStatsList(apiData, accountId) {
        if (!apiData) return { tanks: [], hidden: false };
        const accKey = String(accountId);
        const raw = apiData[accKey] ?? apiData[accountId];
        if (raw === null) return { tanks: [], hidden: true };
        if (!raw) return { tanks: [], hidden: false };

        let list = [];
        if (Array.isArray(raw)) {
            list = raw;
        } else if (typeof raw === 'object') {
            list = Object.entries(raw).map(([tankId, stats]) => ({
                tank_id: Number(tankId),
                ...(typeof stats === 'object' ? stats : {})
            }));
        }

        const tanks = list
            .map((item) => ({
                ...item,
                tank_id: item.tank_id != null ? Number(item.tank_id) : item.tank_id,
                statistics: { all: item.all || {} }
            }))
            .filter((item) => (item.all?.battles || item.statistics?.all?.battles || 0) > 0);

        return { tanks, hidden: false };
    }

    async function enrichTanksWithVehicleNames(tanks, language = 'ru') {
        if (!tanks.length) return tanks;
        try {
            const vehiclesResponse = await axios.get(`${LESTA_CONFIG.apiUrl}/encyclopedia/vehicles/`, {
                params: {
                    application_id: LESTA_CONFIG.applicationId,
                    fields: 'tank_id,name,tier,type,nation,is_premium',
                    language
                },
                timeout: 30000
            });
            if (vehiclesResponse.data.status !== 'ok' || !vehiclesResponse.data.data) {
                return tanks;
            }
            const vehiclesRaw = vehiclesResponse.data.data;
            const vehicles = {};
            if (Array.isArray(vehiclesRaw)) {
                vehiclesRaw.forEach((v) => {
                    if (v?.tank_id != null) vehicles[v.tank_id] = v;
                });
            } else {
                Object.assign(vehicles, vehiclesRaw);
            }
            return tanks.map((tank) => {
                const vId = tank.tank_id;
                const vehicleInfo = vehicles[vId] || vehicles[String(vId)] || {};
                return {
                    ...tank,
                    name: vehicleInfo.name || vehicleInfo.short_name || tank.name || `Танк #${vId}`,
                    tier: vehicleInfo.tier || tank.tier || 0,
                    type: vehicleInfo.type || tank.type || 'unknown',
                    nation: vehicleInfo.nation || tank.nation || 'unknown',
                    is_premium: vehicleInfo.is_premium || tank.is_premium || false
                };
            });
        } catch (e) {
            console.warn('⚠️ Энциклопедия техники недоступна:', e.message);
            return tanks.map((tank) => ({
                ...tank,
                name: tank.name || `Танк #${tank.tank_id}`
            }));
        }
    }

    function tanksToSnapshotMap(tanks) {
        const map = {};
        for (const tank of tanks || []) {
            const stats = tank.statistics?.all || tank.all || {};
            const tankId = tank.tank_id;
            if (tankId == null) continue;
            map[String(tankId)] = {
                battles: Number(stats.battles) || 0,
                wins: Number(stats.wins) || 0,
                frags: Number(stats.frags) || 0,
                damage_dealt: Number(stats.damage_dealt) || 0,
                name: tank.name || '',
                tier: Number(tank.tier) || 0
            };
        }
        return map;
    }

    function parseTankSnapshotMap(row) {
        if (!row || !row.tanks_json) return {};
        try {
            const parsed = JSON.parse(row.tanks_json);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    function insertLestaTankSnapshot(accountId, tanksMap, callback) {
        callback = callback || (() => {});
        if (!accountId || !tanksMap) return callback(null);
        db.run(
            `INSERT INTO lesta_tank_snapshots (account_id, tanks_json) VALUES (?, ?)`,
            [String(accountId), JSON.stringify(tanksMap)],
            callback
        );
    }

    function fetchTankSnapshotBaseline(period, accountId, reliableSinceSec, callback) {
        const dateFilter = getLestaPeriodDateFilter(period);
        const accountStr = String(accountId);
        const reliableSince = Number(reliableSinceSec) || 0;
        const reliableSql = reliableSince > 0 ? ` AND timestamp >= datetime(?, 'unixepoch')` : '';
        const anchorParams = reliableSince > 0 ? [accountStr, dateFilter, reliableSince] : [accountStr, dateFilter];
        const inPeriodParams = reliableSince > 0 ? [accountStr, dateFilter, reliableSince] : [accountStr, dateFilter];

        dbRead.get(
            `SELECT * FROM lesta_tank_snapshots
             WHERE account_id = ? AND timestamp <= datetime('now', ?)${reliableSql}
             ORDER BY timestamp DESC LIMIT 1`,
            anchorParams,
            (err, anchorRow) => {
                if (err) return callback(err);
                dbRead.get(
                    `SELECT * FROM lesta_tank_snapshots
                     WHERE account_id = ? AND timestamp >= datetime('now', ?)${reliableSql}
                     ORDER BY timestamp ASC LIMIT 1`,
                    inPeriodParams,
                    (err2, oldestInPeriod) => {
                        if (err2) return callback(err2);
                        if (anchorRow && oldestInPeriod) {
                            const anchorTs = new Date(anchorRow.timestamp).getTime();
                            const oldestTs = new Date(oldestInPeriod.timestamp).getTime();
                            return callback(null, anchorTs <= oldestTs ? anchorRow : oldestInPeriod);
                        }
                        callback(null, anchorRow || oldestInPeriod || null);
                    }
                );
            }
        );
    }

    function fetchNewestTankSnapshotInPeriod(period, accountId, reliableSinceSec, callback) {
        const dateFilter = getLestaPeriodDateFilter(period);
        const accountStr = String(accountId);
        const reliableSince = Number(reliableSinceSec) || 0;
        const reliableSql = reliableSince > 0 ? ` AND timestamp >= datetime(?, 'unixepoch')` : '';
        const params = reliableSince > 0 ? [accountStr, dateFilter, reliableSince] : [accountStr, dateFilter];
        dbRead.get(
            `SELECT * FROM lesta_tank_snapshots
             WHERE account_id = ? AND timestamp >= datetime('now', ?)${reliableSql}
             ORDER BY timestamp DESC LIMIT 1`,
            params,
            callback
        );
    }

    function computeTankPeriodChanges(currentMap, baselineMap, maxBattlesDelta) {
        maxBattlesDelta = maxBattlesDelta || LESTA_MAX_BATTLES_DELTA * 80;
        const changes = [];
        const ids = new Set([...Object.keys(currentMap || {}), ...Object.keys(baselineMap || {})]);
        ids.forEach((id) => {
            const cur = currentMap[id] || { battles: 0, wins: 0, frags: 0, damage_dealt: 0, name: '', tier: 0 };
            const base = baselineMap[id] || { battles: 0, wins: 0, frags: 0, damage_dealt: 0, name: '', tier: 0 };
            const battlesPlayed = (cur.battles || 0) - (base.battles || 0);
            if (battlesPlayed <= 0 || battlesPlayed > maxBattlesDelta) return;
            const wins = Math.max(0, (cur.wins || 0) - (base.wins || 0));
            const frags = Math.max(0, (cur.frags || 0) - (base.frags || 0));
            const damageDealt = Math.max(0, (cur.damage_dealt || 0) - (base.damage_dealt || 0));
            changes.push({
                tank_id: Number(id),
                name: cur.name || base.name || `Танк ${id}`,
                tier: cur.tier || base.tier || 0,
                battlesPlayed,
                wins,
                frags,
                winRate: battlesPlayed > 0 ? Number(((wins / battlesPlayed) * 100).toFixed(1)) : 0,
                avgDamage: battlesPlayed > 0 ? Math.round(damageDealt / battlesPlayed) : 0,
                fragsPerBattle: battlesPlayed > 0 ? Number((frags / battlesPlayed).toFixed(2)) : 0
            });
        });
        changes.sort((a, b) => b.battlesPlayed - a.battlesPlayed);
        return changes;
    }

    async function fetchAccountTanksForAccount(accountId, language = 'ru') {
        await ensureLestaConfigFromState();
        const targetAccountId = String(accountId || LESTA_CONFIG.accountId || '');
        if (!targetAccountId || !LESTA_CONFIG.applicationId) {
            return { tanks: [], hidden: false, error: 'NO_ACCOUNT' };
        }

        const params = {
            application_id: LESTA_CONFIG.applicationId,
            account_id: targetAccountId,
            fields: LESTA_TANK_STATS_FIELDS,
            language
        };
        if (LESTA_CONFIG.accessToken) params.access_token = LESTA_CONFIG.accessToken;

        const response = await axios.get(`${LESTA_CONFIG.apiUrl}/tanks/stats/`, {
            params,
            timeout: 60000,
            validateStatus: (status) => status < 500
        });

        if (response.data?.status === 'error') {
            return {
                tanks: [],
                hidden: false,
                error: response.data.error?.code || 'API_ERROR',
                message: response.data.error?.message
            };
        }

        const { tanks: rawTanks, hidden } = normalizeTankStatsList(response.data?.data, targetAccountId);
        if (hidden || (rawTanks.length === 0 && response.data?.data?.[targetAccountId] === null)) {
            return { tanks: [], hidden: true, error: 'STATS_HIDDEN' };
        }

        const tanks = await enrichTanksWithVehicleNames(rawTanks, language);
        return { tanks, hidden: false };
    }

    const LESTA_TANK_SNAPSHOT_MIN_SEC = Number(process.env.LESTA_TANK_SNAPSHOT_MIN_SEC || 600);

    async function captureLestaTankSnapshot(accountId) {
        if (!accountId) return false;
        const state = await ensureLestaConfigFromState();
        const nowSec = Math.floor(Date.now() / 1000);
        if (nowSec - (Number(state?.lesta_last_tank_snapshot_at) || 0) < LESTA_TANK_SNAPSHOT_MIN_SEC) {
            return false;
        }

        const { tanks, hidden, error } = await fetchAccountTanksForAccount(accountId);
        if (hidden || error || !tanks.length) return false;

        const tanksMap = tanksToSnapshotMap(tanks);
        await new Promise((resolve, reject) => {
            insertLestaTankSnapshot(accountId, tanksMap, (err) => (err ? reject(err) : resolve()));
        });
        await new Promise((resolve) => {
            updateAppState({ lesta_last_tank_snapshot_at: nowSec }, () => resolve());
        });
        return true;
    }

    function scheduleLestaTankSnapshot(accountId) {
        if (!accountId) return;
        captureLestaTankSnapshot(accountId).catch((e) => {
            console.warn('⚠️ Снимок техники Lesta:', e.message);
        });
    }

    return {
        insertLestaStatsSnapshot,
        fetchLestaHistoryWindow,
        buildLestaDailyActivity,
        ensureLestaReliableSince,
        ensureLestaConfigFromState,
        fetchAccountTanksForAccount,
        scheduleLestaTankSnapshot,
        tanksToSnapshotMap,
        parseTankSnapshotMap,
        insertLestaTankSnapshot,
        fetchTankSnapshotBaseline,
        fetchNewestTankSnapshotInPeriod,
        computeTankPeriodChanges
    };
}

module.exports = { createLestaHistory };
