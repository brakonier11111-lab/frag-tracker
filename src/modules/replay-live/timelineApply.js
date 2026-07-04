'use strict';
/**
 * Применение распарсенного реплея к состоянию виджета: таймлайн урона/HP,
 * фраги, комбат-статы, итоговое summary по концу боя. Вынесено из index.js 1:1;
 * общее состояние модуля — через хаб h (геттеры/сеттеры на замыкание index.js,
 * как detection.js и playbackClock.js).
 */

const fs = require('fs');
const path = require('path');
const { mergePlayerDamage } = require('./replayParser');
const { parseFinishedReplay, readMetaFromZip } = require('./battleResults');
const { parseBattleResultsContext, extractDataReplayFromZip, enrichPlayersWithCombatStats } = require('./battleResultsParser');
const { shouldUseBattleResultsStats, isReplayRecordingComplete } = require('./replayCompleteness');
const { isReplayArchivePath } = require('./replayCache');
const { buildReplayEndSummary } = require('./replaySummary');
const { mergeReplayCombatCounters } = require('./combatStatsUtils');
const {
    buildSparsePlayerTimelines,
    resolveFinalDamageMap,
    computeTeamHpSnapshot,
    currentEntityHpAtClock,
    reconcileStaleAliveHp,
    parseType5SpawnHpByEntity,
    resolveEntitySpawnMaxHp,
    damageAtPoints,
    formatCountdown,
    resolveBattleStartOffset,
    replayBattleElapsed,
    parseReplayPackets,
    parsePl33LiveDamageMap,
    parseDamageHitEvents,
    aggregateCombatStatsFromHits,
    countFragsAtClock,
    buildFragMapFromReplayBuffer,
    enrichPlayersWithFrags,
    DEFAULT_BATTLE_DURATION_SEC
} = require('./replayTimeline');
const { enrichPlayersWithTankNames, getVehicleMaxHp, ensureVehicleHpBlocking } = require('./vehicleNames');
const { REPLAY_SUMMARY_TTL_MS, REPLAY_SUMMARY_DELAY_MS } = require('./constants');

