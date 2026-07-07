'use strict';

const fs = require('fs');
const path = require('path');
const { parseDataReplayBuffer, parseSubtype55VehicleCodes } = require('./replayParser');
const { readMetaFromZip } = require('./battleResults');
const { parseBattleResultsContext, extractDataReplayFromZip, detectReplayDataEntryInZip } = require('./battleResultsParser');
const { createReplayCacheDiffTracker, replayCacheDir, listReplayCacheFiles, parseCacheEntries, getReplayFileActivity, readActiveReplayFromCache, replayPathExists, replayBasenameKey, isReplayArchiveName, isReplayArchivePath, replayArchiveBasename } = require('./replayCache');
const { createReplayAccessTracker, listReplayZipFiles } = require('./replayAccessTracker');
const {
    createTimelineCache,
    formatCountdown,
    replayBattleElapsed,
    parseReplayPackets,
    DEFAULT_BATTLE_DURATION_SEC
} = require('./replayTimeline');
const { enrichPlayersWithTankNames } = require('./vehicleNames');
const { createReplayLiveRoutes } = require('./routes');
const { createReplayDetection } = require('./detection');
const { createPlaybackClock } = require('./playbackClock');
const { createTimelineApply } = require('./timelineApply');
const {
    HOT_ZIP_ACCESS_MS,
    PLAYBACK_IDLE_GRACE_MS,
    STICKY_META_SILENCE_MS,
    STICKY_SESSION_MAX_MS
} = require('./constants');

const DEFAULT_REPLAYS_DIR = path.join(process.env.USERPROFILE || '', 'Documents', 'TanksBlitz', 'replays');
const DEFAULT_GAME_INSTALL_DIR = 'E:\\Games\\Tanks_Blitz';
const DEFAULT_EXTRA_REPLAYS_DIRS = [
    path.join(process.env.USERPROFILE || '', 'Downloads', '31241245124')
];

function detectGameInstallDir() {
    const fromEnv = String(process.env.TANKS_BLITZ_DIR || process.env.REPLAY_LIVE_GAME_DIR || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

    const candidates = [
        DEFAULT_GAME_INSTALL_DIR,
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tanks Blitz'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tanks Blitz')
    ];
    for (const dir of candidates) {
        if (!dir) continue;
        try {
            if (fs.existsSync(path.join(dir, 'tanksblitz.exe'))) return dir;
        } catch (_) { /* noop */ }
    }
    return '';
}

function normalizeExtraReplaysDirs(raw) {
    if (raw == null) return [];
    const list = Array.isArray(raw) ? raw : String(raw).split(/[\n;|]+/);
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const dir = String(item || '').trim();
        if (!dir) continue;
        const key = path.normalize(dir).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(dir);
    }
    return out;
}
const REPLAY_LIVE_MODULE_VERSION = 'timeline-v98-detection-split';
const PLAYBACK_VISUAL_LAG_SEC = Number(process.env.REPLAY_VISUAL_LAG_SEC) || 1;
const WALL_CLOCK_FALLBACK_MS = 8000;
const FALLBACK_BATTLE_START_OFFSET_SEC = 15;

function defaultConfig() {
    return {
        replaysDir: DEFAULT_REPLAYS_DIR,
        gameInstallDir: detectGameInstallDir() || DEFAULT_GAME_INSTALL_DIR,
        extraReplaysDirs: DEFAULT_EXTRA_REPLAYS_DIRS.slice(),
        playerName: process.env.REPLAY_LIVE_PLAYER || 'Xasya',
        pollIntervalMs: 400,
        pythonPath: 'python',
        playbackReplayPath: '',
        autoPlaybackMinutes: 0,
        playbackAccessMinutes: 5,
        playbackSpeed: 1,
        watchReplayCache: true,
        // Ручная калибровка: сколько секунд обычно занимает загрузочный экран игры
        // между открытием реплея и реальным началом картинки боя. У нас нет сигнала,
        // который сообщал бы об этом моменте в реальном времени (game cache не
        // обновляется во время просмотра — проверено экспериментально), поэтому
        // это фиксированная поправка, а не автодетект. 0 = поправка выключена.
        playbackLoadDelaySec: 0
    };
}

