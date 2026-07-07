'use strict';
/**
 * Playback-часы replay-live: выбор источника времени (позиция из game cache /
 * wall-clock по живому zip / чистый wall fallback), пауза/заморозка, рестарт
 * по смене meta-сессии. Вынесено из index.js 1:1; общее состояние модуля
 * доступно через хаб h (геттеры/сеттеры на замыкание index.js, как detection.js).
 */

const { getReplayFileActivity, inspectReplayMeta, diffMetaReplayPosition } = require('./replayCache');
const { DEFAULT_BATTLE_DURATION_SEC } = require('./replayTimeline');
const {
    HOT_ZIP_ACCESS_MS,
    ZIP_PAUSE_MS,
    CLOCK_SYNC_DELTA_SEC,
    GAME_POS_EXTRAPOLATE_MAX_SEC,
    GAME_POS_STALE_MS
} = require('./constants');

function createPlaybackClock(h) {
    function computeClockRaw(maxSec) {
        const elapsed = ((Date.now() - h.playbackSession.startedAt) / 1000) * h.playbackSpeed() - h.playbackLoadDelaySec();
        const clock = h.playbackSession.clockOffsetSec + elapsed;
        const cap = maxSec > 0 ? maxSec : clock;
        return Math.max(0, Math.min(clock, cap));
    }

    function isZipActiveForPlayback(replayPath) {
        if (!replayPath) return false;
        const activity = getReplayFileActivity(replayPath);
        return Boolean(activity.exists && activity.ageMs != null && activity.ageMs <= HOT_ZIP_ACCESS_MS);
    }

    function trackZipLive(replayPath) {
        if (!replayPath) {
            h.playbackSession.zipLiveSince = 0;
            return false;
        }
        if (isPlaybackPaused(replayPath)) {
            h.playbackSession.zipLiveSince = 0;
            return false;
        }
        if (!h.playbackSession.zipLiveSince) {
            h.playbackSession.zipLiveSince = Date.now();
        }
        return true;
    }

    function resolveZipWallClockSec(maxDur) {
        if (!h.playbackSession.zipLiveSince) {
            h.playbackSession.zipLiveSince = Date.now();
        }
        const elapsed = ((Date.now() - h.playbackSession.zipLiveSince) / 1000) * h.playbackSpeed() - h.playbackLoadDelaySec();
        return Math.max(0, Math.min(elapsed, maxDur));
    }

    function replayDataDurationSec() {
        const cached = h.playbackSession.applyCache;
        if (cached && cached.replayDurationSec > 0) return cached.replayDurationSec;
        if (h.state.playbackTimeline && h.state.playbackTimeline.replayDataDurationSec > 0) {
            return h.state.playbackTimeline.replayDataDurationSec;
        }
        return Number(h.state.replayDataDurationSec) || 0;
    }

    function playbackClockMaxSec() {
        const dataEnd = replayDataDurationSec();
        if (dataEnd > 0) return dataEnd;
        return Math.max(Number(h.state.battleDurationSec) || 0, DEFAULT_BATTLE_DURATION_SEC);
    }

    function clearReplayEndState(resetClock) {
        h.playbackSession.frozenClockSec = null;
        h.playbackSession.zipPausedAt = 0;
        if (h.playbackSession.clockSource === 'replay_end') {
            h.playbackSession.clockSource = 'idle';
        }
        if (resetClock && !h.playbackSession.clockRunning) {
            h.playbackSession.lastKnownClockSec = 0;
            h.playbackSession.clockOffsetSec = 0;
        }
        h.state.replayAtEnd = false;
    }

    function stopClockAtReplayEnd(clockSec) {
        if (!h.playbackSession.clockRunning) return false;
        const dataEnd = replayDataDurationSec();
        if (dataEnd <= 0 || clockSec < dataEnd - 0.25) return false;
        h.playbackSession.clockRunning = false;
        h.playbackSession.clockSource = 'replay_end';
        h.playbackSession.lastKnownClockSec = dataEnd;
        h.playbackSession.frozenClockSec = dataEnd;
        h.state.replayAtEnd = true;
        h.playbackMaxProgressSec = Math.max(h.playbackMaxProgressSec, dataEnd);
        h.markReplayPlaybackFinished(h.playbackSession.path);
        if (!h.playbackEndTriggered && h.playbackSession.path) {
            h.playbackEndTriggered = true;
            h.triggerReplayEndSummary(h.playbackSession.path);
        }
        return true;
    }

    function readGameCacheSnapshot(replayPath, replayDurationSec) {
        const cacheEntry = h.readGameCacheEntry(replayPath);
        if (!cacheEntry) return null;
        h.unlockCachePositionIfMetaLive(cacheEntry);
        const maxDur = Math.max(
            replayDurationSec > 0 ? replayDurationSec : 0,
            replayDataDurationSec()
        ) || playbackClockMaxSec() || 600;
        const inspect = inspectReplayMeta(cacheEntry.metaBuf, maxDur);
        let gamePos = inspect ? inspect.parsedPosition : null;
        if (gamePos == null && h.playbackSession.lastMetaHex && !h.playbackSession.cachePositionLocked) {
            gamePos = diffMetaReplayPosition(h.playbackSession.lastMetaHex, cacheEntry.metaHex, maxDur);
        }
        if (h.playbackSession.cachePositionLocked) {
            gamePos = null;
        } else if (h.shouldIgnoreStaleCachePosition(gamePos, maxDur)) {
            gamePos = null;
        }
        return { cacheEntry, inspect, gamePos, maxDur };
    }

    function readGameCachePosition(replayPath, replayDurationSec) {
        const snap = readGameCacheSnapshot(replayPath, replayDurationSec);
        return snap ? snap.gamePos : null;
    }

    function applyVisualLag(clockSec, maxDur) {
        if (h.PLAYBACK_VISUAL_LAG_SEC <= 0 || isPlaybackPaused(h.playbackSession.path)) {
            return clockSec;
        }
        const src = h.playbackSession.clockSource;
        if (src === 'game_cache' || src === 'game_cache_frozen'
            || src === 'zip_wall_sync' || src === 'wall_fallback') {
            return Math.max(0, Math.min(clockSec - h.PLAYBACK_VISUAL_LAG_SEC, maxDur));
        }
        return clockSec;
    }

    function extrapolateGamePosition(replayDurationSec) {
        if (h.playbackSession.gamePositionSec == null || !h.playbackSession.gamePositionAt) return null;
        const maxDur = replayDurationSec > 0 ? replayDurationSec : 600;
        const base = h.playbackSession.gamePositionSec;
        const ageMs = Date.now() - h.playbackSession.gamePositionAt;
        if (isPlaybackPaused(h.playbackSession.path)) {
            return Math.max(0, Math.min(base, maxDur));
        }
        if (ageMs > GAME_POS_STALE_MS) {
            return Math.max(0, Math.min(base, maxDur));
        }
        const ageSec = ageMs / 1000;
        const extra = Math.min(GAME_POS_EXTRAPOLATE_MAX_SEC, ageSec * h.playbackSpeed());
        return Math.max(0, Math.min(base + extra, maxDur));
    }

    function noteBattleAnchor(gamePos) {
        const offset = Number(h.playbackSession.battleStartOffsetSec) || 0;
        if (offset > 0 && gamePos != null && gamePos >= offset - 0.05) {
            h.playbackSession.battleAnchored = true;
        }
    }

    function applyGamePosition(gamePos, replayDurationSec, reason) {
        if (gamePos == null) return false;
        const maxDur = replayDurationSec > 0 ? replayDurationSec : 600;
        const pos = Math.max(0, Math.min(Number(gamePos) || 0, maxDur));
        if (pos < 1 && (h.playbackSession.clockSource === 'replay_end' || h.state.replayAtEnd)) {
            if (h.shouldHoldPlaybackAfterEnd(h.playbackSession.path)) return true;
            if (h.isFinishedReplayPath(h.playbackSession.path)
                && !h.shouldAllowReplayRestart(h.playbackSession.path)) {
                return true;
            }
            clearReplayEndState(true);
        }
        const prev = h.playbackSession.gamePositionSec;
        h.playbackSession.gamePositionSec = pos;
        h.playbackSession.gamePositionAt = Date.now();
        h.playbackSession.lastKnownClockSec = pos;
        h.playbackSession.clockSource = 'game_cache';
        noteBattleAnchor(pos);

        const jumped = prev != null && Math.abs(pos - prev) > CLOCK_SYNC_DELTA_SEC;
        if (jumped || prev == null) {
            h.playbackSession.clockOffsetSec = pos;
            h.playbackSession.startedAt = Date.now();
            h.playbackSession.rewindAt = Date.now();
            h.playbackSession.frozenClockSec = null;
            h.playbackSession.zipPausedAt = 0;
            h.playbackSession.zipLiveSince = 0;
        }

        if (!h.playbackSession.clockRunning && isZipActiveForPlayback(h.playbackSession.path)) {
            h.playbackSession.clockRunning = true;
            if (h.state.playbackDebug) {
                h.state.playbackDebug.clockStartReason = reason || 'game_cache_pos';
                h.state.playbackDebug.clockStartPos = pos;
            }
        }
        return true;
    }

    function resolvePlaybackClockSec() {
        const maxDur = playbackClockMaxSec();
        const gameClock = extrapolateGamePosition(maxDur);
        if (gameClock != null) {
            h.playbackSession.clockSource = 'game_cache';
            const lagged = applyVisualLag(gameClock, maxDur);
            h.playbackSession.lastKnownClockSec = lagged;
            return lagged;
        }

        if (isPlaybackPaused(h.playbackSession.path)
            && h.playbackSession.gamePositionSec != null
            && !usesWallPlaybackClock()
            && h.playbackSession.lastKnownClockSec != null) {
            h.playbackSession.clockSource = 'game_cache_frozen';
            return applyVisualLag(h.playbackSession.lastKnownClockSec, maxDur);
        }

        if (h.playbackSession.clockRunning) {
            if (h.config.watchReplayCache !== false) {
                if (trackZipLive(h.playbackSession.path)) {
                    h.playbackSession.clockSource = 'zip_wall_sync';
                    const wall = applyVisualLag(resolveZipWallClockSec(maxDur), maxDur);
                    h.playbackSession.lastKnownClockSec = wall;
                    return wall;
                }
            }
            const sinceSelect = Date.now() - (h.playbackSession.replaySelectedAt || 0);
            if (sinceSelect < h.WALL_CLOCK_FALLBACK_MS && h.playbackSession.lastKnownClockSec > 0) {
                h.playbackSession.clockSource = 'waiting_game_cache';
                return h.playbackSession.lastKnownClockSec;
            }
            h.playbackSession.clockSource = 'wall_fallback';
            const wall = applyVisualLag(computeClockRaw(maxDur), maxDur);
            h.playbackSession.lastKnownClockSec = wall;
            return wall;
        }

        h.playbackSession.clockSource = 'idle';
        return h.playbackSession.lastKnownClockSec || 0;
    }

    function ensurePlaybackClock(replayPath) {
        if (!replayPath || h.playbackSession.clockRunning) return;
        if (h.shouldHoldPlaybackAfterEnd(replayPath)) return;
        if (!h.playbackSession.pendingSessionStart) return;
        clearReplayEndState(true);
        h.playbackSession.pendingSessionStart = false;
        const durationHint = h.state.playbackTimeline && h.state.playbackTimeline.replayDataDurationSec
            ? h.state.playbackTimeline.replayDataDurationSec
            : (replayDataDurationSec() || Math.max(1, Number(h.state.battleDurationSec) || 600));
        const initialPos = readGameCachePosition(replayPath, durationHint);
        if (initialPos != null) {
            applyGamePosition(initialPos, durationHint, 'play');
        } else {
            startPlaybackClock(0);
            h.playbackSession.clockSource = 'waiting_game_cache';
        }
        if (h.state.playbackDebug) {
            h.state.playbackDebug.clockStartReason = initialPos != null ? 'play' : 'play_wait_cache';
        }
    }

    function ensurePlaybackClockRunning(playbackPath, reason) {
        if (!playbackPath || h.playbackSession.clockRunning) return;
        if (h.shouldHoldPlaybackAfterEnd(playbackPath)) return;
        if (h.isFinishedReplayPath(playbackPath) && !h.shouldAllowReplayRestart(playbackPath)) return;
        if (h.playbackSession.clockSource === 'replay_end' && h.state.replayAtEnd) return;

        clearReplayEndState(true);
        const durationHint = h.state.playbackTimeline && h.state.playbackTimeline.replayDataDurationSec
            ? h.state.playbackTimeline.replayDataDurationSec
            : (replayDataDurationSec() || Math.max(1, Number(h.state.battleDurationSec) || DEFAULT_BATTLE_DURATION_SEC));
        const initialPos = readGameCachePosition(playbackPath, durationHint);
        if (initialPos != null) {
            applyGamePosition(initialPos, durationHint, reason || 'playback_auto');
        } else {
            startPlaybackClock(0);
            h.playbackSession.clockSource = 'waiting_game_cache';
        }
        if (h.state.playbackDebug) {
            h.state.playbackDebug.clockStartReason = reason || 'playback_auto';
            h.state.playbackDebug.clockAutoStarted = true;
        }
    }

    function maybeStartPlaybackClock(replayPath, reason) {
        if (!replayPath) return;
        if (h.shouldHoldPlaybackAfterEnd(replayPath)) return;
        if (h.isFinishedReplayPath(replayPath) && !h.shouldAllowReplayRestart(replayPath)) return;
        if (h.playbackSession.clockRunning) return;

        if (h.playbackSession.pendingSessionStart) {
            ensurePlaybackClock(replayPath);
            if (h.playbackSession.clockRunning) return;
        }

        const sinceSelect = Date.now() - (h.playbackSession.replaySelectedAt || 0);
        const zipSpike = new Set([
            'cache_zip_spike',
            'cache_zip_spike_multi',
            'cache_meta',
            'cache_meta_pos',
            'cache_switch',
            'cache_switch_multi',
            'cache_session',
            'cache_hold',
            'cache_boot_active',
            'cache_active_read',
            'cache_file_touch',
            'cache_file_fresh',
            'game_cache_active',
            'cache_active_zip',
            'cache_zip',
            'cache_fallback',
            'sticky_session',
            'manual_path',
            'manual_play',
            'access_spike',
            'sole_zip_live',
            'session_live',
            'zip_scan',
            'cache_active_live',
            'game_active',
            'game_switch',
            'game_reopen',
            'zip_live',
            'zip_open',
            'meta_changed',
            'game_playing',
            'session_hold',
            'manual_hold'
        ]);
        const durationHint = h.state.playbackTimeline && h.state.playbackTimeline.replayDataDurationSec
            ? h.state.playbackTimeline.replayDataDurationSec
            : (replayDataDurationSec() || Math.max(1, Number(h.state.battleDurationSec) || 600));

        if (zipSpike.has(reason)) {
            if (h.isFinishedReplayPath(replayPath) && !h.shouldAllowReplayRestart(replayPath)) return;
            clearReplayEndState(true);
            h.clearFinishedReplayMark();
            const initialPos = readGameCachePosition(replayPath, durationHint);
            if (initialPos != null) {
                applyGamePosition(initialPos, durationHint, reason);
                h.playbackSession.pendingSessionStart = false;
            } else {
                startPlaybackClock(0);
                h.playbackSession.clockSource = 'waiting_game_cache';
                h.playbackSession.pendingSessionStart = false;
            }
            if (h.state.playbackDebug) {
                h.state.playbackDebug.clockStartReason = initialPos != null ? reason : `${reason}_wait_cache`;
                h.state.playbackDebug.clockStartPos = initialPos;
            }
            return;
        }

        if (reason === 'cache_hold' && sinceSelect >= 150) {
            if (h.isFinishedReplayPath(replayPath) && !h.shouldAllowReplayRestart(replayPath)) return;
            clearReplayEndState(true);
            h.clearFinishedReplayMark();
            const initialPos = readGameCachePosition(replayPath, durationHint);
            if (initialPos != null) {
                applyGamePosition(initialPos, durationHint, reason);
                h.playbackSession.pendingSessionStart = false;
            } else {
                startPlaybackClock(0);
                h.playbackSession.clockSource = 'waiting_game_cache';
                h.playbackSession.pendingSessionStart = false;
            }
            if (h.state.playbackDebug) {
                h.state.playbackDebug.clockStartReason = initialPos != null ? reason : `${reason}_wait_cache`;
            }
        }
    }

    function startPlaybackClock(initialClockSec) {
        if (h.playbackSession.path
            && h.isFinishedReplayPath(h.playbackSession.path)
            && !h.shouldAllowReplayRestart(h.playbackSession.path)) {
            return;
        }
        if (h.playbackSession.path && h.shouldAllowReplayRestart(h.playbackSession.path)) {
            h.clearFinishedReplayMark();
        }
        clearReplayEndState(false);
        h.playbackSession.clockRunning = true;
        h.playbackSession.frozenClockSec = null;
        h.playbackSession.zipPausedAt = 0;
        h.playbackSession.startedAt = Date.now();
        h.playbackSession.clockOffsetSec = Math.max(0, Number(initialClockSec) || 0);
        h.playbackSession.rewindAt = Date.now();
        h.playbackSession.lastKnownClockSec = h.playbackSession.clockOffsetSec;
        h.state.replayAtEnd = false;
    }

    function stopPlaybackClock() {
        h.playbackSession.clockRunning = false;
        h.playbackSession.frozenClockSec = null;
        h.playbackSession.zipPausedAt = 0;
        h.playbackSession.zipLiveSince = 0;
        h.playbackSession.pendingSessionStart = false;
    }

    function ensurePlaybackSession(playbackPath, options) {
        options = options || {};
        const pathChanged = h.playbackSession.path !== playbackPath;
        if (pathChanged) {
            clearReplayEndState(true);
            h.playbackSession = h.defaultPlaybackSessionFields(playbackPath);
            h.playbackSession.applyCache = null;
            h.playbackSession.parseGen += 1;
            h.state.replayAtEnd = false;
            h.state.replayDataDurationSec = 0;
            return true;
        }
        h.playbackSession.lastSeenAt = Date.now();
        if (options.rewind && h.playbackSession.clockRunning) {
            resetPlaybackClock();
        }
        return false;
    }

    function markPlaybackSelection(replayPath, reason) {
        if (h.shouldHoldPlaybackAfterEnd(replayPath)) return;
        const pathChanged = h.playbackSession.path !== replayPath;
        h.playbackSession.lastDetectReason = reason;
        h.replayCacheDiffTracker.syncSelection(h.canonicalCacheReplayPath(replayPath));

        if (pathChanged) {
            h.resetPlaybackCaches('replay_selected', {
                replayPath: h.playbackSession.path || '',
                purgeDisk: 'all',
                stopClock: true,
                resetSession: false,
                clearLiveState: false
            });
            ensurePlaybackSession(replayPath, { rewind: false });
            clearReplayEndState(true);
            h.state.replayAtEnd = false;
            h.state.replayDataDurationSec = 0;
            h.playbackSession.lastRewindPickKey = '';
            h.playbackSession.lastMetaSessionKey = null;
            h.playbackSession.replaySelectedAt = Date.now();
            h.playbackSession.lastMetaChangeAt = Date.now();
            h.playbackSession.zipLiveSince = 0;
            h.playbackSession.pendingSessionStart = false;
            h.maybePersistPlaybackPath(replayPath, reason);
            h.replayAccessTracker.syncPreferPath(replayPath);
            if (reason === 'manual_path' || reason === 'manual_play' || reason === 'game_switch'
                || reason === 'game_active' || reason === 'game_reopen'
                || reason === 'zip_live' || reason === 'zip_open' || reason === 'meta_changed') {
                startPlaybackClock(0);
            }
            return;
        }

        if (reason === 'manual_path' || reason === 'manual_play') {
            ensurePlaybackSession(replayPath, { rewind: false });
            startPlaybackClock(0);
            return;
        }

        if (reason === 'game_switch' || reason === 'game_active' || reason === 'game_reopen'
            || reason === 'zip_live' || reason === 'zip_open' || reason === 'meta_changed') {
            ensurePlaybackSession(replayPath, { rewind: false });
            const durationHint = replayDataDurationSec() || Math.max(1, Number(h.state.battleDurationSec) || 600);
            const initialPos = readGameCachePosition(replayPath, durationHint);
            if (initialPos != null) {
                applyGamePosition(initialPos, durationHint, reason);
            } else {
                startPlaybackClock(0);
            }
            return;
        }

        ensurePlaybackSession(replayPath, { rewind: false });
        maybeStartPlaybackClock(replayPath, reason);
    }

    function maybeRestartPlaybackFromGameCache(replayDurationSec) {
        const snap = readGameCacheSnapshot(h.playbackSession.path, replayDurationSec);
        if (!snap) return;

        const { cacheEntry, inspect, gamePos, maxDur } = snap;
        const sessionKey = cacheEntry.sessionKey;
        const metaChanged = h.playbackSession.lastMetaHex !== cacheEntry.metaHex;
        const sessionChanged = h.playbackSession.lastMetaSessionKey != null
            && h.playbackSession.lastMetaSessionKey !== sessionKey;

        if (metaChanged && inspect) {
            h.playbackSession.lastMetaInspect = inspect;
            h.playbackSession.lastMetaChangeAt = Date.now();
            const reason = sessionChanged ? 'session' : 'meta';
            h.logMetaChange(cacheEntry, inspect, reason);
            if (h.state.playbackDebug) {
                h.state.playbackDebug.lastMetaInspect = inspect;
                h.state.playbackDebug.lastMetaChangeAt = h.playbackSession.lastMetaChangeAt;
                h.state.playbackDebug.metaLogPath = h.metaLogPath();
            }
        }

        if (gamePos != null) {
            if (h.shouldIgnoreStaleCachePosition(gamePos, maxDur) && !sessionChanged) {
                startPlaybackClock(0);
                h.playbackSession.gamePositionSec = null;
                h.playbackSession.pendingSessionStart = false;
                h.playbackSession.clockSource = 'waiting_game_cache';
                h.state.replayAtEnd = false;
            } else if (!h.playbackSession.cachePositionLocked) {
                const prevPos = h.playbackSession.gamePositionSec;
                applyGamePosition(gamePos, maxDur, metaChanged ? 'meta_pos' : 'meta_poll');
                if (prevPos == null || Math.abs(prevPos - gamePos) > 0.05) {
                    h.playbackSession.lastMetaChangeAt = Date.now();
                }
                if (h.state.playbackDebug) {
                    h.state.playbackDebug.clockSyncSource = 'game_cache_meta';
                }
            }
        }

        if (h.playbackSession.lastMetaSessionKey == null) {
            h.playbackSession.lastMetaSessionKey = sessionKey;
            h.playbackSession.lastMetaHex = cacheEntry.metaHex;
            if (gamePos == null && h.playbackSession.pendingSessionStart && isZipActiveForPlayback(h.playbackSession.path)) {
                h.playbackSession.clockRunning = true;
                h.playbackSession.clockSource = 'waiting_game_cache';
            }
            return;
        }

        h.playbackSession.lastMetaHex = cacheEntry.metaHex;

        if (!sessionChanged && !metaChanged) return;

        if (sessionChanged) {
            if (!h.summaryHoldActive()) {
                h.playbackHoldKey = '';
                if (h.state.replayEndSummary) h.state.replayEndSummary = null;
            }
            clearReplayEndState(true);
            h.playbackSession.lastMetaSessionKey = sessionKey;
            h.playbackSession.pendingSessionStart = true;
            h.playbackSession.zipLiveSince = 0;
            h.playbackSession.battleAnchored = false;
            if (h.playbackSession.parseInFlight) {
                h.playbackSession.parseGen += 1;
            } else {
                h.playbackSession.applyCache = null;
            }
            h.playbackSession.loadKey = '';
            h.playbackSession.parseGen += 1;
            h.state.playbackTimeline = null;
            h.state.teamHp = null;
            h.state.replayAtEnd = false;
            h.state.replayDataDurationSec = 0;
            if (gamePos != null && !h.playbackSession.cachePositionLocked) {
                applyGamePosition(gamePos, maxDur, 'meta_session');
                h.playbackSession.pendingSessionStart = false;
            } else {
                startPlaybackClock(0);
                h.playbackSession.clockSource = 'waiting_game_cache';
            }
            if (h.state.playbackDebug) {
                h.state.playbackDebug.clockStartReason = 'meta_session';
                h.state.playbackDebug.playbackRestart = true;
                h.state.playbackDebug.metaSessionKey = sessionKey;
            }
            if (h.state.playbackTimeline) {
                h.state.playbackTimeline.rewindAt = h.playbackSession.rewindAt;
                h.state.playbackTimeline.startedAt = h.playbackSession.startedAt;
            }
        }
    }

    function resetPlaybackClock() {
        h.playbackSession.startedAt = Date.now();
        h.playbackSession.clockOffsetSec = 0;
        h.playbackSession.rewindAt = Date.now();
        h.playbackSession.frozenClockSec = null;
        h.playbackSession.zipPausedAt = 0;
        if (h.playbackSession.clockSource === 'replay_end') {
            h.playbackSession.clockSource = 'idle';
            h.playbackSession.clockRunning = false;
        }
        h.state.replayAtEnd = false;
    }

    function isPlaybackPaused(replayPath) {
        if (!replayPath) return true;
        if (h.playbackSession.path === replayPath && h.playbackSession.clockRunning) {
            return false;
        }
        const activity = getReplayFileActivity(replayPath);
        return !activity.exists || activity.ageMs == null || activity.ageMs > ZIP_PAUSE_MS;
    }

    function usesWallPlaybackClock() {
        const src = h.playbackSession.clockSource;
        return src === 'wall_fallback'
            || src === 'zip_wall_sync'
            || src === 'waiting_game_cache'
            || src === 'idle'
            || h.playbackSession.gamePositionSec == null;
    }

    function getPlaybackClockSec() {
        if (!h.playbackSession.path) return 0;

        const maxDur = playbackClockMaxSec();
        const zipPaused = isPlaybackPaused(h.playbackSession.path);
        const wallClock = usesWallPlaybackClock();

        if (zipPaused && !wallClock) {
            if (h.playbackSession.gamePositionSec != null) {
                h.playbackSession.clockSource = 'game_cache_frozen';
                h.playbackSession.lastKnownClockSec = h.playbackSession.gamePositionSec;
                return Math.min(h.playbackSession.gamePositionSec, maxDur);
            }
            if (h.playbackSession.frozenClockSec == null && h.playbackSession.clockRunning) {
                h.playbackSession.frozenClockSec = resolvePlaybackClockSec();
                h.playbackSession.zipPausedAt = Date.now();
            }
            const frozen = h.playbackSession.frozenClockSec != null
                ? h.playbackSession.frozenClockSec
                : (h.playbackSession.lastKnownClockSec || 0);
            return Math.min(frozen, maxDur);
        }

        if (h.playbackSession.frozenClockSec != null && h.playbackSession.zipPausedAt) {
            h.playbackSession.frozenClockSec = null;
            h.playbackSession.zipPausedAt = 0;
        }

        if (!h.playbackSession.clockRunning && h.playbackSession.gamePositionSec == null) {
            if (h.playbackSession.clockSource === 'replay_end' || h.state.replayAtEnd) {
                return Math.min(h.playbackSession.lastKnownClockSec || replayDataDurationSec() || 0, maxDur);
            }
            if (h.playbackSession.pendingSessionStart) {
                return 0;
            }
            return Math.min(h.playbackSession.lastKnownClockSec || 0, maxDur);
        }

        const clock = Math.min(resolvePlaybackClockSec(), maxDur);
        stopClockAtReplayEnd(clock);
        return h.playbackSession.clockSource === 'replay_end'
            ? maxDur
            : clock;
    }

    return {
        isZipActiveForPlayback,
        trackZipLive,
        replayDataDurationSec,
        clearReplayEndState,
        readGameCacheSnapshot,
        ensurePlaybackClock,
        ensurePlaybackClockRunning,
        maybeStartPlaybackClock,
        startPlaybackClock,
        stopPlaybackClock,
        ensurePlaybackSession,
        markPlaybackSelection,
        maybeRestartPlaybackFromGameCache,
        resetPlaybackClock,
        isPlaybackPaused,
        getPlaybackClockSec
    };
}

module.exports = { createPlaybackClock };
