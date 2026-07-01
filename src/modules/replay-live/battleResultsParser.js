'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { replayArchiveBasename, isReplayArchivePath } = require('./replayCache');
const { mergePlayerDamage } = require('./replayParser');
const { extractZipEntryFromCentral, extractDataReplayFromZipNative, detectReplayDataEntryInZip, REPLAY_DATA_ZIP_ENTRIES } = require('./zipExtract');

function tryRequireAdmZip() {
    try {
        return require('adm-zip');
    } catch (_) {
        return null;
    }
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

const ROSTER_SKIP = new Set([
    'lumber', 'holland', 'faust', 'lagoon', 'port', 'canyon', 'idle', 'desert_train',
    'milbase', 'malinovka', 'mountain', 'erlenberg', 'karelia', 'savanna', 'fort',
    'pliego', 'rift', 'medvedkovo', 'rock', 'forgecity', 'neptune', 'himmelsdorf',
    'plant', 'training', 'booster', 'italy', 'rudniki', 'grossberg', 'mars', 'skit',
    'canal', 'amigosville', 'glacier', 'mars_br', 'avatar_wins', 'None', 'ZOMBI', 'XEH_K2'
]);

function parseRosterFromBattleResults(pb) {
    const roster = new Map();
    if (!pb || !pb.length) return roster;
    let i = 0;
    while (i < pb.length - 5) {
        if (pb.readUInt8(i) !== 0x0a) {
            i += 1;
            continue;
        }
        const lenPart = readVarint(pb, i + 1);
        if (!lenPart || lenPart.value < 2 || lenPart.value > 24) {
            i += 1;
            continue;
        }
        const start = lenPart.next;
        const end = start + lenPart.value;
        if (end > pb.length) break;
        const nick = pb.subarray(start, end).toString('utf8');
        if (!/^[A-Za-z0-9_\-]{2,24}$/.test(nick) || ROSTER_SKIP.has(nick)) {
            i += 1;
            continue;
        }
        let team = 0;
        let accountId = 0;
        let j = end;
        const tailEnd = Math.min(pb.length, end + 40);
        while (j < tailEnd - 1) {
            const tag = pb.readUInt8(j);
            j += 1;
            const field = tag >> 3;
            const wire = tag & 7;
            if (wire === 0) {
                const valPart = readVarint(pb, j);
                if (!valPart) break;
                j = valPart.next;
                if (field === 3 && (valPart.value === 1 || valPart.value === 2)) team = valPart.value;
                if (field === 4) accountId = valPart.value;
            } else if (wire === 2) {
                const lnPart = readVarint(pb, j);
                if (!lnPart) break;
                j = lnPart.next + lnPart.value;
            } else if (wire === 5) {
                j += 4;
            } else if (wire === 1) {
                j += 8;
            } else break;
        }
        roster.set(nick.toLowerCase(), { nickname: nick, team, accountId });
        i += 1;
    }
    return roster;
}

const BATTLE_RESULTS_ENTITY_ID_MIN = 10_000_000;
const BATTLE_RESULTS_ENTITY_ID_MAX = 500_000_000;

function isBattleResultsEntityId(entityId) {
    return entityId >= BATTLE_RESULTS_ENTITY_ID_MIN && entityId <= BATTLE_RESULTS_ENTITY_ID_MAX;
}

function parseCombatSubmessage(buf) {
    const fields = new Map();
    let offset = 0;
    while (offset < buf.length - 1) {
        const tag = buf.readUInt8(offset);
        offset += 1;
        const field = tag >> 3;
        const wire = tag & 7;
        if (wire === 0) {
            const valPart = readVarint(buf, offset);
            if (!valPart) break;
            offset = valPart.next;
            fields.set(field, valPart.value);
        } else if (wire === 2) {
            const lenPart = readVarint(buf, offset);
            if (!lenPart) break;
            offset = lenPart.next + lenPart.value;
        } else if (wire === 5) {
            offset += 4;
        } else if (wire === 1) {
            offset += 8;
        } else break;
    }

    const damageDealt = fields.get(8) || 0;
    if (damageDealt <= 100) return null;

    return {
        shotsFired: fields.get(4) || 0,
        hits: fields.get(5) || 0,
        penetrations: fields.get(7) || 0,
        damageDealt,
        hitsReceived: fields.get(12) || 0,
        penetrationsReceived: fields.get(15) || 0,
        frags: fields.get(6) || fields.get(18) || 0,
        combatStatsSource: 'battle_results'
    };
}

function parseCombatStatsByEntity(pb) {
    const statsByEntity = new Map();
    if (!pb || !pb.length) return statsByEntity;

    let i = 0;
    while (i < pb.length - 12) {
        if (pb.readUInt8(i) !== 0x08) {
            i += 1;
            continue;
        }
        const entityPart = readVarint(pb, i + 1);
        if (!entityPart || !isBattleResultsEntityId(entityPart.value)) {
            i += 1;
            continue;
        }
        const window = pb.subarray(entityPart.next, entityPart.next + 220);
        for (let j = 0; j < window.length - 3; j += 1) {
            if (window.readUInt8(j) !== 0x12) continue;
            const lenPart = readVarint(window, j + 1);
            if (!lenPart || lenPart.value < 15 || lenPart.value > 256) continue;
            const subStart = lenPart.next;
            const subEnd = subStart + lenPart.value;
            if (subEnd > window.length) continue;
            const combat = parseCombatSubmessage(window.subarray(subStart, subEnd));
            if (combat) {
                statsByEntity.set(entityPart.value, combat);
                break;
            }
        }
        i = entityPart.next;
    }

    return statsByEntity;
}

function enrichPlayersWithCombatStats(players, combatStatsByEntity) {
    if (!combatStatsByEntity || !combatStatsByEntity.size) return players || [];
    return (players || []).map((player) => {
        const stats = player.entityId ? combatStatsByEntity.get(player.entityId) : null;
        if (!stats) return player;
        return Object.assign({}, player, stats, {
            damageDealt: stats.damageDealt != null ? stats.damageDealt : player.damageDealt,
            damageSource: 'battle_results'
        });
    });
}

function parseFinalDamageByEntity(pb) {
    const final = new Map();
    if (!pb || !pb.length) return final;
    let i = 0;
    while (i < pb.length - 5) {
        if (pb.readUInt8(i) !== 0x40) {
            i += 1;
            continue;
        }
        const valPart = readVarint(pb, i + 1);
        if (!valPart || valPart.value <= 500 || valPart.value >= 5000) {
            i += 1;
            continue;
        }
        const back = pb.subarray(Math.max(0, i - 30), i);
        let entityId = null;
        for (let k = 0; k < back.length - 2; k += 1) {
            if (back.readUInt8(k) !== 0x08) continue;
            const entPart = readVarint(back, k + 1);
            if (entPart && isBattleResultsEntityId(entPart.value)) {
                entityId = entPart.value;
                break;
            }
        }
        if (entityId != null) {
            final.set(entityId, Math.max(final.get(entityId) || 0, valPart.value));
        }
        i = valPart.next;
    }
    return final;
}

function unpickleSecondElement(buf) {
    if (!buf || buf.length < 16 || buf.readUInt8(0) !== 0x80) return null;
    let offset = 2;
    if (buf.readUInt8(offset) === 0x8a) offset += 9;
    while (offset < buf.length) {
        const op = buf.readUInt8(offset);
        offset += 1;
        if (op === 0x42 || op === 0x43) {
            if (offset >= buf.length) return null;
            const len = buf.readUInt8(offset);
            offset += 1;
            if (offset + len <= buf.length) return buf.subarray(offset, offset + len);
        }
        if (op === 0x54) {
            if (offset + 4 > buf.length) return null;
            const len = buf.readUInt32LE(offset);
            offset += 4;
            if (offset + len <= buf.length) return buf.subarray(offset, offset + len);
        }
    }
    return null;
}

function readBattleResultsProtobufFromPath(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        if (isReplayArchivePath(filePath)) {
            let raw = null;
            const AdmZip = tryRequireAdmZip();
            if (AdmZip) {
                const zip = new AdmZip(filePath);
                const entry = zip.getEntry('battle_results.dat');
                if (entry) raw = entry.getData();
            }
            if (!raw) {
                raw = extractZipEntryFromCentral(filePath, 'battle_results.dat');
            }
            if (!raw) {
                const py = spawnSync('python', [
                    path.join(__dirname, 'parse_battle_results.py'),
                    filePath
                ], { encoding: 'utf8', timeout: 5000 }); // было 12000 — синхронный spawnSync блокирует event loop
                if (py.status === 0 && py.stdout) {
                    const parsed = JSON.parse(py.stdout.trim());
                    if (parsed.success && parsed.players) {
                        return { players: parsed.players, roster: parsed.roster || [] };
                    }
                }
                return null;
            }
            return unpickleSecondElement(raw);
        }
        const raw = fs.readFileSync(filePath);
        return unpickleSecondElement(raw);
    } catch (_) {
        return null;
    }
}