function createReplayLiveModule(deps) {
    const configPath = path.join(deps.userData || deps.appRoot, 'replay-live-config.json');
    const cacheDir = path.join(deps.userData || deps.appRoot, 'replay-live-cache');
    let config = loadConfig();
    sanitizePlaybackReplayPath();

    function resolveGameCacheReplaysDir() {
        const configured = String(config.replaysDir || '').trim();
        if (configured && listReplayCacheFiles(configured).length) {
            return configured;
        }
        if (listReplayCacheFiles(DEFAULT_REPLAYS_DIR).length) {
            return DEFAULT_REPLAYS_DIR;
        }
        return configured || DEFAULT_REPLAYS_DIR;
    }

    function sanitizeGameCacheReplaysDir() {
        const configured = String(config.replaysDir || '').trim();
        const cacheDir = resolveGameCacheReplaysDir();
        if (!configured || !listReplayCacheFiles(configured).length) {
            if (path.normalize(configured || '').toLowerCase() !== path.normalize(cacheDir).toLowerCase()) {
                console.log('[replay-live] replaysDir → game cache dir:', cacheDir);
                config.replaysDir = cacheDir;
                try {
                    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
                } catch (_) { /* noop */ }
            }
        }
    }

    sanitizeGameCacheReplaysDir();
    let timer = null;
    let watcher = null;
    let lastFinishedPath = '';
    let playbackSession = {
        path: '',
        startedAt: 0,
        clockOffsetSec: 0,
        rewindAt: 0,
        lastSeenAt: 0,
        clockRunning: false
    };
    const replayAccessTracker = createReplayAccessTracker();
    const replayCacheDiffTracker = createReplayCacheDiffTracker();
    const timelineCache = createTimelineCache();
    const replayBufCache = new Map();
    const battleResultsCtxCache = new Map();
    let state = emptyState();
    let lastResolvedPlaybackPath = '';
    let lastActivePlaybackAt = 0;
    let playbackEndTriggered = false;
    let playbackMaxProgressSec = 0;
    let playbackHoldKey = '';
    let playbackFinishedKey = '';
    let playbackFinishedSessionKey = null;
    let lastNuclearResetPath = '';
    let lastNuclearResetAt = 0;
    let lastSeenGameCacheMtimeMs = 0;
    let lastGameCacheActivePath = '';
    const lastMetaHexByBasename = new Map();

    function sanitizePlaybackReplayPath() {
        const manual = (config.playbackReplayPath || '').trim();
        if (!manual) return;
        if (!fs.existsSync(manual)) {
            config.playbackReplayPath = '';
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
            return;
        }
        const dir = normalizedReplayPath(path.dirname(manual));
        const allowed = allReplaySearchDirs().some((searchDir) => (
            normalizedReplayPath(searchDir) === dir
        ));
        if (!allowed) {
            config.playbackReplayPath = '';
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        }
    }

    function loadConfig() {
        const base = defaultConfig();
        let projectSaved = null;
        try {
            const projectConfigPath = path.join(deps.appRoot, 'replay-live-config.json');
            if (projectConfigPath !== configPath && fs.existsSync(projectConfigPath)) {
                projectSaved = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
            }
        } catch (_) { /* noop */ }
        try {
            if (fs.existsSync(configPath)) {
                const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                const extraFromProject = projectSaved && projectSaved.extraReplaysDirs != null
                    ? normalizeExtraReplaysDirs(projectSaved.extraReplaysDirs)
                    : null;
                const savedExtras = saved.extraReplaysDirs != null
                    ? normalizeExtraReplaysDirs(saved.extraReplaysDirs)
                    : null;
                const merged = Object.assign({}, base, saved, {
                    watchReplayCache: saved.watchReplayCache !== false,
                    extraReplaysDirs: savedExtras && savedExtras.length
                        ? savedExtras
                        : (extraFromProject && extraFromProject.length ? extraFromProject : base.extraReplaysDirs),
                    autoPlaybackMinutes: saved.autoPlaybackMinutes != null
                        ? Number(saved.autoPlaybackMinutes)
                        : base.autoPlaybackMinutes,
                    playbackAccessMinutes: saved.playbackAccessMinutes != null
                        ? Number(saved.playbackAccessMinutes)
                        : base.playbackAccessMinutes,
                    playbackSpeed: saved.playbackSpeed != null
                        ? Number(saved.playbackSpeed)
                        : base.playbackSpeed
                });
                if (merged.watchReplayCache !== false) {
                    merged.autoPlaybackMinutes = 0;
                }
                return merged;
            }
        } catch (_) { /* noop */ }
        if (projectSaved) {
            return Object.assign({}, base, projectSaved, {
                extraReplaysDirs: normalizeExtraReplaysDirs(
                    projectSaved.extraReplaysDirs != null ? projectSaved.extraReplaysDirs : base.extraReplaysDirs
                )
            });
        }
        return base;
    }

    function saveConfig(next) {
        if (next.extraReplaysDirs != null) {
            next.extraReplaysDirs = normalizeExtraReplaysDirs(next.extraReplaysDirs);
        }
        config = Object.assign({}, config, next);
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        sanitizePlaybackReplayPath();
        return config;
    }

    function allReplaySearchDirs() {
        const primary = String(config.replaysDir || '').trim();
        const extras = normalizeExtraReplaysDirs(config.extraReplaysDirs);
        const seen = new Set();
        const out = [];
        for (const dir of [primary, ...extras]) {
            if (!dir) continue;
            const key = path.normalize(dir).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(dir);
        }
        return out;
    }

    function listReplayZipCandidates(options) {
        options = options || {};
        const now = Date.now();
        const windowMs = options.windowMs;
        const minSize = options.minSize == null ? 50000 : options.minSize;
        const candidates = [];

        for (const dir of allReplaySearchDirs()) {
            if (!fs.existsSync(dir)) continue;
            let names;
            try {
                names = fs.readdirSync(dir);
            } catch (_) {
                continue;
            }
            for (const name of names) {
                if (!isReplayArchiveName(name)) continue;
                const full = path.join(dir, name);
                try {
                    const stat = fs.statSync(full);
                    if (!stat.isFile()) continue;
                    if (minSize > 0 && stat.size < minSize) continue;
                    if (windowMs != null && now - stat.mtimeMs > windowMs) continue;
                    candidates.push({
                        full,
                        mtime: stat.mtimeMs,
                        size: stat.size,
                        lastTouchMs: Math.max(stat.atimeMs || 0, stat.mtimeMs || 0)
                    });
                } catch (_) { /* noop */ }
            }
        }

        return candidates;
    }

    function playbackAccessWindowMs() {
        return Math.max(HOT_ZIP_ACCESS_MS, (Number(config.playbackAccessMinutes) || 10) * 60 * 1000);
    }

    function resolvePlaybackSignals() {
        const cacheReplaysDir = resolveGameCacheReplaysDir();
        const cache = replayCacheDiffTracker.resolve(cacheReplaysDir, {
            zipActiveMs: HOT_ZIP_ACCESS_MS,
            sessionMetaTtlMs: 5 * 60 * 1000,
            multiMetaZipMs: 90 * 1000
        });
        if (usesExclusiveExtraReplayDirs()) {
            return {
                access: {
                    replayPath: '',
                    isActive: false,
                    reason: 'exclusive_cache_only',
                    freshSpike: null,
                    bootstrapped: true
                },
                cache
            };
        }
        return {
            access: replayAccessTracker.resolve(allReplaySearchDirs(), {
                accessMs: playbackAccessWindowMs(),
                minDeltaMs: 100,
                preferPath: resolvePreferPlaybackPath()
            }),
            cache
        };
    }

    function findSoleZipLiveReplayPath() {
        const zipMs = HOT_ZIP_ACCESS_MS;
        const live = [];
        for (const full of listReplayZipFiles(allReplaySearchDirs())) {
            const activity = getReplayFileActivity(full);
            if (activity.exists && activity.ageMs != null && activity.ageMs <= zipMs) {
                live.push(full);
            }
        }
        if (live.length === 1) return live[0];
        return null;
    }

    function clearFinishedReplayMark() {
        playbackFinishedKey = '';
        playbackFinishedSessionKey = null;
    }

    function markReplayPlaybackFinished(replayPath) {
        if (!replayPath) return;
        playbackFinishedKey = playbackLoadKey(replayPath);
        const snap = readGameCacheSnapshot(
            replayPath,
            replayDataDurationSec() || Number(state.replayDataDurationSec) || 0
        );
        playbackFinishedSessionKey = snap && snap.cacheEntry && snap.cacheEntry.sessionKey != null
            ? snap.cacheEntry.sessionKey
            : (playbackSession.lastMetaSessionKey || null);
    }

    function isFinishedReplayPath(replayPath) {
        if (!replayPath || !playbackFinishedKey) return false;
        return playbackLoadKey(replayPath) === playbackFinishedKey;
    }

    function shouldAllowReplayRestart(replayPath) {
        if (!isFinishedReplayPath(replayPath)) return true;
        const sinceSelect = Date.now() - (playbackSession.replaySelectedAt || 0);
        if (playbackSession.path === replayPath && sinceSelect < 15000) {
            clearFinishedReplayMark();
            return true;
        }
        if (!isZipActiveForPlayback(replayPath)) return false;
        const snap = readGameCacheSnapshot(
            replayPath,
            replayDataDurationSec() || Number(state.replayDataDurationSec) || 0
        );
        if (snap && snap.cacheEntry && snap.cacheEntry.sessionKey != null
            && playbackFinishedSessionKey != null
            && snap.cacheEntry.sessionKey !== playbackFinishedSessionKey) {
            clearFinishedReplayMark();
            return true;
        }
        if (snap && snap.gamePos != null && snap.gamePos < 5) {
            clearFinishedReplayMark();
            return true;
        }
        return false;
    }

    function isFreshReplaySelection() {
        const sinceSelect = Date.now() - (playbackSession.replaySelectedAt || 0);
        return sinceSelect < 12000;
    }

    function shouldIgnoreStaleCachePosition(gamePos, maxDur) {
        if (!isFreshReplaySelection() || gamePos == null) return false;
        const reason = playbackSession.lastDetectReason || '';
        const freshPick = reason === 'game_switch' || reason === 'game_reopen'
            || reason === 'game_active' || reason === 'manual_play' || reason === 'manual_path'
            || reason === 'zip_live' || reason === 'cache_active' || reason === 'hard_switch'
            || reason === 'meta_changed' || reason === 'extra_dir';
        if (!freshPick) return false;
        if (maxDur > 20 && gamePos >= maxDur - 5) return true;
        if (maxDur > 20 && gamePos >= maxDur * 0.85) return true;
        if (!playbackSession.clockRunning && gamePos > 20) return true;
        return false;
    }

    function unlockCachePositionIfMetaLive(cacheEntry) {
        if (!playbackSession.cachePositionLocked || !cacheEntry) return;
        const hex = cacheEntry.metaHex || '';
        if (!playbackSession.cachePositionBaselineHex) {
            playbackSession.cachePositionBaselineHex = hex;
            return;
        }
        if (hex !== playbackSession.cachePositionBaselineHex) {
            playbackSession.cachePositionLocked = false;
        }
    }

    function heldPlaybackPathFromKey() {
        if (!playbackHoldKey) return '';
        const sep = playbackHoldKey.lastIndexOf('|');
        if (sep <= 0) return '';
        const replayPath = playbackHoldKey.slice(0, sep);
        return replayPathExists(replayPath) ? replayPath : '';
    }

    function summaryHoldActive() {
        const summary = state.replayEndSummary;
        return Boolean(summary && (summary.pending || summary.visible));
    }

    function resolveHeldPlaybackPath() {
        if (!playbackHoldKey || !summaryHoldActive()) return null;
        const heldPath = heldPlaybackPathFromKey();
        if (!heldPath) return null;
        if (state.replayEndSummary.replayKey
            && state.replayEndSummary.replayKey !== playbackHoldKey) {
            return null;
        }
        if (playbackLoadKey(heldPath) !== playbackHoldKey) return null;
        return {
            path: heldPath,
            source: 'summary_hold',
            reason: 'summary_hold'
        };
    }

    function normalizedReplayPath(replayPath) {
        return path.normalize(String(replayPath || '')).toLowerCase();
    }

    function isPathInPrimaryReplaysDir(replayPath) {
        const primary = String(config.replaysDir || '').trim();
        if (!primary || !replayPath) return false;
        const dir = normalizedReplayPath(path.dirname(replayPath));
        return dir === normalizedReplayPath(primary);
    }

    function isPathInExtraReplaysDirs(replayPath) {
        if (!replayPath) return false;
        const dir = normalizedReplayPath(path.dirname(replayPath));
        return normalizeExtraReplaysDirs(config.extraReplaysDirs).some((extraDir) => (
            normalizedReplayPath(extraDir) === dir
        ));
    }

    // Имя подпапки, куда прячем досмотренные реплеи, чтобы рабочая папка (Downloads)
    // не захламлялась — детект «какой реплей открыт» путается, когда там лежит
    // много старых файлов (сравнивать время файлов становится неоднозначно).
    const WATCHED_REPLAYS_SUBDIR = 'Старые';

    // Переносит досмотренный реплей из отслеживаемой extra dir в её подпапку
    // WATCHED_REPLAYS_SUBDIR. Тихо ничего не делает, если файл не в extra dir,
    // если рядом лежит .mtime-маркер от game cache watcher (на всякий не рвём
    // связку) — маркер переносим вместе с самим файлом.
    function archiveWatchedReplay(replayPath) {
        if (!replayPath || !isPathInExtraReplaysDirs(replayPath)) return;
        try {
            if (!fs.existsSync(replayPath)) return;
            const dir = path.dirname(replayPath);
            const archiveDir = path.join(dir, WATCHED_REPLAYS_SUBDIR);
            fs.mkdirSync(archiveDir, { recursive: true });

            const name = path.basename(replayPath);
            let dest = path.join(archiveDir, name);
            if (fs.existsSync(dest)) {
                const ext = path.extname(name);
                const stem = name.slice(0, name.length - ext.length);
                dest = path.join(archiveDir, `${stem}_${Date.now()}${ext}`);
            }
            fs.renameSync(replayPath, dest);
            console.log('[replay-live] досмотренный реплей перемещён в архив:', name);
        } catch (err) {
            console.warn('[replay-live] не удалось архивировать реплей:', err.message);
        }
    }

    function usesExclusiveExtraReplayDirs() {
        return normalizeExtraReplaysDirs(config.extraReplaysDirs).length > 0;
    }

    function playbackAccessIsLive(access) {
        if (!access || !access.replayPath) return false;
        const age = access.accessAgeMs;
        return age == null || age <= playbackAccessWindowMs();
    }

    function pickAccessReplayPath(access) {
        if (!access || !access.replayPath || !replayPathExists(access.replayPath)) return null;
        if (!playbackAccessIsLive(access)) return null;
        if (isFinishedReplayPath(access.replayPath) && !shouldAllowReplayRestart(access.replayPath)) {
            return null;
        }
        return {
            path: access.replayPath,
            source: 'access_tracker',
            reason: access.freshSpike ? 'access_spike' : (access.reason || 'access_live')
        };
    }

    function resolvePreferPlaybackPath() {
        if (usesExclusiveExtraReplayDirs()) {
            const session = playbackSession.path || lastResolvedPlaybackPath;
            if (session && fs.existsSync(session)) return session;
            return '';
        }
        const manual = (config.playbackReplayPath || '').trim();
        if (manual && fs.existsSync(manual)) return manual;
        const session = playbackSession.path || lastResolvedPlaybackPath;
        if (session && fs.existsSync(session)) return session;
        return '';
    }

    function isPlaybackSessionLive(replayPath) {
        if (!replayPath || !fs.existsSync(replayPath)) return false;
        if (playbackSession.path === replayPath && playbackSession.clockRunning) return true;
        if (isZipActiveForPlayback(replayPath)) return true;
        if (!isPlaybackPaused(replayPath)) return true;
        const selectedAt = playbackSession.replaySelectedAt || lastActivePlaybackAt || 0;
        return selectedAt > 0 && (Date.now() - selectedAt) <= playbackAccessWindowMs();
    }

    function shouldBlockAutoSwitchTo(candidatePath, signals) {
        const current = resolvePreferPlaybackPath();
        if (!current || !candidatePath) return false;
        if (normalizedReplayPath(current) === normalizedReplayPath(candidatePath)) return false;
        if (!isPlaybackSessionLive(current)) return false;

        const spike = signals && signals.access && signals.access.freshSpike;
        if (spike && normalizedReplayPath(spike.path) === normalizedReplayPath(candidatePath)) {
            return false;
        }
        return true;
    }

    function guardReplayPick(pick, signals) {
        if (!pick || !pick.path) return pick;
        if (shouldBlockAutoSwitchTo(pick.path, signals)) return null;
        return pick;
    }

    function maybePersistPlaybackPath(replayPath, reason) {
        if (!replayPath || !fs.existsSync(replayPath)) return;
        const manual = (config.playbackReplayPath || '').trim();
        if (manual && normalizedReplayPath(manual) === normalizedReplayPath(replayPath)) return;
        if (reason === 'manual_path' || reason === 'manual_play' || reason === 'config_manual_path') {
            saveConfig({ playbackReplayPath: replayPath });
            return;
        }
        if (isPathInExtraReplaysDirs(replayPath)) {
            saveConfig({ playbackReplayPath: replayPath });
        }
    }

    function hasHigherPriorityReplayPath(replayPath) {
        const target = normalizedReplayPath(replayPath);
        if (!target) return false;

        const manual = (config.playbackReplayPath || '').trim();
        if (manual && fs.existsSync(manual) && normalizedReplayPath(manual) !== target) {
            return true;
        }

        if (isPathInExtraReplaysDirs(replayPath) && isPlaybackSessionLive(replayPath)) {
            return false;
        }
        if (playbackSession.path === replayPath && playbackSession.clockRunning) {
            return false;
        }

        return false;
    }

    function activateManualReplayPath(replayPath, options) {
        options = options || {};
        const nextPath = String(replayPath || '').trim();
        if (!nextPath || !fs.existsSync(nextPath)) {
            return { ok: false, error: 'path_not_found' };
        }

        hardResetAllReplayState(nextPath, options.reason || 'manual_path', { force: true });
        playbackSession.lastDetectReason = options.reason || 'manual_path';
        if (options.persist !== false) {
            saveConfig({ playbackReplayPath: nextPath });
        } else {
            config.playbackReplayPath = nextPath;
        }
        replayAccessTracker.syncPreferPath(nextPath);
        poll();
        return { ok: true, path: nextPath };
    }

    function resolveManualPlaybackPath(signals) {
        const manual = (config.playbackReplayPath || '').trim();
        if (!manual || !fs.existsSync(manual)) return null;
        if (shouldHoldPlaybackAfterEnd(manual) && !isZipActiveForPlayback(manual)) {
            return null;
        }
        if (isFinishedReplayPath(manual) && !isZipActiveForPlayback(manual)) {
            return null;
        }

        const newerExtra = findLatestLiveReplayPick();
        if (newerExtra && newerExtra.path
            && normalizedReplayPath(newerExtra.path) !== normalizedReplayPath(manual)
            && isPathInExtraReplaysDirs(newerExtra.path)) {
            const activity = getReplayFileActivity(newerExtra.path);
            if (activity.ageMs != null && activity.ageMs <= HOT_ZIP_ACCESS_MS) {
                return null;
            }
        }

        const spike = signals && signals.access && signals.access.freshSpike;
        if (spike && spike.path
            && normalizedReplayPath(spike.path) !== normalizedReplayPath(manual)
            && isPathInExtraReplaysDirs(spike.path)) {
            return null;
        }

        return {
            path: manual,
            source: 'manual',
            reason: 'manual_path'
        };
    }

    // Детект открытого реплея вынесен в detection.js. Общее состояние
    // проброшено через геттеры/сеттеры — присваивания вида h.playbackHoldKey = ''
    // внутри detection.js меняют локальные переменные этого замыкания.
    const h = {
        lastMetaHexByBasename,
        replayAccessTracker,
        replayCacheDiffTracker,
        timelineCache,
        replayBufCache,
        battleResultsCtxCache,
        cacheDir,
        PLAYBACK_VISUAL_LAG_SEC,
        WALL_CLOCK_FALLBACK_MS
    };
    Object.defineProperties(h, {
        playbackSession: { get: () => playbackSession, set: (v) => { playbackSession = v; } },
        state: { get: () => state, set: (v) => { state = v; } },
        config: { get: () => config, set: (v) => { config = v; } },
        lastResolvedPlaybackPath: { get: () => lastResolvedPlaybackPath, set: (v) => { lastResolvedPlaybackPath = v; } },
        lastActivePlaybackAt: { get: () => lastActivePlaybackAt, set: (v) => { lastActivePlaybackAt = v; } },
        playbackHoldKey: { get: () => playbackHoldKey, set: (v) => { playbackHoldKey = v; } },
        playbackEndTriggered: { get: () => playbackEndTriggered, set: (v) => { playbackEndTriggered = v; } },
        playbackMaxProgressSec: { get: () => playbackMaxProgressSec, set: (v) => { playbackMaxProgressSec = v; } },
        lastSeenGameCacheMtimeMs: { get: () => lastSeenGameCacheMtimeMs, set: (v) => { lastSeenGameCacheMtimeMs = v; } },
        lastGameCacheActivePath: { get: () => lastGameCacheActivePath, set: (v) => { lastGameCacheActivePath = v; } }
    });
    Object.assign(h, {
        poll: (...a) => poll(...a),
        isFinishedReplayPath: (...a) => isFinishedReplayPath(...a),
        shouldAllowReplayRestart: (...a) => shouldAllowReplayRestart(...a),
        normalizedReplayPath: (...a) => normalizedReplayPath(...a),
        playbackAccessWindowMs: (...a) => playbackAccessWindowMs(...a),
        isPathInExtraReplaysDirs: (...a) => isPathInExtraReplaysDirs(...a),
        isPathInPrimaryReplaysDir: (...a) => isPathInPrimaryReplaysDir(...a),
        listReplayZipCandidates: (...a) => listReplayZipCandidates(...a),
        clearFinishedReplayMark: (...a) => clearFinishedReplayMark(...a),
        resolveGameCacheReplaysDir: (...a) => resolveGameCacheReplaysDir(...a),
        saveConfig: (...a) => saveConfig(...a),
        hardResetAllReplayState: (...a) => hardResetAllReplayState(...a),
        defaultPlaybackSessionFields: (...a) => defaultPlaybackSessionFields(...a),
        usesExclusiveExtraReplayDirs: (...a) => usesExclusiveExtraReplayDirs(...a),
        resolvePlaybackSignals: (...a) => resolvePlaybackSignals(...a),
        shouldHoldPlaybackAfterEnd: (...a) => shouldHoldPlaybackAfterEnd(...a),
        replayDataDurationSec: (...a) => replayDataDurationSec(...a),
        getPlaybackClockSec: (...a) => getPlaybackClockSec(...a),
        isZipActiveForPlayback: (...a) => isZipActiveForPlayback(...a),
        summaryHoldActive: (...a) => summaryHoldActive(...a),
        pickAccessReplayPath: (...a) => pickAccessReplayPath(...a),
        guardReplayPick: (...a) => guardReplayPick(...a),
        markPlaybackSelection: (...a) => markPlaybackSelection(...a),
        findSoleZipLiveReplayPath: (...a) => findSoleZipLiveReplayPath(...a),
        normalizeExtraReplaysDirs: (...a) => normalizeExtraReplaysDirs(...a),
        playbackSpeed: (...a) => playbackSpeed(...a),
        playbackLoadDelaySec: (...a) => playbackLoadDelaySec(...a),
        unlockCachePositionIfMetaLive: (...a) => unlockCachePositionIfMetaLive(...a),
        shouldIgnoreStaleCachePosition: (...a) => shouldIgnoreStaleCachePosition(...a),
        markReplayPlaybackFinished: (...a) => markReplayPlaybackFinished(...a),
        triggerReplayEndSummary: (...a) => triggerReplayEndSummary(...a),
        resetPlaybackCaches: (...a) => resetPlaybackCaches(...a),
        maybePersistPlaybackPath: (...a) => maybePersistPlaybackPath(...a),
        logMetaChange: (...a) => logMetaChange(...a),
        metaLogPath: (...a) => metaLogPath(...a),
        archiveWatchedReplay: (...a) => archiveWatchedReplay(...a),
        playbackLoadKey: (...a) => playbackLoadKey(...a),
        isFreshReplaySelection: (...a) => isFreshReplaySelection(...a),
        findAuthorEntityId: (...a) => findAuthorEntityId(...a),
        formatTime: (...a) => formatTime(...a),
        getBattleResultsContext: (...a) => getBattleResultsContext(...a),
        getPlaybackReplayBuf: (...a) => getPlaybackReplayBuf(...a),
        recordingBattleResultsPath: (...a) => recordingBattleResultsPath(...a),
        replayFileMtime: (...a) => replayFileMtime(...a),
        tankNameContext: (...a) => tankNameContext(...a),
        clearReplayEndState: (...a) => clearReplayEndState(...a),
        ensurePlaybackClock: (...a) => ensurePlaybackClock(...a),
        ensurePlaybackClockRunning: (...a) => ensurePlaybackClockRunning(...a),
        ensurePlaybackSession: (...a) => ensurePlaybackSession(...a),
        maybeRestartPlaybackFromGameCache: (...a) => maybeRestartPlaybackFromGameCache(...a),
        maybeStartPlaybackClock: (...a) => maybeStartPlaybackClock(...a)
    });
    const {
        scheduleExtraDirReplayPoll,
        resolveFreshAccessReplayPick,
        findNewerExtraDirLiveReplay,
        resolveExtraDirOpenedReplayPick,
        pickExtraDirReplayIfNew,
        findLatestLiveReplayPick,
        readGameCacheEntry,
        canonicalCacheReplayPath,
        resetExclusiveReplayWatchState,
        beginFreshExclusiveReplay,
        exclusiveReplaySessionKey,
        currentExclusivePlaybackPath,
        clearExclusiveIdleSession,
        resolveExclusiveExtraDirPick,
        resolveRecentlyOpenedReplayPath,
        pickReplayFromSignals,
        returnPlaybackPick
    } = createReplayDetection(h);
    Object.assign(h, {
        readGameCacheEntry: (...a) => readGameCacheEntry(...a),
        canonicalCacheReplayPath: (...a) => canonicalCacheReplayPath(...a)
    });

    function emptyState() {
        return {
            status: 'idle',
            mode: 'idle',
            updatedAt: new Date().toISOString(),
            recordingPath: '',
            sourceLabel: '',
            playbackSource: '',
            playbackLoading: false,
            playbackDebug: null,
            dataFileSize: 0,
            clientVersion: '',
            battleTimeSec: 0,
            battleTimeLabel: '00:00',
            battleDurationSec: 0,
            replayDataDurationSec: 0,
            replayAtEnd: false,
            playbackClockSec: 0,
            playbackClockRunning: false,
            playbackStartedAt: 0,
            playbackSpeed: 1,
            authorNickname: '',
            authorTeam: 0,
            arenaUniqueId: null,
            battleLevel: null,
            players: [],
            playerCount: 0,
            packetCount: 0,
            live: {
                damageDealt: null,
                hits: null,
                frags: null
            },
            lastBattle: null,
            replayEndSummary: null,
            playbackTimeline: null,
            replaySwitchAt: 0,
            activeReplayPath: ''
        };
    }

    function formatTime(sec) {
        const s = Math.max(0, Math.floor(sec || 0));
        const mm = String(Math.floor(s / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        return `${mm}:${ss}`;
    }

    function findAuthorEntityId(parsed, entityPlayers) {
        const authorNick = (parsed && parsed.authorNickname) || config.playerName || '';
        if (!authorNick) return null;
        let found = null;
        entityPlayers.forEach((player, entityId) => {
            if (player.nickname === authorNick) found = entityId;
        });
        return found;
    }

    function playbackSpeed() {
        const speed = Number(config.playbackSpeed);
        return speed > 0 ? speed : 1;
    }

    // Знак важен: положительное значение ПРИДЕРЖИВАЕТ часы (виджет спешит —
    // считает секунды загрузки, которых по факту не было в бою), отрицательное —
    // РАЗГОНЯЕТ вперёд (виджет отстаёт — детект сработал позже, чем реально
    // начался бой). Направление зависит от конкретной связки игра/железо
    // пользователя, поэтому не фиксируем знак — подбирается на практике.
    function playbackLoadDelaySec() {
        const sec = Number(config.playbackLoadDelaySec);
        if (!Number.isFinite(sec)) return 0;
        return Math.max(-60, Math.min(sec, 60));
    }

    function metaLogPath() {
        return path.join(deps.userData || deps.appRoot, 'replay-live-meta.log');
    }

    function logMetaChange(cacheEntry, inspect, reason) {
        if (!cacheEntry || !inspect) return;
        try {
            const line = JSON.stringify({
                at: new Date().toISOString(),
                replay: path.basename(cacheEntry.replayPath || ''),
                reason,
                sessionKey: inspect.sessionKey,
                metaTs: inspect.metaTs,
                parsedPosition: inspect.parsedPosition,
                hex: inspect.hex,
                slots: inspect.slots
            }) + '\n';
            fs.appendFileSync(metaLogPath(), line, 'utf8');
        } catch (_) { /* noop */ }
    }

    function defaultPlaybackSessionFields(playbackPath) {
        return {
            path: playbackPath || '',
            startedAt: 0,
            clockOffsetSec: 0,
            rewindAt: 0,
            lastSeenAt: Date.now(),
            lastDetectReason: '',
            lastRewindPickKey: '',
            lastMetaSessionKey: null,
            clockRunning: false,
            replaySelectedAt: Date.now(),
            zipLiveSince: 0,
            battleStartOffsetSec: 0,
            pendingSessionStart: false,
            frozenClockSec: null,
            zipPausedAt: 0,
            lastMetaHex: null,
            gamePositionSec: null,
            gamePositionAt: 0,
            clockSource: 'idle',
            battleAnchored: false,
            lastKnownClockSec: 0,
            lastMetaInspect: null,
            lastMetaChangeAt: 0,
            loadKey: '',
            parseGen: 0,
            parseInFlight: false,
            applyCache: null,
            cachePositionLocked: false,
            cachePositionBaselineHex: null
        };
    }

    function purgeExtractedReplayDiskCache(scope) {
        try {
            if (!fs.existsSync(cacheDir)) return 0;
            let removed = 0;
            const replayBase = scope && scope !== 'all' && scope !== '*'
                ? replayArchiveBasename(scope)
                : '';
            for (const name of fs.readdirSync(cacheDir)) {
                if (!name.endsWith('.data.replay') && !name.endsWith('.data.replay.mtime')) continue;
                if (replayBase && !name.startsWith(`${replayBase}.data.replay`)) continue;
                try {
                    fs.unlinkSync(path.join(cacheDir, name));
                    removed += 1;
                } catch (_) { /* noop */ }
            }
            return removed;
        } catch (_) {
            return 0;
        }
    }

    function clearReplayBufCacheForPath(replayPath) {
        if (!replayPath) {
            replayBufCache.clear();
            return;
        }
        const prefix = `${replayPath}|`;
        for (const key of replayBufCache.keys()) {
            if (key.startsWith(prefix)) replayBufCache.delete(key);
        }
    }

    function clearBattleResultsCtxCacheForPath(replayPath) {
        if (!replayPath) {
            battleResultsCtxCache.clear();
            return;
        }
        const prefix = `${replayPath}|`;
        for (const key of [...battleResultsCtxCache.keys()]) {
            if (key.startsWith(prefix)) battleResultsCtxCache.delete(key);
        }
    }

    function resetPlaybackCaches(reason, options) {
        options = options || {};
        const endedPath = options.replayPath || '';
        const purgeDisk = options.purgeDisk !== false;
        const purgeScope = options.purgeDisk === 'all' || options.purgeDisk === '*'
            ? 'all'
            : (endedPath || 'all');

        if (options.resetTrackers !== false && !(playbackHoldKey && summaryHoldActive())) {
            replayCacheDiffTracker.reset();
            replayAccessTracker.reset();
        }

        if (options.resetTimeline !== false) {
            timelineCache.reset();
        }

        if (options.resetMemory !== false) {
            if (endedPath) {
                clearReplayBufCacheForPath(endedPath);
                clearBattleResultsCtxCacheForPath(endedPath);
            } else {
                replayBufCache.clear();
                battleResultsCtxCache.clear();
            }
        }

        if (purgeDisk) {
            purgeExtractedReplayDiskCache(purgeScope);
        }

        if (!options.keepProgress) {
            playbackMaxProgressSec = 0;
        }

        if (options.stopClock !== false) {
            stopPlaybackClock();
        }

        if (options.resetSession !== false) {
            const keepPath = options.keepSessionPath != null
                ? options.keepSessionPath
                : (options.preserveSessionPath ? playbackSession.path : '');
            const parseGen = (playbackSession.parseGen || 0) + 1;
            playbackSession = defaultPlaybackSessionFields(keepPath);
            playbackSession.parseGen = parseGen;
            playbackSession.applyCache = null;
            playbackSession.parseInFlight = false;
        } else if (playbackSession) {
            playbackSession.applyCache = null;
            playbackSession.parseInFlight = false;
            playbackSession.parseGen = (playbackSession.parseGen || 0) + 1;
            playbackSession.loadKey = '';
            playbackSession.lastMetaHex = null;
            playbackSession.lastMetaSessionKey = null;
            playbackSession.gamePositionSec = null;
            playbackSession.gamePositionAt = 0;
            playbackSession.zipLiveSince = 0;
            playbackSession.frozenClockSec = null;
            playbackSession.zipPausedAt = 0;
            playbackSession.lastMetaInspect = null;
        }

        if (options.clearLiveState) {
            if (!options.keepReplayAtEnd) {
                state.replayAtEnd = false;
                state.replayDataDurationSec = 0;
            } else {
                state.replayAtEnd = true;
            }
            state.gamePositionSec = null;
            state.gamePositionAt = null;
            state.clockSource = options.keepReplayAtEnd ? 'replay_end' : 'idle';
            state.battleAnchored = false;
            state.playbackClockSec = 0;
            state.playbackClockRunning = false;
            state.playbackStartedAt = 0;
            state.playbackTimeline = null;
            state.teamHp = null;
            state.teamHpDebug = null;
            state.introPhase = false;
            state.battleClockRunning = false;
        } else if (options.keepReplayAtEnd) {
            state.replayAtEnd = true;
        }

        state.playbackDebug = Object.assign({}, state.playbackDebug || {}, {
            lastCleanupReason: reason || 'manual',
            lastCleanupAt: Date.now(),
            lastCleanupReplay: endedPath ? path.basename(endedPath) : ''
        });

        console.log('[replay-live] playback cleanup:', reason || 'manual', endedPath ? path.basename(endedPath) : '');
    }

    function hardResetAllReplayState(replayPath, reason, options) {
        options = options || {};
        if (!replayPath) return;

        const norm = normalizedReplayPath(replayPath);
        const isSpike = reason === 'access_spike' || reason === 'replay_reopened'
            || reason === 'manual_path' || reason === 'manual_play'
            || reason === 'game_switch' || reason === 'game_reopen'
            || reason === 'zip_live' || reason === 'zip_open' || reason === 'meta_changed' || options.force;
        const now = Date.now();
        if (!isSpike && norm === lastNuclearResetPath && (now - lastNuclearResetAt) < 1500) return;

        lastNuclearResetPath = norm;
        lastNuclearResetAt = now;

        console.log('[replay-live] HARD RESET:', path.basename(replayPath), reason || 'switch');

        clearFinishedReplayMark();
        playbackHoldKey = '';
        playbackFinishedKey = '';
        playbackFinishedSessionKey = null;
        resetPlaybackSummaryTracking(true);

        resetPlaybackCaches('hard_replay_switch', {
            replayPath: playbackSession.path || lastResolvedPlaybackPath || replayPath,
            purgeDisk: 'all',
            stopClock: true,
            resetSession: true,
            keepSessionPath: replayPath,
            clearLiveState: true,
            resetTrackers: true,
            resetTimeline: true,
            resetMemory: true
        });

        replayBufCache.clear();
        battleResultsCtxCache.clear();
        lastResolvedPlaybackPath = '';
        lastActivePlaybackAt = 0;
        playbackSession = defaultPlaybackSessionFields(replayPath);
        playbackSession.lastDetectReason = reason || 'hard_switch';
        playbackSession.replaySelectedAt = now;
        playbackSession.lastMetaChangeAt = now;
        playbackSession.pendingSessionStart = true;
        playbackSession.gamePositionSec = null;
        playbackSession.gamePositionAt = 0;
        playbackSession.lastKnownClockSec = 0;
        playbackSession.clockOffsetSec = 0;
        playbackSession.lastMetaSessionKey = null;
        playbackSession.lastMetaHex = null;

        playbackSession.cachePositionLocked = true;
        playbackSession.cachePositionBaselineHex = null;
        startPlaybackClock(0);
        playbackSession.clockSource = 'waiting_game_cache';
        playbackSession.pendingSessionStart = false;
        playbackSession.gamePositionSec = null;
        playbackSession.gamePositionAt = 0;

        state.replayEndSummary = null;
        state.playbackTimeline = null;
        state.players = [];
        state.playerCount = 0;
        state.packetCount = 0;
        state.live = { damageDealt: null, hits: null, frags: null };
        state.lastBattle = null;
        state.authorNickname = '';
        state.replayAtEnd = false;
        state.teamHp = null;
        state.teamHpDebug = null;
        state.replaySwitchAt = now;
        state.activeReplayPath = replayPath;
        resetReplayEndClock();
    }

    function getBattleResultsContext(battleResultsPath) {
        if (!battleResultsPath) {
            return {
                finalDamage: new Map(),
                rosterByNick: new Map(),
                combatStatsByEntity: new Map()
            };
        }
        try {
            const mtimeMs = fs.statSync(battleResultsPath).mtimeMs;
            const key = `${battleResultsPath}|${mtimeMs}`;
            if (battleResultsCtxCache.has(key)) return battleResultsCtxCache.get(key);
            const ctx = parseBattleResultsContext(battleResultsPath);
            battleResultsCtxCache.set(key, ctx);
            if (battleResultsCtxCache.size > 8) {
                battleResultsCtxCache.delete(battleResultsCtxCache.keys().next().value);
            }
            return ctx;
        } catch (_) {
            return parseBattleResultsContext(battleResultsPath);
        }
    }

    function getPlaybackReplayBuf(playbackPath) {
        if (!playbackPath) return null;
        const mtimeMs = replayFileMtime(playbackPath);
        const key = `${playbackPath}|${mtimeMs}`;
        if (replayBufCache.has(key)) return replayBufCache.get(key);

        let buf = null;
        if (isReplayArchivePath(playbackPath)) {
            buf = extractDataReplayFromZip(playbackPath, cacheDir);
        } else if (fs.existsSync(playbackPath)) {
            buf = safeReadFile(playbackPath);
        }
        if (buf && buf.length > 32) {
            replayBufCache.set(key, buf);
            if (replayBufCache.size > 6) {
                replayBufCache.delete(replayBufCache.keys().next().value);
            }
        }
        return buf;
    }

    function playbackLoadKey(playbackPath) {
        return `${playbackPath}|${replayFileMtime(playbackPath)}`;
    }

    function shouldHoldPlaybackAfterEnd(playbackPath) {
        if (!playbackPath || !playbackHoldKey) return false;
        if (playbackLoadKey(playbackPath) !== playbackHoldKey) return false;
        if (isZipActiveForPlayback(playbackPath)) return false;
        return true;
    }

    function revealPendingReplaySummary() {
        const summary = state.replayEndSummary;
        if (!summary || !summary.pending) return;
        const showAt = summary.showAt ? Date.parse(summary.showAt) : 0;
        if (!showAt || Date.now() < showAt) return;
        summary.visible = true;
        summary.pending = false;
        summary.shownAt = new Date().toISOString();
        state.mode = 'playback_summary';
    }

    function applyPlaybackQuickState(parsed, playbackPath, buf) {
        ensurePlaybackSession(playbackPath);
        const replayDurationSec = parsed.battleTimeSec || 0;
        const battleDurationSec = Math.max(
            DEFAULT_BATTLE_DURATION_SEC,
            Math.ceil(replayDurationSec) || DEFAULT_BATTLE_DURATION_SEC
        );
        maybeRestartPlaybackFromGameCache(replayDurationSec || battleDurationSec);
        maybeStartPlaybackClock(playbackPath, playbackSession.lastDetectReason);
        ensurePlaybackClockRunning(playbackPath, playbackSession.lastDetectReason || 'quick');

        const battleStartOffsetSec = Number(playbackSession.battleStartOffsetSec) || FALLBACK_BATTLE_START_OFFSET_SEC;
        const clockSec = getPlaybackClockSec();
        const battleElapsedSec = replayBattleElapsed(clockSec, battleStartOffsetSec);

        const tankCtx = tankNameContext({
            buf,
            playbackPath,
            authorNickname: parsed.authorNickname || config.playerName || ''
        });
        const players = enrichPlayersWithTankNames(
            (parsed.players || []).map((row) => Object.assign({}, row, {
                damageDealt: 0,
                hits: 0,
                frags: 0,
                damageSource: 'replay'
            })),
            tankCtx
        );

        state.playbackLoading = true;
        state.clientVersion = parsed.clientVersion || state.clientVersion;
        state.battleDurationSec = battleDurationSec;
        state.replayDataDurationSec = replayDurationSec;
        state.replayAtEnd = false;
        state.battleTimeSec = clockSec;
        state.battleTimeLabel = formatCountdown(clockSec, DEFAULT_BATTLE_DURATION_SEC, battleStartOffsetSec);
        state.countdownRemainingSec = Math.max(0, DEFAULT_BATTLE_DURATION_SEC - battleElapsedSec);
        state.countdownLabel = playbackSession.clockRunning
            ? state.battleTimeLabel
            : formatCountdown(0, DEFAULT_BATTLE_DURATION_SEC, battleStartOffsetSec);
        state.battleStartOffsetSec = battleStartOffsetSec;
        state.movementStartSec = battleStartOffsetSec;
        state.introPhase = playbackSession.clockRunning && clockSec < battleStartOffsetSec;
        state.battleClockRunning = playbackSession.clockRunning && clockSec >= battleStartOffsetSec;
        state.playbackClockSec = clockSec;
        state.playbackClockRunning = playbackSession.clockRunning && !state.replayAtEnd;
        state.replayPositionSec = clockSec;
        state.gamePositionSec = playbackSession.gamePositionSec;
        state.gamePositionAt = playbackSession.gamePositionAt;
        state.clockSource = playbackSession.clockSource;
        state.battleAnchored = playbackSession.battleAnchored;
        state.battleElapsedSec = battleElapsedSec;
        state.authorNickname = parsed.authorNickname || state.authorNickname;
        state.arenaUniqueId = parsed.arenaUniqueId;
        state.battleLevel = parsed.battleLevel;
        state.players = players;
        state.playerCount = players.length;
        state.packetCount = parsed.packetCount || 0;
        const quickAuthor = players.find((p) => p.nickname === parsed.authorNickname)
            || players.find((p) => p.nickname === config.playerName)
            || null;
        state.authorTeam = quickAuthor && quickAuthor.team ? quickAuthor.team : (state.authorTeam || 0);
        state.playbackTimeline = null;
    }

    // Playback-часы (game cache / zip wall-clock / wall fallback, пауза, рестарт
    // по meta-сессии) вынесены в playbackClock.js. Общее состояние — через хаб h.
    const {
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
    } = createPlaybackClock(h);


    function replayFileMtime(replayPath) {
        try {
            return fs.statSync(replayPath).mtimeMs;
        } catch (_) {
            return 0;
        }
    }

    function recordingDir() {
        const name = `recording_${config.playerName}.tbreplay`;
        return path.join(config.replaysDir, name);
    }

    function recordingDataPath() {
        return path.join(recordingDir(), 'data.replay');
    }

    function recordingBattleResultsPath() {
        return path.join(recordingDir(), 'battle_results.dat');
    }

    function safeReadFile(filePath) {
        try {
            const fd = fs.openSync(filePath, 'r');
            try {
                const stat = fs.fstatSync(fd);
                const size = stat.size;
                if (!size) return Buffer.alloc(0);
                const buf = Buffer.alloc(size);
                fs.readSync(fd, buf, 0, size, 0);
                return buf;
            } finally {
                fs.closeSync(fd);
            }
        } catch (_) {
            return null;
        }
    }

    function isRecordingActive() {
        const dir = recordingDir();
        if (!fs.existsSync(dir)) return false;
        try {
            return fs.statSync(dir).isDirectory();
        } catch (_) {
            return false;
        }
    }

    function tryContinueActivePlayback() {
        const replayPath = playbackSession.path || lastResolvedPlaybackPath;
        if (!replayPath || !fs.existsSync(replayPath)) return null;
        if (findNewerExtraDirLiveReplay(replayPath)) return null;
        if (hasHigherPriorityReplayPath(replayPath)) return null;
        if (shouldHoldPlaybackAfterEnd(replayPath)) return null;
        if (isFinishedReplayPath(replayPath) && !shouldAllowReplayRestart(replayPath)) return null;

        const selectedAt = playbackSession.replaySelectedAt || lastActivePlaybackAt;
        if (!selectedAt) return null;

        const sessionAge = Date.now() - selectedAt;
        if (sessionAge > STICKY_SESSION_MAX_MS) return null;

        const wasActive = playbackSession.clockRunning
            || (playbackSession.lastKnownClockSec || 0) > 2
            || lastActivePlaybackAt > 0;
        if (!wasActive) return null;

        const replayDurSec = replayDataDurationSec()
            || Number(state.replayDataDurationSec) || 0;
        const maxSessionMs = replayDurSec > 0
            ? replayDurSec * 1000 + 180_000
            : 25 * 60 * 1000;
        if (sessionAge > maxSessionMs) return null;

        if (state.replayAtEnd && !playbackSession.clockRunning) {
            const activity = getReplayFileActivity(replayPath);
            if (activity.ageMs != null && activity.ageMs > STICKY_META_SILENCE_MS) {
                return null;
            }
        }

        markPlaybackSelection(replayPath, 'session_continue');
        replayCacheDiffTracker.syncSelection(replayPath);
        return {
            path: replayPath,
            source: 'session_continue',
            reason: 'session_continue'
        };
    }

    function tryStickyPlaybackSession() {
        const replayPath = playbackSession.path;
        if (!replayPath || !playbackSession.replaySelectedAt) return null;
        if (hasHigherPriorityReplayPath(replayPath)) return null;
        if (isFinishedReplayPath(replayPath) && !shouldAllowReplayRestart(replayPath)) return null;
        if (Date.now() - playbackSession.replaySelectedAt > STICKY_SESSION_MAX_MS) return null;
        if (!fs.existsSync(replayPath)) return null;

        const entry = readGameCacheEntry(replayPath);
        if (!entry && !isZipActiveForPlayback(replayPath) && !playbackSession.clockRunning) return null;

        try {
            const files = listReplayCacheFiles(resolveGameCacheReplaysDir());
            if (files.length) {
                const buf = fs.readFileSync(files[0].full);
                const activePath = readActiveReplayFromCache(buf);
                if (activePath && activePath !== replayPath && fs.existsSync(activePath)) {
                    const switchAct = getReplayFileActivity(activePath);
                    if (switchAct.exists && switchAct.ageMs != null && switchAct.ageMs <= 20_000) {
                        const normalizedActive = path.normalize(activePath).toLowerCase();
                        const activeEntry = parseCacheEntries(buf).find((row) => (
                            path.normalize(row.replayPath).toLowerCase() === normalizedActive
                        ));
                        if (activeEntry
                            && playbackSession.lastMetaHex
                            && entry.metaHex === playbackSession.lastMetaHex
                            && activeEntry.metaHex !== entry.metaHex) {
                            return null;
                        }
                    }
                }
            }
        } catch (_) { /* noop */ }

        const lastActivity = playbackSession.lastMetaChangeAt || playbackSession.replaySelectedAt;
        const silentMs = Date.now() - lastActivity;
        const zipPaused = isPlaybackPaused(replayPath);

        if (silentMs > STICKY_META_SILENCE_MS && zipPaused && !playbackSession.clockRunning
            && (playbackSession.clockSource === 'replay_end' || state.replayAtEnd)) {
            return null;
        }

        if (playbackSession.clockRunning || silentMs < STICKY_META_SILENCE_MS || !zipPaused) {
            markPlaybackSelection(replayPath, 'sticky_session');
            replayCacheDiffTracker.syncSelection(replayPath);
            return {
                path: replayPath,
                source: 'sticky',
                reason: 'sticky_session'
            };
        }

        return null;
    }

    function resolvePlaybackReplayPath() {
        const held = resolveHeldPlaybackPath();
        if (held) {
            markPlaybackSelection(held.path, held.reason);
            state.playbackDebug = Object.assign({}, state.playbackDebug || {}, {
                reason: 'active',
                detectSource: held.source || 'summary_hold',
                trackerReason: held.reason,
                activeReplay: path.basename(held.path),
                replayPath: path.basename(held.path)
            });
            return held;
        }

        if (usesExclusiveExtraReplayDirs()) {
            const signals = resolvePlaybackSignals();
            const pick = resolveExclusiveExtraDirPick(signals);

            if (pick && pick.path) {
                const current = playbackSession.path || lastResolvedPlaybackPath || '';
                const prevKey = exclusiveReplaySessionKey(current, playbackSession.lastMetaHex);
                const nextKey = exclusiveReplaySessionKey(pick.path, pick.metaHex);
                const needsFreshStart = !current || prevKey !== nextKey;

                if (needsFreshStart) {
                    beginFreshExclusiveReplay(pick.path, pick.reason || 'game_switch');
                    if (pick.metaHex) {
                        playbackSession.lastMetaHex = pick.metaHex;
                    }
                    if (pick.cacheMtimeMs) {
                        lastSeenGameCacheMtimeMs = pick.cacheMtimeMs;
                    }
                } else if (pick.metaHex) {
                    playbackSession.lastMetaHex = pick.metaHex;
                }

                markPlaybackSelection(pick.path, pick.reason);
                return returnPlaybackPick(pick, {
                    exclusiveExtraDir: true,
                    gameActivePath: pick.path,
                    accessDeltaMs: null
                });
            }

            state.playbackDebug = {
                reason: 'inactive',
                detectSource: 'waiting_game_open',
                accessReason: signals.access.reason || 'none',
                gameCacheActive: '',
                activeReplay: '',
                replayPath: ''
            };
            const prev = currentExclusivePlaybackPath();
            if (prev && !isZipActiveForPlayback(prev) && !playbackSession.clockRunning) {
                clearExclusiveIdleSession();
            }
            return null;
        }

        const signals = resolvePlaybackSignals();

        const manualPick = resolveManualPlaybackPath(signals);
        if (manualPick) {
            markPlaybackSelection(manualPick.path, manualPick.reason);
            return manualPick;
        }

        const extraOpened = resolveExtraDirOpenedReplayPick(signals);
        const extraPick = pickExtraDirReplayIfNew(extraOpened);
        if (extraPick) return extraPick;

        const freshAccess = resolveFreshAccessReplayPick(signals);
        const freshPick = pickExtraDirReplayIfNew(freshAccess);
        if (freshPick) return freshPick;

        if (config.watchReplayCache !== false) {
            const continued = tryContinueActivePlayback();
            if (continued && continued.path) {
                state.playbackDebug = {
                    reason: 'active',
                    detectSource: continued.source || 'session_continue',
                    trackerReason: continued.reason,
                    activeReplay: path.basename(continued.path),
                    replayPath: path.basename(continued.path),
                    sessionAgeMs: Date.now() - (playbackSession.replaySelectedAt || lastActivePlaybackAt)
                };
                return continued;
            }

            const sticky = tryStickyPlaybackSession();
            if (sticky && sticky.path) {
                state.playbackDebug = {
                    reason: 'active',
                    detectSource: sticky.source || 'sticky',
                    trackerReason: sticky.reason,
                    activeReplay: path.basename(sticky.path),
                    replayPath: path.basename(sticky.path),
                    stickySilenceMs: Date.now() - (playbackSession.lastMetaChangeAt || playbackSession.replaySelectedAt)
                };
                return sticky;
            }

            const pick = pickReplayFromSignals(signals);
            if (pick) {
                const extraLive = findLatestLiveReplayPick();
                if (extraLive && extraLive.path
                    && isPathInExtraReplaysDirs(extraLive.path)
                    && normalizedReplayPath(extraLive.path) !== normalizedReplayPath(pick.path)
                    && getReplayFileActivity(extraLive.path).ageMs <= HOT_ZIP_ACCESS_MS) {
                    const forced = pickExtraDirReplayIfNew(extraLive);
                    if (forced) return forced;
                }
                return returnPlaybackPick(pick, {
                    accessDeltaMs: signals.access.freshSpike ? signals.access.freshSpike.deltaMs : null,
                    cacheReason: signals.cache.reason,
                    changedCount: signals.cache.changedCount,
                    zipSpikes: signals.cache.zipSpikes
                });
            }

            state.playbackDebug = {
                reason: 'inactive',
                detectSource: signals.cache.reason || signals.access.reason || 'none',
                cacheReason: signals.cache.reason,
                accessReason: signals.access.reason,
                activeReplay: signals.cache.activeReplay || '',
                changedCount: signals.cache.changedCount || null,
                zipSpikes: signals.cache.zipSpikes || null
            };

            const extraLive = findLatestLiveReplayPick();
            if (extraLive) {
                return returnPlaybackPick(extraLive, { extraDirFallback: true });
            }
        }

        const autoMinutes = Number(config.autoPlaybackMinutes) || 0;
        if (autoMinutes <= 0) return null;

        const windowMs = autoMinutes * 60 * 1000;
        const candidates = listReplayZipCandidates({ minSize: 50000, windowMs })
            .sort((a, b) => b.mtime - a.mtime);
        if (!candidates[0]) return null;
        return { path: candidates[0].full, source: 'recent_zip' };
    }

    function findLatestFinishedReplay() {
        const candidates = listReplayZipCandidates({ minSize: 0 })
            .sort((a, b) => b.mtime - a.mtime);
        return candidates[0] ? candidates[0].full : null;
    }

    function tankNameContext(options) {
        options = options || {};
        const playbackPath = options.playbackPath || '';
        const meta = isReplayArchivePath(playbackPath)
            ? readMetaFromZip(playbackPath)
            : null;
        const vehicleCodesByNick = options.buf
            ? parseSubtype55VehicleCodes(parseReplayPackets(options.buf))
            : new Map();

        return {
            cacheDir,
            authorNickname: options.authorNickname || '',
            authorVehicleInternal: meta && meta.playerVehicleName ? meta.playerVehicleName : '',
            vehicleCodesByNick
        };
    }

    // Применение таймлайна/summary вынесено в timelineApply.js (хаб h).
    const {
        applyParsedReplay,
        applyPlaybackTimeline,
        applyFinishedReplay,
        expireReplayEndSummary,
        triggerReplayEndSummary,
        checkPlaybackEndSummary,
        resetPlaybackSummaryTracking,
        resetReplayEndClock
    } = createTimelineApply(h);


    function poll() {
        try {
            pollInner();
        } catch (err) {
            console.error('[replay-live] poll error:', err);
        }
    }

    function pollInner() {
        const now = new Date().toISOString();
        expireReplayEndSummary();
        revealPendingReplaySummary();
        if (isRecordingActive()) {
            resetPlaybackSummaryTracking(true);
            replayAccessTracker.reset();
            replayCacheDiffTracker.reset();
            const dataPath = recordingDataPath();
            const buf = safeReadFile(dataPath);
            const size = buf ? buf.length : 0;
            const parsed = buf && buf.length > 32 ? parseDataReplayBuffer(buf) : null;

            state.status = 'recording';
            state.mode = 'recording';
            state.updatedAt = now;
            state.recordingPath = dataPath;
            state.sourceLabel = path.basename(recordingDir());
            state.dataFileSize = size;
            if (parsed) {
                applyParsedReplay(parsed, {
                    buf,
                    mode: 'recording',
                    clockSec: parsed.battleTimeSec || 0,
                    battleResultsPath: fs.existsSync(recordingBattleResultsPath())
                        ? recordingBattleResultsPath()
                        : ''
                });
            }
            return;
        }

        const playback = resolvePlaybackReplayPath();
        if (playback && playback.path) {
            let playbackPath = playback.path;

            if (shouldHoldPlaybackAfterEnd(playbackPath)) {
                state.status = 'playback';
                state.mode = state.replayEndSummary && state.replayEndSummary.visible
                    ? 'playback_summary'
                    : 'playback_ended';
                state.replayAtEnd = true;
                state.playbackClockRunning = false;
                state.recordingPath = playbackPath;
                state.sourceLabel = path.basename(playbackPath);
                state.playbackLoading = false;
                state.updatedAt = now;
                return;
            }
            if (isFinishedReplayPath(playbackPath) && !shouldAllowReplayRestart(playbackPath)) {
                const signals = resolvePlaybackSignals();
                const nextPick = usesExclusiveExtraReplayDirs()
                    ? resolveExclusiveExtraDirPick(signals)
                    : resolveRecentlyOpenedReplayPath(signals);
                const nextIsDifferent = nextPick && nextPick.path
                    && replayBasenameKey(nextPick.path) !== replayBasenameKey(playbackPath);
                if (nextIsDifferent) {
                    beginFreshExclusiveReplay(nextPick.path, nextPick.reason || 'game_switch');
                    markPlaybackSelection(nextPick.path, nextPick.reason);
                    playbackPath = nextPick.path;
                    playback.reason = nextPick.reason;
                    playback.source = nextPick.source || playback.source;
                    lastResolvedPlaybackPath = nextPick.path;
                } else if (usesExclusiveExtraReplayDirs() && !isZipActiveForPlayback(playbackPath)) {
                    resetExclusiveReplayWatchState();
                    resetPlaybackCaches('replay_ended', {
                        replayPath: playbackPath,
                        purgeDisk: 'all',
                        stopClock: true,
                        resetSession: true,
                        keepSessionPath: '',
                        clearLiveState: true,
                        resetTrackers: true,
                        resetTimeline: true,
                        resetMemory: true
                    });
                    lastResolvedPlaybackPath = '';
                    lastActivePlaybackAt = 0;
                    clearExclusiveIdleSession();
                    state.status = 'idle';
                    state.mode = 'idle';
                    state.replayAtEnd = false;
                    state.recordingPath = '';
                    state.sourceLabel = '';
                    state.playbackTimeline = null;
                    state.teamHp = null;
                    state.players = [];
                    state.playerCount = 0;
                    state.playbackLoading = false;
                    state.updatedAt = now;
                    return;
                } else {
                    if (!playbackFinishedKey) markReplayPlaybackFinished(playbackPath);
                    state.status = 'playback';
                    state.mode = state.replayEndSummary && state.replayEndSummary.visible
                        ? 'playback_summary'
                        : 'playback_ended';
                    state.replayAtEnd = true;
                    state.playbackClockRunning = false;
                    state.recordingPath = playbackPath;
                    state.sourceLabel = path.basename(playbackPath);
                    state.playbackLoading = false;
                    state.updatedAt = now;
                    revealPendingReplaySummary();
                    if (isReplayArchivePath(playbackPath)) {
                        checkPlaybackEndSummary(playbackPath);
                    }
                    return;
                }
            }
            lastActivePlaybackAt = Date.now();
            if (playbackPath !== lastResolvedPlaybackPath) {
                const prev = lastResolvedPlaybackPath;
                const holdPrev = !usesExclusiveExtraReplayDirs()
                    && playbackHoldKey && prev
                    && playbackLoadKey(prev) === playbackHoldKey
                    && summaryHoldActive();
                if (holdPrev) {
                    playbackPath = prev;
                } else if (usesExclusiveExtraReplayDirs() && prev
                    && replayBasenameKey(prev) !== replayBasenameKey(playbackPath)) {
                    beginFreshExclusiveReplay(playbackPath, playback.reason || 'game_switch');
                    lastResolvedPlaybackPath = playbackPath;
                } else {
                    lastResolvedPlaybackPath = playbackPath;
                    if (prev && playbackLoadKey(prev) !== playbackLoadKey(playbackPath)) {
                        clearFinishedReplayMark();
                    }
                    if (prev) {
                        resetPlaybackCaches('replay_switch', {
                            replayPath: prev,
                            purgeDisk: 'all',
                            stopClock: true,
                            resetSession: false,
                            clearLiveState: true
                        });
                        state.playbackTimeline = null;
                        state.teamHp = null;
                        state.players = [];
                        state.playerCount = 0;
                        state.live = state.live || {};
                        state.live.damageDealt = null;
                        state.live.damageSource = null;
                    }
                    resetPlaybackSummaryTracking(true);
                    resetReplayEndClock();
                }
            }
            if (playbackPath !== lastResolvedPlaybackPath) {
                lastResolvedPlaybackPath = playbackPath;
            }
            ensurePlaybackSession(playbackPath);
            const durationHint = state.playbackTimeline && state.playbackTimeline.durationSec
                ? state.playbackTimeline.durationSec
                : Math.max(1, Number(state.battleDurationSec) || 600);
            maybeRestartPlaybackFromGameCache(durationHint);
            maybeStartPlaybackClock(playbackPath, playback.reason || playbackSession.lastDetectReason);
            ensurePlaybackClockRunning(playbackPath, playback.reason || 'playback_poll');
            trackZipLive(playbackPath);
            if (!shouldHoldPlaybackAfterEnd(playbackPath)
                && !isPlaybackPaused(playbackPath)
                && !playbackSession.clockRunning
                && !(isFinishedReplayPath(playbackPath) && !shouldAllowReplayRestart(playbackPath))) {
                clearReplayEndState(true);
                startPlaybackClock(0);
            }
            const loadKey = playbackLoadKey(playbackPath);
            const buf = getPlaybackReplayBuf(playbackPath);
            const parsed = buf && buf.length > 32 ? parseDataReplayBuffer(buf) : null;
            state.status = 'playback';
            state.mode = 'playback';
            state.updatedAt = now;
            state.recordingPath = playbackPath;
            state.sourceLabel = path.basename(playbackPath);
            state.activeReplayPath = playbackPath;
            state.dataFileSize = buf ? buf.length : 0;
            state.playbackSource = playback.source || 'unknown';
            state.playbackLoading = Boolean(
                !parsed
                || (playbackSession.parseInFlight && !state.playerCount && !playbackSession.applyCache)
            );
            if (parsed) {
                const battleResultsPath = isReplayArchivePath(playbackPath)
                    ? playbackPath
                    : '';
                if (loadKey === playbackSession.loadKey && playbackSession.applyCache) {
                    applyPlaybackTimeline(parsed, buf, battleResultsPath, playbackPath);
                } else {
                    if (playbackSession.loadKey !== loadKey) {
                        playbackSession.loadKey = loadKey;
                        playbackSession.applyCache = null;
                        playbackSession.parseGen += 1;
                    }
                    applyPlaybackQuickState(parsed, playbackPath, buf);
                    if (!playbackSession.applyCache && !playbackSession.parseInFlight) {
                        const parseGen = playbackSession.parseGen;
                        playbackSession.parseInFlight = true;
                        setImmediate(() => {
                            if (playbackSession.parseGen !== parseGen || playbackSession.loadKey !== loadKey) {
                                playbackSession.parseInFlight = false;
                                return;
                            }
                            try {
                                applyPlaybackTimeline(parsed, buf, battleResultsPath, playbackPath, { forceFull: true });
                            } catch (err) {
                                console.error('[replay-live] deferred parse error:', err);
                            } finally {
                                if (playbackSession.parseGen === parseGen) {
                                    playbackSession.parseInFlight = false;
                                }
                            }
                        });
                    }
                }
            } else {
                const battleDurationSec = Math.max(DEFAULT_BATTLE_DURATION_SEC, Number(state.battleDurationSec) || 0);
                const replayDataSec = replayDataDurationSec() || Number(state.replayDataDurationSec) || 0;
                const battleStartOffsetSec = Number(playbackSession.battleStartOffsetSec) || FALLBACK_BATTLE_START_OFFSET_SEC;
                const clockSec = getPlaybackClockSec();
                const replayAtEnd = replayDataSec > 0 && clockSec >= replayDataSec - 0.25;
                const battleElapsedSec = replayBattleElapsed(clockSec, battleStartOffsetSec);
                const countdownRemainingSec = Math.max(0, DEFAULT_BATTLE_DURATION_SEC - battleElapsedSec);
                const introPhase = playbackSession.clockRunning && clockSec < battleStartOffsetSec;
                const battleClockRunning = playbackSession.clockRunning && clockSec >= battleStartOffsetSec;

                state.battleDurationSec = battleDurationSec;
                state.replayDataDurationSec = replayDataSec;
                state.replayAtEnd = replayAtEnd;
                state.battleTimeSec = clockSec;
                state.battleTimeLabel = formatCountdown(clockSec, DEFAULT_BATTLE_DURATION_SEC, battleStartOffsetSec);
                state.countdownRemainingSec = countdownRemainingSec;
                state.countdownLabel = playbackSession.clockRunning
                    ? state.battleTimeLabel
                    : formatCountdown(0, DEFAULT_BATTLE_DURATION_SEC, battleStartOffsetSec);
                state.battleStartOffsetSec = battleStartOffsetSec;
                state.movementStartSec = battleStartOffsetSec;
                state.introPhase = introPhase;
                state.battleClockRunning = battleClockRunning;
                state.playbackClockSec = clockSec;
                state.playbackClockRunning = playbackSession.clockRunning && !replayAtEnd;
                state.replayPositionSec = clockSec;
                state.gamePositionSec = playbackSession.gamePositionSec;
                state.gamePositionAt = playbackSession.gamePositionAt;
                state.clockSource = playbackSession.clockSource;
                state.battleAnchored = playbackSession.battleAnchored;
                state.battleElapsedSec = battleElapsedSec;
                state.playbackStartedAt = playbackSession.startedAt;
                state.playbackSpeed = playbackSpeed();
                state.playbackTimeline = null;
                state.playbackLoading = true;
            }
            const startDbg = playbackSession.applyCache && playbackSession.applyCache.timeline
                ? playbackSession.applyCache.timeline.battleStartDebug
                : null;
            const replayDataEntry = playbackPath
                ? (() => {
                    try {
                        const entryMarker = path.join(
                            cacheDir,
                            `${replayArchiveBasename(playbackPath)}.data.replay.entry`
                        );
                        if (fs.existsSync(entryMarker)) {
                            return fs.readFileSync(entryMarker, 'utf8').trim();
                        }
                    } catch (_) { /* noop */ }
                    return detectReplayDataEntryInZip(playbackPath);
                })()
                : null;
            const legacyReplayFormat = replayDataEntry === 'data.wotreplay';
            state.playbackDebug = Object.assign({}, state.playbackDebug, {
                extractOk: Boolean(buf && buf.length > 32),
                extractSize: buf ? buf.length : 0,
                replayDataEntry,
                legacyReplayFormat,
                legacyReplayUnsupported: legacyReplayFormat
                    && (!parsed || !parsed.players || !parsed.players.length),
                hitCount: playbackSession.applyCache && playbackSession.applyCache.timeline
                    ? (playbackSession.applyCache.timeline.hitCount || 0)
                    : 0,
                playbackVisualLagSec: PLAYBACK_VISUAL_LAG_SEC,
                playbackClockSec: state.playbackClockSec,
                playbackClockRunning: state.playbackClockRunning,
                battleDurationSec: state.battleDurationSec,
                battleStartOffsetSec: state.battleStartOffsetSec,
                gamePositionSec: state.gamePositionSec,
                clockSource: playbackSession.clockSource,
                battleAnchored: playbackSession.battleAnchored,
                metaLogPath: metaLogPath(),
                lastMetaInspect: playbackSession.lastMetaInspect,
                battleStartSource: startDbg ? startDbg.source : null,
                movementStartSec: startDbg ? startDbg.movementStart : null,
                countdownStartSec: startDbg ? startDbg.countdownStart : null,
                firstHitClockSec: startDbg ? startDbg.firstHitClock : null,
                hitInferredStartSec: startDbg ? startDbg.hitInferred : null
            });
            if (isReplayArchivePath(playbackPath)) {
                checkPlaybackEndSummary(playbackPath);
            }
            return;
        }

        const exclusiveIdleGrace = usesExclusiveExtraReplayDirs() && state.replayAtEnd ? 0 : PLAYBACK_IDLE_GRACE_MS;
        if (lastActivePlaybackAt > 0
            && (Date.now() - lastActivePlaybackAt) < exclusiveIdleGrace
            && (state.status === 'playback' || state.status === 'processing')) {
            state.updatedAt = now;
            return;
        }

        if (summaryHoldActive() && heldPlaybackPathFromKey()) {
            const heldPath = heldPlaybackPathFromKey();
            state.status = 'playback';
            state.mode = state.replayEndSummary && state.replayEndSummary.visible
                ? 'playback_summary'
                : 'playback_ended';
            state.replayAtEnd = true;
            state.playbackClockRunning = false;
            state.recordingPath = heldPath;
            state.sourceLabel = path.basename(heldPath);
            state.playbackLoading = false;
            state.updatedAt = now;
            revealPendingReplaySummary();
            return;
        }

        const endedPlaybackPath = lastResolvedPlaybackPath || playbackSession.path;
        if (endedPlaybackPath && !playbackEndTriggered) {
            const duration = Math.max(
                replayDataDurationSec(),
                Number(state.replayDataDurationSec) || 0,
                Number(playbackSession.applyCache && playbackSession.applyCache.replayDurationSec) || 0,
                playbackMaxProgressSec
            );
            if (duration >= 25 && (
                playbackMaxProgressSec >= duration * 0.88
                || state.replayAtEnd
            )) {
                playbackEndTriggered = true;
                triggerReplayEndSummary(endedPlaybackPath);
            }
        }

        const keepSummary = state.replayEndSummary
            && (state.replayEndSummary.visible || state.replayEndSummary.pending);

        resetPlaybackCaches('playback_idle', {
            replayPath: endedPlaybackPath || '',
            purgeDisk: keepSummary ? false : 'all',
            stopClock: true,
            resetSession: true,
            keepSessionPath: '',
            clearLiveState: !keepSummary,
            keepReplayAtEnd: Boolean(keepSummary),
            resetTrackers: !keepSummary,
            resetTimeline: !keepSummary,
            resetMemory: !keepSummary
        });
        if (!keepSummary) {
            if (usesExclusiveExtraReplayDirs()) {
                resetExclusiveReplayWatchState();
            }
            clearFinishedReplayMark();
            playbackEndTriggered = false;
            state.replayAtEnd = false;
        }
        lastResolvedPlaybackPath = '';
        lastActivePlaybackAt = 0;
        state.playbackClockRunning = false;
        if (!state.playbackDebug) {
            state.playbackDebug = { reason: 'idle' };
        }

        const latest = findLatestFinishedReplay();
        if (latest && latest !== lastFinishedPath) {
            lastFinishedPath = latest;
            applyFinishedReplay(latest);
        }

        if (state.status === 'recording' || state.status === 'playback') {
            if (!keepSummary) {
                state.status = 'idle';
                state.mode = 'idle';
            } else {
                state.status = 'playback';
                state.mode = state.replayEndSummary && state.replayEndSummary.visible
                    ? 'playback_summary'
                    : 'playback_ended';
            }
            if (!keepSummary) {
                state.recordingPath = '';
                state.sourceLabel = '';
                state.dataFileSize = 0;
                state.battleTimeSec = 0;
                state.battleTimeLabel = '00:00';
                state.battleDurationSec = 0;
                state.playbackClockSec = 0;
                state.playbackStartedAt = 0;
                state.playbackTimeline = null;
                state.players = [];
                state.playerCount = 0;
                state.packetCount = 0;
                state.live.damageDealt = null;
                state.live.damageSource = null;
            }
        } else if (state.status !== 'idle' && !(keepSummary && state.replayEndSummary)) {
            state.status = 'idle';
            state.mode = 'idle';
        }

        state.updatedAt = now;
    }

    function startWatcher() {
        stopWatcher();
        replayCacheDiffTracker.reset();
        replayAccessTracker.reset();
        lastNuclearResetPath = '';
        lastNuclearResetAt = 0;
        lastSeenGameCacheMtimeMs = 0;
        lastGameCacheActivePath = '';
        lastMetaHexByBasename.clear();
        setImmediate(() => poll());
        timer = setInterval(poll, Math.max(250, Number(config.pollIntervalMs) || 400));
        try {
            const dirWatchers = [];
            for (const dir of allReplaySearchDirs()) {
                if (!fs.existsSync(dir)) continue;
                const isExtraDir = normalizeExtraReplaysDirs(config.extraReplaysDirs).some((extraDir) => (
                    normalizedReplayPath(extraDir) === normalizedReplayPath(dir)
                ));
                try {
                    dirWatchers.push(fs.watch(dir, { persistent: false }, () => {
                        if (isExtraDir) scheduleExtraDirReplayPoll();
                        else poll();
                    }));
                } catch (_) { /* noop */ }
            }
            const gameCacheDir = replayCacheDir(resolveGameCacheReplaysDir());
            if (fs.existsSync(gameCacheDir)) {
                dirWatchers.push(fs.watch(gameCacheDir, { persistent: false }, () => poll()));
            }
            if (dirWatchers.length) {
                watcher = {
                    close: () => {
                        dirWatchers.forEach((w) => {
                            try { w.close(); } catch (_) { /* noop */ }
                        });
                    }
                };
            }
        } catch (err) {
            console.warn('[replay-live] fs.watch failed:', err.message);
        }
        console.log('[replay-live] watcher started:', {
            game: config.gameInstallDir || detectGameInstallDir() || '(unknown)',
            gameCache: replayCacheDir(resolveGameCacheReplaysDir()),
            replayDirs: allReplaySearchDirs()
        });
    }

    function stopWatcher() {
        if (timer) clearInterval(timer);
        timer = null;
        if (watcher) {
            try { watcher.close(); } catch (_) { /* noop */ }
            watcher = null;
        }
    }

    function getState() {
        return Object.assign({}, state, {
            moduleVersion: REPLAY_LIVE_MODULE_VERSION,
            config: {
                replaysDir: config.replaysDir,
                gameInstallDir: config.gameInstallDir || detectGameInstallDir() || '',
                gameCacheDir: replayCacheDir(resolveGameCacheReplaysDir()),
                extraReplaysDirs: normalizeExtraReplaysDirs(config.extraReplaysDirs),
                playerName: config.playerName,
                pollIntervalMs: config.pollIntervalMs,
                playbackReplayPath: config.playbackReplayPath || '',
                autoPlaybackMinutes: Number(config.autoPlaybackMinutes) || 0,
                playbackAccessMinutes: Number(config.playbackAccessMinutes) || 10,
                playbackSpeed: playbackSpeed(),
                watchReplayCache: config.watchReplayCache !== false
            }
        });
    }

    const { registerRoutes, registerPages } = createReplayLiveRoutes({
        appRoot: deps.appRoot,
        getState,
        getConfig: () => config,
        saveConfig,
        listReplayZipCandidates,
        activateManualReplayPath,
        normalizedReplayPath,
        resetTrackers: () => {
            replayAccessTracker.reset();
            replayCacheDiffTracker.reset();
            timelineCache.reset();
            replayBufCache.clear();
            battleResultsCtxCache.clear();
        },
        resetPlaybackClock,
        getInternalState: () => state,
        getPlaybackSession: () => playbackSession,
        startWatcher,
        poll
    });

    function init() {
        startWatcher();
    }

    return {
        init,
        registerRoutes,
        registerPages,
        getState,
        stopWatcher
    };
}

module.exports = { createReplayLiveModule };
