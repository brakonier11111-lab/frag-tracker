'use strict';

const { parseSubtype55SpawnHp } = require('./replayParser');

const REPLAY_MAGIC = 0x12345678;
const DEFAULT_BATTLE_DURATION_SEC = 420;
const DEFAULT_BATTLE_START_OFFSET_SEC = 15;
const FIRST_BATTLE_HIT_ELAPSED_SEC = 24;
const PL33_SUBTYPE = 9;
const PL33_PAYLOAD_LEN = 33;
const PL13_SHOT_PAYLOAD_LEN = 13;
const PL13_SHOT_SUBTYPE = 0;
const PL33_MIN_CLOCK = 20;
const PL33_MIN_DAMAGE = 30;
const PL33_MAX_DAMAGE = 1800;
const PL54_RAM_SUBTYPE = 54;
const PL54_RAM_MIN_DAMAGE = 20;
const PL54_RAM_MAX_DAMAGE = 200;
const TYPE39_SPLASH_PAYLOAD_LEN = 28;
const SPLASH_MIN_DAMAGE = 300;
const SPLASH_MAX_DAMAGE = 900;
const RAM_PL33_LINK_SEC = 0.25;
const SPLASH_SHOT_WINDOW_SEC = 2;
const PL33_SHOT_WINDOW_SEC = 2;
const HIT_SUM_TOLERANCE = 0.08;
const TYPE10_POSITION_PAYLOAD_LEN = 49;
const MOVEMENT_MIN_CLOCK = 5;
const MOVEMENT_MIN_DELTA = 0.3;
const MOVEMENT_MAX_DELTA = 30;
const MOVEMENT_STABLE_SAMPLES = 2;
const HP_TYPE7_SUBTYPE = 3;
const HP_SUB4_SUBTYPE = 4;
const HP_MIN_VALUE = 50;
const HP_MAX_VALUE = 3500;
const HP_SUB4_MIN_VALUE = 1100;
const HP_SUB4_MAX_VALUE = 2200;
const HP_SUB4_JUNK_VALUES = new Set([2049, 2051, 2052, 2306, 2307, 2562, 2563]);

function isValidSub4Hp(value) {
    return value >= HP_SUB4_MIN_VALUE
        && value <= HP_SUB4_MAX_VALUE
        && !HP_SUB4_JUNK_VALUES.has(value);
}

function parseSub4HpEvents(packets, playerEntityIds) {
    const events = [];

    packets.forEach(({ type, clock, payload, payloadLen }) => {
        if (type !== 7 || payloadLen !== 14) return;
        if (payload.readUInt32LE(4) !== HP_SUB4_SUBTYPE) return;
        if (payload.readUInt32LE(8) !== 2) return;

        const entityId = payload.readUInt32LE(0);
        if (!playerEntityIds.has(entityId)) return;

        const hp = payload.readUInt16LE(12);
        if (!isValidSub4Hp(hp)) return;

        events.push({ clock, entityId, hp });
    });

    events.sort((a, b) => a.clock - b.clock || a.entityId - b.entityId);
    return events;
}

function parseHpEvents(packets, playerEntityIds) {
    const events = [];
    const maxHpByEntity = new Map();

    packets.forEach(({ type, clock, payload, payloadLen }) => {
        if (type !== 7 || payloadLen !== 14) return;
        if (payload.readUInt32LE(4) !== HP_TYPE7_SUBTYPE) return;
        if (payload.readUInt32LE(8) !== 2) return;

        const entityId = payload.readUInt32LE(0);
        if (!playerEntityIds.has(entityId)) return;

        const hp = payload.readUInt16LE(12);
        if (hp > HP_MAX_VALUE) return;

        events.push({ clock, entityId, hp });
        if (hp >= HP_MIN_VALUE) {
            maxHpByEntity.set(entityId, Math.max(maxHpByEntity.get(entityId) || 0, hp));
        }
    });

    events.sort((a, b) => a.clock - b.clock || a.entityId - b.entityId);
    return { events, maxHpByEntity };
}

function buildHpPointsFromEvents(events) {
    const byEntity = new Map();

    (events || []).forEach((event) => {
        if (!byEntity.has(event.entityId)) byEntity.set(event.entityId, []);
        const points = byEntity.get(event.entityId);
        const t = Math.round(event.clock * 10) / 10;
        const last = points[points.length - 1];
        if (last && last[0] === t) {
            last[1] = event.hp;
        } else {
            points.push([t, event.hp]);
        }
    });

    byEntity.forEach((points, entityId) => {
        if (!points.length) byEntity.set(entityId, [[0, 0]]);
    });

    return byEntity;
}

function buildSpawnMaxHpMap(hpByEntity, hits, sub4ByEntity, p55SpawnByEntity) {
    const spawn = new Map();

    (hpByEntity || new Map()).forEach((points, entityId) => {
        let best = 0;
        (points || []).forEach((point) => {
            const t = point[0];
            const hp = point[1] || 0;
            if (hp <= 0) return;
            let dmg = 0;
            (hits || []).forEach((hit) => {
                if (hit.victimId === entityId && hit.clock <= t) {
                    dmg += hit.damage || 0;
                }
            });
            best = Math.max(best, hp + dmg);
        });
        if (best > 0) spawn.set(entityId, best);
    });

    (sub4ByEntity || new Map()).forEach((points, entityId) => {
        let best = spawn.get(entityId) || 0;
        (points || []).forEach((point) => {
            if (isValidSub4Hp(point[1])) best = Math.max(best, point[1] || 0);
        });
        if (best > 0) spawn.set(entityId, best);
    });

    (p55SpawnByEntity || new Map()).forEach((hp, entityId) => {
        if (hp > 0) spawn.set(entityId, Math.max(spawn.get(entityId) || 0, hp));
    });

    return spawn;
}

function damageReceivedBefore(hits, entityId, clockSec) {
    let dmg = 0;
    (hits || []).forEach((hit) => {
        const victimId = hit.victimId != null ? hit.victimId : hit.entityId;
        if (victimId === entityId && hit.clock <= clockSec) {
            dmg += hit.damage || 0;
        }
    });
    return dmg;
}

const POST_SUB3_HIT_EPS_SEC = 0.05;

function isPlaceholderHpPoint(point) {
    return Boolean(point && point[0] <= 0 && point[1] === 0);
}

function hasMeaningfulHpTelemetry(hpPoints, clockSec) {
    return (hpPoints || []).some((point) => point[0] <= clockSec && !isPlaceholderHpPoint(point));
}

function lastTelemetryClockAt(points, clockSec) {
    let last = null;
    (points || []).forEach((point) => {
        if (point[0] <= clockSec && !isPlaceholderHpPoint(point)) last = point[0];
    });
    return last;
}

function applyVictimHitsAfterClock(hits, entityId, clockSec, anchorClock, hp) {
    let value = hp;
    (hits || []).forEach((hit) => {
        const victimId = hit.victimId != null ? hit.victimId : hit.entityId;
        if (victimId !== entityId) return;
        if (anchorClock != null && hit.clock <= anchorClock + POST_SUB3_HIT_EPS_SEC) return;
        if (hit.clock > clockSec) return;
        value -= hit.damage || 0;
    });
    return Math.max(0, value);
}

