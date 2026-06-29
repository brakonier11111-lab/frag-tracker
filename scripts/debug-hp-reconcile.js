'use strict';

const fs = require('fs');
const path = require('path');
const { parseDataReplayBuffer } = require('../src/modules/replay-live/replayParser');
const { extractDataReplayFromZip } = require('../src/modules/replay-live/battleResultsParser');
const {
    createTimelineCache,
    buildSparsePlayerTimelines,
    currentEntityHpAtClock,
    reconcileStaleAliveHp,
    computeTeamHpSnapshot
} = require('../src/modules/replay-live/replayTimeline');

const replayPath = process.argv[2] || 'C:\\Users\\ixacy\\Documents\\TanksBlitz\\replays\\20260627_2350__Xasya_E-100_1167989321110665103.tbreplay';
const cacheDir = path.join(__dirname, '..', 'replay-live-cache');
const buf = extractDataReplayFromZip(replayPath, cacheDir);
if (!buf) { console.error('failed to extract data.replay'); process.exit(1); }
const parsed = parseDataReplayBuffer(buf);
const entityPlayers = new Map();
(parsed.players || []).forEach((p) => { if (p.entityId) entityPlayers.set(p.entityId, p); });

const cache = createTimelineCache();
const timeline = cache.get(replayPath, buf, fs.statSync(replayPath).mtimeMs, {
    authorEntityId: 0,
    finalDamage: new Map(),
    playerEntityIds: new Set(entityPlayers.keys())
});

const sparse = buildSparsePlayerTimelines(timeline.hits, new Map(), entityPlayers, {
    countdownDurationSec: 420,
    replayDurationSec: Math.ceil(timeline.battleDurationSec),
    hpByEntity: timeline.hpByEntity,
    sub4ByEntity: timeline.sub4ByEntity,
    spawnMaxByEntity: timeline.spawnMaxByEntity
});

console.log('duration', timeline.battleDurationSec, 'players', sparse.players.length, 'victimHits', timeline.victimDamageHits?.length);

function analyze(clockSec, replayAtEnd) {
    const victimHits = timeline.victimDamageHits || [];
    const rows = sparse.players.map((p) => {
        const meta = entityPlayers.get(p.entityId) || {};
        const spawn = p.spawnMaxHp || p.maxHp || 0;
        const hpBefore = currentEntityHpAtClock({
            entityId: p.entityId,
            clockSec,
            hpPoints: p.hpPoints,
            sub4HpPoints: p.sub4HpPoints,
            spawnMaxHp: spawn,
            victimHits
        });
        return {
            nick: p.nickname || meta.nickname,
            team: p.team || meta.team,
            spawn,
            hpBefore,
            hpPoints: p.hpPoints,
            lastTel: (p.hpPoints || []).filter((pt) => pt[0] <= clockSec).pop()
        };
    });

    const teamHp = computeTeamHpSnapshot(
        timeline.hpByEntity,
        entityPlayers,
        1,
        clockSec,
        timeline.maxHpByEntity,
        {
            authorNickname: 'Xasya',
            hits: timeline.hits,
            victimHits,
            sub4ByEntity: timeline.sub4ByEntity,
            spawnMaxByEntity: timeline.spawnMaxByEntity,
            p55SpawnByEntity: timeline.p55SpawnByEntity,
            replayDurationSec: timeline.battleDurationSec,
            replayAtEnd
        }
    );

    const falseDead = rows.filter((r) => {
        const dbg = [...entityPlayers.values()].find((x) => x.nickname === r.nick);
        return r.hpBefore > 0; // we'll compare with team snapshot per entity
    });

    const killedByReconcile = [];
    rows.forEach((r) => {
        const copy = [{ nickname: r.nick, team: r.team, currentHp: r.hpBefore, hpPoints: r.hpPoints }];
        reconcileStaleAliveHp(copy, clockSec, {
            replayDurationSec: timeline.battleDurationSec,
            replayAtEnd
        });
        if (r.hpBefore > 0 && copy[0].currentHp === 0) killedByReconcile.push(r);
    });

    const zeroBefore = rows.filter((r) => r.hpBefore <= 0);
    if (killedByReconcile.length || zeroBefore.length) {
        console.log('\n=== clock', clockSec, 'replayAtEnd', replayAtEnd, 'team alive', teamHp.allies.alive + teamHp.enemies.alive, '===');
        zeroBefore.forEach((r) => console.log('  zero from HP logic:', r.nick, 'spawn', r.spawn, 'lastTel', r.lastTel));
        killedByReconcile.forEach((r) => console.log('  reconcile kill:', r.nick, 'hp', r.hpBefore, 'lastTel', r.lastTel?.[0]));
    }
}

for (const t of [30, 60, 120, 180, 240, 300, 360, 380, 400, 420, 440]) {
    if (t <= timeline.battleDurationSec + 20) {
        analyze(t, false);
    }
}

console.log('\n--- at replay end ---');
analyze(timeline.battleDurationSec, true);
