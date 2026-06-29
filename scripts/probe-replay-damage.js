'use strict';

const path = require('path');
const {
    parseReplayPackets,
    parseLiveMaxSamples
} = require('../src/modules/replay-live/replayTimeline');
const {
    parseSubtype55Players,
    parseDataReplayBuffer
} = require('../src/modules/replay-live/replayParser');
const {
    extractDataReplayFromZip,
    parseBattleResultsContext
} = require('../src/modules/replay-live/battleResultsParser');

const replayPath = process.argv[2] || 'C:\\Users\\ixacy\\Documents\\TanksBlitz\\replays\\20260623_2042__Xasya_Object_907_1168525801180284280.tbreplay';

const buf = extractDataReplayFromZip(replayPath, path.join(__dirname, '../work'));
if (!buf) {
    console.error('Failed to extract data.replay from', replayPath);
    process.exit(1);
}

const ctx = parseBattleResultsContext(replayPath);
const packets = parseReplayPackets(buf);
const liveSamples = parseLiveMaxSamples(buf);

const entityPlayers = new Map();
packets.forEach(({ type, payload, payloadLen }) => {
    if (type === 8 && payloadLen > 500 && payload.readUInt32LE(4) === 55) {
        parseSubtype55Players(payload).forEach((p, eid) => entityPlayers.set(eid, p));
    }
});

function nick(eid) {
    const p = entityPlayers.get(eid);
    return p ? p.nickname : String(eid);
}

// Group live samples by entity, keep monotonic max only
const byEntity = new Map();
liveSamples.forEach((s) => {
    if (!byEntity.has(s.entityId)) byEntity.set(s.entityId, []);
    byEntity.get(s.entityId).push(s);
});

console.log('=== type7 f4=4 live cumulative samples ===');
console.log('total samples:', liveSamples.length, 'entities:', byEntity.size);

const rows = [];
byEntity.forEach((samples, entityId) => {
    samples.sort((a, b) => a.clock - b.clock);
    let maxVal = 0;
    const timeline = [];
    samples.forEach((s) => {
        if (s.value <= maxVal) return;
        maxVal = s.value;
        timeline.push({ clock: s.clock, value: s.value });
    });
    const final = ctx.finalDamage.get(entityId) || 0;
    const firstClock = timeline.length ? timeline[0].clock : null;
    const firstVal = timeline.length ? timeline[0].value : 0;
    rows.push({
        entityId,
        nickname: nick(entityId),
        final,
        maxRaw: maxVal,
        firstClock,
        firstVal,
        pointCount: timeline.length,
        timeline: timeline.slice(0, 8),
        timelineTail: timeline.slice(-3)
    });
});

rows.sort((a, b) => (b.final || b.maxRaw) - (a.final || a.maxRaw));
rows.forEach((r) => {
    console.log('\n---', r.nickname, `(eid=${r.entityId}) final=${r.final} maxRaw=${r.maxRaw} points=${r.pointCount}`);
    console.log('  first damage at replay clock', r.firstClock, 'value', r.firstVal);
    r.timeline.forEach((p) => console.log('   ', p.clock.toFixed(1), '->', p.value));
    if (r.pointCount > 8) {
        console.log('   ...');
        r.timelineTail.forEach((p) => console.log('   ', p.clock.toFixed(1), '->', p.value));
    }
});

// Scan all type7 pl=14 variants
console.log('\n=== type7 pl=14 field combos ===');
const combos = new Map();
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (type !== 7 || payloadLen !== 14) return;
    const f4 = payload.readUInt32LE(4);
    const f8 = payload.readUInt32LE(8);
    const key = `${f4}|${f8}`;
    if (!combos.has(key)) combos.set(key, { count: 0, firstClock: clock, entities: new Set() });
    const c = combos.get(key);
    c.count += 1;
    c.entities.add(payload.readUInt32LE(0));
});
[...combos.entries()].sort((a, b) => b[1].count - a[1].count).forEach(([key, c]) => {
    console.log(`f4=${key.split('|')[0]} f8=${key.split('|')[1]} count=${c.count} entities=${c.entities.size} firstClock=${c.firstClock.toFixed(1)}`);
});

// Early damage check - who has damage before clock 40?
console.log('\n=== samples with value>0 before replay clock 40 ===');
byEntity.forEach((samples, entityId) => {
    const early = samples.filter((s) => s.clock < 40 && s.value > 0);
    if (early.length) {
        console.log(nick(entityId), early.slice(0, 5).map((s) => `${s.clock.toFixed(1)}:${s.value}`).join(', '));
    }
});