const TYPE5_SPAWN_MAX_CLOCK_SEC = 180;
const TYPE5_SPAWN_WINDOW_SEC = 3;
const TYPE5_HP_MIN = 1000;
const TYPE5_HP_MAX = 3500;
const P55_SPAWN_HP_MIN = 1500;

function parseType5SpawnHpByEntity(packets, rosterByEntity, options) {
    options = options || {};
    const out = new Map();
    if (!packets || !rosterByEntity || !rosterByEntity.size) return out;

    const maxClock = options.maxClock || TYPE5_SPAWN_MAX_CLOCK_SEC;
    const vehicleHpByEntity = options.vehicleHpByEntity instanceof Map ? options.vehicleHpByEntity : new Map();
    const candidates = new Map();
    const rows = [...rosterByEntity.entries()]
        .filter(([, row]) => row && row.nickname && row.entityId);

    packets.forEach(({ type, clock, payload }) => {
        if (type !== 5 || clock > maxClock || !payload || payload.length < 20) return;

        rows.forEach(([entityId, row]) => {
            const nickBuf = Buffer.from(row.nickname, 'utf8');
            const nickOffset = payload.indexOf(nickBuf);
            if (nickOffset < 14) return;
            if (payload.readUInt8(nickOffset - 2) !== 0x06) return;
            if (payload.readUInt8(nickOffset - 1) !== nickBuf.length) return;

            const hp = payload.readUInt16LE(nickOffset - 12);
            if (hp < TYPE5_HP_MIN || hp > TYPE5_HP_MAX) return;

            if (!candidates.has(entityId)) candidates.set(entityId, []);
            candidates.get(entityId).push({ hp, clock });
        });
    });

    candidates.forEach((list, entityId) => {
        const vehicleHp = vehicleHpByEntity.get(entityId) || 0;
        list.sort((a, b) => a.clock - b.clock || a.hp - b.hp);

        const firstClock = list[0].clock;
        const spawnPool = list.filter((candidate) => candidate.clock <= firstClock + TYPE5_SPAWN_WINDOW_SEC);
        let spawnHp = Math.max(...spawnPool.map((candidate) => candidate.hp));

        if (vehicleHp > 0) {
            const matched = spawnPool.filter((candidate) => Math.abs(candidate.hp - vehicleHp) <= 300);
            if (matched.length) {
                spawnHp = Math.max(spawnHp, ...matched.map((candidate) => candidate.hp));
            }
            if (spawnHp < vehicleHp - 40) {
                spawnHp = Math.max(spawnHp, vehicleHp);
            }
        }

        out.set(entityId, spawnHp);
    });

    return out;
}

function resolveEntitySpawnMaxHp(options) {
    options = options || {};
    const type5Hp = Number(options.type5Hp) || 0;
    const vehicleHp = Number(options.vehicleHp) || 0;
    const p55Spawn = Number(options.p55Spawn) || 0;
    const heuristicSpawn = Number(options.heuristicSpawn) || 0;

    function inSpawnRange(hp) {
        return hp >= P55_SPAWN_HP_MIN && hp <= TYPE5_HP_MAX;
    }

    // Type5 (HP 12 bytes before nickname in packet type 5) is the game's per-tank battle HP.
    // parseType5SpawnHpByEntity already picks early-battle spawn values — trust them first.
    if (inSpawnRange(type5Hp)) {
        const spottedDamaged = vehicleHp > 0
            && type5Hp < vehicleHp - 40
            && heuristicSpawn > type5Hp + 80;
        if (!spottedDamaged) return type5Hp;
    }

    if (inSpawnRange(p55Spawn)) return p55Spawn;

    if (inSpawnRange(vehicleHp)) return vehicleHp;

    if (inSpawnRange(heuristicSpawn)) {
        const heuristicFromP55 = p55Spawn > 0 && Math.abs(heuristicSpawn - p55Spawn) <= 80;
        const type5BelowHeuristic = type5Hp > 0 && type5Hp < heuristicSpawn - 40;
        if (!(heuristicFromP55 && type5BelowHeuristic)) {
            return heuristicSpawn;
        }
    }

    return Math.max(type5Hp, vehicleHp, p55Spawn, heuristicSpawn) || 0;
}

function parsePl33VictimDamageEvents(packets, playerEntityIds) {
    const hits = [];
    const seen = new Set();
    const ids = playerEntityIds instanceof Set ? playerEntityIds : new Set(playerEntityIds || []);

    packets.forEach(({ type, clock, payload, payloadLen }) => {
        if (type !== 8 || payloadLen !== PL33_PAYLOAD_LEN) return;
        if (payload.readUInt32LE(4) !== PL33_SUBTYPE) return;
        if (clock < PL33_MIN_CLOCK) return;

        const victimId = payload.readUInt32LE(0);
        if (!ids.has(victimId)) return;
        if (victimId !== payload.readUInt32LE(16)) return;

        const damage = payload.readUInt16LE(30);
        if (damage < PL33_MIN_DAMAGE || damage > PL33_MAX_DAMAGE) return;

        const key = `${victimId}|${clock.toFixed(2)}|${damage}`;
        if (seen.has(key)) return;
        seen.add(key);

        hits.push({
            clock,
            entityId: victimId,
            victimId,
            damage,
            penetrated: payload.readUInt8(32) > 0,
            source: 'pl33_victim'
        });
    });

    hits.sort((a, b) => a.clock - b.clock || a.entityId - b.entityId);
    return hits;
}

function hpValueAtPoints(points, clockSec) {
    if (!points || !points.length) return null;
    let lo = 0;
    let hi = points.length - 1;
    let best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid][0] <= clockSec) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (best < 0) return null;
    if (isPlaceholderHpPoint(points[best])) return null;
    return points[best][1];
}

function currentEntityHpAtClock(options) {
    options = options || {};
    const entityId = options.entityId;
    const clockSec = options.clockSec || 0;
    const hpPoints = options.hpPoints || [];
    const sub4HpPoints = options.sub4HpPoints || [];
    const spawnMaxHp = options.spawnMaxHp || 0;
    const hits = options.victimHits || options.hits || [];

    if (hpPoints.length) {
        for (let i = 0; i < hpPoints.length; i += 1) {
            if (hpPoints[i][0] > clockSec) break;
            if (isPlaceholderHpPoint(hpPoints[i])) continue;
            if (hpPoints[i][1] === 0) return 0;
        }
    }

    const sub3Hp = hpValueAtPoints(hpPoints, clockSec);
    if (sub3Hp != null) {
        const anchorClock = lastTelemetryClockAt(hpPoints, clockSec);
        return applyVictimHitsAfterClock(hits, entityId, clockSec, anchorClock, sub3Hp);
    }

    // No real HP snapshot yet — stay alive (avoid victim-hit overcount).
    if (spawnMaxHp > 0 && !hasMeaningfulHpTelemetry(hpPoints, clockSec)) {
        return spawnMaxHp;
    }

    const damageTaken = spawnMaxHp > 0
        ? damageReceivedBefore(hits, entityId, clockSec)
        : 0;

    if (spawnMaxHp > 0 && damageTaken >= spawnMaxHp) return 0;

    if (spawnMaxHp > 0) {
        return Math.max(0, spawnMaxHp - damageTaken);
    }

    const sub4Hp = hpValueAtPoints(sub4HpPoints, clockSec);
    if (sub4Hp != null && isValidSub4Hp(sub4Hp)) return sub4Hp;

    return 0;
}