function parseBattleResultsContext(filePath) {
    const loaded = readBattleResultsProtobufFromPath(filePath);
    if (!loaded) {
        return {
            finalDamage: new Map(),
            rosterByNick: new Map(),
            players: [],
            combatStatsByEntity: new Map()
        };
    }
    if (loaded.players) {
        const finalDamage = new Map();
        const combatStatsByEntity = new Map();
        loaded.players.forEach((row) => {
            if (row.entityId && row.damageDealt != null) {
                finalDamage.set(row.entityId, row.damageDealt);
            }
            if (row.entityId && row.damageDealt != null && row.shotsFired != null) {
                combatStatsByEntity.set(row.entityId, {
                    shotsFired: row.shotsFired || 0,
                    hits: row.hits || 0,
                    penetrations: row.penetrations || 0,
                    damageDealt: row.damageDealt,
                    hitsReceived: row.hitsReceived || 0,
                    penetrationsReceived: row.penetrationsReceived || 0,
                    frags: row.frags || 0,
                    combatStatsSource: 'battle_results'
                });
            }
        });
        const rosterByNick = new Map();
        (loaded.roster || []).forEach((row) => {
            if (row.nickname) rosterByNick.set(row.nickname.toLowerCase(), row);
        });
        return { finalDamage, rosterByNick, players: loaded.players, combatStatsByEntity };
    }
    const pb = loaded;
    const rosterByNick = parseRosterFromBattleResults(pb);
    const combatStatsByEntity = parseCombatStatsByEntity(pb);
    const finalDamage = parseFinalDamageByEntity(pb);
    combatStatsByEntity.forEach((stats, entityId) => {
        if (stats.damageDealt != null) {
            finalDamage.set(entityId, stats.damageDealt);
        }
    });
    return { finalDamage, rosterByNick, players: [], combatStatsByEntity };
}

