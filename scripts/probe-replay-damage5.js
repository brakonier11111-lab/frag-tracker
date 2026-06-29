'use strict';

const path = require('path');
const { parseReplayPackets } = require('../src/modules/replay-live/replayTimeline');
const { parseSubtype55Players } = require('../src/modules/replay-live/replayParser');
const { extractDataReplayFromZip, parseBattleResultsContext } = require('../src/modules/replay-live/battleResultsParser');

const replayPath = process.argv[2] || 'C:\\Users\\ixacy\\Documents\\TanksBlitz\\replays\\20260623_2042__Xasya_Object_907_1168525801180284280.tbreplay';
const buf = extractDataReplayFromZip(replayPath, path.join(__dirname, '../work'));
if (!buf) process.exit(1);
const ctx = parseBattleResultsContext(replayPath);
const packets = parseReplayPackets(buf);

const entityPlayers = new Map();
packets.forEach(({ type, payload, payloadLen }) => {
    if (type === 8 && payloadLen > 500 && payload.readUInt32LE(4) === 55) {
        parseSubtype55Players(payload).forEach((p, eid) => entityPlayers.set(eid, p));
    }
});
function nick(eid) { return (entityPlayers.get(eid) || {}).nickname || String(eid); }

function analyzePacketFilter(label, filterFn) {
    const byEntity = new Map();
    packets.forEach(({ type, clock, payload, payloadLen }) => {
        if (!filterFn(type, payload, payloadLen)) return;
        const entityId = payload.readUInt32LE(0);
        if (entityId < 100_000_000) return;
        const fields = {};
        for (const off of [8, 10, 12, 16, 20, 24, 28, 32]) {
            if (off + 2 <= payloadLen) fields[`u16@${off}`] = payload.readUInt16LE(off);
            if (off + 4 <= payloadLen) fields[`u32@${off}`] = payload.readUInt32LE(off);
        }
        if (!byEntity.has(entityId)) byEntity.set(entityId, []);
        byEntity.get(entityId).push({ clock, fields, hex: payload.subarray(0, Math.min(40, payloadLen)).toString('hex') });
    });
    console.log(`\n=== ${label} entities=${byEntity.size} ===`);
    [...byEntity.entries()].sort((a, b) => (ctx.finalDamage.get(b[0])||0)-(ctx.finalDamage.get(a[0])||0)).slice(0, 5).forEach(([eid, samples]) => {
        console.log(nick(eid), 'final', ctx.finalDamage.get(eid), 'samples', samples.length);
        console.log(' first', JSON.stringify(samples[0]));
        console.log(' mid', JSON.stringify(samples[Math.floor(samples.length/2)]));
    });
    return byEntity;
}

// pl19 - try delta between consecutive u16@12 (if decreasing = damage?)
console.log('=== pl19 delta-as-damage ===');
const pl19hits = [];
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (type !== 8 || payloadLen !== 19) return;
    if (payload.readUInt32LE(4) !== 2 || payload.readUInt32LE(8) !== 7) return;
    pl19hits.push({ clock, entityId: payload.readUInt32LE(0), v: payload.readUInt16LE(12) });
});
pl19hits.sort((a,b)=>a.clock-b.clock);
const byE = new Map();
pl19hits.forEach(h => {
    if (!byE.has(h.entityId)) byE.set(h.entityId, []);
    byE.get(h.entityId).push(h);
});
[...byE.entries()].sort((a,b)=>(ctx.finalDamage.get(b[0])||0)-(ctx.finalDamage.get(a[0])||0)).forEach(([eid, hits]) => {
    let prev = null;
    const deltas = [];
    hits.forEach(h => {
        if (prev != null && prev > h.v) deltas.push({ clock: h.clock, dmg: prev - h.v });
        prev = h.v;
    });
    const sum = deltas.reduce((s,d)=>s+d.dmg,0);
    console.log(nick(eid), 'deltas', deltas.length, 'sum', sum, 'final', ctx.finalDamage.get(eid), deltas.map(d=>`${d.clock.toFixed(1)}:${d.dmg}`).join(' '));
});

analyzePacketFilter('type8 pl=49 sub=35', (t,p,pl)=>t===8&&pl===49&&p.readUInt32LE(4)===35);
analyzePacketFilter('type8 pl=28 sub=25', (t,p,pl)=>t===8&&pl===28&&p.readUInt32LE(4)===25);
analyzePacketFilter('type8 pl=31 sub=55', (t,p,pl)=>t===8&&pl===31&&p.readUInt32LE(4)===55);

// type 8 pl=49 sub=35 - brute monotonic u16 offsets
console.log('\n=== pl49 sub35 monotonic search ===');
const cand = new Map();
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (type !== 8 || payloadLen !== 49 || payload.readUInt32LE(4) !== 35) return;
    const entityId = payload.readUInt32LE(0);
    if (!ctx.finalDamage.has(entityId)) return;
    for (let off = 8; off + 2 <= payloadLen; off++) {
        const v = payload.readUInt16LE(off);
        if (v <= 0 || v > 5000) continue;
        const key = off;
        if (!cand.has(key)) cand.set(key, new Map());
        if (!cand.get(key).has(entityId)) cand.get(key).set(entityId, []);
        cand.get(key).get(entityId).push({ clock, v });
    }
});
[...cand.entries()].map(([off, byEnt]) => {
    let matches = 0;
    byEnt.forEach((samples, eid) => {
        samples.sort((a,b)=>a.clock-b.clock);
        let max = 0; samples.forEach(s=>{if(s.v>max)max=s.v;});
        const final = ctx.finalDamage.get(eid)||0;
        if (final && max/final >= 0.9 && max/final <= 1.1) matches++;
    });
    return { off, matches, entities: byEnt.size };
}).sort((a,b)=>b.matches-a.matches).slice(0,10).forEach(r=>console.log('u16@'+r.off, 'matches', r.matches, '/', r.entities));