function shouldReconcileStaleHp(clockSec, options) {
    options = options || {};
    return options.replayAtEnd === true;
}

function reconcileStaleAliveHp(rows, clockSec, options) {
    options = options || {};
    if (!shouldReconcileStaleHp(clockSec, options)) return rows;

    const staleGapSec = options.staleGapSec != null ? options.staleGapSec : 20;
    const telemetryDeltaSec = options.telemetryDeltaSec != null ? options.telemetryDeltaSec : 3;
    if (!rows || !rows.length) return rows;

    const byTeam = new Map();
    rows.forEach((row) => {
        const team = row.team || 0;
        if (team !== 1 && team !== 2) return;
        if (!byTeam.has(team)) byTeam.set(team, []);
        byTeam.get(team).push(row);
    });

    byTeam.forEach((teamRows) => {
        const alive = teamRows.filter((row) => (row.currentHp || 0) > 0);
        if (alive.length <= 1) return;

        const lastClockOf = (row) => lastTelemetryClockAt(row.hpPoints || [], clockSec);
        const maxLastClock = alive.reduce((best, row) => Math.max(best, lastClockOf(row)), -1);
        if (maxLastClock < 0) return;

        alive.forEach((row) => {
            const lastClock = lastClockOf(row);
            const age = clockSec - lastClock;
            if (lastClock < maxLastClock - telemetryDeltaSec && age > staleGapSec) {
                row.currentHp = 0;
            }
        });
    });

    return rows;
}

function computeTeamHpSnapshot(hpByEntity, rosterByEntity, authorTeam, clockSec, maxHpByEntity, options) {
    options = options || {};
    const authorNick = options.authorNickname || '';
    const hits = options.hits || [];
    const sub4ByEntity = options.sub4ByEntity instanceof Map ? options.sub4ByEntity : new Map();
    const authoritativeHpByEntity = options.authoritativeHpByEntity instanceof Map
        ? options.authoritativeHpByEntity
        : new Map();
    const vehicleHpByEntity = options.vehicleHpByEntity instanceof Map ? options.vehicleHpByEntity : new Map();
    const spawnMaxByEntity = options.spawnMaxByEntity instanceof Map
        ? options.spawnMaxByEntity
        : buildSpawnMaxHpMap(hpByEntity, hits, sub4ByEntity, options.p55SpawnByEntity);
    const p55SpawnByEntity = options.p55SpawnByEntity instanceof Map ? options.p55SpawnByEntity : new Map();
    const allies = { current: 0, max: 0, alive: 0, total: 0 };
    const enemies = { current: 0, max: 0, alive: 0, total: 0 };

    function isOnTeam(meta, side) {
        const team = meta.team || 0;
        const nick = meta.nickname || '';
        if (!authorTeam) return false;
        if (side === 'ally') {
            return team === authorTeam || (authorNick && nick === authorNick);
        }
        return team !== authorTeam && (team === 1 || team === 2);
    }

    function peakHp(entityId, hpPoints, sub4HpPoints) {
        const rawSpawn = spawnMaxByEntity.get(entityId) || 0;
        const sub3Peak = (maxHpByEntity && maxHpByEntity.get(entityId))
            || (hpPoints || []).reduce((best, point) => Math.max(best, point[1] || 0), 0);
        const sub4Peak = (sub4HpPoints || []).reduce((best, point) => {
            const hp = point[1] || 0;
            return isValidSub4Hp(hp) ? Math.max(best, hp) : best;
        }, 0);

        return resolveEntitySpawnMaxHp({
            type5Hp: authoritativeHpByEntity.get(entityId) || 0,
            vehicleHp: vehicleHpByEntity.get(entityId) || 0,
            p55Spawn: p55SpawnByEntity.get(entityId) || 0,
            heuristicSpawn: Math.max(rawSpawn, sub3Peak, sub4Peak)
        });
    }

    const perEntity = [];

    (rosterByEntity || new Map()).forEach((meta, entityId) => {
        const isAlly = isOnTeam(meta, 'ally');
        const isEnemy = isOnTeam(meta, 'enemy');
        if (!isAlly && !isEnemy) return;

        const hpPoints = hpByEntity.get(entityId) || [];
        const sub4HpPoints = sub4ByEntity.get(entityId) || [];
        const rawSpawnMaxHp = spawnMaxByEntity.get(entityId) || 0;
        const sub3Peak = (maxHpByEntity && maxHpByEntity.get(entityId))
            || hpPoints.reduce((best, point) => Math.max(best, point[1] || 0), 0);
        const spawnMaxHp = resolveEntitySpawnMaxHp({
            type5Hp: authoritativeHpByEntity.get(entityId) || 0,
            vehicleHp: vehicleHpByEntity.get(entityId) || 0,
            p55Spawn: p55SpawnByEntity.get(entityId) || 0,
            heuristicSpawn: Math.max(rawSpawnMaxHp, sub3Peak)
        });
        const current = currentEntityHpAtClock({
            entityId,
            clockSec,
            hpPoints,
            sub4HpPoints,
            spawnMaxHp,
            victimHits: options.victimHits || hits,
            hits
        });
        const peak = peakHp(entityId, hpPoints, sub4HpPoints);

        perEntity.push({
            entityId,
            team: meta.team || 0,
            side: isAlly ? 'ally' : 'enemy',
            currentHp: current,
            peak,
            hpPoints
        });
    });

    reconcileStaleAliveHp(perEntity, clockSec, Object.assign({}, options.reconcileStale || {}, {
        replayDurationSec: options.replayDurationSec,
        replayAtEnd: options.replayAtEnd
    }));

    perEntity.forEach((row) => {
        const bucket = row.side === 'ally' ? allies : enemies;
        bucket.total += 1;
        if (row.peak > 0) bucket.max += row.peak;
        bucket.current += Math.max(0, row.currentHp);
        if (row.currentHp > 0) bucket.alive += 1;
    });

    const pct = (row) => {
        if (row.max > 0) return Math.round((row.current / row.max) * 100);
        if (row.total > 0 && row.current > 0) return 100;
        return 0;
    };

    return {
        allies: Object.assign({}, allies, { percent: pct(allies) }),
        enemies: Object.assign({}, enemies, { percent: pct(enemies) }),
        authorTeam: authorTeam || 0,
        clockSec: clockSec || 0
    };
}

