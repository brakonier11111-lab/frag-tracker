'use strict';

/**
 * Чистая дельта-математика Lesta-статистики (вынесено из server.js 1:1).
 * Ни БД, ни сети — только вычисления. От этих функций зависит автосписание
 * фрагов из режима 1 (см. lesta-sync) и все периодные показатели
 * (blitz-challenge, lesta-routes). Покрыто юнит-тестами: tests/lesta-delta.test.js.
 *
 * Константы читают env на момент require (loadEnv() в server.js выполняется
 * раньше любых require модулей).
 */
const LESTA_HISTORY_HEARTBEAT_SEC = Number(process.env.LESTA_HISTORY_HEARTBEAT_SEC || 900);
const LESTA_MAX_BATTLES_DELTA = Number(process.env.LESTA_MAX_BATTLES_DELTA || 40);
const LESTA_RELIABLE_BATTLES_GAP = Number(process.env.LESTA_RELIABLE_BATTLES_GAP || 3000);

function isReliableSnapshotRow(row, referenceBattles) {
    if (!row) return false;
    const rowBattles = Number(row.battles) || 0;
    const ref = Number(referenceBattles) || 0;
    if (ref < 5000) return true;
    return rowBattles >= ref - LESTA_RELIABLE_BATTLES_GAP;
}

function emptyDeltaContribution() {
    return {
        battles_delta: 0,
        wins_delta: 0,
        losses_delta: 0,
        frags_delta: 0,
        damage_delta: 0,
        xp_delta: 0,
        is_resync: 1
    };
}

function safeLestaCounterDelta(previousValue, currentValue, maxDelta) {
    const limit = maxDelta != null ? maxDelta : LESTA_MAX_BATTLES_DELTA;
    const prev = Number(previousValue) || 0;
    const cur = Number(currentValue) || 0;
    const raw = cur - prev;
    if (raw < 0 || raw > limit) {
        return { delta: 0, resync: true, raw };
    }
    return { delta: raw, resync: false, raw };
}

function deriveSnapshotDeltas(previousRow, currentRow) {
    previousRow = previousRow || {};
    currentRow = currentRow || {};
    const battles = safeLestaCounterDelta(previousRow.battles, currentRow.battles);
    const wins = safeLestaCounterDelta(previousRow.wins, currentRow.wins);
    const losses = safeLestaCounterDelta(previousRow.losses, currentRow.losses);
    const frags = safeLestaCounterDelta(previousRow.frags, currentRow.frags, LESTA_MAX_BATTLES_DELTA * 3);
    const damage = safeLestaCounterDelta(previousRow.damage_dealt, currentRow.damage_dealt, 500000);
    const xp = safeLestaCounterDelta(previousRow.xp, currentRow.xp, 250000);
    const resync = battles.resync || wins.resync || losses.resync || frags.resync || damage.resync || xp.resync;
    return {
        battles_delta: battles.delta,
        wins_delta: wins.delta,
        losses_delta: losses.delta,
        frags_delta: frags.delta,
        damage_delta: damage.delta,
        xp_delta: xp.delta,
        is_resync: resync ? 1 : 0
    };
}

function aggregateDeltasList(deltasList) {
    let battlesPlayed = 0;
    let wins = 0;
    let losses = 0;
    let frags = 0;
    let damageDealt = 0;
    let xp = 0;
    for (const d of deltasList || []) {
        battlesPlayed += Number(d.battles_delta) || 0;
        wins += Number(d.wins_delta) || 0;
        losses += Number(d.losses_delta) || 0;
        frags += Number(d.frags_delta) || 0;
        damageDealt += Number(d.damage_delta) || 0;
        xp += Number(d.xp_delta) || 0;
    }
    const winRate = battlesPlayed > 0 ? Number(((wins / battlesPlayed) * 100).toFixed(1)) : 0;
    return {
        battlesPlayed,
        wins,
        losses,
        frags,
        damageDealt,
        xp,
        winRate,
        avgDamage: battlesPlayed > 0 ? Math.round(damageDealt / battlesPlayed) : 0,
        avgXp: battlesPlayed > 0 ? Math.round(xp / battlesPlayed) : 0,
        fragsPerBattle: battlesPlayed > 0 ? Number((frags / battlesPlayed).toFixed(2)) : 0
    };
}

