'use strict';

const REPLAY_MAGIC = 0x12345678;

function readLengthDelimitedU8(buf, offset) {
    if (offset >= buf.length) return null;
    const len = buf.readUInt8(offset);
    offset += 1;
    if (offset + len > buf.length) return null;
    return { value: buf.subarray(offset, offset + len), next: offset + len };
}

function readStringU8(buf, offset) {
    const part = readLengthDelimitedU8(buf, offset);
    if (!part) return null;
    return { value: part.value.toString('utf8'), next: part.next };
}

function readQuirkyLength(buf, offset) {
    if (offset >= buf.length) return null;
    const first = buf.readUInt8(offset);
    if (first === 0xff) {
        if (offset + 4 > buf.length) return null;
        const len = buf.readUInt16LE(offset + 1);
        const magic = buf.readUInt8(offset + 3);
        if (magic !== 0x00) return null;
        return { value: len, next: offset + 4 };
    }
    return { value: first, next: offset + 1 };
}

function readVarint(buf, offset) {
    let result = 0;
    let shift = 0;
    while (offset < buf.length) {
        const b = buf.readUInt8(offset);
        offset += 1;
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 35) return null;
    }
    return { value: result >>> 0, next: offset };
}

function parseBasePlayerCreate(payload) {
    if (payload.length < 20) return null;
    let offset = 10;
    const authorPart = readStringU8(payload, offset);
    if (!authorPart) return null;
    offset = authorPart.next;
    if (offset + 12 > payload.length) return null;
    const arenaUniqueId = Number(payload.readBigUInt64LE(offset));
    offset += 8;
    const arenaTypeId = payload.readUInt32LE(offset);
    offset += 4;
    const lenPart = readQuirkyLength(payload, offset);
    if (!lenPart) return { authorNickname: authorPart.value, arenaUniqueId, arenaTypeId };
    offset = lenPart.next;
    const pickleEnd = Math.min(payload.length, offset + lenPart.value);
    const pickleBlob = payload.subarray(offset, pickleEnd);
    const battleLevel = extractPickleUInt(pickleBlob, 'battleLevel');
    const accountIds = extractPickleAccountIds(pickleBlob);
    return {
        authorNickname: authorPart.value,
        arenaUniqueId,
        arenaTypeId,
        battleLevel,
        accountIds
    };
}

function extractPickleUInt(blob, key) {
    const needle = Buffer.from(key, 'ascii');
    const idx = blob.indexOf(needle);
    if (idx < 0) return null;
    for (let i = idx + needle.length; i < Math.min(blob.length, idx + needle.length + 8); i += 1) {
        const b = blob.readUInt8(i);
        if (b <= 20) return b;
    }
    return null;
}

function extractPickleAccountIds(blob) {
    const marker = Buffer.from('accountDatabaseIds', 'ascii');
    const idx = blob.indexOf(marker);
    if (idx < 0) return [];
    const tail = blob.subarray(idx, Math.min(blob.length, idx + 400));
    const ids = [];
    for (let i = 0; i < tail.length - 4; i += 1) {
        if (tail.readUInt8(i) === 0x4a) {
            const val = tail.readInt32LE(i + 1);
            if (val > 1000 && val < 2000000000) ids.push(val >>> 0);
        }
    }
    return [...new Set(ids)].slice(0, 20);
}





function findVehicleIdBeforeNick(payload, nickAbsOffset) {
    if (!payload || nickAbsOffset < 2) return 0;
    for (let back = 2; back <= 30; back += 1) {
        const marker = nickAbsOffset - back;
        if (marker < 0) break;
        if (payload.readUInt8(marker) !== 0x12 || payload.readUInt8(marker + 1) !== 0x0f) continue;
        const inner = payload.subarray(marker + 2, marker + 17);
        if (inner.length < 2) return 0;
        return inner.readUInt16LE(0);
    }
    return 0;
}

const VEHICLE_CODE_SKIP = new Set([
    'ZOMBI', 'WAR2', 'FLERC', 'CKFT', '161W', 'DBREL', 'HTTP', 'HTTPS'
]);