function parsePl33LiveDamageMap(buf, playerEntityIds, clockSec) {
    const ids = playerEntityIds instanceof Set
        ? playerEntityIds
        : new Set(playerEntityIds || []);
    if (!ids.size || !buf || buf.length < 32) return new Map();

    const packets = parseReplayPackets(buf);
    const { hits: pl33Hits } = parsePl33HitEvents(packets, ids);
    const cap = Number.isFinite(clockSec) ? Math.max(0, clockSec) : Infinity;
    const out = new Map();

    pl33Hits.forEach((hit) => {
        if (hit.clock > cap) return;
        const entityId = hit.entityId;
        out.set(entityId, (out.get(entityId) || 0) + (hit.damage || 0));
    });

    return out;
}

function parseReplayPackets(buf, options) {
    options = options || {};
    const tailReserve = options.tailReserve == null ? 256 : options.tailReserve;
    const safeLength = Math.max(0, buf.length - tailReserve);
    const packets = [];

    if (safeLength < 16 || buf.readUInt32LE(0) !== REPLAY_MAGIC) {
        return packets;
    }

    let offset = 4 + 8;
    const hashLen = buf.readUInt8(offset);
    offset += 1 + hashLen;
    const versionLen = buf.readUInt8(offset);
    offset += 1 + versionLen + 1;

    while (offset + 12 <= safeLength) {
        const payloadLen = buf.readUInt32LE(offset);
        offset += 4;
        const type = buf.readUInt32LE(offset);
        offset += 4;
        const clock = buf.readFloatLE(offset);
        offset += 4;
        if (payloadLen > buf.length - offset || payloadLen > 5_000_000) break;
        const payload = buf.subarray(offset, offset + payloadLen);
        offset += payloadLen;
        packets.push({ type, clock, payload, payloadLen });
    }

    return packets;
}

function parsePl33HitEvents(packets, playerEntityIds) {
    const hits = [];
    const seen = new Set();
    let firstCanonicalClock = Infinity;

    packets.forEach(({ type, clock, payload, payloadLen }) => {
        if (type !== 8 || payloadLen !== PL33_PAYLOAD_LEN) return;
        if (payload.readUInt32LE(4) !== PL33_SUBTYPE) return;
        if (clock < PL33_MIN_CLOCK) return;

        const attackerId = payload.readUInt32LE(12);
        if (!playerEntityIds.has(attackerId)) return;

        const victimId = payload.readUInt32LE(0);
        if (victimId !== payload.readUInt32LE(16)) return;

        const damage = payload.readUInt16LE(30);
        if (damage < PL33_MIN_DAMAGE || damage > PL33_MAX_DAMAGE) return;

        // byte32=0 are duplicate/ancillary hit events; flag>0 are real damage ticks.
        if (payload.readUInt8(32) === 0) return;

        if (clock < firstCanonicalClock) firstCanonicalClock = clock;

        const key = `${attackerId}|${clock.toFixed(2)}|${damage}`;
        if (seen.has(key)) return;
        seen.add(key);

        hits.push({
            clock,
            entityId: attackerId,
            damage,
            victimId,
            penetrated: payload.readUInt8(32) > 0,
            source: 'pl33_hit'
        });
    });

    hits.sort((a, b) => a.clock - b.clock || a.entityId - b.entityId);
    return {
        hits,
        firstCanonicalClock: Number.isFinite(firstCanonicalClock) ? firstCanonicalClock : null
    };
}

function parseRamDamageEvents(packets, playerEntityIds, pl33Hits) {
    const hits = [];
    const seen = new Set();
    const pl33ByAttacker = new Map();

    (pl33Hits || []).forEach((hit) => {
        if (!pl33ByAttacker.has(hit.entityId)) pl33ByAttacker.set(hit.entityId, []);
        pl33ByAttacker.get(hit.entityId).push(hit);
    });

    packets.forEach(({ type, clock, payload, payloadLen }) => {
        if (type !== 8 || payloadLen < 10) return;
        if (payload.readUInt32LE(4) !== PL54_RAM_SUBTYPE) return;

        const damage = payload.readUInt16LE(8);
        if (damage < PL54_RAM_MIN_DAMAGE || damage > PL54_RAM_MAX_DAMAGE) return;

        let attackerId = null;
        pl33ByAttacker.forEach((entityHits, entityId) => {
            if (attackerId != null) return;
            if (entityHits.some((hit) => Math.abs(hit.clock - clock) <= RAM_PL33_LINK_SEC)) {
                attackerId = entityId;
            }
        });
        if (attackerId == null) return;

        const key = `${attackerId}|${clock.toFixed(2)}|${damage}`;
        if (seen.has(key)) return;
        seen.add(key);

        hits.push({
            clock,
            entityId: attackerId,
            damage,
            victimId: 0,
            penetrated: false,
            source: 'ram'
        });
    });

    hits.sort((a, b) => a.clock - b.clock || a.entityId - b.entityId);
    return hits;
}

function parseSplashDamageEvents(packets, playerEntityIds, shotEvents, pl33Hits) {
    const hits = [];
    const seen = new Set();
    const ids = playerEntityIds instanceof Set ? playerEntityIds : new Set(playerEntityIds || []);

    (shotEvents || []).forEach((shot) => {
        if (!ids.has(shot.entityId)) return;

        const hasDirectHit = (pl33Hits || []).some((hit) => (
            hit.entityId === shot.entityId
            && Math.abs(hit.clock - shot.clock) <= PL33_SHOT_WINDOW_SEC
        ));
        if (hasDirectHit) return;

        let splash = null;
        packets.forEach(({ type, clock, payload, payloadLen }) => {
            if (splash) return;
            if (type !== 39 || payloadLen !== TYPE39_SPLASH_PAYLOAD_LEN) return;
            if (Math.abs(clock - shot.clock) > SPLASH_SHOT_WINDOW_SEC) return;

            const damage = payload.readUInt16LE(4);
            if (damage < SPLASH_MIN_DAMAGE || damage > SPLASH_MAX_DAMAGE) return;
            splash = { clock, damage };
        });
        if (!splash) return;

        const key = `${shot.entityId}|${shot.clock.toFixed(2)}|${splash.damage}`;
        if (seen.has(key)) return;
        seen.add(key);

        hits.push({
            clock: Math.max(shot.clock, splash.clock),
            entityId: shot.entityId,
            damage: splash.damage,
            victimId: 0,
            penetrated: false,
            source: 'splash'
        });
    });

    hits.sort((a, b) => a.clock - b.clock || a.entityId - b.entityId);
    return hits;
}

function mergeCombatHitEvents(pl33Hits, ramHits, splashHits) {
    return [...(pl33Hits || []), ...(ramHits || []), ...(splashHits || [])]
        .sort((a, b) => a.clock - b.clock || a.entityId - b.entityId);
}

