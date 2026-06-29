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
const entityList = [];
packets.forEach(({ type, payload, payloadLen }) => {
    if (type === 8 && payloadLen > 500 && payload.readUInt32LE(4) === 55) {
        parseSubtype55Players(payload).forEach((p, eid) => {
            entityPlayers.set(eid, p);
            entityList.push({ eid, nick: p.nickname, tail: (eid & 0xff).toString(16).padStart(2, '0') });
        });
    }
});

function nick(eid) {
    return (entityPlayers.get(eid) || {}).nickname || String(eid);
}

// type39 impact-like: f20 in 0.08-0.12, dmg 50-600, after clock 20
console.log('=== type39 impact candidates (clock>=20, dmg 50-600, f20 0.08-0.12) ===');
const impacts = [];
packets.forEach(({ clock, payload, payloadLen }) => {
    if (payloadLen !== 28) return;
    const f20 = payload.readFloatLE(20);
    const dmg = payload.readUInt16LE(24);
    if (clock < 20 || dmg < 50 || dmg > 600) return;
    if (f20 < 0.08 || f20 > 0.12) return;
    impacts.push({
        clock,
        dmg,
        f0: payload.readFloatLE(0),
        f4: payload.readFloatLE(4),
        f8: payload.readFloatLE(8),
        f12: payload.readFloatLE(12),
        f16: payload.readFloatLE(16),
        f20,
        hex: payload.toString('hex')
    });
});
console.log('count', impacts.length);
impacts.slice(0, 30).forEach((e) => {
    console.log(`t=${e.clock.toFixed(1)} dmg=${e.dmg} f0=${e.f0.toFixed(1)} f20=${e.f20.toFixed(4)} hex=${e.hex.slice(0, 40)}`);
});

// Match pl19 tail byte (3 bytes before 00) to entity low byte
console.log('\n=== entity tail bytes from pl19 ===');
const tails = new Map();
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (type !== 8 || payloadLen !== 19) return;
    if (payload.readUInt32LE(4) !== 2 || payload.readUInt32LE(8) !== 7) return;
    const entityId = payload.readUInt32LE(0);
    const tail = payload.subarray(14, 18).toString('hex');
    tails.set(entityId, tail);
});
[...tails.entries()].forEach(([eid, tail]) => console.log(nick(eid), eid, 'tail', tail));

// Search type39 for entity id bytes in payload
console.log('\n=== match type39 hex patterns to attacker tails ===');
const knownTails = [...tails.entries()].map(([eid, tail]) => ({ eid, nick: nick(eid), tail }));
impacts.slice(0, 50).forEach((imp) => {
    const matched = knownTails.filter((k) => imp.hex.includes(k.tail.slice(0, 6)));
    if (matched.length) {
        console.log(`t=${imp.clock.toFixed(1)} dmg=${imp.dmg} ->`, matched.map((m) => m.nick).join(','));
    }
});

// Sum type39 impacts by matched attacker if tail in hex at fixed offset
console.log('\n=== attribute type39 by tail substring in payload ===');
const byAttacker = new Map();
impacts.forEach((imp) => {
    let best = null;
    knownTails.forEach(({ eid, tail }) => {
        if (imp.hex.includes(tail.slice(0, 6))) best = eid;
    });
    if (best) {
        if (!byAttacker.has(best)) byAttacker.set(best, []);
        byAttacker.get(best).push({ clock: imp.clock, dmg: imp.dmg });
    }
});
[...byAttacker.entries()].sort((a, b) => (ctx.finalDamage.get(b[0]) || 0) - (ctx.finalDamage.get(a[0]) || 0)).forEach(([eid, hits]) => {
    const sum = hits.reduce((s, h) => s + h.dmg, 0);
    const final = ctx.finalDamage.get(eid) || 0;
    console.log(nick(eid), `impacts=${hits.length} sum=${sum} final=${final}`, hits.slice(0, 8).map((h) => `${h.clock.toFixed(1)}:${h.dmg}`).join(' '));
});

// type 8 pl=21 structure - might be stat updates
console.log('\n=== type8 pl=21 samples ===');
let c21 = 0;
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (type !== 8 || payloadLen !== 21 || c21 > 8) return;
    if (clock < 30) return;
    const eid = payload.readUInt32LE(0);
    console.log(`clock=${clock.toFixed(1)} eid=${nick(eid)} hex=${payload.toString('hex')}`);
    c21 += 1;
});

// Look for cumulative damage in battle - search all packets entity@0 u32 that increases smoothly
console.log('\n=== search type8 subtype for damage stat ===');
const subtypes = new Map();
packets.forEach(({ type, payload, payloadLen }) => {
    if (type !== 8 || payloadLen < 8) return;
    const sub = payload.readUInt32LE(4);
    const key = `${payloadLen}|${sub}`;
    if (!subtypes.has(key)) subtypes.set(key, 0);
    subtypes.set(key, subtypes.get(key) + 1);
});
[...subtypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, n]) => console.log('pl|sub', k, 'count', n));
