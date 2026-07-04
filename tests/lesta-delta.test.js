'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    LESTA_MAX_BATTLES_DELTA,
    LESTA_RELIABLE_BATTLES_GAP,
    isReliableSnapshotRow,
    safeLestaCounterDelta,
    deriveSnapshotDeltas,
    aggregateDeltasList,
    rowToDeltaContribution,
    buildDeltaSeries,
    getLestaCountersFromState,
    computeLestaPeriodDelta,
    getLestaPeriodDateFilter,
    computeLestaPeriodStatsFromRows,
    isHistoryRowInTrackingWindow
} = require('../src/core/lesta-delta');

// От этой математики зависит автосписание фрагов из режима 1 —
// семантика закреплена здесь, поведенчески — в scripts/test-lesta-sync.js.

test('safeLestaCounterDelta: обычный прирост', () => {
    assert.deepEqual(safeLestaCounterDelta(1000, 1005), { delta: 5, resync: false, raw: 5 });
});

test('safeLestaCounterDelta: отрицательная дельта = пересчёт API, дельта 0', () => {
    assert.deepEqual(safeLestaCounterDelta(1000, 990), { delta: 0, resync: true, raw: -10 });
});

test('safeLestaCounterDelta: скачок больше лимита игнорируется', () => {
    const jump = LESTA_MAX_BATTLES_DELTA + 1;
    assert.deepEqual(safeLestaCounterDelta(0, jump), { delta: 0, resync: true, raw: jump });
    // ровно на лимите — проходит
    assert.equal(safeLestaCounterDelta(0, LESTA_MAX_BATTLES_DELTA).delta, LESTA_MAX_BATTLES_DELTA);
});

test('safeLestaCounterDelta: кастомный лимит и нечисловые входы', () => {
    assert.equal(safeLestaCounterDelta(0, 100, 200).delta, 100);
    assert.deepEqual(safeLestaCounterDelta(undefined, null), { delta: 0, resync: false, raw: 0 });
    assert.equal(safeLestaCounterDelta('1000', '1003').delta, 3);
});

test('isReliableSnapshotRow: при ref < 5000 любой снапшот надёжен', () => {
    assert.equal(isReliableSnapshotRow({ battles: 1 }, 4999), true);
    assert.equal(isReliableSnapshotRow(null, 100), false);
});

test('isReliableSnapshotRow: при большом ref отсеиваются далёкие по боям строки', () => {
    const ref = 20000;
    assert.equal(isReliableSnapshotRow({ battles: ref - LESTA_RELIABLE_BATTLES_GAP }, ref), true);
    assert.equal(isReliableSnapshotRow({ battles: ref - LESTA_RELIABLE_BATTLES_GAP - 1 }, ref), false);
});

test('deriveSnapshotDeltas: нормальная сессия', () => {
    const prev = { battles: 100, wins: 60, losses: 40, frags: 150, damage_dealt: 200000, xp: 90000 };
    const cur = { battles: 103, wins: 62, losses: 41, frags: 155, damage_dealt: 206000, xp: 92500 };
    assert.deepEqual(deriveSnapshotDeltas(prev, cur), {
        battles_delta: 3, wins_delta: 2, losses_delta: 1,
        frags_delta: 5, damage_delta: 6000, xp_delta: 2500, is_resync: 0
    });
});

test('deriveSnapshotDeltas: пересчёт API по одному счётчику помечает весь снапшот resync', () => {
    const prev = { battles: 100, wins: 60, losses: 40, frags: 150, damage_dealt: 200000, xp: 90000 };
    const cur = { ...prev, battles: 101, frags: 149 }; // frags уменьшились
    const d = deriveSnapshotDeltas(prev, cur);
    assert.equal(d.is_resync, 1);
    assert.equal(d.frags_delta, 0);
    assert.equal(d.battles_delta, 1); // остальные счётчики считаются как есть
});

test('computeLestaPeriodDelta: клэмп отрицательных дельт в 0 и производные метрики', () => {
    const baseline = { battles: 1000, wins: 600, losses: 400, frags: 1500, damage_dealt: 2000000, xp: 900000 };
    const current = { battles: 1004, wins: 603, losses: 401, frags: 1508, damage_dealt: 2010000, xp: 904000 };
    const d = computeLestaPeriodDelta(baseline, current);
    assert.equal(d.battlesPlayed, 4);
    assert.equal(d.winRate, 75);
    assert.equal(d.avgDamage, 2500);
    assert.equal(d.avgXp, 1000);
    assert.equal(d.fragsPerBattle, 2);

    // пересчёт API вниз — не уходит в минус
    const shrunk = computeLestaPeriodDelta(current, baseline);
    assert.equal(shrunk.battlesPlayed, 0);
    assert.equal(shrunk.winRate, 0);
    assert.equal(shrunk.avgDamage, 0);
});