function reconcileEntityHitsWithFinal(entityHits, final) {
    if (!entityHits.length) return [];

    const sorted = entityHits
        .slice()
        .sort((a, b) => a.clock - b.clock || String(a.source).localeCompare(String(b.source)));
    const rawSum = sorted.reduce((sum, hit) => sum + (hit.damage || 0), 0);

    if (!final || final <= 0) return sorted;
    if (rawSum === final) return sorted;

    if (rawSum < final) {
        const out = sorted.map((hit) => Object.assign({}, hit));
        const last = out[out.length - 1];
        out.push({
            clock: last.clock,
            entityId: last.entityId,
            damage: final - rawSum,
            victimId: 0,
            penetrated: false,
            source: 'extra'
        });
        return out;
    }

    return normalizeHitSum(sorted, final);
}

function isSupplementaryCombatHit(hit) {
    return hit && (hit.source === 'ram' || hit.source === 'splash');
}

function cloneCombatHit(hit) {
    return {
        clock: hit.clock,
        entityId: hit.entityId,
        damage: hit.damage,
        victimId: hit.victimId,
        penetrated: hit.penetrated,
        source: hit.source
    };
}

function buildEntityHitEvents(rawHits, options) {
    options = options || {};
    const finalDamage = options.finalDamage instanceof Map ? options.finalDamage : null;
    const hitsByEntity = new Map();

    (rawHits || []).forEach((hit) => {
        if (!hitsByEntity.has(hit.entityId)) hitsByEntity.set(hit.entityId, []);
        hitsByEntity.get(hit.entityId).push(hit);
    });

    const entityIds = new Set(hitsByEntity.keys());
    if (finalDamage) finalDamage.forEach((_, entityId) => entityIds.add(entityId));
    if (options.playerEntityIds instanceof Set) {
        options.playerEntityIds.forEach((entityId) => entityIds.add(entityId));
    }

    const reliableHits = [];
    entityIds.forEach((entityId) => {
        const final = finalDamage ? (finalDamage.get(entityId) || 0) : 0;
        const allEntityHits = (hitsByEntity.get(entityId) || []).map(cloneCombatHit);
        const pl33Hits = allEntityHits.filter((hit) => hit.source === 'pl33_hit');
        const supplementary = allEntityHits.filter(isSupplementaryCombatHit);

        if (!pl33Hits.length && !supplementary.length) return;

        let resolved = [];

        if (!final) {
            resolved = pl33Hits.length ? pl33Hits : [];
        } else {
            const pl33Sum = pl33Hits.reduce((sum, hit) => sum + (hit.damage || 0), 0);

            if (pl33Sum > final) {
                resolved = normalizeHitSum(pl33Hits, final);
            } else if (pl33Sum === final) {
                resolved = pl33Hits;
            } else {
                let budget = final - pl33Sum;
                const added = [];
                supplementary
                    .slice()
                    .sort((a, b) => a.clock - b.clock || String(a.source).localeCompare(String(b.source)))
                    .forEach((hit) => {
                        const dmg = hit.damage || 0;
                        if (dmg > 0 && dmg <= budget) {
                            added.push(hit);
                            budget -= dmg;
                        }
                    });
                resolved = pl33Hits.concat(added);
                if (budget > 0 && resolved.length) {
                    const last = resolved[resolved.length - 1];
                    resolved.push({
                        clock: last.clock,
                        entityId: last.entityId,
                        damage: budget,
                        victimId: 0,
                        penetrated: false,
                        source: 'extra'
                    });
                }
            }
        }

        resolved.forEach((hit) => reliableHits.push(hit));
    });

    reliableHits.sort((a, b) => a.clock - b.clock || a.entityId - b.entityId);
    return reliableHits;
}

function parseEntityShotEvents(packets, playerEntityIds) {
    const events = [];
    const ids = playerEntityIds instanceof Set ? playerEntityIds : new Set(playerEntityIds || []);

    packets.forEach(({ type, clock, payload, payloadLen }) => {
        if (type !== 8 || payloadLen !== PL13_SHOT_PAYLOAD_LEN) return;
        if (payload.readUInt32LE(4) !== PL13_SHOT_SUBTYPE) return;
        const entityId = payload.readUInt32LE(0);
        if (!ids.has(entityId)) return;
        events.push({ entityId, clock });
    });

    events.sort((a, b) => a.clock - b.clock || a.entityId - b.entityId);
    return events;
}

function countShotsForEntity(shotEvents, entityId, clockSec) {
    if (!shotEvents || !shotEvents.length) return 0;
    let count = 0;
    for (let i = 0; i < shotEvents.length; i += 1) {
        const shot = shotEvents[i];
        if (shot.entityId !== entityId) continue;
        if (shot.clock > clockSec) continue;
        count += 1;
    }
    return count;
}

function hitsMatchFinal(hits, finalDamage) {
    if (!finalDamage || finalDamage <= 0) return !hits.length;
    if (!hits.length) return false;
    const sum = hits.reduce((acc, hit) => acc + hit.damage, 0);
    const ratio = sum / finalDamage;
    return ratio >= (1 - HIT_SUM_TOLERANCE) && ratio <= (1 + HIT_SUM_TOLERANCE);
}

function normalizeHitSum(hits, finalDamage) {
    if (!hits.length) return [];
    if (!finalDamage || finalDamage <= 0) return hits;

    const rawSum = hits.reduce((sum, hit) => sum + hit.damage, 0);
    if (rawSum <= 0) return [];

    const scale = finalDamage / rawSum;
    const scaled = hits.map((hit) => ({
        clock: hit.clock,
        entityId: hit.entityId,
        damage: Math.max(1, Math.round(hit.damage * scale)),
        victimId: hit.victimId,
        penetrated: hit.penetrated,
        source: hit.source
    }));

    let sum = scaled.reduce((acc, hit) => acc + hit.damage, 0);
    if (sum !== finalDamage) {
        scaled[scaled.length - 1].damage += finalDamage - sum;
    }
    return scaled;
}