function parseSubtype55VehicleCodes(packets) {
    const byNick = new Map();
    const tankRe = /^[A-Z]{2,3}[0-9]{1,3}[A-Za-z0-9_\-]*$/;

    (packets || []).forEach((packet) => {
        if (!packet || packet.type !== 8 || !packet.payload || packet.payload.length < 24) return;
        if (packet.payload.readUInt32LE(4) !== 55 || packet.payload.length > 400) return;

        const pay = packet.payload;
        let nickname = '';
        const codes = [];

        for (let i = 0; i < pay.length - 3; i += 1) {
            if (pay.readUInt8(i) === 0x1a) {
                const len = pay.readUInt8(i + 1);
                if (len >= 2 && len <= 24 && i + 2 + len <= pay.length) {
                    const nick = pay.subarray(i + 2, i + 2 + len).toString('utf8');
                    if (/^[A-Za-z0-9_\-]{2,24}$/.test(nick)) nickname = nick;
                }
            }
            if ((pay.readUInt8(i) & 7) !== 2) continue;
            const len = pay.readUInt8(i + 1);
            if (len < 3 || len > 35 || i + 2 + len > pay.length) continue;
            const code = pay.subarray(i + 2, i + 2 + len).toString('utf8');
            if (!tankRe.test(code) || VEHICLE_CODE_SKIP.has(code)) continue;
            codes.push(code);
        }

        if (!nickname || !codes.length) return;
        const prev = byNick.get(nickname);
        if (!prev || codes[0].length > prev.length) {
            byNick.set(nickname, codes[0]);
        }
    });

    return byNick;
}

function parseSubtype55Players(payload) {
    const players = new Map();
    if (!payload || payload.length < 30) return players;
    let i = 12;
    while (i < payload.length - 10) {
        if (payload.readUInt8(i) !== 0x08) {
            i += 1;
            continue;
        }
        const entityPart = readVarint(payload, i + 1);
        if (!entityPart || entityPart.value < 1000) {
            i += 1;
            continue;
        }
        const rest = payload.subarray(entityPart.next, entityPart.next + 80);
        if (rest.length < 20 || rest.readUInt8(0) !== 0x12 || rest.readUInt8(1) !== 0x0f) {
            i += 1;
            continue;
        }
        const nickOffset = 17;
        if (rest.readUInt8(nickOffset) !== 0x1a) {
            i += 1;
            continue;
        }
        const nickLen = rest.readUInt8(nickOffset + 1);
        if (nickLen < 2 || nickLen > 24 || nickOffset + 2 + nickLen > rest.length) {
            i += 1;
            continue;
        }
        const nickname = rest.subarray(nickOffset + 2, nickOffset + 2 + nickLen).toString('utf8');
        if (!/^[A-Za-z0-9_\-]{2,24}$/.test(nickname)) {
            i += 1;
            continue;
        }
        let team = 0;
        let accountId = 0;
        let platoonGroupId = 0;
        const tail = rest.subarray(nickOffset + 2 + nickLen, nickOffset + 2 + nickLen + 50);
        let t = 0;
        let maxHp = 0;
        while (t < tail.length - 1) {
            const tag = tail.readUInt8(t);
            t += 1;
            const field = tag >> 3;
            const wire = tag & 7;
            if (wire === 0) {
                const valPart = readVarint(tail, t);
                if (!valPart) break;
                t = valPart.next;
                if (field === 4 && (valPart.value === 1 || valPart.value === 2)) team = valPart.value;
                if (field === 7) accountId = valPart.value;
                if (field === 10 && valPart.value > 1000) platoonGroupId = valPart.value;
                if (field === 31
                    && valPart.value >= 1500
                    && valPart.value <= 3500
                    && valPart.value !== 2049) {
                    maxHp = Math.max(maxHp, valPart.value);
                }
            } else if (wire === 2) {
                const lenPart = readVarint(tail, t);
                if (!lenPart) break;
                t = lenPart.next + lenPart.value;
            } else if (wire === 5) {
                t += 4;
            } else if (wire === 1) {
                t += 8;
            } else break;
        }
        const nickAbsOffset = entityPart.next + nickOffset;
        players.set(entityPart.value, {
            entityId: entityPart.value,
            nickname,
            team,
            accountId,
            platoonGroupId,
            vehicleId: findVehicleIdBeforeNick(payload, nickAbsOffset),
            spawnMaxHp: maxHp || 0,
            damageDealt: null,
            damageSource: null
        });
        i = entityPart.next + 17;
    }
    return players;
}

