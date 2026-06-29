'use strict';

const path = require('path');
const {
    parseDamageHitEvents,
    buildSparsePlayerTimelines,
    damageAtPoints,
    resolveFinalDamageMap
} = require('../src/modules/replay-live/replayTimeline');
const { parseDataReplayBuffer } = require('../src/modules/replay-live/replayParser');
const { extractDataReplayFromZip, parseBattleResultsContext } = require('../src/modules/replay-live/battleResultsParser');

const replayPath = process.argv[2] || 'C:\\Users\\ixacy\\Documents\\TanksBlitz\\replays\\20260623_2042__Xasya_Object_907_1168525801180284280.tbreplay';
const buf = extractDataReplayFromZip(replayPath, path.join(__dirname, '../work'));
const ctx = parseBattleResultsContext(replayPath);
const parsed = parseDataReplayBuffer(buf);

const entityPlayers = new Map();
(parsed.players || []).forEach((p) => {
    if (p.entityId) entityPlayers.set(p.entityId, p);
});
const author = [...entityPlayers.entries()].find(([, p]) => p.nickname === 'Xasya');

const timeline = parseDamageHitEvents(buf, {
    authorEntityId: author ? author[0] : null,
    finalDamage: ctx.finalDamage
});

const finalMap = resolveFinalDamageMap(ctx.finalDamage, timeline.hits);
const sparse = buildSparsePlayerTimelines(timeline.hits, finalMap, entityPlayers, {
    replayDurationSec: Math.ceil(timeline.battleDurationSec)
});

function nick(eid) {
    return (entityPlayers.get(eid) || {}).nickname || String(eid);
}

console.log('hits', timeline.hitCount, 'pl19', timeline.pl19HitCount, 'early', timeline.earlyHitCount, 'delta', timeline.deltaHitCount);
console.log('\n=== damage at key clocks ===');
[17, 35, 40, 45, 50, 60, 70, 80, 100, 120, 150].forEach((clock) => {
    const row = sparse.players
        .map((p) => ({ nick: p.nickname, dmg: damageAtPoints(p.points, clock) }))
        .filter((r) => r.dmg > 0)
        .sort((a, b) => b.dmg - a.dmg);
    console.log(`\nclock ${clock}:`, row.map((r) => `${r.nick}=${r.dmg}`).join(', ') || '(none)');
});

console.log('\n=== Xasya timeline ===');
const xasya = sparse.players.find((p) => p.nickname === 'Xasya');
if (xasya) xasya.points.forEach((pt) => console.log(`  t=${pt[0]} dmg=${pt[1]}`));

console.log('\n=== finals check ===');
sparse.players.forEach((p) => {
    const final = ctx.finalDamage.get(p.entityId) || 0;
    const last = p.points[p.points.length - 1][1];
    if (final && last !== final) console.log('MISMATCH', p.nickname, last, 'vs', final);
});
