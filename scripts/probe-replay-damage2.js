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

// Analyze type7 f4=2 pl=14 - most common
function analyzeF4(f4target) {
    const byEntity = new Map();
    packets.forEach(({ type, clock, payload, payloadLen }) => {
        if (type !== 7 || payloadLen !== 14) return;
        if (payload.readUInt32LE(4) !== f4target || payload.readUInt32LE(8) !== 2) return;
        const entityId = payload.readUInt32LE(0);
        const u16_10 = payload.readUInt16LE(10);
        const u16_12 = payload.readUInt16LE(12);
        if (!byEntity.has(entityId)) byEntity.set(entityId, []);
        byEntity.get(entityId).push({ clock, u16_10, u16_12 });
    });

    console.log(`\n=== type7 f4=${f4target} f8=2 pl=14 ===`);
    const rows = [];
    byEntity.forEach((samples, entityId) => {
        samples.sort((a, b) => a.clock - b.clock);
        // Try u16@10 as cumulative
        let max10 = 0;
        const t10 = [];
        samples.forEach((s) => {
            if (s.u16_10 <= max10) return;
            max10 = s.u16_10;
            t10.push({ clock: s.clock, value: s.u16_10 });
        });
        // Try u16@12 as cumulative
        let max12 = 0;
        const t12 = [];
        samples.forEach((s) => {
            if (s.u16_12 <= max12) return;
            max12 = s.u16_12;
            t12.push({ clock: s.clock, value: s.u16_12 });
        });
        const final = ctx.finalDamage.get(entityId) || 0;
        rows.push({ entityId, nickname: nick(entityId), final, max10, max12, t10, t12, count: samples.length });
    });
    rows.sort((a, b) => b.final - a.final);
    rows.forEach((r) => {
        const match10 = r.final > 0 ? (r.max10 / r.final).toFixed(2) : '-';
        const match12 = r.final > 0 ? (r.max12 / r.final).toFixed(2) : '-';
        console.log(`\n${r.nickname} final=${r.final} max@10=${r.max10} ratio=${match10} max@12=${r.max12} ratio=${match12} pkts=${r.count}`);
        if (r.t10.length <= 12) r.t10.forEach((p) => console.log('  @10', p.clock.toFixed(1), p.value));
        else {
            r.t10.slice(0, 6).forEach((p) => console.log('  @10', p.clock.toFixed(1), p.value));
            console.log('  ...');
            r.t10.slice(-3).forEach((p) => console.log('  @10', p.clock.toFixed(1), p.value));
        }
    });
}

analyzeF4(2);
analyzeF4(4);

// type 8 pl=19 hits per entity
console.log('\n=== type8 pl=19 hits (raw sum) ===');
const pl19 = new Map();
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (type !== 8 || payloadLen !== 19) return;
    if (payload.readUInt32LE(4) !== 2 || payload.readUInt32LE(8) !== 7) return;
    const entityId = payload.readUInt32LE(0);
    const dmg = payload.readUInt16LE(12);
    if (dmg <= 0 || dmg > 1800) return;
    if (!pl19.has(entityId)) pl19.set(entityId, []);
    pl19.get(entityId).push({ clock, dmg });
});
[...pl19.entries()].sort((a, b) => {
    const fa = ctx.finalDamage.get(a[0]) || 0;
    const fb = ctx.finalDamage.get(b[0]) || 0;
    return fb - fa;
}).forEach(([eid, hits]) => {
    const sum = hits.reduce((s, h) => s + h.dmg, 0);
    const final = ctx.finalDamage.get(eid) || 0;
    console.log(nick(eid), `hits=${hits.length} sum=${sum} final=${final} ratio=${final ? (sum / final).toFixed(2) : '-'} first@${hits[0].clock.toFixed(1)}`);
});

// Search for packets where u16 value equals known final damage for Xasya (3813)
console.log('\n=== search u16=3813 or nearby for Xasya entity ===');
const xasya = 282442529;
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (clock < 30 || clock > 200) return;
    for (let off = 0; off + 2 <= payloadLen; off += 1) {
        const v = payload.readUInt16LE(off);
        if (v >= 3700 && v <= 3900) {
            if (payload.includes && payload.indexOf) {
                // check entity in payload
            }
            const hasEntity = payload.indexOf(Buffer.from([xasya & 0xff, (xasya >> 8) & 0xff, (xasya >> 16) & 0xff, (xasya >> 24) & 0xff])) >= 0
                || (off >= 4 && payload.readUInt32LE(0) === xasya);
            if (hasEntity || payload.readUInt32LE(0) === xasya) {
                console.log(`type=${type} pl=${payloadLen} clock=${clock.toFixed(1)} off=${off} u16=${v} hex=${payload.subarray(0, Math.min(24, payloadLen)).toString('hex')}`);
            }
        }
    }
});