function parseDamageHitEvents(buf, options) {
    options = options || {};
    const packets = parseReplayPackets(buf, options);
    let battleDurationSec = 0;

    packets.forEach(({ clock }) => {
        if (Number.isFinite(clock) && clock >= 0) {
            battleDurationSec = Math.max(battleDurationSec, clock);
        }
    });

    const playerEntityIds = options.playerEntityIds instanceof Set
        ? new Set(options.playerEntityIds)
        : new Set();
    if (options.finalDamage instanceof Map) {
        options.finalDamage.forEach((_, entityId) => playerEntityIds.add(entityId));
    }
    if (options.authorEntityId) playerEntityIds.add(options.authorEntityId);

    const shotEvents = parseEntityShotEvents(packets, playerEntityIds);
    const { hits: pl33Hits, firstCanonicalClock } = parsePl33HitEvents(packets, playerEntityIds);
    const ramHits = parseRamDamageEvents(packets, playerEntityIds, pl33Hits);
    const splashHits = parseSplashDamageEvents(packets, playerEntityIds, shotEvents, pl33Hits);
    const mergedHits = mergeCombatHitEvents(pl33Hits, ramHits, splashHits);
    const victimDamageHits = parsePl33VictimDamageEvents(packets, playerEntityIds);
    const { events: hpEvents, maxHpByEntity } = parseHpEvents(packets, playerEntityIds);
    const sub4HpEvents = parseSub4HpEvents(packets, playerEntityIds);
    const hpByEntity = buildHpPointsFromEvents(hpEvents);
    const sub4ByEntity = buildHpPointsFromEvents(sub4HpEvents);
    const battleStart = detectBattleStartDetails(packets, playerEntityIds);
    const battleStartOffsetSec = battleStart.battleStartOffsetSec;
    const hits = buildEntityHitEvents(mergedHits, {
        finalDamage: options.finalDamage instanceof Map ? options.finalDamage : null,
        playerEntityIds
    });
    let p55SpawnByEntity = new Map();
    packets.forEach(({ type, payload, payloadLen }) => {
        if (type === 8 && payloadLen > 500 && payload.readUInt32LE(4) === 55) {
            p55SpawnByEntity = parseSubtype55SpawnHp(payload);
        }
    });
    const spawnMaxByEntity = buildSpawnMaxHpMap(hpByEntity, hits, sub4ByEntity, p55SpawnByEntity);

    return {
        hits,
        victimDamageHits,
        hpEvents,
        sub4HpEvents,
        hpByEntity,
        sub4ByEntity,
        spawnMaxByEntity,
        p55SpawnByEntity,
        maxHpByEntity,
        battleDurationSec,
        firstCanonicalClock,
        battleStartOffsetSec,
        battleStartDebug: battleStart,
        pl33HitCount: pl33Hits.length,
        pl33EntityCount: new Set(pl33Hits.map((hit) => hit.entityId)).size,
        shotEventCount: shotEvents.length,
        shotEvents,
        victimHitCount: victimDamageHits.length,
        hpEventCount: hpEvents.length,
        sub4HpEventCount: sub4HpEvents.length
    };
}

function buildPointsFromHits(hits) {
    if (!hits.length) {
        return [[0, 0]];
    }

    const points = [[0, 0]];
    let cum = 0;

    hits.forEach((hit) => {
        cum += hit.damage;
        const t = Math.round(hit.clock * 10) / 10;
        const last = points[points.length - 1];
        if (last[0] === t) {
            last[1] = cum;
        } else {
            points.push([t, cum]);
        }
    });

    return points;
}

function resolveFinalDamageMap(finalFromResults, hitEvents) {
    if (finalFromResults && finalFromResults.size) return finalFromResults;

    const fallback = new Map();
    hitEvents.forEach((hit) => {
        fallback.set(hit.entityId, (fallback.get(hit.entityId) || 0) + hit.damage);
    });
    return fallback;
}

function aggregateCombatStatsFromHits(hits, clockSec, playerEntityIds, shotEvents) {
    const stats = new Map();
    const ids = playerEntityIds instanceof Set ? playerEntityIds : new Set(playerEntityIds || []);

    function ensure(entityId) {
        if (!stats.has(entityId)) {
            stats.set(entityId, {
                shotsFired: 0,
                hits: 0,
                penetrations: 0,
                damageDealt: 0,
                hitsReceived: 0,
                penetrationsReceived: 0,
                tanksDamaged: 0,
                combatStatsSource: 'replay',
                _victims: new Set()
            });
        }
        return stats.get(entityId);
    }

    (hits || []).forEach((hit) => {
        if (!hit || hit.clock > clockSec) return;

        const penetrated = hit.penetrated !== false;

        if (ids.has(hit.entityId)) {
            const attacker = ensure(hit.entityId);
            attacker.hits += 1;
            attacker.damageDealt += hit.damage || 0;
            if (penetrated) attacker.penetrations += 1;
            if (hit.victimId && ids.has(hit.victimId)) {
                attacker._victims.add(hit.victimId);
            }
        }

        if (hit.victimId && ids.has(hit.victimId)) {
            const victim = ensure(hit.victimId);
            victim.hitsReceived += 1;
            if (penetrated) victim.penetrationsReceived += 1;
        }
    });

    stats.forEach((row, entityId) => {
        row.tanksDamaged = row._victims.size;
        const replayShots = countShotsForEntity(shotEvents, entityId, clockSec);
        row.shotsFired = replayShots > 0 ? replayShots : 0;
        delete row._victims;
    });

    return stats;
}

function buildSparsePlayerTimelines(hitEvents, finalDamage, entityPlayers, options) {
    options = options || {};
    const hpByEntity = options.hpByEntity instanceof Map ? options.hpByEntity : new Map();
    const sub4ByEntity = options.sub4ByEntity instanceof Map ? options.sub4ByEntity : new Map();
    const spawnMaxByEntity = options.spawnMaxByEntity instanceof Map ? options.spawnMaxByEntity : new Map();
    let durationSec = options.replayDurationSec || 0;

    hitEvents.forEach((hit) => {
        if (hit.clock > durationSec) durationSec = Math.ceil(hit.clock);
    });
    if (!durationSec) {
        durationSec = options.countdownDurationSec || DEFAULT_BATTLE_DURATION_SEC;
    }

    const hitsByEntity = new Map();
    hitEvents.forEach((hit) => {
        if (!hitsByEntity.has(hit.entityId)) hitsByEntity.set(hit.entityId, []);
        hitsByEntity.get(hit.entityId).push(hit);
    });

    const entityIds = new Set([
        ...finalDamage.keys(),
        ...hitsByEntity.keys(),
        ...entityPlayers.keys(),
        ...hpByEntity.keys(),
        ...sub4ByEntity.keys()
    ]);

    const players = [];
    entityIds.forEach((entityId) => {
        const meta = entityPlayers.get(entityId) || {};
        const hits = hitsByEntity.get(entityId) || [];
        const points = hits.length ? buildPointsFromHits(hits) : [[0, 0]];

        players.push({
            entityId,
            nickname: meta.nickname || '',
            team: meta.team || 0,
            vehicleId: meta.vehicleId || 0,
            tankName: meta.tankName || '',
            platoonGroupId: meta.platoonGroupId || 0,
            hpPoints: hpByEntity.get(entityId) || [[0, 0]],
            sub4HpPoints: sub4ByEntity.get(entityId) || [[0, 0]],
            spawnMaxHp: spawnMaxByEntity.get(entityId) || 0,
            points
        });
    });

    players.sort((a, b) => {
        const aFinal = a.points[a.points.length - 1][1] || 0;
        const bFinal = b.points[b.points.length - 1][1] || 0;
        return bFinal - aFinal || String(a.nickname).localeCompare(String(b.nickname));
    });

    return { durationSec, countdownDurationSec: options.countdownDurationSec || DEFAULT_BATTLE_DURATION_SEC, players };
}

function damageAtPoints(points, clockSec) {
    if (!points || !points.length) return 0;
    let lo = 0;
    let hi = points.length - 1;
    let best = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid][0] <= clockSec) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return points[best][1];
}