function parseLiveDamageMap(buf, options) {
    // Subtype-4 type-7 packets are not cumulative damage (they track HP-like values).
    // Live damage must come from PL33 hit events via parsePl33LiveDamageMap().
    return new Map();
}

function mergePlayerDamage(entityPlayers, liveDamage, finalDamage, rosterByNick) {
    const merged = new Map();
    entityPlayers.forEach((player, entityId) => {
        merged.set(entityId, Object.assign({}, player));
    });

    finalDamage.forEach((damage, entityId) => {
        const row = merged.get(entityId) || {
            entityId,
            nickname: '',
            team: 0,
            accountId: 0
        };
        row.damageDealt = damage;
        row.damageSource = 'battle_results';
        merged.set(entityId, row);
    });

    liveDamage.forEach((damage, entityId) => {
        const row = merged.get(entityId) || {
            entityId,
            nickname: '',
            team: 0,
            accountId: 0
        };
        if (row.damageSource !== 'battle_results') {
            row.damageDealt = damage;
            row.damageSource = 'live';
        }
        merged.set(entityId, row);
    });

    merged.forEach((row) => {
        const meta = rosterByNick.get((row.nickname || '').toLowerCase());
        if (meta) {
            if (!row.team) row.team = meta.team || 0;
            if (!row.accountId) row.accountId = meta.accountId || 0;
        }
    });

    return [...merged.values()]
        .sort((a, b) => (b.damageDealt || 0) - (a.damageDealt || 0) || String(a.nickname).localeCompare(String(b.nickname)));
}

function parseDataReplayBuffer(buf, options) {
    options = options || {};
    const tailReserve = options.tailReserve == null ? 256 : options.tailReserve;
    const safeLength = Math.max(0, buf.length - tailReserve);
    const result = {
        clientVersion: '',
        packets: [],
        battleTimeSec: 0,
        authorNickname: '',
        arenaUniqueId: null,
        arenaTypeId: null,
        battleLevel: null,
        accountIds: [],
        players: [],
        packetCount: 0,
        parseError: null
    };

    if (safeLength < 16) return result;
    if (buf.readUInt32LE(0) !== REPLAY_MAGIC) {
        result.parseError = 'bad_magic';
        return result;
    }

    let offset = 4;
    offset += 8;
    const hashPart = readLengthDelimitedU8(buf, offset);
    if (!hashPart) return result;
    offset = hashPart.next;
    const versionPart = readStringU8(buf, offset);
    if (!versionPart) return result;
    result.clientVersion = versionPart.value;
    offset = versionPart.next + 1;

    const entityPlayers = new Map();
    const liveDamage = parseLiveDamageMap(buf, options);

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

        result.packetCount += 1;
        result.battleTimeSec = Math.max(result.battleTimeSec, clock);

        if (type === 0) {
            const created = parseBasePlayerCreate(payload);
            if (created) {
                result.authorNickname = created.authorNickname || result.authorNickname;
                result.arenaUniqueId = created.arenaUniqueId;
                result.arenaTypeId = created.arenaTypeId;
                result.battleLevel = created.battleLevel;
                result.accountIds = created.accountIds || result.accountIds;
            }
        } else if (type === 8 && payload.length > 500 && payload.readUInt32LE(4) === 55) {
            parseSubtype55Players(payload).forEach((player, entityId) => {
                entityPlayers.set(entityId, player);
            });
        }
    }

    const rosterByNick = new Map();
    entityPlayers.forEach((player) => {
        if (player.nickname) rosterByNick.set(player.nickname.toLowerCase(), player);
    });
    result.players = mergePlayerDamage(entityPlayers, liveDamage, new Map(), rosterByNick);
    result.liveDamage = Object.fromEntries(liveDamage);
    return result;
}

function parseSubtype55SpawnHp(payload) {
    const spawnHp = new Map();
    parseSubtype55Players(payload).forEach((player, entityId) => {
        if (player.spawnMaxHp > 0) spawnHp.set(entityId, player.spawnMaxHp);
    });
    return spawnHp;
}

module.exports = {
    parseDataReplayBuffer,
    parseSubtype55Players,
    parseSubtype55SpawnHp,
    parseSubtype55VehicleCodes,
    parseLiveDamageMap,
    mergePlayerDamage,
    REPLAY_MAGIC
};
