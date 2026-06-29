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
const tailToEntity = new Map();
packets.forEach(({ type, payload, payloadLen }) => {
    if (type === 8 && payloadLen > 500 && payload.readUInt32LE(4) === 55) {
        parseSubtype55Players(payload).forEach((p, eid) => {
            entityPlayers.set(eid, p);
            const tail = Buffer.alloc(4);
            tail.writeUInt32LE(eid);
            tailToEntity.set(tail.subarray(0, 3).toString('hex') + 'd510', eid);
            // pl19 uses 3 byte + d510 pattern
            const b = Buffer.alloc(4);
            b.writeUInt32LE(eid);
            const t3 = `${b[0].toString(16).padStart(2,'0')}${b[1].toString(16).padStart(2,'0')}${b[2].toString(16).padStart(2,'0')}bbd510`;
            tailToEntity.set(t3, eid);
        });
    }
});

function nick(eid) { return (entityPlayers.get(eid) || {}).nickname || String(eid); }

function findAttacker(hex) {
    for (const [tail, eid] of tailToEntity.entries()) {
        if (hex.includes(tail)) return eid;
    }
    return null;
}

// Parse pl49 sub35
const events = [];
packets.forEach(({ clock, payload, payloadLen }) => {
    if (payloadLen !== 49 || payload.readUInt32LE(4) !== 35) return;
    const hex = payload.toString('hex');
    const victim = payload.readUInt32LE(12);
    const attacker = findAttacker(hex);
    const fields = {};
    for (let off = 16; off + 2 <= payloadLen; off += 2) {
        fields[off] = payload.readUInt16LE(off);
    }
    events.push({ clock, attacker, victim, fields, hex });
});

console.log('pl49 sub35 events', events.length);
console.log('attributed', events.filter(e => e.attacker).length);

// Show field value distribution at each offset for attributed events
const offsets = [16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46];
offsets.forEach((off) => {
    const vals = events.filter(e => e.attacker).map(e => e.fields[off]).filter(v => v > 0 && v < 2000);
    if (vals.length < 5) return;
    const uniq = [...new Set(vals)].length;
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    console.log(`off ${off}: count=${vals.length} uniq=${uniq} min=${min} max=${max}`);
});

// Group by attacker, count events and try u16@44 as damage
console.log('\n=== per attacker event counts ===');
const byAtk = new Map();
events.forEach((e) => {
    if (!e.attacker) return;
    if (!byAtk.has(e.attacker)) byAtk.set(e.attacker, []);
    byAtk.get(e.attacker).push(e);
});
[...byAtk.entries()].sort((a,b)=>(ctx.finalDamage.get(b[0])||0)-(ctx.finalDamage.get(a[0])||0)).forEach(([eid, evs]) => {
    console.log(nick(eid), 'events', evs.length, 'final', ctx.finalDamage.get(eid), 'first', evs[0].clock.toFixed(1), 'fields44 sample', evs.slice(0,5).map(e=>e.fields[44]).join(','));
});

// Try correlate u16 fields with known shot damage - show first 10 Xasya events
console.log('\n=== Xasya pl49 events ===');
const xasya = [...entityPlayers.entries()].find(([,p]) => p.nickname === 'Xasya')[0];
(byAtk.get(xasya) || []).slice(0, 15).forEach((e) => {
    console.log(`t=${e.clock.toFixed(1)} vic=${nick(e.victim)} u16@36=${e.fields[36]} u16@44=${e.fields[44]} u16@46=${e.fields[46]}`);
});

// Compare pl19 clock to pl49 for same attacker
console.log('\n=== pl19 vs pl49 clocks for Xasya ===');
const pl19 = [];
packets.forEach(({ type, clock, payload, payloadLen }) => {
    if (type !== 8 || payloadLen !== 19) return;
    if (payload.readUInt32LE(0) !== xasya) return;
    if (payload.readUInt32LE(4) !== 2 || payload.readUInt32LE(8) !== 7) return;
    pl19.push({ clock, v: payload.readUInt16LE(12) });
});
console.log('pl19', pl19.map(p => `${p.clock.toFixed(1)}:${p.v}`).join(' '));
console.log('pl49 count', (byAtk.get(xasya)||[]).length, 'first few clocks', (byAtk.get(xasya)||[]).slice(0,10).map(e=>e.clock.toFixed(1)).join(' '));

// Scale approach: distribute final damage across pl49 event times proportionally?
// Count events per player vs final
console.log('\n=== events vs final ratio ===');
[...byAtk.entries()].sort((a,b)=>(ctx.finalDamage.get(b[0])||0)-(ctx.finalDamage.get(a[0])||0)).forEach(([eid, evs]) => {
    const final = ctx.finalDamage.get(eid) || 0;
    if (!final) return;
    // filter events after battle start 37
    const battle = evs.filter(e => e.clock >= 35);
    console.log(nick(eid), 'battleEvents', battle.length, 'final', final, 'avgPerEvent', (final/battle.length).toFixed(0));
});
