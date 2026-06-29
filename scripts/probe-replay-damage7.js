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
function nick(eid) { return (entityPlayers.get(eid) || {}).nickname || String(eid); }

// Build tail map from pl19
const tailToEntity = new Map();
packets.forEach(({ type, payload, payloadLen }) => {
    if (type !== 8 || payloadLen !== 19) return;
    if (payload.readUInt32LE(4) !== 2 || payload.readUInt32LE(8) !== 7) return;
    const eid = payload.readUInt32LE(0);
    const tail = payload.subarray(14, 18).toString('hex');
    tailToEntity.set(tail, eid);
});
console.log('tails from pl19');
[...tailToEntity.entries()].forEach(([t,e]) => console.log(t, nick(e)));

function findAttacker(hex) {
    for (const [tail, eid] of tailToEntity.entries()) {
        if (hex.includes(tail)) return eid;
    }
    return null;
}

const events = [];
packets.forEach(({ clock, payload, payloadLen }) => {
    if (payloadLen !== 49 || payload.readUInt32LE(4) !== 35) return;
    const hex = payload.toString('hex');
    const victim = payload.readUInt32LE(12);
    const attacker = findAttacker(hex);
    if (!attacker) return;
    events.push({
        clock,
        attacker,
        victim,
        u16_36: payload.readUInt16LE(36),
        u16_44: payload.readUInt16LE(44),
        u16_46: payload.readUInt16LE(46),
        f20: payload.readFloatLE(20),
        f24: payload.readFloatLE(24),
        f28: payload.readFloatLE(28),
        f32: payload.readFloatLE(32),
        f40: payload.readFloatLE(40)
    });
});

console.log('\nattributed pl49 events', events.length);
const byAtk = new Map();
events.forEach((e) => {
    if (!byAtk.has(e.attacker)) byAtk.set(e.attacker, []);
    byAtk.get(e.attacker).push(e);
});

[...byAtk.entries()].sort((a,b)=>(ctx.finalDamage.get(b[0])||0)-(ctx.finalDamage.get(a[0])||0)).forEach(([eid, evs]) => {
    const battle = evs.filter(e => e.clock >= 35);
    console.log('\n', nick(eid), 'final', ctx.finalDamage.get(eid), 'events', battle.length, 'first@', battle[0]?.clock.toFixed(1));
    battle.slice(0, 12).forEach((e) => console.log(`  t=${e.clock.toFixed(1)} vic=${nick(e.victim)} u44=${e.u16_44} u46=${e.u16_46} f20=${e.f20.toFixed(1)}`));
});

// type39 early hits for xasya
const xasya = [...entityPlayers.entries()].find(([,p]) => p.nickname === 'Xasya')[0];
console.log('\nXasya type39 impacts');
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (type !== 39 || payloadLen !== 28) return;
    const f20 = payload.readFloatLE(20);
    const dmg = payload.readUInt16LE(24);
    if (clock >= 20 && clock <= 30 && f20 > 0.08 && f20 < 0.12 && dmg >= 200 && dmg <= 600) {
        console.log(` t=${clock.toFixed(1)} dmg=${dmg}`);
    }
});

// Alternative: use type7 f4=2 - maybe it's not damage but let's check u16@12 changes monotonic for each entity with scaling
console.log('\n=== type7 f4=2 u16@12 monotonic scaled to final ===');
const f2 = new Map();
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (type !== 7 || payloadLen !== 14) return;
    if (payload.readUInt32LE(4) !== 2 || payload.readUInt32LE(8) !== 2) return;
    const eid = payload.readUInt32LE(0);
    const v = payload.readUInt16LE(12);
    if (!f2.has(eid)) f2.set(eid, []);
    f2.get(eid).push({ clock, v });
});
[...f2.entries()].sort((a,b)=>(ctx.finalDamage.get(b[0])||0)-(ctx.finalDamage.get(a[0])||0)).slice(0,5).forEach(([eid, samples]) => {
    samples.sort((a,b)=>a.clock-b.clock);
    let max = 0;
    const tl = [];
    samples.forEach(s => { if (s.v > max) { max = s.v; tl.push(s); } });
    const final = ctx.finalDamage.get(eid)||0;
    const scale = max > 0 && final > 0 ? final/max : 1;
    console.log(nick(eid), 'maxRaw', max, 'final', final, 'scale', scale.toFixed(3));
    tl.filter(s => s.clock >= 35).slice(0,8).forEach(s => console.log(`  t=${s.clock.toFixed(1)} raw=${s.v} scaled=${Math.round(s.v*scale)}`));
});