function enrichPlayersWithBattleResults(players, entityPlayers, liveDamage, battleResultsPath) {
    const ctx = parseBattleResultsContext(battleResultsPath);
    const entityMap = new Map();
    (players || []).forEach((p) => {
        if (p.entityId) entityMap.set(p.entityId, p);
    });
    entityPlayers.forEach((p, entityId) => {
        entityMap.set(entityId, p);
    });
    return mergePlayerDamage(entityMap, liveDamage, ctx.finalDamage, ctx.rosterByNick);
}

function extractDataReplayFromZip(zipPath, cacheDir) {
    const entryName = detectReplayDataEntryInZip(zipPath);
    if (!entryName) {
        try {
            const AdmZip = tryRequireAdmZip();
            if (AdmZip) {
                const zip = new AdmZip(zipPath);
                for (const name of REPLAY_DATA_ZIP_ENTRIES) {
                    const entry = zip.getEntry(name);
                    if (entry && entry.getData().length > 32) {
                        return writeCachedReplayExtract(zipPath, cacheDir, entry.getData(), name);
                    }
                }
            }
        } catch (_) { /* noop */ }
        return extractViaPythonFallback(zipPath, cacheDir);
    }

    try {
        fs.mkdirSync(cacheDir, { recursive: true });
        const stat = fs.statSync(zipPath);
        const cached = path.join(cacheDir, `${replayArchiveBasename(zipPath)}.data.replay`);
        const marker = `${cached}.mtime`;
        const entryMarker = `${cached}.entry`;
        if (fs.existsSync(cached) && fs.existsSync(marker)) {
            const saved = fs.readFileSync(marker, 'utf8');
            const savedEntry = fs.existsSync(entryMarker)
                ? fs.readFileSync(entryMarker, 'utf8').trim()
                : 'data.replay';
            if (saved === String(stat.mtimeMs) && savedEntry === entryName) {
                const diskBuf = fs.readFileSync(cached);
                if (diskBuf && diskBuf.length > 32) return diskBuf;
            }
        }
    } catch (_) { /* fall through */ }

    const native = extractDataReplayFromZipNative(zipPath);
    if (native && native.length > 32) {
        return writeCachedReplayExtract(zipPath, cacheDir, native, entryName);
    }

    const AdmZip = tryRequireAdmZip();
    if (AdmZip) {
        const zip = new AdmZip(zipPath);
        const entry = zip.getEntry(entryName);
        if (entry) {
            const buf = entry.getData();
            if (buf && buf.length > 32) {
                return writeCachedReplayExtract(zipPath, cacheDir, buf, entryName);
            }
        }
    }

    return extractViaPythonFallback(zipPath, cacheDir);
}

