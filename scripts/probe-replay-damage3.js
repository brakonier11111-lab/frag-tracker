'use strict';

const path = require('path');
const { parseReplayPackets } = require('../src/modules/replay-live/replayTimeline');
const { parseSubtype55Players } = require('../src/modules/replay-live/replayParser');
const { extractDataReplayFromZip, parseBattleResultsContext } = require('../src/modules/replay-live/battleResultsParser');

const replayPath = process.argv[2] || 'C:\\Users\\ixacy\\Documents\\TanksBlitz\\replays\\20260623_2042__Xasya_Object_907_1168525801180284280.tbreplay';
const buf = extractDataReplayFromZip(replayPath, path.join(__dirname, '../work'));
const ctx = parseBattleResultsContext(replayPath);
const packets = parseReplayPackets(buf);

const entityPlayers = new Map();
packets.forEach(({ type, payload, payloadLen }) => {
    if (type === 8 && payloadLen > 500 && payload.readUInt32LE(4) === 55) {
        parseSubtype55Players(payload).forEach((p, eid) => entityPlayers.set(eid, p));
    }
});

function nick(eid) {
    return (entityPlayers.get(eid) || {}).nickname || String(eid);
}

// type 39 pl=28 analysis
console.log('=== type39 pl=28 events ===');
const t39 = [];
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (type !== 39 || payloadLen !== 28) return;
    const f0 = payload.readFloatLE(0);
    const f20 = payload.readFloatLE(20);
    const u24 = payload.readUInt16LE(24);
    t39.push({ clock, f0, f20, u24, hex: payload.toString('hex') });
});
console.log('count', t39.length);
t39.slice(0, 15).forEach((e) => console.log(`clock=${e.clock.toFixed(1)} f0=${e.f0.toFixed(2)} f20=${e.f20.toFixed(4)} dmg=${e.u24}`));
console.log('...');
t39.slice(-5).forEach((e) => console.log(`clock=${e.clock.toFixed(1)} f0=${e.f0.toFixed(2)} f20=${e.f20.toFixed(4)} dmg=${e.u24}`));

// type 7 f4=3 hits
console.log('\n=== type7 f4=3 pl=14 per entity ===');
const f3 = new Map();
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (type !== 7 || payloadLen !== 14) return;
    if (payload.readUInt32LE(4) !== 3 || payload.readUInt32LE(8) !== 2) return;
    const entityId = payload.readUInt32LE(0);
    const dmg = payload.readUInt16LE(12);
    if (dmg <= 0 || dmg > 1800) return;
    if (!f3.has(entityId)) f3.set(entityId, []);
    f3.get(entityId).push({ clock, dmg });
});
[...f3.entries()].sort((a, b) => (ctx.finalDamage.get(b[0]) || 0) - (ctx.finalDamage.get(a[0]) || 0)).forEach(([eid, hits]) => {
    const sum = hits.reduce((s, h) => s + h.dmg, 0);
    const final = ctx.finalDamage.get(eid) || 0;
    console.log(nick(eid), `hits=${hits.length} sum=${sum} final=${final}`, hits.map((h) => `${h.clock.toFixed(1)}:${h.dmg}`).join(' '));
});

// Brute: for each (type, plen, offset) find entity@0 u16@off monotonic series
console.log('\n=== brute monotonic u16@offset for entity@0 packets ===');
const candidates = new Map();
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (payloadLen < 14 || payloadLen > 64) return;
    const entityId = payload.readUInt32LE(0);
    if (entityId < 100_000_000 || entityId > 500_000_000) return;
    const final = ctx.finalDamage.get(entityId);
    if (!final || final < 100) return;

    for (let off = 8; off + 2 <= payloadLen; off += 1) {
        const v = payload.readUInt16LE(off);
        if (v <= 0 || v > 5000) continue;
        const key = `${type}|${payloadLen}|${off}`;
        if (!candidates.has(key)) candidates.set(key, new Map());
        const byEnt = candidates.get(key);
        if (!byEnt.has(entityId)) byEnt.set(entityId, []);
        byEnt.get(entityId).push({ clock, v });
    }
});

const scored = [];
candidates.forEach((byEnt, key) => {
    let matchCount = 0;
    let totalErr = 0;
    let entities = 0;
    byEnt.forEach((samples, entityId) => {
        samples.sort((a, b) => a.clock - b.clock);
        let max = 0;
        samples.forEach((s) => { if (s.v > max) max = s.v; });
        const final = ctx.finalDamage.get(entityId) || 0;
        if (!final) return;
        entities += 1;
        const ratio = max / final;
        if (ratio >= 0.85 && ratio <= 1.15) {
            matchCount += 1;
            totalErr += Math.abs(max - final);
        }
    });
    if (matchCount >= 3) {
        scored.push({ key, matchCount, entities, totalErr });
    }
});
scored.sort((a, b) => b.matchCount - a.matchCount || a.totalErr - b.totalErr);
scored.slice(0, 15).forEach((s) => console.log(s.key, 'matches', s.matchCount, '/', s.entities, 'err', s.totalErr));

// Detail best candidate
if (scored.length) {
    const [type, plen, off] = scored[0].key.split('|').map(Number);
    console.log(`\n=== detail best: type=${type} pl=${plen} u16@${off} ===`);
    const byEnt = candidates.get(scored[0].key);
    [...byEnt.entries()].sort((a, b) => (ctx.finalDamage.get(b[0]) || 0) - (ctx.finalDamage.get(a[0]) || 0)).forEach(([eid, samples]) => {
        samples.sort((a, b) => a.clock - b.clock);
        let max = 0;
        const timeline = [];
        samples.forEach((s) => {
            if (s.v <= max) return;
            max = s.v;
            timeline.push(s);
        });
        const final = ctx.finalDamage.get(eid) || 0;
        console.log(nick(eid), `final=${final} max=${max}`, timeline.slice(0, 6).map((p) => `${p.clock.toFixed(1)}:${p.v}`).join(' '));
    });
}

// type 8 pl=19 with bytes 14-18 victim hint
console.log('\n=== pl19 first hits with tail bytes ===');
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (type !== 8 || payloadLen !== 19) return;
    if (payload.readUInt32LE(4) !== 2 || payload.readUInt32LE(8) !== 7) return;
    const entityId = payload.readUInt32LE(0);
    const dmg = payload.readUInt16LE(12);
    const tail = payload.subarray(14).toString('hex');
    if (clock < 45) {
        console.log(`clock=${clock.toFixed(1)} ${nick(entityId)} dmg=${dmg} tail=${tail}`);
    }
});