test('computeLestaPeriodDelta: null-входы не падают', () => {
    assert.equal(computeLestaPeriodDelta(null, null).battlesPlayed, 0);
});

test('getLestaCountersFromState: маппинг полей app_state и null', () => {
    assert.equal(getLestaCountersFromState(null), null);
    const c = getLestaCountersFromState({ lesta_last_battles: '10', lesta_last_frags: 25 });
    assert.equal(c.battles, 10);
    assert.equal(c.frags, 25);
    assert.equal(c.wins, 0);
});

test('aggregateDeltasList: суммирование и производные', () => {
    const agg = aggregateDeltasList([
        { battles_delta: 2, wins_delta: 1, losses_delta: 1, frags_delta: 3, damage_delta: 4000, xp_delta: 2000 },
        { battles_delta: 3, wins_delta: 3, losses_delta: 0, frags_delta: 7, damage_delta: 6000, xp_delta: 3000 }
    ]);
    assert.equal(agg.battlesPlayed, 5);
    assert.equal(agg.winRate, 80);
    assert.equal(agg.avgDamage, 2000);
    assert.equal(agg.fragsPerBattle, 2);
    assert.equal(aggregateDeltasList([]).battlesPlayed, 0);
    assert.equal(aggregateDeltasList(null).winRate, 0);
});

test('rowToDeltaContribution: ненадёжная строка (или предыдущая) даёт пустой вклад с is_resync', () => {
    const ref = 20000;
    const bad = { battles: 100 }; // далеко от ref
    const good = { battles: 19990, account_id: null };
    assert.equal(rowToDeltaContribution(bad, null, ref).is_resync, 1);
    assert.equal(rowToDeltaContribution(good, bad, ref).is_resync, 1);
    assert.equal(rowToDeltaContribution(good, bad, ref).battles_delta, 0);
});

test('rowToDeltaContribution: строка с account_id использует предрассчитанные дельты', () => {
    const row = { account_id: 42, battles: 100, battles_delta: 2, frags_delta: 5, wins_delta: 1, losses_delta: 1, damage_delta: 100, xp_delta: 50, is_resync: 0 };
    const d = rowToDeltaContribution(row, null, 100);
    assert.equal(d.battles_delta, 2);
    assert.equal(d.frags_delta, 5);
});

test('rowToDeltaContribution: строка без account_id — дельты выводятся из соседних снапшотов', () => {
    const prev = { battles: 100, wins: 60, losses: 40, frags: 150, damage_dealt: 0, xp: 0 };
    const row = { battles: 102, wins: 61, losses: 41, frags: 154, damage_dealt: 0, xp: 0 };
    const d = rowToDeltaContribution(row, prev, 100);
    assert.equal(d.battles_delta, 2);
    assert.equal(d.frags_delta, 4);
});

test('computeLestaPeriodStatsFromRows: меньше 2 строк = нули; первая строка — якорь, её вклад отбрасывается', () => {
    assert.equal(computeLestaPeriodStatsFromRows([], 0).battlesPlayed, 0);
    assert.equal(computeLestaPeriodStatsFromRows([{ battles: 1 }], 0).battlesPlayed, 0);

    const rows = [
        { battles: 100, wins: 60, losses: 40, frags: 150, damage_dealt: 0, xp: 0 },
        { battles: 102, wins: 61, losses: 41, frags: 153, damage_dealt: 0, xp: 0 },
        { battles: 105, wins: 63, losses: 42, frags: 160, damage_dealt: 0, xp: 0 }
    ];
    const stats = computeLestaPeriodStatsFromRows(rows, 105);
    assert.equal(stats.battlesPlayed, 5);
    assert.equal(stats.frags, 10);
});

test('buildDeltaSeries: длина = числу строк, первый элемент считается от prev=null', () => {
    const rows = [
        { battles: 100, wins: 0, losses: 0, frags: 0, damage_dealt: 0, xp: 0 },
        { battles: 101, wins: 0, losses: 0, frags: 0, damage_dealt: 0, xp: 0 }
    ];
    const series = buildDeltaSeries(rows, 0);
    assert.equal(series.length, 2);
    assert.equal(series[1].battles_delta, 1);
});

test('isHistoryRowInTrackingWindow: отсечка по reliableSince', () => {
    const row = { battles: 100, timestamp: '2026-07-01 12:00:00' };
    const rowTs = Math.floor(new Date('2026-07-01T12:00:00').getTime() / 1000);
    assert.equal(isHistoryRowInTrackingWindow(row, 0, 0), true);
    assert.equal(isHistoryRowInTrackingWindow(row, 0, rowTs), true);
    assert.equal(isHistoryRowInTrackingWindow(row, 0, rowTs + 1), false);
});

test('getLestaPeriodDateFilter: маппинг периодов и дефолт', () => {
    assert.equal(getLestaPeriodDateFilter('7d'), '-7 days');
    assert.equal(getLestaPeriodDateFilter('garbage'), '-1 day');
});