function damageAtClockFromTimelines(timelinesByEntity, clockSec) {
    const out = new Map();
    timelinesByEntity.forEach((points, entityId) => {
        out.set(entityId, damageAtPoints(points, clockSec));
    });
    return out;
}

function replayBattleElapsed(replayClockSec, battleStartOffsetSec) {
    const offset = battleStartOffsetSec > 0
        ? battleStartOffsetSec
        : DEFAULT_BATTLE_START_OFFSET_SEC;
    return Math.max(0, (replayClockSec || 0) - offset);
}

function resolveBattleStartOffset(firstHitClock) {
    if (firstHitClock != null && firstHitClock > PL33_MIN_CLOCK) {
        const inferred = Math.round((firstHitClock - FIRST_BATTLE_HIT_ELAPSED_SEC) * 10) / 10;
        if (inferred >= 5 && inferred <= 55) return inferred;
    }
    return DEFAULT_BATTLE_START_OFFSET_SEC;
}

function detectFirstPlayerMovementClock(packets, playerEntityIds) {
    if (!playerEntityIds || !playerEntityIds.size) return null;

    const last = new Map();
    const stable = new Map();
    let first = null;

    packets.forEach(({ type, clock, payload, payloadLen }) => {
        if (type !== 10 || payloadLen !== TYPE10_POSITION_PAYLOAD_LEN) return;
        if (clock < MOVEMENT_MIN_CLOCK || clock > 55) return;

        const u0 = payload.readUInt32LE(0);
        const u8 = payload.readUInt32LE(8);
        let entityId = null;
        if (playerEntityIds.has(u0)) entityId = u0;
        else if (playerEntityIds.has(u8)) entityId = u8;
        else return;

        const x = payload.readFloatLE(12);
        const z = payload.readFloatLE(20);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return;

        const prev = last.get(entityId);
        if (!prev) {
            last.set(entityId, { x, z });
            stable.set(entityId, 1);
            return;
        }

        const delta = Math.hypot(x - prev.x, z - prev.z);
        if (delta < 0.05) {
            stable.set(entityId, (stable.get(entityId) || 0) + 1);
            last.set(entityId, { x, z });
            return;
        }

        if (delta >= MOVEMENT_MIN_DELTA
            && delta <= MOVEMENT_MAX_DELTA
            && (stable.get(entityId) || 0) >= MOVEMENT_STABLE_SAMPLES) {
            if (first == null || clock < first) first = clock;
        }

        last.set(entityId, { x, z });
        if (delta > MOVEMENT_MAX_DELTA) stable.set(entityId, 0);
    });

    return first != null ? Math.round(first * 10) / 10 : null;
}

function detectBattleCountdownStart(packets) {
    let start = null;

    packets.forEach(({ type, clock, payload, payloadLen }) => {
        if (type !== 7 || payloadLen !== 14) return;
        if (payload.readUInt32LE(4) !== 2) return;
        if (clock < 5 || clock > 55) return;
        if (start == null || clock < start) start = clock;
    });

    if (start == null) return null;
    return Math.round(start * 10) / 10;
}

function detectFirstHitClockFromPl33Packets(packets) {
    let firstHitClock = null;
    packets.forEach(({ type, clock, payload, payloadLen }) => {
        if (type !== 8 || payloadLen !== PL33_PAYLOAD_LEN) return;
        if (payload.readUInt32LE(4) !== PL33_SUBTYPE) return;
        if (clock < PL33_MIN_CLOCK) return;
        if (payload.readUInt32LE(0) !== payload.readUInt32LE(16)) return;
        if (payload.readUInt8(32) === 0) return;

        const damage = payload.readUInt16LE(30);
        if (damage < PL33_MIN_DAMAGE || damage > PL33_MAX_DAMAGE) return;
        if (firstHitClock == null || clock < firstHitClock) firstHitClock = clock;
    });
    return firstHitClock != null ? Math.round(firstHitClock * 10) / 10 : null;
}

function detectBattleStartDetails(packets, playerEntityIds) {
    const movementStart = detectFirstPlayerMovementClock(packets, playerEntityIds);
    const countdownStart = detectBattleCountdownStart(packets);
    const firstHitClock = detectFirstHitClockFromPl33Packets(packets);

    const hitInferred = firstHitClock != null
        ? resolveBattleStartOffset(firstHitClock)
        : null;

    // Countdown packet marks the 7:00 battle timer — prefer it over hit-inferred
    // offsets, which only estimate when the first shot lands (~24s after start).
    if (countdownStart != null && countdownStart >= 5 && countdownStart <= 55) {
        const battleStartOffsetSec = movementStart != null
            ? Math.max(movementStart, countdownStart)
            : countdownStart;
        const source = movementStart != null ? 'movement_countdown_blend' : 'countdown';
        return { movementStart, countdownStart, firstHitClock, hitInferred, battleStartOffsetSec, source };
    }

    if (movementStart != null) {
        return {
            movementStart,
            countdownStart,
            firstHitClock,
            hitInferred,
            battleStartOffsetSec: movementStart,
            source: 'movement'
        };
    }

    if (countdownStart != null) {
        return {
            movementStart,
            countdownStart,
            firstHitClock,
            hitInferred,
            battleStartOffsetSec: countdownStart,
            source: 'countdown'
        };
    }

    const battleStartOffsetSec = hitInferred != null ? hitInferred : resolveBattleStartOffset(firstHitClock);
    const source = hitInferred != null ? 'hit_inferred' : 'default';
    return { movementStart, countdownStart, firstHitClock, hitInferred, battleStartOffsetSec, source };
}

function detectBattleStartClock(packets, playerEntityIds) {
    return detectBattleStartDetails(packets, playerEntityIds).battleStartOffsetSec;
}

function formatCountdown(replayClockSec, durationSec, battleStartOffsetSec) {
    const total = durationSec > 0 ? durationSec : DEFAULT_BATTLE_DURATION_SEC;
    const battleElapsed = replayBattleElapsed(replayClockSec, battleStartOffsetSec);
    const remaining = Math.max(0, Math.floor(total - battleElapsed));
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');
    return `${mm}:${ss}`;
}

const END_BATTLE_FRAG_HP_MAX = 50;
const KILL_ATTRIBUTION_AFTER_DEATH_SEC = 3;

function resolveVictimDeath(player, clockSec, victimHits) {
    const limit = Number(clockSec) || 0;
    const entityId = player.entityId;
    if (!entityId) return null;

    for (const pt of (player.hpPoints || [])) {
        if (pt[0] > limit) break;
        if (isPlaceholderHpPoint(pt)) continue;
        if (pt[1] === 0) {
            return { deathClock: pt[0], endOfBattle: false };
        }
    }

    const hitsOnVictim = (victimHits || []).filter((hit) => hit.victimId === entityId);
    const endHp = currentEntityHpAtClock({
        entityId,
        clockSec: limit,
        hpPoints: player.hpPoints || [],
        sub4HpPoints: player.sub4HpPoints || [],
        spawnMaxHp: player.spawnMaxHp || 0,
        hits: hitsOnVictim
    });
    if (endHp > 0 && endHp <= END_BATTLE_FRAG_HP_MAX) {
        return { deathClock: limit, endOfBattle: true };
    }
    return null;
}