function writeCachedReplayExtract(zipPath, cacheDir, buf, entryName) {
    try {
        const stat = fs.statSync(zipPath);
        const cached = path.join(cacheDir, `${replayArchiveBasename(zipPath)}.data.replay`);
        const marker = `${cached}.mtime`;
        const entryMarker = `${cached}.entry`;
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cached, buf);
        fs.writeFileSync(marker, String(stat.mtimeMs), 'utf8');
        fs.writeFileSync(entryMarker, entryName || 'data.replay', 'utf8');
    } catch (_) { /* noop */ }
    return buf;
}

function extractViaPythonFallback(zipPath, cacheDir) {
    try {
        const stat = fs.statSync(zipPath);
        const cached = path.join(cacheDir, `${replayArchiveBasename(zipPath)}.data.replay`);
        const marker = `${cached}.mtime`;
        const entryMarker = `${cached}.entry`;
        const cmd = spawnSync('python', [
            '-c',
            'import zipfile,sys\n'
            + 'names=("data.replay","data.wotreplay")\n'
            + 'with zipfile.ZipFile(sys.argv[1]) as z:\n'
            + '  picked=next((n for n in names if n in z.namelist()), None)\n'
            + '  if not picked: raise SystemExit(2)\n'
            + '  open(sys.argv[2],"wb").write(z.read(picked))\n'
            + '  open(sys.argv[3],"w",encoding="utf-8").write(picked)',
            zipPath,
            cached,
            entryMarker
        ], { timeout: 8000 }); // было 30000 — синхронный spawnSync морозит весь event loop, 8с с запасом хватает на распаковку одного zip-члена
        if (cmd.status !== 0) return null;
        fs.writeFileSync(marker, String(stat.mtimeMs), 'utf8');
        return fs.readFileSync(cached);
    } catch (_) {
        return null;
    }
}

module.exports = {
    parseBattleResultsContext,
    enrichPlayersWithBattleResults,
    enrichPlayersWithCombatStats,
    extractDataReplayFromZip,
    detectReplayDataEntryInZip,
    parseFinalDamageByEntity,
    parseCombatStatsByEntity,
    parseRosterFromBattleResults
};