function rowToDeltaContribution(row, previousRow, referenceBattles) {
    if (!isReliableSnapshotRow(row, referenceBattles)) {
        return emptyDeltaContribution();
    }
    if (previousRow && !isReliableSnapshotRow(previousRow, referenceBattles)) {
        return emptyDeltaContribution();
    }
    if (row && row.account_id != null) {
        return {
            battles_delta: row.battles_delta || 0,
            wins_delta: row.wins_delta || 0,
            losses_delta: row.losses_delta || 0,
            frags_delta: row.frags_delta || 0,
            damage_delta: row.damage_delta || 0,
            xp_delta: row.xp_delta || 0,
            is_resync: row.is_resync || 0
        };
    }
    return deriveSnapshotDeltas(previousRow, row);
}

function buildDeltaSeries(rows, referenceBattles) {
    const series = [];
    let prev = null;
    for (const row of rows || []) {
        series.push(rowToDeltaContribution(row, prev, referenceBattles));
        prev = row;
    }
    return series;
}

function getLestaCountersFromState(state) {
    if (!state) return null;
    return {
        battles: Number(state.lesta_last_battles) || 0,
        frags: Number(state.lesta_last_frags) || 0,
        wins: Number(state.lesta_last_wins) || 0,
        losses: Number(state.lesta_last_losses) || 0,
        damage_dealt: Number(state.lesta_last_damage_dealt) || 0,
        xp: Number(state.lesta_last_xp) || 0,
        win_rate: Number(state.lesta_last_win_rate) || 0,
        frags_per_battle: Number(state.lesta_last_frags_per_battle) || 0
    };
}

function computeLestaPeriodDelta(baseline, current) {
    baseline = baseline || {};
    current = current || {};
    const battlesPlayed = Math.max(0, (current.battles || 0) - (baseline.battles || 0));
    const wins = Math.max(0, (current.wins || 0) - (baseline.wins || 0));
    const losses = Math.max(0, (current.losses || 0) - (baseline.losses || 0));
    const frags = Math.max(0, (current.frags || 0) - (baseline.frags || 0));
    const damageDealt = Math.max(0, (current.damage_dealt || 0) - (baseline.damage_dealt || 0));
    const xp = Math.max(0, (current.xp || 0) - (baseline.xp || 0));
    const winRate = battlesPlayed > 0 ? Number(((wins / battlesPlayed) * 100).toFixed(1)) : 0;
    return {
        battlesPlayed,
        wins,
        losses,
        frags,
        damageDealt,
        xp,
        winRate,
        avgDamage: battlesPlayed > 0 ? Math.round(damageDealt / battlesPlayed) : 0,
        avgXp: battlesPlayed > 0 ? Math.round(xp / battlesPlayed) : 0,
        fragsPerBattle: battlesPlayed > 0 ? Number((frags / battlesPlayed).toFixed(2)) : 0
    };
}

function getLestaPeriodDateFilter(period) {
    switch (period) {
        case '1d': return '-1 day';
        case '7d': return '-7 days';
        case '30d': return '-30 days';
        case '180d': return '-180 days';
        case '365d': return '-365 days';
        default: return '-1 day';
    }
}

function computeLestaPeriodStatsFromRows(rows, referenceBattles) {
    if (!rows || rows.length < 2) {
        return aggregateDeltasList([]);
    }
    const deltas = buildDeltaSeries(rows, referenceBattles);
    return aggregateDeltasList(deltas.slice(1));
}

function historyRowTimestampSec(row) {
    if (!row || !row.timestamp) return 0;
    const ts = Math.floor(new Date(String(row.timestamp).replace(' ', 'T')).getTime() / 1000);
    return Number.isFinite(ts) ? ts : 0;
}

function isHistoryRowInTrackingWindow(row, referenceBattles, reliableSinceSec) {
    if (!isReliableSnapshotRow(row, referenceBattles)) return false;
    if (reliableSinceSec > 0 && historyRowTimestampSec(row) < reliableSinceSec) return false;
    return true;
}

module.exports = {
    LESTA_HISTORY_HEARTBEAT_SEC,
    LESTA_MAX_BATTLES_DELTA,
    LESTA_RELIABLE_BATTLES_GAP,
    isReliableSnapshotRow,
    emptyDeltaContribution,
    safeLestaCounterDelta,
    deriveSnapshotDeltas,
    aggregateDeltasList,
    rowToDeltaContribution,
    buildDeltaSeries,
    getLestaCountersFromState,
    computeLestaPeriodDelta,
    getLestaPeriodDateFilter,
    computeLestaPeriodStatsFromRows,
    historyRowTimestampSec,
    isHistoryRowInTrackingWindow
};