function createTimelineApply(h) {
    function applyParsedReplay(parsed, options) {
        options = options || {};
        if (!parsed) return;

        const entityPlayers = new Map();
        (parsed.players || []).forEach((player) => {
            if (player.entityId) entityPlayers.set(player.entityId, player);
        });

        const liveDamage = parsePl33LiveDamageMap(
            options.buf || Buffer.alloc(0),
            new Set(entityPlayers.keys()),
            options.clockSec != null ? options.clockSec : (parsed.battleTimeSec || 0)
        );

        let battleResultsPath = options.battleResultsPath || '';
        if (!battleResultsPath && options.mode === 'recording' && fs.existsSync(h.recordingBattleResultsPath())) {
            battleResultsPath = h.recordingBattleResultsPath();
        }

        const ctx = battleResultsPath ? parseBattleResultsContext(battleResultsPath) : {
            finalDamage: new Map(),
            rosterByNick: new Map(),
            combatStatsByEntity: new Map()
        };

        const players = enrichPlayersWithTankNames(
            mergePlayerDamage(entityPlayers, liveDamage, ctx.finalDamage, ctx.rosterByNick),
            h.tankNameContext({
                buf: options.buf,
                authorNickname: parsed.authorNickname || h.config.playerName || ''
            })
        );
        const authorRow = players.find((p) => p.nickname === parsed.authorNickname)
            || players.find((p) => p.nickname === h.config.playerName)
            || null;

        h.state.clientVersion = parsed.clientVersion || h.state.clientVersion;
        h.state.battleTimeSec = parsed.battleTimeSec || 0;
        h.state.battleTimeLabel = h.formatTime(h.state.battleTimeSec);
        h.state.authorNickname = parsed.authorNickname || h.state.authorNickname;
        h.state.arenaUniqueId = parsed.arenaUniqueId;
        h.state.battleLevel = parsed.battleLevel;
        h.state.players = players;
        h.state.playerCount = players.length;
        h.state.packetCount = parsed.packetCount || 0;
        h.state.live.damageDealt = authorRow && authorRow.damageDealt != null ? authorRow.damageDealt : null;
        h.state.live.damageSource = authorRow ? authorRow.damageSource : null;
    }

    function applyPlaybackTimeline(parsed, buf, battleResultsPath, playbackPath, options) {
        options = options || {};
        if (!parsed || !buf) return;

        const mtimeMs = h.replayFileMtime(playbackPath);
        const loadKey = h.playbackLoadKey(playbackPath);
        let entityPlayers;
        let authorEntityId;
        let ctx;
        let tankCtx;
        let timeline;
        let sparse;
        let countdownDurationSec;
        let battleStartOffsetSec;
        let replayDurationSec;
        let battleDurationSec;
        let replayRecordingComplete;
        let usesExactFinals;

        if (!options.forceFull && h.playbackSession.applyCache && h.playbackSession.applyCache.loadKey === loadKey) {
            ({
                entityPlayers,
                authorEntityId,
                ctx,
                tankCtx,
                timeline,
                sparse,
                countdownDurationSec,
                battleStartOffsetSec,
                replayDurationSec,
                battleDurationSec,
                replayRecordingComplete,
                usesExactFinals
            } = h.playbackSession.applyCache);
        } else {
            entityPlayers = new Map();
            (parsed.players || []).forEach((player) => {
                if (player.entityId) entityPlayers.set(player.entityId, player);
            });

            authorEntityId = h.findAuthorEntityId(parsed, entityPlayers);
            ctx = h.getBattleResultsContext(battleResultsPath);

            tankCtx = h.tankNameContext({
                buf,
                playbackPath,
                authorNickname: parsed.authorNickname || h.config.playerName || ''
            });
            enrichPlayersWithTankNames([...entityPlayers.values()], tankCtx).forEach((player) => {
                if (player.entityId) entityPlayers.set(player.entityId, player);
            });

            const playerEntityIds = new Set(entityPlayers.keys());
            ctx.finalDamage.forEach((_, entityId) => playerEntityIds.add(entityId));

            timeline = h.timelineCache.get(playbackPath, buf, mtimeMs, {
                authorEntityId,
                finalDamage: ctx.finalDamage,
                playerEntityIds
            });
            h.ensurePlaybackSession(playbackPath);

            countdownDurationSec = DEFAULT_BATTLE_DURATION_SEC;
            battleStartOffsetSec = timeline.battleStartOffsetSec
                || resolveBattleStartOffset(timeline.firstCanonicalClock);
            h.playbackSession.battleStartOffsetSec = battleStartOffsetSec;
            replayDurationSec = timeline.battleDurationSec || parsed.battleTimeSec || 0;
            battleDurationSec = Math.max(countdownDurationSec, Math.ceil(replayDurationSec));
            replayRecordingComplete = isReplayRecordingComplete(playbackPath, replayDurationSec);

            const finalDamageMap = resolveFinalDamageMap(ctx.finalDamage, timeline.hits);
            usesExactFinals = ctx.finalDamage.size > 0;

            sparse = buildSparsePlayerTimelines(
                timeline.hits,
                finalDamageMap,
                entityPlayers,
                {
                    countdownDurationSec,
                    replayDurationSec: Math.ceil(replayDurationSec),
                    hpByEntity: timeline.hpByEntity,
                    sub4ByEntity: timeline.sub4ByEntity,
                    spawnMaxByEntity: timeline.spawnMaxByEntity
                }
            );

            h.playbackSession.applyCache = {
                loadKey,
                entityPlayers,
                authorEntityId,
                ctx,
                tankCtx,
                timeline,
                sparse,
                countdownDurationSec,
                battleStartOffsetSec,
                replayDurationSec,
                battleDurationSec,
                replayRecordingComplete,
                usesExactFinals
            };
        }

        h.ensurePlaybackSession(playbackPath);
        if (h.playbackSession.pendingSessionStart) {
            h.ensurePlaybackClock(playbackPath);
        }
        h.maybeRestartPlaybackFromGameCache(replayDurationSec || battleDurationSec);
        h.maybeStartPlaybackClock(playbackPath, h.playbackSession.lastDetectReason);
        h.ensurePlaybackClockRunning(playbackPath, h.playbackSession.lastDetectReason || 'timeline');

        const clockSec = h.getPlaybackClockSec();
        const atEnd = replayDurationSec > 0 && clockSec >= replayDurationSec - 0.25;
        const replayAtEnd = (atEnd || h.playbackSession.clockSource === 'replay_end')
            && !h.isFreshReplaySelection();
        const movementStartSec = battleStartOffsetSec;
        const introPhase = h.playbackSession.clockRunning && clockSec < movementStartSec;
        const statsClockSec = introPhase
            ? Math.min(clockSec, Math.max(0, movementStartSec - 0.05))
            : clockSec;
        const playerEntityIds = new Set(entityPlayers.keys());
        const liveDamage = new Map();
        sparse.players.forEach((player) => {
            liveDamage.set(player.entityId, damageAtPoints(player.points, statsClockSec));
        });

        const useBattleResults = shouldUseBattleResultsStats({
            atEnd,
            combatStatsByEntity: ctx.combatStatsByEntity,
            playbackPath,
            replayDurationSec
        });
        const finalDamage = useBattleResults && usesExactFinals ? ctx.finalDamage : new Map();

        let players = mergePlayerDamage(entityPlayers, liveDamage, finalDamage, ctx.rosterByNick)
            .map((row) => Object.assign({}, row, {
                damageSource: row.damageDealt != null
                    ? (useBattleResults ? 'battle_results' : 'replay')
                    : row.damageSource
            }));

        if (useBattleResults) {
            players = enrichPlayersWithCombatStats(players, ctx.combatStatsByEntity);
        } else {
            const replayStats = aggregateCombatStatsFromHits(
                timeline.hits,
                statsClockSec,
                playerEntityIds,
                timeline.shotEvents
            );
            players = players.map((row) => {
                const stats = row.entityId ? replayStats.get(row.entityId) : null;
                if (!stats) return row;
                return Object.assign({}, row, stats, {
                    damageDealt: stats.damageDealt || row.damageDealt || 0,
                    damageSource: stats.damageDealt ? 'replay' : row.damageSource
                });
            });
        }

        const replayCounters = aggregateCombatStatsFromHits(
            timeline.hits,
            statsClockSec,
            playerEntityIds,
            timeline.shotEvents
        );
        players = players.map((row) => {
            const stats = row.entityId ? replayCounters.get(row.entityId) : null;
            if (!stats) return row;
            return mergeReplayCombatCounters(row, stats);
        });

        players = enrichPlayersWithTankNames(players, tankCtx);

        const authorRow = players.find((p) => p.nickname === parsed.authorNickname)
            || players.find((p) => p.nickname === h.config.playerName)
            || null;
        const authorTeam = authorRow && authorRow.team ? authorRow.team : 0;
        const rosterByEntity = new Map(entityPlayers);
        players.forEach((row) => {
            if (!row.entityId) return;
            const prev = rosterByEntity.get(row.entityId) || {};
            rosterByEntity.set(row.entityId, Object.assign({}, prev, row));
        });
        const vehicleHpByEntity = new Map();
        ensureVehicleHpBlocking(
            [...rosterByEntity.values()].map((row) => row.vehicleId).filter(Boolean),
            h.cacheDir
        );
        rosterByEntity.forEach((row, entityId) => {
            const hp = getVehicleMaxHp(row.vehicleId);
            if (hp > 0) vehicleHpByEntity.set(entityId, hp);
        });
        const type5HpByEntity = parseType5SpawnHpByEntity(parseReplayPackets(buf), rosterByEntity, {
            vehicleHpByEntity
        });
        const victimHits = timeline.victimDamageHits || [];

        const teamHp = computeTeamHpSnapshot(
            timeline.hpByEntity,
            rosterByEntity,
            authorTeam,
            statsClockSec,
            timeline.maxHpByEntity,
            {
                authorNickname: parsed.authorNickname || h.config.playerName || '',
                authorEntityId: authorRow && authorRow.entityId ? authorRow.entityId : 0,
                hits: timeline.hits,
                victimHits,
                sub4ByEntity: timeline.sub4ByEntity,
                spawnMaxByEntity: timeline.spawnMaxByEntity,
                p55SpawnByEntity: timeline.p55SpawnByEntity,
                authoritativeHpByEntity: type5HpByEntity,
                vehicleHpByEntity,
                replayDurationSec,
                replayAtEnd
            }
        );
        const teamHpDebug = [];
        rosterByEntity.forEach((row, entityId) => {
            const team = row.team || 0;
            if (!authorTeam || (team !== 1 && team !== 2 && row.nickname !== (parsed.authorNickname || h.config.playerName))) {
                return;
            }
            const hpPoints = timeline.hpByEntity && timeline.hpByEntity.get(entityId) || [];
            const vehicleHp = vehicleHpByEntity.get(entityId) || 0;
            const type5Hp = type5HpByEntity.get(entityId) || 0;
            const heuristicHp = timeline.spawnMaxByEntity && timeline.spawnMaxByEntity.get(entityId) || 0;
            const p55Hp = timeline.p55SpawnByEntity && timeline.p55SpawnByEntity.get(entityId) || 0;
            const chosenHp = resolveEntitySpawnMaxHp({
                type5Hp,
                vehicleHp,
                p55Spawn: p55Hp,
                heuristicSpawn: heuristicHp
            });
            const currentHp = currentEntityHpAtClock({
                entityId,
                clockSec: statsClockSec,
                hpPoints,
                sub4HpPoints: timeline.sub4ByEntity && timeline.sub4ByEntity.get(entityId) || [],
                spawnMaxHp: chosenHp,
                victimHits,
                hits: timeline.hits
            });
            teamHpDebug.push({
                entityId,
                nickname: row.nickname || '',
                team,
                side: team === authorTeam || row.nickname === (parsed.authorNickname || h.config.playerName) ? 'ally' : 'enemy',
                vehicleId: row.vehicleId || 0,
                tankName: row.tankName || '',
                type5Hp,
                vehicleHp,
                p55Hp,
                heuristicHp,
                chosenHp,
                currentHp,
                hpPoints
            });
        });
        reconcileStaleAliveHp(teamHpDebug, statsClockSec, {
            replayDurationSec,
            replayAtEnd
        });
        teamHpDebug.forEach((row) => { delete row.hpPoints; });

        const battleElapsedSec = replayBattleElapsed(clockSec, movementStartSec);
        const countdownRemainingSec = Math.max(0, countdownDurationSec - battleElapsedSec);
        const battleClockRunning = h.playbackSession.clockRunning && clockSec >= movementStartSec;

        h.state.clientVersion = parsed.clientVersion || h.state.clientVersion;
        h.state.battleDurationSec = battleDurationSec;
        h.state.replayDataDurationSec = replayDurationSec;
        h.state.replayAtEnd = replayAtEnd;
        h.state.battleTimeSec = clockSec;
        h.state.battleTimeLabel = formatCountdown(clockSec, countdownDurationSec, battleStartOffsetSec);
        h.state.countdownRemainingSec = countdownRemainingSec;
        h.state.countdownLabel = h.playbackSession.clockRunning
            ? h.state.battleTimeLabel
            : formatCountdown(0, countdownDurationSec, battleStartOffsetSec);
        h.state.battleStartOffsetSec = battleStartOffsetSec;
        h.state.movementStartSec = movementStartSec;
        h.state.introPhase = introPhase;
        h.state.battleClockRunning = battleClockRunning;
        h.state.playbackClockSec = clockSec;
        h.state.playbackClockRunning = h.playbackSession.clockRunning && !replayAtEnd;
        h.state.replayPositionSec = clockSec;
        h.state.gamePositionSec = h.playbackSession.gamePositionSec;
        h.state.gamePositionAt = h.playbackSession.gamePositionAt;
        h.state.clockSource = h.playbackSession.clockSource;
        h.state.battleAnchored = h.playbackSession.battleAnchored;
        h.state.battleElapsedSec = battleElapsedSec;
        h.state.playbackStartedAt = h.playbackSession.startedAt;
        h.state.playbackSpeed = h.playbackSpeed();
        h.state.authorNickname = parsed.authorNickname || h.state.authorNickname;
        h.state.arenaUniqueId = parsed.arenaUniqueId;
        h.state.battleLevel = parsed.battleLevel;
        h.state.players = players;
        h.state.playerCount = players.length;
        h.state.packetCount = parsed.packetCount || 0;
        h.state.live.damageDealt = authorRow && authorRow.damageDealt != null ? authorRow.damageDealt : null;
        h.state.live.damageSource = authorRow
            ? (useBattleResults ? 'battle_results' : 'replay')
            : null;
        h.state.replayRecordingComplete = replayRecordingComplete;
        h.state.teamHp = teamHp;
        h.state.teamHpDebug = teamHpDebug;
        h.state.authorTeam = authorTeam;
        h.state.authorPlatoonGroupId = authorRow && authorRow.platoonGroupId
            ? authorRow.platoonGroupId
            : 0;

        let timelinePlayers;
        if (sparse.players.length) {
            const teamByEntity = new Map();
            const teamByNick = new Map();
            entityPlayers.forEach((meta, entityId) => {
                if (meta.team) teamByEntity.set(entityId, meta.team);
                if (meta.nickname && meta.team) teamByNick.set(meta.nickname, meta.team);
            });
            players.forEach((row) => {
                if (row.entityId && row.team) teamByEntity.set(row.entityId, row.team);
                if (row.nickname && row.team) teamByNick.set(row.nickname, row.team);
            });
            timelinePlayers = sparse.players.map((player) => Object.assign({}, player, {
                team: player.team || teamByEntity.get(player.entityId) || teamByNick.get(player.nickname) || 0,
                tankName: (entityPlayers.get(player.entityId) || {}).tankName || player.tankName || '',
                platoonGroupId: player.platoonGroupId
                    || (entityPlayers.get(player.entityId) || {}).platoonGroupId
                    || 0
            }));
        } else if (players.length) {
            timelinePlayers = players.map((row) => ({
                entityId: row.entityId || 0,
                nickname: row.nickname || '',
                team: row.team || 0,
                vehicleId: row.vehicleId || 0,
                tankName: row.tankName || '',
                points: [[0, Number(row.damageDealt) || 0]],
                hpPoints: [[0, 0]],
                sub4HpPoints: [[0, 0]],
                spawnMaxHp: row.maxHp || row.spawnMaxHp || 0,
                maxHp: row.maxHp || row.spawnMaxHp || 0
            }));
        }

        if (typeof timelinePlayers !== 'undefined' && timelinePlayers.length) {
            h.state.playbackTimeline = {
                replayKey: path.basename(playbackPath),
                durationSec: replayDurationSec || sparse.durationSec || 0,
                replayDataDurationSec: replayDurationSec || sparse.durationSec || 0,
                countdownDurationSec,
                battleStartOffsetSec,
                movementStartSec,
                startedAt: h.playbackSession.startedAt,
                rewindAt: h.playbackSession.rewindAt || 0,
                speed: h.playbackSpeed(),
                authorNickname: parsed.authorNickname || h.config.playerName || '',
                authorTeam,
                authorPlatoonGroupId: h.state.authorPlatoonGroupId || 0,
                teamHp,
                teamHpDebug,
                exactFinals: usesExactFinals,
                hitCount: timeline.hitCount || 0,
                pl33HitCount: timeline.pl33HitCount || 0,
                pl33EntityCount: timeline.pl33EntityCount || 0,
                hpEventCount: timeline.hpEventCount || 0,
                sub4HpEventCount: timeline.sub4HpEventCount || 0,
                victimHits: victimHits.map((hit) => ({
                    entityId: hit.entityId || hit.victimId,
                    clock: hit.clock,
                    damage: hit.damage || 0
                })),
                combatHits: (timeline.hits || []).map((hit) => ({
                    entityId: hit.entityId,
                    victimId: hit.victimId,
                    clock: hit.clock,
                    damage: hit.damage || 0
                })),
                players: timelinePlayers
            };
        } else {
            h.state.playbackTimeline = null;
        }
        h.state.playbackLoading = false;
    }

    function applyFinishedReplay(zipPath) {
        const parsed = parseFinishedReplay(zipPath, h.config.pythonPath);
        if (!parsed || !parsed.meta) return;
        const meta = parsed.meta;
        const author = parsed.author || {};
        h.state.lastBattle = {
            fileName: path.basename(zipPath),
            tankName: meta.playerVehicleName || '',
            mapName: meta.mapName || '',
            durationSec: Number(meta.battleDuration) || 0,
            playerName: meta.playerName || '',
            damageDealt: author.damageDealt != null ? author.damageDealt : null,
            baseXp: author.baseXp != null ? author.baseXp : null,
            frags: author.frags != null ? author.frags : null,
            players: parsed.players || [],
            finishedAt: new Date().toISOString(),
            parseSource: parsed.source || 'unknown'
        };
    }

    function expireReplayEndSummary() {
        if (!h.state.replayEndSummary || !h.state.replayEndSummary.visible) return;
        const shownAt = h.state.replayEndSummary.shownAt
            ? new Date(h.state.replayEndSummary.shownAt).getTime()
            : 0;
        if (shownAt && Date.now() - shownAt > REPLAY_SUMMARY_TTL_MS) {
            h.state.replayEndSummary.visible = false;
            h.state.replayEndSummary.pending = false;
            h.playbackHoldKey = '';
            h.resetPlaybackCaches('summary_expired', {
                purgeDisk: 'all',
                clearLiveState: true,
                resetSession: true,
                keepSessionPath: ''
            });
        }
    }

    function applyReplayCombatStats(players, playbackPath, ctx, durationSec) {
        const buf = h.getPlaybackReplayBuf(playbackPath);
        if (!buf || !players || !players.length) return players;

        const playerEntityIds = new Set();
        players.forEach((row) => {
            if (row.entityId) playerEntityIds.add(row.entityId);
        });
        if (ctx && ctx.finalDamage) {
            ctx.finalDamage.forEach((_, entityId) => playerEntityIds.add(entityId));
        }

        const parsed = parseDamageHitEvents(buf, {
            playerEntityIds,
            finalDamage: ctx && ctx.finalDamage
        });
        const clockSec = durationSec || parsed.battleDurationSec || 99999;
        const replayStats = aggregateCombatStatsFromHits(
            parsed.hits,
            clockSec,
            playerEntityIds,
            parsed.shotEvents
        );

        return players.map((row) => {
            const stats = row.entityId ? replayStats.get(row.entityId) : null;
            if (!stats) return row;
            return mergeReplayCombatCounters(row, stats);
        });
    }

    function triggerReplayEndSummary(playbackPath) {
        if (!playbackPath || !isReplayArchivePath(playbackPath)) return;
        const replayKey = h.playbackLoadKey(playbackPath);
        if (h.state.replayEndSummary
            && h.state.replayEndSummary.replayKey === replayKey
            && (h.state.replayEndSummary.visible || h.state.replayEndSummary.pending)) {
            return;
        }

        const meta = readMetaFromZip(playbackPath);
        const parsedFinished = parseFinishedReplay(playbackPath, h.config.pythonPath);
        const ctx = h.getBattleResultsContext(playbackPath);
        const entityPlayers = new Map();
        (h.state.players || []).forEach((player) => {
            if (player.entityId) entityPlayers.set(player.entityId, player);
        });
        ctx.finalDamage.forEach((_, entityId) => {
            if (!entityPlayers.has(entityId)) {
                entityPlayers.set(entityId, { entityId, nickname: '', team: 0 });
            }
        });

        let players = mergePlayerDamage(
            entityPlayers,
            new Map(),
            ctx.finalDamage,
            ctx.rosterByNick
        );
        if ((!players || !players.length) && parsedFinished && parsedFinished.players) {
            players = parsedFinished.players;
        }
        players = enrichPlayersWithTankNames(players, h.tankNameContext({
            playbackPath,
            authorNickname: h.state.authorNickname || h.config.playerName || ''
        }));
        players = enrichPlayersWithCombatStats(players, ctx.combatStatsByEntity);
        players = applyReplayCombatStats(
            players,
            playbackPath,
            ctx,
            h.replayDataDurationSec()
                || h.state.replayDataDurationSec
                || (meta && Number(meta.battleDuration))
                || h.playbackMaxProgressSec
                || 0
        );

        const authorNick = h.state.authorNickname
            || h.config.playerName
            || (meta && meta.playerName)
            || '';
        const summaryDurationSec = h.replayDataDurationSec()
            || h.state.replayDataDurationSec
            || (meta && Number(meta.battleDuration))
            || h.playbackMaxProgressSec
            || 0;
        let fragMap;
        if (h.state.playbackTimeline) {
            fragMap = countFragsAtClock(h.state.playbackTimeline, summaryDurationSec);
        } else {
            const replayBuf = extractDataReplayFromZip(playbackPath, h.cacheDir);
            fragMap = replayBuf
                ? buildFragMapFromReplayBuffer(replayBuf, {
                    entityPlayers,
                    finalDamage: ctx.finalDamage,
                    clockSec: summaryDurationSec
                })
                : new Map();
        }
        const authorStats = parsedFinished && parsedFinished.author ? parsedFinished.author : {};
        players = enrichPlayersWithFrags(players, {
            fragMap,
            authorNickname: authorNick,
            authorFrags: authorStats.frags
        });

        const authorRow = players.find((p) => p.nickname === authorNick) || null;

        h.state.replayEndSummary = buildReplayEndSummary({
            replayKey,
            replayFile: path.basename(playbackPath),
            authorNickname: authorNick,
            authorRow,
            authorStats,
            players,
            meta: meta || (parsedFinished && parsedFinished.meta) || {},
            playbackTimeline: h.state.playbackTimeline,
            authorTeam: h.state.authorTeam || (authorRow && authorRow.team) || 0,
            durationSec: summaryDurationSec,
            tankName: authorRow && authorRow.tankName
        });
        h.state.replayEndSummary.visible = false;
        h.state.replayEndSummary.pending = true;
        h.state.replayEndSummary.showAt = new Date(Date.now() + REPLAY_SUMMARY_DELAY_MS).toISOString();
        h.state.replayEndSummary.endedAt = new Date().toISOString();
        h.playbackHoldKey = replayKey;
        h.markReplayPlaybackFinished(playbackPath);
        h.state.replayAtEnd = true;
        h.state.playbackClockRunning = false;
        h.state.status = 'playback';
        h.state.mode = 'playback_ended';
        h.state.recordingPath = playbackPath;
        h.state.sourceLabel = path.basename(playbackPath);
        h.state.playbackLoading = false;
        h.lastResolvedPlaybackPath = playbackPath;
        console.log('[replay-live] replay end summary:', path.basename(playbackPath));
        h.resetPlaybackCaches('replay_end_summary', {
            replayPath: playbackPath,
            purgeDisk: 'all',
            stopClock: true,
            resetSession: true,
            keepSessionPath: '',
            clearLiveState: true,
            keepReplayAtEnd: true,
            keepProgress: true
        });
        if (!h.summaryHoldActive()) {
            h.replayAccessTracker.reset();
            h.replayCacheDiffTracker.reset();
        }
        // Небольшая задержка: даём игре/итогам боя спокойно отпустить файл и
        // домассировать состояние конца реплея, прежде чем убрать его с диска.
        setTimeout(() => h.archiveWatchedReplay(playbackPath), 5000);
    }

    function checkPlaybackEndSummary(playbackPath) {
        if (h.playbackEndTriggered || !playbackPath) return;
        const sinceSelect = Date.now() - (h.playbackSession.replaySelectedAt || 0);
        if (sinceSelect < 20000) return;
        const duration = Math.max(
            h.replayDataDurationSec(),
            Number(h.playbackSession.applyCache && h.playbackSession.applyCache.replayDurationSec) || 0,
            h.playbackMaxProgressSec
        );
        if (duration < 25) return;

        const clock = Number(h.state.playbackClockSec) || 0;
        h.playbackMaxProgressSec = Math.max(h.playbackMaxProgressSec, clock);
        const nearEnd = clock >= duration - 3 || (clock / duration) >= 0.96;
        if (!nearEnd) return;

        h.playbackEndTriggered = true;
        triggerReplayEndSummary(playbackPath);
    }

    function resetPlaybackSummaryTracking(clearSummary) {
        h.playbackEndTriggered = false;
        h.playbackMaxProgressSec = 0;
        h.playbackHoldKey = '';
        if (clearSummary) {
            h.state.replayEndSummary = null;
            h.replayAccessTracker.reset();
            h.replayCacheDiffTracker.reset();
        }
    }

    function resetReplayEndClock() {
        h.clearReplayEndState(true);
    }

    return {
        applyParsedReplay,
        applyPlaybackTimeline,
        applyFinishedReplay,
        expireReplayEndSummary,
        triggerReplayEndSummary,
        checkPlaybackEndSummary,
        resetPlaybackSummaryTracking,
        resetReplayEndClock
    };
}

module.exports = { createTimelineApply };