function findKillHitForDeath(victimHits, victimId, deathInfo, limit) {
    const deathClock = deathInfo.deathClock;
    const endOfBattle = deathInfo.endOfBattle === true;
    let killHit = null;

    (victimHits || []).forEach((hit) => {
        if (!hit || hit.victimId !== victimId) return;
        if (hit.clock > limit) return;
        if (!endOfBattle && hit.clock > deathClock + KILL_ATTRIBUTION_AFTER_DEATH_SEC) return;
        if (!killHit || hit.clock > killHit.clock) killHit = hit;
    });

    return killHit;
}

function countFragsAtClock(timeline, clockSec) {
    const players = timeline?.players || [];
    const hits = timeline?.combatHits || timeline?.hits || [];
    const frags = new Map();
    const credited = new Set();
    const limit = Number(clockSec) || 0;

    players.forEach((player) => {
        const victimId = player.entityId;
        if (!victimId) return;

        const deathInfo = resolveVictimDeath(player, limit, hits);
        if (!deathInfo) return;

        const killHit = findKillHitForDeath(hits, victimId, deathInfo, limit);
        const attackerId = killHit && killHit.entityId;
        if (!attackerId || attackerId === victimId || credited.has(victimId)) return;
        credited.add(victimId);
        frags.set(attackerId, (frags.get(attackerId) || 0) + 1);
    });

    return frags;
}

function buildFragMapFromReplayBuffer(buf, options) {
    options = options || {};
    if (!buf || !buf.length) return new Map();

    const entityPlayers = options.entityPlayers instanceof Map ? options.entityPlayers : new Map();
    const finalDamage = options.finalDamage instanceof Map ? options.finalDamage : new Map();
    const clockSec = Number(options.clockSec) || 0;
    const playerEntityIds = new Set([
        ...entityPlayers.keys(),
        ...finalDamage.keys()
    ]);
    if (!playerEntityIds.size) return new Map();

    const parsed = parseDamageHitEvents(buf, { playerEntityIds, finalDamage });
    const sparse = buildSparsePlayerTimelines(parsed.hits, finalDamage, entityPlayers, {
        replayDurationSec: clockSec,
        shotEvents: parsed.shotEvents,
        hpByEntity: parsed.hpByEntity,
        sub4ByEntity: parsed.sub4ByEntity,
        spawnMaxByEntity: parsed.spawnMaxByEntity
    });

    return countFragsAtClock({
        players: sparse.players,
        combatHits: (parsed.hits || []).map((hit) => ({
            entityId: hit.entityId,
            victimId: hit.victimId,
            clock: hit.clock,
            damage: hit.damage || 0
        }))
    }, clockSec);
}

function enrichPlayersWithFrags(players, options) {
    options = options || {};
    const fragMap = options.fragMap instanceof Map ? options.fragMap : new Map();
    const authorNick = (options.authorNickname || '').trim().toLowerCase();
    const authorFrags = options.authorFrags;

    return (players || []).map((row) => {
        const fromCombat = Number(row.frags);
        const fromReplay = row.entityId ? (fragMap.get(row.entityId) || 0) : 0;
        const combatFrags = Number.isFinite(fromCombat) && fromCombat > 0 ? fromCombat : 0;
        let frags = fromReplay > 0 ? fromReplay : combatFrags;
        if (!frags && authorFrags != null && row.nickname
            && row.nickname.toLowerCase() === authorNick) {
            frags = Number(authorFrags) || 0;
        }
        return Object.assign({}, row, { frags });
    });
}

function createTimelineCache() {
    const byKey = new Map();

    function get(replayPath, buf, mtimeMs, options) {
        options = options || {};
        const key = `${replayPath}|${mtimeMs || 0}|${options.authorEntityId || 0}|${options.finalDamage ? options.finalDamage.size : 0}|v57-pl13-shots`;
        const cached = byKey.get(key);
        if (cached) return cached;

        const parsed = parseDamageHitEvents(buf, options);
        const timeline = {
            hits: parsed.hits,
            victimDamageHits: parsed.victimDamageHits || [],
            hpByEntity: parsed.hpByEntity,
            sub4ByEntity: parsed.sub4ByEntity,
            spawnMaxByEntity: parsed.spawnMaxByEntity,
            p55SpawnByEntity: parsed.p55SpawnByEntity,
            maxHpByEntity: parsed.maxHpByEntity,
            battleDurationSec: parsed.battleDurationSec,
            firstCanonicalClock: parsed.firstCanonicalClock,
            battleStartOffsetSec: parsed.battleStartOffsetSec,
            battleStartDebug: parsed.battleStartDebug || null,
            hitCount: parsed.hits.length,
            pl33HitCount: parsed.pl33HitCount || 0,
            pl33EntityCount: parsed.pl33EntityCount || 0,
            shotEventCount: parsed.shotEventCount || 0,
            shotEvents: parsed.shotEvents || [],
            hpEventCount: parsed.hpEventCount || 0,
            sub4HpEventCount: parsed.sub4HpEventCount || 0
        };
        byKey.set(key, timeline);
        if (byKey.size > 12) {
            const first = byKey.keys().next().value;
            byKey.delete(first);
        }
        return timeline;
    }

    function reset() {
        byKey.clear();
    }

    return { get, reset };
}

module.exports = {
    parsePl33LiveDamageMap,
    parseReplayPackets,
    parseType5SpawnHpByEntity,
    resolveEntitySpawnMaxHp,
    parsePl33VictimDamageEvents,
    parseDamageHitEvents,
    parsePl33HitEvents,
    parseEntityShotEvents,
    countShotsForEntity,
    parseHpEvents,
    parseSub4HpEvents,
    buildHpPointsFromEvents,
    buildSpawnMaxHpMap,
    isValidSub4Hp,
    hpValueAtPoints,
    currentEntityHpAtClock,
    reconcileStaleAliveHp,
    computeTeamHpSnapshot,
    buildEntityHitEvents,
    normalizeHitSum,
    hitsMatchFinal,
    resolveFinalDamageMap,
    buildSparsePlayerTimelines,
    aggregateCombatStatsFromHits,
    countFragsAtClock,
    buildFragMapFromReplayBuffer,
    enrichPlayersWithFrags,
    buildPointsFromHits,
    damageAtPoints,
    damageAtClockFromTimelines,
    formatCountdown,
    replayBattleElapsed,
    detectBattleStartClock,
    detectBattleStartDetails,
    detectFirstPlayerMovementClock,
    detectBattleCountdownStart,
    resolveBattleStartOffset,
    createTimelineCache,
    DEFAULT_BATTLE_DURATION_SEC,
    DEFAULT_BATTLE_START_OFFSET_SEC
};
