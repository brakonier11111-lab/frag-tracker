'use strict';

const fs = require('fs');
const path = require('path');
const { parseDataReplayBuffer, mergePlayerDamage, parseSubtype55VehicleCodes } = require('./replayParser');
const { parseFinishedReplay, readMetaFromZip } = require('./battleResults');
const { parseBattleResultsContext, extractDataReplayFromZip, detectReplayDataEntryInZip, enrichPlayersWithCombatStats } = require('./battleResultsParser');
const { shouldUseBattleResultsStats, isReplayRecordingComplete } = require('./replayCompleteness');
const { createReplayCacheDiffTracker, replayCacheDir, listReplayCacheFiles, parseCacheEntries, getReplayFileActivity, readReplayCacheEntry, readActiveReplayFromCache, parseReplayPositionFromMeta, inspectReplayMeta, diffMetaReplayPosition, resolveReplayFromGameCache, findRecentlyAccessedReplay, replayPathExists, replayBasenameKey, isReplayArchiveName, isReplayArchivePath, replayArchiveBasename } = require('./replayCache');
const { buildReplayEndSummary } = require('./replaySummary');
const { mergeReplayCombatCounters } = require('./combatStatsUtils');
const { createReplayAccessTracker, listReplayZipFiles } = require('./replayAccessTracker');
const {
    createTimelineCache,
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

const STRONG_CACHE_REASONS = new Set([
    'cache_switch',
    'cache_switch_multi',
    'cache_meta',
    'cache_meta_pos',
    'cache_zip_spike',
    'cache_zip_spike_multi',
    'cache_file_touch'
]);
const WEAK_CACHE_REASONS = new Set([
    'cache_boot_active',
    'cache_boot_wait',
    'cache_session',
    'cache_hold',
    'cache_active_read',
    'cache_idle',
    'cache_ambiguous'
]);
const REPLAY_LIVE_MODULE_VERSION = 'timeline-v97-tbreplay-bin';
const GAME_CACHE_INTENT_MS = 15 * 1000;
const ZIP_JUST_OPENED_MS = 45 * 1000;
const ZIP_SWITCH_TOUCH_DELTA_MS = 1500;
const GAME_CACHE_OPEN_MS = 45 * 1000;
const GAME_CACHE_STALE_MS = 3 * 60 * 1000;
const HOT_ZIP_ACCESS_MS = 60 * 1000;
const ZIP_LIVE_MS = 3000;
const ZIP_PAUSE_MS = 90 * 1000;
const ZIP_PAUSE_IGNORE_MS = 60 * 60 * 1000;
const CLOCK_SYNC_DELTA_SEC = 0.35;
const GAME_POS_EXTRAPOLATE_MAX_SEC = 0.2;
const GAME_POS_STALE_MS = 2500;
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
    let lastSpikeHandledKey = '';
    let lastSeenGameCacheMtimeMs = 0;
    let lastGameCacheActivePath = '';
    const lastMetaHexByBasename = new Map();
    const PLAYBACK_IDLE_GRACE_MS = 15_000;
    const STICKY_META_SILENCE_MS = 4 * 60 * 1000;
    const STICKY_SESSION_MAX_MS = 60 * 60 * 1000;
    const REPLAY_SUMMARY_TTL_MS = 3 * 60 * 1000;
    const REPLAY_SUMMARY_DELAY_MS = 10_000;

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

    let extraDirPollTimer = null;

    function scheduleExtraDirReplayPoll() {
        if (extraDirPollTimer) clearTimeout(extraDirPollTimer);
        extraDirPollTimer = setTimeout(() => {
            extraDirPollTimer = null;
            poll();
        }, 150);
    }

    function resolveFreshAccessReplayPick(signals) {
        const spike = signals && signals.access && signals.access.freshSpike;
        if (!spike || !spike.path || !replayPathExists(spike.path)) return null;
        if (isFinishedReplayPath(spike.path) && !shouldAllowReplayRestart(spike.path)) return null;
        return {
            path: spike.path,
            source: 'access_tracker',
            reason: 'access_spike'
        };
    }

    function findNewerExtraDirLiveReplay(currentPath) {
        const pick = findLatestLiveReplayPick();
        if (!pick || !pick.path) return '';
        if (currentPath && normalizedReplayPath(pick.path) === normalizedReplayPath(currentPath)) return '';
        const activity = getReplayFileActivity(pick.path);
        if (activity.ageMs == null || activity.ageMs > HOT_ZIP_ACCESS_MS) return '';
        return pick.path;
    }

    function resolveExtraDirOpenedReplayPick(signals) {
        const accessPath = signals && signals.access && signals.access.replayPath;
        if (accessPath && isPathInExtraReplaysDirs(accessPath) && replayPathExists(accessPath)) {
            const activity = getReplayFileActivity(accessPath);
            if (activity.ageMs != null && activity.ageMs <= playbackAccessWindowMs()) {
                if (!isFinishedReplayPath(accessPath) || shouldAllowReplayRestart(accessPath)) {
                    return {
                        path: accessPath,
                        source: 'access_tracker',
                        reason: signals.access.freshSpike ? 'access_spike' : 'access_live'
                    };
                }
            }
        }

        const pick = findLatestLiveReplayPick();
        if (!pick || !pick.path) return null;
        const current = playbackSession.path || lastResolvedPlaybackPath || '';
        if (current && normalizedReplayPath(current) === normalizedReplayPath(pick.path)) return null;
        if (isFinishedReplayPath(pick.path) && !shouldAllowReplayRestart(pick.path)) return null;
        return pick;
    }

    function pickExtraDirReplayIfNew(extraPick) {
        if (!extraPick || !extraPick.path) return null;
        const current = playbackSession.path || lastResolvedPlaybackPath || '';
        if (current && normalizedReplayPath(current) === normalizedReplayPath(extraPick.path)) {
            return null;
        }
        clearFinishedReplayMark();
        playbackHoldKey = '';
        return returnPlaybackPick(extraPick, { extraDirPriority: true });
    }

    function findLatestLiveReplayPick() {
        const candidates = listReplayZipCandidates({
            minSize: 50000,
            windowMs: playbackAccessWindowMs()
        })
            .filter((item) => isPathInExtraReplaysDirs(item.full))
            .sort((a, b) => (b.lastTouchMs || b.mtime) - (a.lastTouchMs || a.mtime));

        for (const item of candidates) {
            const activity = getReplayFileActivity(item.full);
            if (activity.ageMs != null && activity.ageMs <= HOT_ZIP_ACCESS_MS) {
                return {
                    path: item.full,
                    source: 'extra_dir_live',
                    reason: 'extra_dir_live'
                };
            }
        }

        const recent = candidates[0];
        if (recent) {
            const touchAge = Date.now() - (recent.lastTouchMs || recent.mtime || 0);
            if (touchAge <= playbackAccessWindowMs()) {
                return {
                    path: recent.full,
                    source: 'extra_dir_recent',
                    reason: 'extra_dir_recent'
                };
            }
        }

        return null;
    }

    function readGameCacheBuffer() {
        const cacheFiles = listReplayCacheFiles(resolveGameCacheReplaysDir());
        if (!cacheFiles.length) return null;
        try {
            return {
                buf: fs.readFileSync(cacheFiles[0].full),
                mtimeMs: cacheFiles[0].mtime,
                ageMs: Date.now() - cacheFiles[0].mtime
            };
        } catch (_) {
            return null;
        }
    }

    function readGameCacheEntry(replayPath) {
        return readReplayCacheEntry(resolveGameCacheReplaysDir(), replayPath);
    }

    function canonicalCacheReplayPath(replayPath) {
        if (!replayPath) return '';
        const entry = readGameCacheEntry(replayPath);
        return entry && entry.replayPath ? entry.replayPath : replayPath;
    }

    function metaSessionKeyFromHex(metaHex) {
        if (!metaHex) return 0;
        try {
            const buf = Buffer.from(metaHex, 'hex');
            return buf.length >= 4 ? buf.readUInt32LE(0) : 0;
        } catch (_) {
            return 0;
        }
    }

    function resetExclusiveReplayWatchState() {
        lastMetaHexByBasename.clear();
        clearFinishedReplayMark();
        playbackEndTriggered = false;
        lastSeenGameCacheMtimeMs = 0;
        lastGameCacheActivePath = '';
        playbackHoldKey = '';
        replayCacheDiffTracker.reset();
        replayAccessTracker.reset();
        timelineCache.reset();
        replayBufCache.clear();
        battleResultsCtxCache.clear();
    }

    function beginFreshExclusiveReplay(replayPath, reason) {
        resetExclusiveReplayWatchState();
        hardResetAllReplayState(replayPath, reason || 'game_switch', { force: true });
        saveConfig({ playbackReplayPath: replayPath });
        lastGameCacheActivePath = normalizedReplayPath(replayPath);
    }

    function exclusiveReplaySessionKey(replayPath, metaHex) {
        return `${replayBasenameKey(path.basename(replayPath || ''))}|${metaHex || ''}`;
    }

    function extraDirHasFreshMetaChangeForOther(currentPath, cache) {
        if (!cache || !cache.buf || !currentPath) return false;
        const curBase = replayBasenameKey(path.basename(currentPath));
        return listExtraDirCacheLinkedCandidates(cache.buf).some((row) => (
            row.metaChanged && replayBasenameKey(path.basename(row.path)) !== curBase
        ));
    }

    function findExtraDirReplayByBasenameKey(replayPathOrName) {
        const key = replayBasenameKey(path.basename(replayPathOrName));
        if (!key) return '';
        let best = '';
        let bestAge = Infinity;
        for (const dir of normalizeExtraReplaysDirs(config.extraReplaysDirs)) {
            if (!fs.existsSync(dir)) continue;
            let names;
            try {
                names = fs.readdirSync(dir);
            } catch (_) {
                continue;
            }
            for (const name of names) {
                if (!isReplayArchiveName(name)) continue;
                if (replayBasenameKey(name) !== key) continue;
                const full = path.join(dir, name);
                if (!replayPathExists(full)) continue;
                const act = getReplayFileActivity(full);
                const age = act.ageMs != null ? act.ageMs : Infinity;
                if (!best || age < bestAge) {
                    best = full;
                    bestAge = age;
                }
            }
        }
        return best;
    }

    function mapGameCachePathToExtraDir(replayPath) {
        if (!replayPath) return '';
        if (isPathInExtraReplaysDirs(replayPath) && replayPathExists(replayPath)) {
            return replayPath;
        }
        const base = path.basename(replayPath);
        for (const dir of normalizeExtraReplaysDirs(config.extraReplaysDirs)) {
            const candidate = path.join(dir, base);
            if (replayPathExists(candidate)) return candidate;
        }
        return findExtraDirReplayByBasenameKey(replayPath);
    }

    function listExtraDirCacheLinkedCandidates(cacheBuf) {
        const entries = parseCacheEntries(cacheBuf)
            .filter((row) => replayPathExists(row.replayPath));
        const byBase = new Map();
        for (const row of entries) {
            const base = replayBasenameKey(path.basename(row.replayPath));
            if (!base) continue;
            const prev = byBase.get(base);
            if (!prev || row.metaTs > prev.metaTs) {
                byBase.set(base, row);
            }
        }

        const candidates = [];
        for (const dir of normalizeExtraReplaysDirs(config.extraReplaysDirs)) {
            if (!fs.existsSync(dir)) continue;
            let names;
            try {
                names = fs.readdirSync(dir);
            } catch (_) {
                continue;
            }
            for (const name of names) {
                if (!isReplayArchiveName(name)) continue;
                const baseKey = replayBasenameKey(name);
                const row = byBase.get(baseKey);
                if (!row) continue;
                const extraPath = path.join(dir, name);
                if (!replayPathExists(extraPath)) continue;

                const extraAct = getReplayFileActivity(extraPath);
                const docAct = getReplayFileActivity(row.replayPath);
                const freshnessMs = Math.min(
                    extraAct.ageMs != null ? extraAct.ageMs : Infinity,
                    docAct.ageMs != null ? docAct.ageMs : Infinity
                );
                const prevHex = lastMetaHexByBasename.get(baseKey);
                const metaChanged = prevHex != null && prevHex !== row.metaHex;
                lastMetaHexByBasename.set(baseKey, row.metaHex);

                candidates.push({
                    path: extraPath,
                    metaHex: row.metaHex,
                    metaTs: row.metaTs,
                    freshnessMs,
                    lastTouchMs: Math.max(extraAct.lastTouchMs || 0, docAct.lastTouchMs || 0),
                    metaChanged
                });
            }
        }
        return candidates;
    }

    function pickFreshestTouchedExtraDirZip(maxAgeMs) {
        const limit = maxAgeMs != null ? maxAgeMs : ZIP_JUST_OPENED_MS;
        let best = null;
        for (const dir of normalizeExtraReplaysDirs(config.extraReplaysDirs)) {
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
                if (!replayPathExists(full)) continue;
                const act = getReplayFileActivity(full);
                if (!act.exists || act.ageMs == null || act.ageMs > limit) continue;
                if (!best
                    || act.ageMs < best.ageMs
                    || (act.ageMs === best.ageMs && (act.lastTouchMs || 0) > (best.lastTouchMs || 0))) {
                    const entry = readGameCacheEntry(full);
                    best = {
                        path: full,
                        metaHex: entry ? entry.metaHex : '',
                        ageMs: act.ageMs,
                        lastTouchMs: act.lastTouchMs || 0
                    };
                }
            }
        }
        return best;
    }

    function currentExclusivePlaybackPath() {
        return playbackSession.path || lastResolvedPlaybackPath || '';
    }

    function clearExclusiveIdleSession() {
        playbackSession = defaultPlaybackSessionFields('');
        lastResolvedPlaybackPath = '';
        lastActivePlaybackAt = 0;
        lastMetaHexByBasename.clear();
        if ((config.playbackReplayPath || '').trim()) {
            saveConfig({ playbackReplayPath: '' });
        }
    }

    function collectGameIntentExtraDirBasenames(cache, signals) {
        const keys = new Set();
        const cacheSig = signals && signals.cache;
        if (cacheSig && cacheSig.replayPath && !WEAK_CACHE_REASONS.has(cacheSig.reason)) {
            const extra = mapGameCachePathToExtraDir(cacheSig.replayPath);
            if (extra && isPathInExtraReplaysDirs(extra)) {
                keys.add(replayBasenameKey(path.basename(extra)));
            }
        }
        if (cache && cache.buf) {
            const cacheFresh = cache.ageMs != null && cache.ageMs <= GAME_CACHE_INTENT_MS;
            for (const row of listExtraDirCacheLinkedCandidates(cache.buf)) {
                const bk = replayBasenameKey(path.basename(row.path));
                if (row.metaChanged) {
                    keys.add(bk);
                    continue;
                }
                if (cacheFresh && row.freshnessMs <= 15000) {
                    keys.add(bk);
                }
            }
        }
        return keys;
    }

    function pickJustOpenedExtraDirZipNotCurrent(currentPath) {
        if (!currentPath) return null;
        const currentKey = replayBasenameKey(path.basename(currentPath));
        const currentAct = getReplayFileActivity(currentPath);
        const currentTouch = currentAct.lastTouchMs || 0;
        const scanned = scanLiveExtraDirZips({
            excludeBasenameKeys: new Set([currentKey])
        });
        let best = null;
        for (const row of scanned.hotZips) {
            const act = getReplayFileActivity(row.path);
            if (!act.exists || act.ageMs == null || act.ageMs > ZIP_JUST_OPENED_MS) continue;
            if (currentTouch && row.touch - currentTouch < ZIP_SWITCH_TOUCH_DELTA_MS) continue;
            if (!best || row.touch > best.touch) {
                const entry = readGameCacheEntry(row.path);
                best = {
                    path: row.path,
                    metaHex: entry ? entry.metaHex : '',
                    touch: row.touch
                };
            }
        }
        return best;
    }

    function scanLiveExtraDirZips(options) {
        options = options || {};
        const allowedKeys = options.allowedBasenameKeys || null;
        const excludeKeys = options.excludeBasenameKeys || null;
        const hotZips = [];
        let best = null;

        for (const dir of normalizeExtraReplaysDirs(config.extraReplaysDirs)) {
            if (!fs.existsSync(dir)) continue;
            let names;
            try {
                names = fs.readdirSync(dir);
            } catch (_) {
                continue;
            }
            for (const name of names) {
                if (!isReplayArchiveName(name)) continue;
                const baseKey = replayBasenameKey(name);
                if (allowedKeys && !allowedKeys.has(baseKey)) continue;
                if (excludeKeys && excludeKeys.has(baseKey)) continue;
                const full = path.join(dir, name);
                if (!replayPathExists(full)) continue;
                const act = getReplayFileActivity(full);
                if (!act.exists || act.ageMs == null || act.ageMs > HOT_ZIP_ACCESS_MS) continue;
                const touch = act.lastTouchMs || 0;
                hotZips.push({ path: full, touch, baseKey });
                if (!best || touch > best.touch) {
                    const entry = readGameCacheEntry(full);
                    best = {
                        path: full,
                        metaHex: entry ? entry.metaHex : '',
                        touch,
                        baseKey
                    };
                }
            }
        }

        return { best, hotZips };
    }

    function pickLiveExtraDirZipDirect(cache, signals) {
        const intentKeys = collectGameIntentExtraDirBasenames(cache, signals);
        if (intentKeys.size) {
            const scoped = scanLiveExtraDirZips({ allowedBasenameKeys: intentKeys });
            if (scoped.best) return scoped.best;
        }

        const all = scanLiveExtraDirZips();
        if (all.hotZips.length === 1) return all.best;
        return null;
    }

    function shouldSwitchExclusiveExtraDirReplay(fromPath, toPath) {
        if (!fromPath || !toPath) return Boolean(toPath);
        if (normalizedReplayPath(fromPath) === normalizedReplayPath(toPath)) return false;
        const fromAct = getReplayFileActivity(fromPath);
        const toAct = getReplayFileActivity(toPath);
        if (!toAct.exists || toAct.ageMs == null || toAct.ageMs > ZIP_JUST_OPENED_MS) return false;
        const fromTouch = fromAct.lastTouchMs || 0;
        const toTouch = toAct.lastTouchMs || 0;
        if (fromTouch && toTouch - fromTouch < ZIP_SWITCH_TOUCH_DELTA_MS) return false;
        return true;
    }

    function pickLiveExtraDirReplayFromCache(cacheBuf, cache, signals) {
        if (!cacheBuf) return null;
        const current = currentExclusivePlaybackPath();
        const intentKeys = collectGameIntentExtraDirBasenames(cache, signals);
        const entries = parseCacheEntries(cacheBuf)
            .filter((row) => replayPathExists(row.replayPath));
        let best = null;
        for (const row of entries) {
            const extraPath = mapGameCachePathToExtraDir(row.replayPath);
            if (!extraPath || !isPathInExtraReplaysDirs(extraPath)) continue;
            const act = getReplayFileActivity(extraPath);
            if (!act.exists || act.ageMs == null || act.ageMs > HOT_ZIP_ACCESS_MS) continue;
            const baseKey = replayBasenameKey(path.basename(extraPath));
            if (current && !intentKeys.has(baseKey) && !shouldSwitchExclusiveExtraDirReplay(current, extraPath)) {
                continue;
            }
            const touch = act.lastTouchMs || 0;
            if (!best || touch > best.touch) {
                best = {
                    path: extraPath,
                    metaHex: row.metaHex,
                    touch
                };
            }
        }
        return best;
    }

    function pickMetaChangedExtraDirReplay(cache) {
        if (!cache || !cache.buf) return null;
        const currentPath = currentExclusivePlaybackPath();
        const currentKey = replayBasenameKey(path.basename(currentPath));
        const cacheFresh = cache.ageMs != null && cache.ageMs <= 15000;
        const candidates = listExtraDirCacheLinkedCandidates(cache.buf)
            .filter((row) => {
                const bk = replayBasenameKey(path.basename(row.path));
                if (row.metaChanged) return true;
                if (!currentPath) return false;
                if (cacheFresh && row.freshnessMs <= 15000 && bk !== currentKey) return true;
                return false;
            });
        if (!candidates.length) return null;

        let best = null;
        for (const row of candidates) {
            if (isFinishedReplayPath(row.path) && !shouldAllowReplayRestart(row.path)) continue;
            const tier = row.metaChanged ? 0 : 1;
            if (!best
                || tier < best.tier
                || (tier === best.tier && row.freshnessMs < best.freshnessMs)
                || (tier === best.tier
                    && row.freshnessMs === best.freshnessMs
                    && row.lastTouchMs > best.lastTouchMs)) {
                best = {
                    path: row.path,
                    metaHex: row.metaHex,
                    tier,
                    freshnessMs: row.freshnessMs,
                    lastTouchMs: row.lastTouchMs
                };
            }
        }
        if (!best) return null;
        return {
            path: best.path,
            metaHex: best.metaHex,
            reason: 'meta_changed',
            source: 'game_cache'
        };
    }

    function pickCacheDiffExtraDirReplay(signals, cache) {
        const cacheSig = signals && signals.cache;
        if (!cacheSig || !cacheSig.replayPath) return null;
        if (WEAK_CACHE_REASONS.has(cacheSig.reason)) return null;

        const extraPath = mapGameCachePathToExtraDir(cacheSig.replayPath);
        if (!extraPath || !replayPathExists(extraPath) || !isPathInExtraReplaysDirs(extraPath)) return null;
        if (isFinishedReplayPath(extraPath) && !shouldAllowReplayRestart(extraPath)) return null;

        const zipLive = isZipActiveForPlayback(extraPath);
        const switchReason = cacheSig.reason === 'cache_switch' || cacheSig.reason === 'cache_switch_multi';
        const cacheFresh = cache && cache.ageMs != null && cache.ageMs <= 15000;

        if (!zipLive && !(switchReason && cacheFresh)) return null;

        const entry = readGameCacheEntry(cacheSig.replayPath);
        return {
            path: extraPath,
            metaHex: entry ? entry.metaHex : '',
            reason: cacheSig.reason,
            source: 'game_cache'
        };
    }

    function resolveExclusiveExtraDirPick(signals) {
        const cache = readGameCacheBuffer();
        const cacheSig = signals && signals.cache;

        function pack(pick) {
            return Object.assign({}, pick, {
                cacheMtimeMs: cache ? cache.mtimeMs : 0
            });
        }

        const current = currentExclusivePlaybackPath();
        if (!current) {
            const freshZip = pickFreshestTouchedExtraDirZip();
            if (freshZip) {
                return pack({
                    path: freshZip.path,
                    metaHex: freshZip.metaHex,
                    reason: 'zip_open',
                    source: 'extra_dir'
                });
            }
        }

        if (cache && cache.buf) {
            const metaPick = pickMetaChangedExtraDirReplay(cache);
            if (metaPick) {
                return pack(metaPick);
            }
        }

        const cacheDiffPick = pickCacheDiffExtraDirReplay(signals, cache);
        if (cacheDiffPick) {
            return pack(cacheDiffPick);
        }

        const justOpened = pickJustOpenedExtraDirZipNotCurrent(current);
        if (justOpened) {
            return pack({
                path: justOpened.path,
                metaHex: justOpened.metaHex,
                reason: 'zip_open',
                source: 'extra_dir'
            });
        }

        const directPick = pickLiveExtraDirZipDirect(cache, signals);
        if (directPick) {
            if (!current
                || replayBasenameKey(directPick.path) !== replayBasenameKey(current)) {
                return pack({
                    path: directPick.path,
                    metaHex: directPick.metaHex,
                    reason: 'zip_live',
                    source: 'extra_dir'
                });
            }
        }

        if (cache && cache.buf) {
            const livePick = pickLiveExtraDirReplayFromCache(cache.buf, cache, signals);
            if (livePick) {
                if (!current
                    || replayBasenameKey(livePick.path) !== replayBasenameKey(current)) {
                    return pack({
                        path: livePick.path,
                        metaHex: livePick.metaHex,
                        reason: 'zip_live',
                        source: 'game_cache'
                    });
                }
            }
        }

        const spikePick = pickAccessSpikeExtraReplay(signals, cache);
        if (spikePick) {
            return pack({
                path: spikePick.path,
                metaHex: spikePick.metaHex,
                reason: spikePick.reason || 'access_spike',
                source: 'access_spike'
            });
        }

        if (cacheSig && cacheSig.replayPath) {
            const extraPath = mapGameCachePathToExtraDir(cacheSig.replayPath);
            if (extraPath && replayPathExists(extraPath) && isZipActiveForPlayback(extraPath)) {
                const entry = readGameCacheEntry(cacheSig.replayPath);
                return pack({
                    path: extraPath,
                    metaHex: entry ? entry.metaHex : '',
                    reason: cacheSig.reason || 'cache_active',
                    source: 'game_cache'
                });
            }
        }

        const manualReasons = new Set(['manual_play', 'manual_path', 'config_manual_path']);
        const manualPath = (config.playbackReplayPath || '').trim();
        if (manualPath
            && replayPathExists(manualPath)
            && isPathInExtraReplaysDirs(manualPath)
            && manualReasons.has(playbackSession.lastDetectReason)) {
            return {
                path: manualPath,
                source: 'manual',
                reason: playbackSession.lastDetectReason,
                cacheMtimeMs: cache ? cache.mtimeMs : 0
            };
        }

        const held = tryContinueExclusiveExtraPlayback();
        if (held) {
            return pack(held);
        }

        return null;
    }

    function tryContinueExclusiveExtraPlayback() {
        const current = playbackSession.path || lastResolvedPlaybackPath || '';
        if (!current || !replayPathExists(current) || !isPathInExtraReplaysDirs(current)) return null;
        if (shouldHoldPlaybackAfterEnd(current)) return null;
        if (isFinishedReplayPath(current) && !shouldAllowReplayRestart(current)) return null;

        const cache = readGameCacheBuffer();
        if (extraDirHasFreshMetaChangeForOther(current, cache)) return null;

        const signals = resolvePlaybackSignals();
        const cacheDiffPick = pickCacheDiffExtraDirReplay(signals, cache);
        if (cacheDiffPick
            && replayBasenameKey(cacheDiffPick.path) !== replayBasenameKey(current)) {
            return null;
        }

        if (cache && cache.buf) {
            const metaPick = pickMetaChangedExtraDirReplay(cache);
            if (metaPick
                && replayBasenameKey(metaPick.path) !== replayBasenameKey(current)) {
                return null;
            }
        }

        const intentKeys = collectGameIntentExtraDirBasenames(cache, signals);
        if (intentKeys.size) {
            const curKey = replayBasenameKey(path.basename(current));
            for (const key of intentKeys) {
                if (key !== curKey) return null;
            }
        }

        const justOpened = pickJustOpenedExtraDirZipNotCurrent(current);
        if (justOpened) return null;

        const otherLive = pickLiveExtraDirZipDirect(cache, signals);
        if (otherLive
            && replayBasenameKey(otherLive.path) !== replayBasenameKey(current)) {
            return null;
        }

        const selectedAt = playbackSession.replaySelectedAt || lastActivePlaybackAt || 0;
        if (!selectedAt) return null;

        const replayDurSec = Math.max(
            replayDataDurationSec(),
            Number(state.replayDataDurationSec) || 0,
            Number(playbackSession.applyCache && playbackSession.applyCache.replayDurationSec) || 0
        );
        const clockSec = playbackSession.clockRunning
            ? getPlaybackClockSec()
            : (playbackSession.lastKnownClockSec || 0);

        if (state.replayAtEnd) return null;
        if (replayDurSec > 0 && clockSec >= replayDurSec - 0.5) return null;

        const sessionAgeMs = Date.now() - selectedAt;
        const maxSessionMs = replayDurSec > 0
            ? replayDurSec * 1000 + 180_000
            : STICKY_SESSION_MAX_MS;
        if (sessionAgeMs > maxSessionMs) return null;

        const entry = readGameCacheEntry(current);
        return {
            path: current,
            metaHex: entry ? entry.metaHex : (playbackSession.lastMetaHex || ''),
            reason: 'session_continue',
            source: 'session_hold'
        };
    }

    function pickAccessSpikeExtraReplay(signals, cache) {
        const spike = signals && signals.access && signals.access.freshSpike;
        if (!spike || !spike.path || !isPathInExtraReplaysDirs(spike.path)) return null;
        if (!replayPathExists(spike.path)) return null;

        const activity = getReplayFileActivity(spike.path);
        if (activity.ageMs == null || activity.ageMs > HOT_ZIP_ACCESS_MS * 3) return null;

        const current = playbackSession.path || lastResolvedPlaybackPath || '';
        if (current && normalizedReplayPath(current) === normalizedReplayPath(spike.path)) {
            return null;
        }

        if (!cache || !cache.buf) return null;

        const base = replayBasenameKey(path.basename(spike.path));
        const row = parseCacheEntries(cache.buf).find((entry) => (
            replayBasenameKey(path.basename(entry.replayPath)) === base
        ));
        if (!row) return null;

        const prevHex = lastMetaHexByBasename.get(base);
        const metaChanged = prevHex != null && prevHex !== row.metaHex;
        if (!metaChanged) return null;

        return {
            path: spike.path,
            metaHex: row.metaHex,
            cacheMtimeMs: cache.mtimeMs,
            reason: 'access_spike'
        };
    }

    function resolveActiveExtraDirReplayFromCache(signals) {
        const direct = pickLiveExtraDirZipDirect(readGameCacheBuffer(), signals);
        if (direct) {
            return {
                path: direct.path,
                metaHex: direct.metaHex,
                cacheMtimeMs: 0
            };
        }

        const cache = readGameCacheBuffer();
        const cacheDiffPick = pickCacheDiffExtraDirReplay(signals, cache);
        if (cacheDiffPick) {
            return {
                path: cacheDiffPick.path,
                metaHex: cacheDiffPick.metaHex,
                cacheMtimeMs: cache ? cache.mtimeMs : 0
            };
        }

        if (cache && cache.buf) {
            const metaPick = pickMetaChangedExtraDirReplay(cache);
            if (metaPick) {
                return {
                    path: metaPick.path,
                    metaHex: metaPick.metaHex,
                    cacheMtimeMs: cache.mtimeMs
                };
            }
        }

        if (cache && cache.buf) {
            const livePick = pickLiveExtraDirReplayFromCache(cache.buf, cache, signals);
            if (livePick) {
                return {
                    path: livePick.path,
                    metaHex: livePick.metaHex,
                    cacheMtimeMs: cache.mtimeMs
                };
            }
        }

        return null;
    }

    function resolveGameOpenedExtraDirReplay(signals) {
        if (!usesExclusiveExtraReplayDirs()) return null;

        const active = resolveActiveExtraDirReplayFromCache(signals);
        if (active && active.path) {
            const spikePick = pickAccessSpikeExtraReplay(signals, readGameCacheBuffer());
            const reason = spikePick && normalizedReplayPath(spikePick.path) === normalizedReplayPath(active.path)
                ? 'access_spike'
                : 'game_active';
            return {
                path: active.path,
                source: reason === 'access_spike' ? 'access_spike' : 'game_cache',
                reason,
                metaHex: active.metaHex,
                cacheMtimeMs: active.cacheMtimeMs
            };
        }

        return null;
    }

    function resolveRecentlyOpenedReplayPath(signals) {
        if (!usesExclusiveExtraReplayDirs()) return null;

        const gamePick = resolveGameOpenedExtraDirReplay(signals);
        if (gamePick) return gamePick;

        const manualReasons = new Set(['manual_play', 'manual_path', 'config_manual_path']);
        const manualPath = playbackSession.path || (config.playbackReplayPath || '').trim();
        if (manualPath
            && replayPathExists(manualPath)
            && isPathInExtraReplaysDirs(manualPath)
            && manualReasons.has(playbackSession.lastDetectReason)) {
            return {
                path: manualPath,
                source: 'manual',
                reason: playbackSession.lastDetectReason
            };
        }

        return null;
    }

    function tryHoldCurrentExtraDirSession(gameActivePath) {
        const current = playbackSession.path || lastResolvedPlaybackPath || '';
        if (!current || !replayPathExists(current) || !isPathInExtraReplaysDirs(current)) return null;
        if (shouldHoldPlaybackAfterEnd(current)) return null;

        const cache = readGameCacheBuffer();
        if (extraDirHasFreshMetaChangeForOther(current, cache)) return null;

        if (gameActivePath
            && normalizedReplayPath(gameActivePath) !== normalizedReplayPath(current)) {
            return null;
        }

        if (isFinishedReplayPath(current) && !shouldAllowReplayRestart(current)) return null;

        const manualReasons = new Set(['manual_play', 'manual_path', 'config_manual_path']);
        if (manualReasons.has(playbackSession.lastDetectReason)) {
            return {
                path: current,
                source: 'session_hold',
                reason: 'manual_hold'
            };
        }

        if (gameActivePath && normalizedReplayPath(gameActivePath) === normalizedReplayPath(current)) {
            return {
                path: current,
                source: 'session_hold',
                reason: 'game_playing'
            };
        }

        const selectedAt = playbackSession.replaySelectedAt || lastActivePlaybackAt || 0;
        if (!selectedAt) return null;

        if (playbackSession.clockRunning) {
            return {
                path: current,
                source: 'session_hold',
                reason: 'session_hold'
            };
        }

        return null;
    }

    function readCacheLiveActivePath() {
        const cacheFiles = listReplayCacheFiles(resolveGameCacheReplaysDir());
        if (!cacheFiles.length) return null;
        try {
            const cacheStat = fs.statSync(cacheFiles[0].full);
            if (Date.now() - cacheStat.mtimeMs > 3 * 60 * 1000) return null;
            const activePath = readActiveReplayFromCache(fs.readFileSync(cacheFiles[0].full));
            if (activePath && replayPathExists(activePath) && isZipActiveForPlayback(activePath)) {
                return activePath;
            }
        } catch (_) { /* noop */ }
        return null;
    }

    function pickReplayFromSignals(signals) {
        if (playbackHoldKey && summaryHoldActive()) return null;

        const { access, cache } = signals;
        const accessPick = pickAccessReplayPath(access);

        if (accessPick) {
            const cachePath = cache && cache.replayPath ? cache.replayPath : '';
            const sameAsCache = cachePath
                && normalizedReplayPath(cachePath) === normalizedReplayPath(accessPick.path);
            const cacheWantsSwitch = cache && cache.isActive && cachePath && !sameAsCache
                && replayPathExists(cachePath)
                && STRONG_CACHE_REASONS.has(cache.reason)
                && isZipActiveForPlayback(cachePath);

            if (!cacheWantsSwitch
                || access.freshSpike
                || isPathInExtraReplaysDirs(accessPick.path)
                || !isPathInPrimaryReplaysDir(accessPick.path)) {
                return guardReplayPick(accessPick, signals);
            }
        }

        if (cache.isActive && cache.replayPath && replayPathExists(cache.replayPath)) {
            if (!isFinishedReplayPath(cache.replayPath)
                || shouldAllowReplayRestart(cache.replayPath)) {
                if (STRONG_CACHE_REASONS.has(cache.reason) || isZipActiveForPlayback(cache.replayPath)) {
                    return guardReplayPick({
                        path: cache.replayPath,
                        source: 'cache_diff',
                        reason: cache.reason
                    }, signals);
                }
            }
        }

        const cacheLive = readCacheLiveActivePath();
        if (cacheLive && (!isFinishedReplayPath(cacheLive) || shouldAllowReplayRestart(cacheLive))) {
            return guardReplayPick({
                path: cacheLive,
                source: 'cache_diff',
                reason: 'cache_active_live'
            }, signals);
        }

        const sole = findSoleZipLiveReplayPath();
        if (sole && (!isFinishedReplayPath(sole) || shouldAllowReplayRestart(sole))) {
            return guardReplayPick({
                path: sole,
                source: 'zip_scan',
                reason: 'sole_zip_live'
            }, signals);
        }

        return null;
    }

    function returnPlaybackPick(pick, debugExtra) {
        markPlaybackSelection(pick.path, pick.reason);
        state.playbackDebug = Object.assign({}, state.playbackDebug || {}, {
            reason: 'active',
            detectSource: pick.source,
            trackerReason: pick.reason,
            activeReplay: path.basename(pick.path),
            replayPath: path.basename(pick.path)
        }, debugExtra || {});
        return {
            path: pick.path,
            source: pick.source,
            reason: pick.reason
        };
    }

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
        const atReplayEnd = replayDurationSec > 0 && clockSec >= replayDurationSec - 0.25;
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

    function computeClockRaw(maxSec) {
        const elapsed = ((Date.now() - playbackSession.startedAt) / 1000) * playbackSpeed() - playbackLoadDelaySec();
        const clock = playbackSession.clockOffsetSec + elapsed;
        const cap = maxSec > 0 ? maxSec : clock;
        return Math.max(0, Math.min(clock, cap));
    }

    function isZipLive(replayPath) {
        if (!replayPath) return false;
        const activity = getReplayFileActivity(replayPath);
        return Boolean(activity.exists && activity.ageMs != null && activity.ageMs <= ZIP_LIVE_MS);
    }

    function isZipActiveForPlayback(replayPath) {
        if (!replayPath) return false;
        const activity = getReplayFileActivity(replayPath);
        return Boolean(activity.exists && activity.ageMs != null && activity.ageMs <= HOT_ZIP_ACCESS_MS);
    }

    function trackZipLive(replayPath) {
        if (!replayPath) {
            playbackSession.zipLiveSince = 0;
            return false;
        }
        if (isPlaybackPaused(replayPath)) {
            playbackSession.zipLiveSince = 0;
            return false;
        }
        if (!playbackSession.zipLiveSince) {
            playbackSession.zipLiveSince = Date.now();
        }
        return true;
    }

    function resolveZipWallClockSec(maxDur) {
        if (!playbackSession.zipLiveSince) {
            playbackSession.zipLiveSince = Date.now();
        }
        const elapsed = ((Date.now() - playbackSession.zipLiveSince) / 1000) * playbackSpeed() - playbackLoadDelaySec();
        return Math.max(0, Math.min(elapsed, maxDur));
    }

    function replayDataDurationSec() {
        const cached = playbackSession.applyCache;
        if (cached && cached.replayDurationSec > 0) return cached.replayDurationSec;
        if (state.playbackTimeline && state.playbackTimeline.replayDataDurationSec > 0) {
            return state.playbackTimeline.replayDataDurationSec;
        }
        return Number(state.replayDataDurationSec) || 0;
    }

    function playbackClockMaxSec() {
        const dataEnd = replayDataDurationSec();
        if (dataEnd > 0) return dataEnd;
        return Math.max(Number(state.battleDurationSec) || 0, DEFAULT_BATTLE_DURATION_SEC);
    }

    function clearReplayEndState(resetClock) {
        playbackSession.frozenClockSec = null;
        playbackSession.zipPausedAt = 0;
        if (playbackSession.clockSource === 'replay_end') {
            playbackSession.clockSource = 'idle';
        }
        if (resetClock && !playbackSession.clockRunning) {
            playbackSession.lastKnownClockSec = 0;
            playbackSession.clockOffsetSec = 0;
        }
        state.replayAtEnd = false;
    }

    function stopClockAtReplayEnd(clockSec) {
        if (!playbackSession.clockRunning) return false;
        const dataEnd = replayDataDurationSec();
        if (dataEnd <= 0 || clockSec < dataEnd - 0.25) return false;
        playbackSession.clockRunning = false;
        playbackSession.clockSource = 'replay_end';
        playbackSession.lastKnownClockSec = dataEnd;
        playbackSession.frozenClockSec = dataEnd;
        state.replayAtEnd = true;
        playbackMaxProgressSec = Math.max(playbackMaxProgressSec, dataEnd);
        markReplayPlaybackFinished(playbackSession.path);
        if (!playbackEndTriggered && playbackSession.path) {
            playbackEndTriggered = true;
            triggerReplayEndSummary(playbackSession.path);
        }
        return true;
    }

    function readGameCacheSnapshot(replayPath, replayDurationSec) {
        const cacheEntry = readGameCacheEntry(replayPath);
        if (!cacheEntry) return null;
        unlockCachePositionIfMetaLive(cacheEntry);
        const maxDur = Math.max(
            replayDurationSec > 0 ? replayDurationSec : 0,
            replayDataDurationSec()
        ) || playbackClockMaxSec() || 600;
        const inspect = inspectReplayMeta(cacheEntry.metaBuf, maxDur);
        let gamePos = inspect ? inspect.parsedPosition : null;
        if (gamePos == null && playbackSession.lastMetaHex && !playbackSession.cachePositionLocked) {
            gamePos = diffMetaReplayPosition(playbackSession.lastMetaHex, cacheEntry.metaHex, maxDur);
        }
        if (playbackSession.cachePositionLocked) {
            gamePos = null;
        } else if (shouldIgnoreStaleCachePosition(gamePos, maxDur)) {
            gamePos = null;
        }
        return { cacheEntry, inspect, gamePos, maxDur };
    }

    function readGameCachePosition(replayPath, replayDurationSec) {
        const snap = readGameCacheSnapshot(replayPath, replayDurationSec);
        return snap ? snap.gamePos : null;
    }

    function applyVisualLag(clockSec, maxDur) {
        if (PLAYBACK_VISUAL_LAG_SEC <= 0 || isPlaybackPaused(playbackSession.path)) {
            return clockSec;
        }
        const src = playbackSession.clockSource;
        if (src === 'game_cache' || src === 'game_cache_frozen'
            || src === 'zip_wall_sync' || src === 'wall_fallback') {
            return Math.max(0, Math.min(clockSec - PLAYBACK_VISUAL_LAG_SEC, maxDur));
        }
        return clockSec;
    }

    function extrapolateGamePosition(replayDurationSec) {
        if (playbackSession.gamePositionSec == null || !playbackSession.gamePositionAt) return null;
        const maxDur = replayDurationSec > 0 ? replayDurationSec : 600;
        const base = playbackSession.gamePositionSec;
        const ageMs = Date.now() - playbackSession.gamePositionAt;
        if (isPlaybackPaused(playbackSession.path)) {
            return Math.max(0, Math.min(base, maxDur));
        }
        if (ageMs > GAME_POS_STALE_MS) {
            return Math.max(0, Math.min(base, maxDur));
        }
        const ageSec = ageMs / 1000;
        const extra = Math.min(GAME_POS_EXTRAPOLATE_MAX_SEC, ageSec * playbackSpeed());
        return Math.max(0, Math.min(base + extra, maxDur));
    }

    function noteBattleAnchor(gamePos) {
        const offset = Number(playbackSession.battleStartOffsetSec) || 0;
        if (offset > 0 && gamePos != null && gamePos >= offset - 0.05) {
            playbackSession.battleAnchored = true;
        }
    }

    function applyGamePosition(gamePos, replayDurationSec, reason) {
        if (gamePos == null) return false;
        const maxDur = replayDurationSec > 0 ? replayDurationSec : 600;
        const pos = Math.max(0, Math.min(Number(gamePos) || 0, maxDur));
        if (pos < 1 && (playbackSession.clockSource === 'replay_end' || state.replayAtEnd)) {
            if (shouldHoldPlaybackAfterEnd(playbackSession.path)) return true;
            if (isFinishedReplayPath(playbackSession.path)
                && !shouldAllowReplayRestart(playbackSession.path)) {
                return true;
            }
            clearReplayEndState(true);
        }
        const prev = playbackSession.gamePositionSec;
        playbackSession.gamePositionSec = pos;
        playbackSession.gamePositionAt = Date.now();
        playbackSession.lastKnownClockSec = pos;
        playbackSession.clockSource = 'game_cache';
        noteBattleAnchor(pos);

        const jumped = prev != null && Math.abs(pos - prev) > CLOCK_SYNC_DELTA_SEC;
        if (jumped || prev == null) {
            playbackSession.clockOffsetSec = pos;
            playbackSession.startedAt = Date.now();
            playbackSession.rewindAt = Date.now();
            playbackSession.frozenClockSec = null;
            playbackSession.zipPausedAt = 0;
            playbackSession.zipLiveSince = 0;
        }

        if (!playbackSession.clockRunning && isZipActiveForPlayback(playbackSession.path)) {
            playbackSession.clockRunning = true;
            if (state.playbackDebug) {
                state.playbackDebug.clockStartReason = reason || 'game_cache_pos';
                state.playbackDebug.clockStartPos = pos;
            }
        }
        return true;
    }

    function resolvePlaybackClockSec() {
        const maxDur = playbackClockMaxSec();
        const gameClock = extrapolateGamePosition(maxDur);
        if (gameClock != null) {
            playbackSession.clockSource = 'game_cache';
            const lagged = applyVisualLag(gameClock, maxDur);
            playbackSession.lastKnownClockSec = lagged;
            return lagged;
        }

        if (isPlaybackPaused(playbackSession.path)
            && playbackSession.gamePositionSec != null
            && !usesWallPlaybackClock()
            && playbackSession.lastKnownClockSec != null) {
            playbackSession.clockSource = 'game_cache_frozen';
            return applyVisualLag(playbackSession.lastKnownClockSec, maxDur);
        }

        if (playbackSession.clockRunning) {
            if (config.watchReplayCache !== false) {
                if (trackZipLive(playbackSession.path)) {
                    playbackSession.clockSource = 'zip_wall_sync';
                    const wall = applyVisualLag(resolveZipWallClockSec(maxDur), maxDur);
                    playbackSession.lastKnownClockSec = wall;
                    return wall;
                }
            }
            const sinceSelect = Date.now() - (playbackSession.replaySelectedAt || 0);
            if (sinceSelect < WALL_CLOCK_FALLBACK_MS && playbackSession.lastKnownClockSec > 0) {
                playbackSession.clockSource = 'waiting_game_cache';
                return playbackSession.lastKnownClockSec;
            }
            playbackSession.clockSource = 'wall_fallback';
            const wall = applyVisualLag(computeClockRaw(maxDur), maxDur);
            playbackSession.lastKnownClockSec = wall;
            return wall;
        }

        playbackSession.clockSource = 'idle';
        return playbackSession.lastKnownClockSec || 0;
    }

    function ensurePlaybackClock(replayPath) {
        if (!replayPath || playbackSession.clockRunning) return;
        if (shouldHoldPlaybackAfterEnd(replayPath)) return;
        if (!playbackSession.pendingSessionStart) return;
        clearReplayEndState(true);
        playbackSession.pendingSessionStart = false;
        const durationHint = state.playbackTimeline && state.playbackTimeline.replayDataDurationSec
            ? state.playbackTimeline.replayDataDurationSec
            : (replayDataDurationSec() || Math.max(1, Number(state.battleDurationSec) || 600));
        const initialPos = readGameCachePosition(replayPath, durationHint);
        if (initialPos != null) {
            applyGamePosition(initialPos, durationHint, 'play');
        } else {
            startPlaybackClock(0);
            playbackSession.clockSource = 'waiting_game_cache';
        }
        if (state.playbackDebug) {
            state.playbackDebug.clockStartReason = initialPos != null ? 'play' : 'play_wait_cache';
        }
    }

    function ensurePlaybackClockRunning(playbackPath, reason) {
        if (!playbackPath || playbackSession.clockRunning) return;
        if (shouldHoldPlaybackAfterEnd(playbackPath)) return;
        if (isFinishedReplayPath(playbackPath) && !shouldAllowReplayRestart(playbackPath)) return;
        if (playbackSession.clockSource === 'replay_end' && state.replayAtEnd) return;

        clearReplayEndState(true);
        const durationHint = state.playbackTimeline && state.playbackTimeline.replayDataDurationSec
            ? state.playbackTimeline.replayDataDurationSec
            : (replayDataDurationSec() || Math.max(1, Number(state.battleDurationSec) || DEFAULT_BATTLE_DURATION_SEC));
        const initialPos = readGameCachePosition(playbackPath, durationHint);
        if (initialPos != null) {
            applyGamePosition(initialPos, durationHint, reason || 'playback_auto');
        } else {
            startPlaybackClock(0);
            playbackSession.clockSource = 'waiting_game_cache';
        }
        if (state.playbackDebug) {
            state.playbackDebug.clockStartReason = reason || 'playback_auto';
            state.playbackDebug.clockAutoStarted = true;
        }
    }

    function maybeStartPlaybackClock(replayPath, reason) {
        if (!replayPath) return;
        if (shouldHoldPlaybackAfterEnd(replayPath)) return;
        if (isFinishedReplayPath(replayPath) && !shouldAllowReplayRestart(replayPath)) return;
        if (playbackSession.clockRunning) return;

        if (playbackSession.pendingSessionStart) {
            ensurePlaybackClock(replayPath);
            if (playbackSession.clockRunning) return;
        }

        const sinceSelect = Date.now() - (playbackSession.replaySelectedAt || 0);
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
        const durationHint = state.playbackTimeline && state.playbackTimeline.replayDataDurationSec
            ? state.playbackTimeline.replayDataDurationSec
            : (replayDataDurationSec() || Math.max(1, Number(state.battleDurationSec) || 600));

        if (zipSpike.has(reason)) {
            if (isFinishedReplayPath(replayPath) && !shouldAllowReplayRestart(replayPath)) return;
            clearReplayEndState(true);
            clearFinishedReplayMark();
            const initialPos = readGameCachePosition(replayPath, durationHint);
            if (initialPos != null) {
                applyGamePosition(initialPos, durationHint, reason);
                playbackSession.pendingSessionStart = false;
            } else {
                startPlaybackClock(0);
                playbackSession.clockSource = 'waiting_game_cache';
                playbackSession.pendingSessionStart = false;
            }
            if (state.playbackDebug) {
                state.playbackDebug.clockStartReason = initialPos != null ? reason : `${reason}_wait_cache`;
                state.playbackDebug.clockStartPos = initialPos;
            }
            return;
        }

        if (reason === 'cache_hold' && sinceSelect >= 150) {
            if (isFinishedReplayPath(replayPath) && !shouldAllowReplayRestart(replayPath)) return;
            clearReplayEndState(true);
            clearFinishedReplayMark();
            const initialPos = readGameCachePosition(replayPath, durationHint);
            if (initialPos != null) {
                applyGamePosition(initialPos, durationHint, reason);
                playbackSession.pendingSessionStart = false;
            } else {
                startPlaybackClock(0);
                playbackSession.clockSource = 'waiting_game_cache';
                playbackSession.pendingSessionStart = false;
            }
            if (state.playbackDebug) {
                state.playbackDebug.clockStartReason = initialPos != null ? reason : `${reason}_wait_cache`;
            }
        }
    }

    function startPlaybackClock(initialClockSec) {
        if (playbackSession.path
            && isFinishedReplayPath(playbackSession.path)
            && !shouldAllowReplayRestart(playbackSession.path)) {
            return;
        }
        if (playbackSession.path && shouldAllowReplayRestart(playbackSession.path)) {
            clearFinishedReplayMark();
        }
        clearReplayEndState(false);
        playbackSession.clockRunning = true;
        playbackSession.frozenClockSec = null;
        playbackSession.zipPausedAt = 0;
        playbackSession.startedAt = Date.now();
        playbackSession.clockOffsetSec = Math.max(0, Number(initialClockSec) || 0);
        playbackSession.rewindAt = Date.now();
        playbackSession.lastKnownClockSec = playbackSession.clockOffsetSec;
        state.replayAtEnd = false;
    }

    function stopPlaybackClock() {
        playbackSession.clockRunning = false;
        playbackSession.frozenClockSec = null;
        playbackSession.zipPausedAt = 0;
        playbackSession.zipLiveSince = 0;
        playbackSession.pendingSessionStart = false;
    }

    function ensurePlaybackSession(playbackPath, options) {
        options = options || {};
        const pathChanged = playbackSession.path !== playbackPath;
        if (pathChanged) {
            clearReplayEndState(true);
            playbackSession = defaultPlaybackSessionFields(playbackPath);
            playbackSession.applyCache = null;
            playbackSession.parseGen += 1;
            state.replayAtEnd = false;
            state.replayDataDurationSec = 0;
            return true;
        }
        playbackSession.lastSeenAt = Date.now();
        if (options.rewind && playbackSession.clockRunning) {
            resetPlaybackClock();
        }
        return false;
    }

    function markPlaybackSelection(replayPath, reason) {
        if (shouldHoldPlaybackAfterEnd(replayPath)) return;
        const pathChanged = playbackSession.path !== replayPath;
        playbackSession.lastDetectReason = reason;
        replayCacheDiffTracker.syncSelection(canonicalCacheReplayPath(replayPath));

        if (pathChanged) {
            resetPlaybackCaches('replay_selected', {
                replayPath: playbackSession.path || '',
                purgeDisk: 'all',
                stopClock: true,
                resetSession: false,
                clearLiveState: false
            });
            ensurePlaybackSession(replayPath, { rewind: false });
            clearReplayEndState(true);
            state.replayAtEnd = false;
            state.replayDataDurationSec = 0;
            playbackSession.lastRewindPickKey = '';
            playbackSession.lastMetaSessionKey = null;
            playbackSession.replaySelectedAt = Date.now();
            playbackSession.lastMetaChangeAt = Date.now();
            playbackSession.zipLiveSince = 0;
            playbackSession.pendingSessionStart = false;
            maybePersistPlaybackPath(replayPath, reason);
            replayAccessTracker.syncPreferPath(replayPath);
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
            const durationHint = replayDataDurationSec() || Math.max(1, Number(state.battleDurationSec) || 600);
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

    function alignPlaybackClockTo(positionSec, battleDurationSec) {
        const maxSec = battleDurationSec > 0 ? battleDurationSec : positionSec;
        const pos = Math.max(0, Math.min(Number(positionSec) || 0, maxSec));
        applyGamePosition(pos, maxSec, 'align');
    }

    function maybeRestartPlaybackFromGameCache(replayDurationSec) {
        const snap = readGameCacheSnapshot(playbackSession.path, replayDurationSec);
        if (!snap) return;

        const { cacheEntry, inspect, gamePos, maxDur } = snap;
        const sessionKey = cacheEntry.sessionKey;
        const metaChanged = playbackSession.lastMetaHex !== cacheEntry.metaHex;
        const sessionChanged = playbackSession.lastMetaSessionKey != null
            && playbackSession.lastMetaSessionKey !== sessionKey;

        if (metaChanged && inspect) {
            playbackSession.lastMetaInspect = inspect;
            playbackSession.lastMetaChangeAt = Date.now();
            const reason = sessionChanged ? 'session' : 'meta';
            logMetaChange(cacheEntry, inspect, reason);
            if (state.playbackDebug) {
                state.playbackDebug.lastMetaInspect = inspect;
                state.playbackDebug.lastMetaChangeAt = playbackSession.lastMetaChangeAt;
                state.playbackDebug.metaLogPath = metaLogPath();
            }
        }

        if (gamePos != null) {
            if (shouldIgnoreStaleCachePosition(gamePos, maxDur) && !sessionChanged) {
                startPlaybackClock(0);
                playbackSession.gamePositionSec = null;
                playbackSession.pendingSessionStart = false;
                playbackSession.clockSource = 'waiting_game_cache';
                state.replayAtEnd = false;
            } else if (!playbackSession.cachePositionLocked) {
                const prevPos = playbackSession.gamePositionSec;
                applyGamePosition(gamePos, maxDur, metaChanged ? 'meta_pos' : 'meta_poll');
                if (prevPos == null || Math.abs(prevPos - gamePos) > 0.05) {
                    playbackSession.lastMetaChangeAt = Date.now();
                }
                if (state.playbackDebug) {
                    state.playbackDebug.clockSyncSource = 'game_cache_meta';
                }
            }
        }

        if (playbackSession.lastMetaSessionKey == null) {
            playbackSession.lastMetaSessionKey = sessionKey;
            playbackSession.lastMetaHex = cacheEntry.metaHex;
            if (gamePos == null && playbackSession.pendingSessionStart && isZipActiveForPlayback(playbackSession.path)) {
                playbackSession.clockRunning = true;
                playbackSession.clockSource = 'waiting_game_cache';
            }
            return;
        }

        playbackSession.lastMetaHex = cacheEntry.metaHex;

        if (!sessionChanged && !metaChanged) return;

        if (sessionChanged) {
            if (!summaryHoldActive()) {
                playbackHoldKey = '';
                if (state.replayEndSummary) state.replayEndSummary = null;
            }
            clearReplayEndState(true);
            playbackSession.lastMetaSessionKey = sessionKey;
            playbackSession.pendingSessionStart = true;
            playbackSession.zipLiveSince = 0;
            playbackSession.battleAnchored = false;
            if (playbackSession.parseInFlight) {
                playbackSession.parseGen += 1;
            } else {
                playbackSession.applyCache = null;
            }
            playbackSession.loadKey = '';
            playbackSession.parseGen += 1;
            state.playbackTimeline = null;
            state.teamHp = null;
            state.replayAtEnd = false;
            state.replayDataDurationSec = 0;
            if (gamePos != null && !playbackSession.cachePositionLocked) {
                applyGamePosition(gamePos, maxDur, 'meta_session');
                playbackSession.pendingSessionStart = false;
            } else {
                startPlaybackClock(0);
                playbackSession.clockSource = 'waiting_game_cache';
            }
            if (state.playbackDebug) {
                state.playbackDebug.clockStartReason = 'meta_session';
                state.playbackDebug.playbackRestart = true;
                state.playbackDebug.metaSessionKey = sessionKey;
            }
            if (state.playbackTimeline) {
                state.playbackTimeline.rewindAt = playbackSession.rewindAt;
                state.playbackTimeline.startedAt = playbackSession.startedAt;
            }
        }
    }

    function resetPlaybackClock() {
        playbackSession.startedAt = Date.now();
        playbackSession.clockOffsetSec = 0;
        playbackSession.rewindAt = Date.now();
        playbackSession.frozenClockSec = null;
        playbackSession.zipPausedAt = 0;
        if (playbackSession.clockSource === 'replay_end') {
            playbackSession.clockSource = 'idle';
            playbackSession.clockRunning = false;
        }
        state.replayAtEnd = false;
    }

    function hasGameCachePlayback(replayPath) {
        if (!replayPath) return false;
        return Boolean(readGameCacheEntry(replayPath));
    }

    function isPlaybackPaused(replayPath) {
        if (!replayPath) return true;
        if (playbackSession.path === replayPath && playbackSession.clockRunning) {
            return false;
        }
        const activity = getReplayFileActivity(replayPath);
        return !activity.exists || activity.ageMs == null || activity.ageMs > ZIP_PAUSE_MS;
    }

    function usesWallPlaybackClock() {
        const src = playbackSession.clockSource;
        return src === 'wall_fallback'
            || src === 'zip_wall_sync'
            || src === 'waiting_game_cache'
            || src === 'idle'
            || playbackSession.gamePositionSec == null;
    }

    function getPlaybackClockSec() {
        if (!playbackSession.path) return 0;

        const maxDur = playbackClockMaxSec();
        const zipPaused = isPlaybackPaused(playbackSession.path);
        const wallClock = usesWallPlaybackClock();

        if (zipPaused && !wallClock) {
            if (playbackSession.gamePositionSec != null) {
                playbackSession.clockSource = 'game_cache_frozen';
                playbackSession.lastKnownClockSec = playbackSession.gamePositionSec;
                return Math.min(playbackSession.gamePositionSec, maxDur);
            }
            if (playbackSession.frozenClockSec == null && playbackSession.clockRunning) {
                playbackSession.frozenClockSec = resolvePlaybackClockSec();
                playbackSession.zipPausedAt = Date.now();
            }
            const frozen = playbackSession.frozenClockSec != null
                ? playbackSession.frozenClockSec
                : (playbackSession.lastKnownClockSec || 0);
            return Math.min(frozen, maxDur);
        }

        if (playbackSession.frozenClockSec != null && playbackSession.zipPausedAt) {
            playbackSession.frozenClockSec = null;
            playbackSession.zipPausedAt = 0;
        }

        if (!playbackSession.clockRunning && playbackSession.gamePositionSec == null) {
            if (playbackSession.clockSource === 'replay_end' || state.replayAtEnd) {
                return Math.min(playbackSession.lastKnownClockSec || replayDataDurationSec() || 0, maxDur);
            }
            if (playbackSession.pendingSessionStart) {
                return 0;
            }
            return Math.min(playbackSession.lastKnownClockSec || 0, maxDur);
        }

        const clock = Math.min(resolvePlaybackClockSec(), maxDur);
        stopClockAtReplayEnd(clock);
        return playbackSession.clockSource === 'replay_end'
            ? maxDur
            : clock;
    }

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

        const now = Date.now();
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
        if (!battleResultsPath && options.mode === 'recording' && fs.existsSync(recordingBattleResultsPath())) {
            battleResultsPath = recordingBattleResultsPath();
        }

        const ctx = battleResultsPath ? parseBattleResultsContext(battleResultsPath) : {
            finalDamage: new Map(),
            rosterByNick: new Map(),
            combatStatsByEntity: new Map()
        };

        const players = enrichPlayersWithTankNames(
            mergePlayerDamage(entityPlayers, liveDamage, ctx.finalDamage, ctx.rosterByNick),
            tankNameContext({
                buf: options.buf,
                authorNickname: parsed.authorNickname || config.playerName || ''
            })
        );
        const authorRow = players.find((p) => p.nickname === parsed.authorNickname)
            || players.find((p) => p.nickname === config.playerName)
            || null;

        state.clientVersion = parsed.clientVersion || state.clientVersion;
        state.battleTimeSec = parsed.battleTimeSec || 0;
        state.battleTimeLabel = formatTime(state.battleTimeSec);
        state.authorNickname = parsed.authorNickname || state.authorNickname;
        state.arenaUniqueId = parsed.arenaUniqueId;
        state.battleLevel = parsed.battleLevel;
        state.players = players;
        state.playerCount = players.length;
        state.packetCount = parsed.packetCount || 0;
        state.live.damageDealt = authorRow && authorRow.damageDealt != null ? authorRow.damageDealt : null;
        state.live.damageSource = authorRow ? authorRow.damageSource : null;
    }

    function applyPlaybackTimeline(parsed, buf, battleResultsPath, playbackPath, options) {
        options = options || {};
        if (!parsed || !buf) return;

        const mtimeMs = replayFileMtime(playbackPath);
        const loadKey = playbackLoadKey(playbackPath);
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

        if (!options.forceFull && playbackSession.applyCache && playbackSession.applyCache.loadKey === loadKey) {
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
            } = playbackSession.applyCache);
        } else {
            entityPlayers = new Map();
            (parsed.players || []).forEach((player) => {
                if (player.entityId) entityPlayers.set(player.entityId, player);
            });

            authorEntityId = findAuthorEntityId(parsed, entityPlayers);
            ctx = getBattleResultsContext(battleResultsPath);

            tankCtx = tankNameContext({
                buf,
                playbackPath,
                authorNickname: parsed.authorNickname || config.playerName || ''
            });
            enrichPlayersWithTankNames([...entityPlayers.values()], tankCtx).forEach((player) => {
                if (player.entityId) entityPlayers.set(player.entityId, player);
            });

            const playerEntityIds = new Set(entityPlayers.keys());
            ctx.finalDamage.forEach((_, entityId) => playerEntityIds.add(entityId));

            timeline = timelineCache.get(playbackPath, buf, mtimeMs, {
                authorEntityId,
                finalDamage: ctx.finalDamage,
                playerEntityIds
            });
            ensurePlaybackSession(playbackPath);

            countdownDurationSec = DEFAULT_BATTLE_DURATION_SEC;
            battleStartOffsetSec = timeline.battleStartOffsetSec
                || resolveBattleStartOffset(timeline.firstCanonicalClock);
            playbackSession.battleStartOffsetSec = battleStartOffsetSec;
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

            playbackSession.applyCache = {
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

        ensurePlaybackSession(playbackPath);
        if (playbackSession.pendingSessionStart) {
            ensurePlaybackClock(playbackPath);
        }
        maybeRestartPlaybackFromGameCache(replayDurationSec || battleDurationSec);
        maybeStartPlaybackClock(playbackPath, playbackSession.lastDetectReason);
        ensurePlaybackClockRunning(playbackPath, playbackSession.lastDetectReason || 'timeline');

        const clockSec = getPlaybackClockSec();
        const atEnd = replayDurationSec > 0 && clockSec >= replayDurationSec - 0.25;
        const replayAtEnd = (atEnd || playbackSession.clockSource === 'replay_end')
            && !isFreshReplaySelection();
        const movementStartSec = battleStartOffsetSec;
        const introPhase = playbackSession.clockRunning && clockSec < movementStartSec;
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
            || players.find((p) => p.nickname === config.playerName)
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
            cacheDir
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
                authorNickname: parsed.authorNickname || config.playerName || '',
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
            if (!authorTeam || (team !== 1 && team !== 2 && row.nickname !== (parsed.authorNickname || config.playerName))) {
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
                side: team === authorTeam || row.nickname === (parsed.authorNickname || config.playerName) ? 'ally' : 'enemy',
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
        const battleClockRunning = playbackSession.clockRunning && clockSec >= movementStartSec;

        state.clientVersion = parsed.clientVersion || state.clientVersion;
        state.battleDurationSec = battleDurationSec;
        state.replayDataDurationSec = replayDurationSec;
        state.replayAtEnd = replayAtEnd;
        state.battleTimeSec = clockSec;
        state.battleTimeLabel = formatCountdown(clockSec, countdownDurationSec, battleStartOffsetSec);
        state.countdownRemainingSec = countdownRemainingSec;
        state.countdownLabel = playbackSession.clockRunning
            ? state.battleTimeLabel
            : formatCountdown(0, countdownDurationSec, battleStartOffsetSec);
        state.battleStartOffsetSec = battleStartOffsetSec;
        state.movementStartSec = movementStartSec;
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
        state.authorNickname = parsed.authorNickname || state.authorNickname;
        state.arenaUniqueId = parsed.arenaUniqueId;
        state.battleLevel = parsed.battleLevel;
        state.players = players;
        state.playerCount = players.length;
        state.packetCount = parsed.packetCount || 0;
        state.live.damageDealt = authorRow && authorRow.damageDealt != null ? authorRow.damageDealt : null;
        state.live.damageSource = authorRow
            ? (useBattleResults ? 'battle_results' : 'replay')
            : null;
        state.replayRecordingComplete = replayRecordingComplete;
        state.teamHp = teamHp;
        state.teamHpDebug = teamHpDebug;
        state.authorTeam = authorTeam;
        state.authorPlatoonGroupId = authorRow && authorRow.platoonGroupId
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
            state.playbackTimeline = {
                replayKey: path.basename(playbackPath),
                durationSec: replayDurationSec || sparse.durationSec || 0,
                replayDataDurationSec: replayDurationSec || sparse.durationSec || 0,
                countdownDurationSec,
                battleStartOffsetSec,
                movementStartSec,
                startedAt: playbackSession.startedAt,
                rewindAt: playbackSession.rewindAt || 0,
                speed: playbackSpeed(),
                authorNickname: parsed.authorNickname || config.playerName || '',
                authorTeam,
                authorPlatoonGroupId: state.authorPlatoonGroupId || 0,
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
            state.playbackTimeline = null;
        }
        state.playbackLoading = false;
    }

    function applyFinishedReplay(zipPath) {
        const parsed = parseFinishedReplay(zipPath, config.pythonPath);
        if (!parsed || !parsed.meta) return;
        const meta = parsed.meta;
        const author = parsed.author || {};
        state.lastBattle = {
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
        if (!state.replayEndSummary || !state.replayEndSummary.visible) return;
        const shownAt = state.replayEndSummary.shownAt
            ? new Date(state.replayEndSummary.shownAt).getTime()
            : 0;
        if (shownAt && Date.now() - shownAt > REPLAY_SUMMARY_TTL_MS) {
            state.replayEndSummary.visible = false;
            state.replayEndSummary.pending = false;
            playbackHoldKey = '';
            resetPlaybackCaches('summary_expired', {
                purgeDisk: 'all',
                clearLiveState: true,
                resetSession: true,
                keepSessionPath: ''
            });
        }
    }

    function applyReplayCombatStats(players, playbackPath, ctx, durationSec) {
        const buf = getPlaybackReplayBuf(playbackPath);
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
        const replayKey = playbackLoadKey(playbackPath);
        if (state.replayEndSummary
            && state.replayEndSummary.replayKey === replayKey
            && (state.replayEndSummary.visible || state.replayEndSummary.pending)) {
            return;
        }

        const meta = readMetaFromZip(playbackPath);
        const parsedFinished = parseFinishedReplay(playbackPath, config.pythonPath);
        const ctx = getBattleResultsContext(playbackPath);
        const entityPlayers = new Map();
        (state.players || []).forEach((player) => {
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
        players = enrichPlayersWithTankNames(players, tankNameContext({
            playbackPath,
            authorNickname: state.authorNickname || config.playerName || ''
        }));
        players = enrichPlayersWithCombatStats(players, ctx.combatStatsByEntity);
        players = applyReplayCombatStats(
            players,
            playbackPath,
            ctx,
            replayDataDurationSec()
                || state.replayDataDurationSec
                || (meta && Number(meta.battleDuration))
                || playbackMaxProgressSec
                || 0
        );

        const authorNick = state.authorNickname
            || config.playerName
            || (meta && meta.playerName)
            || '';
        const summaryDurationSec = replayDataDurationSec()
            || state.replayDataDurationSec
            || (meta && Number(meta.battleDuration))
            || playbackMaxProgressSec
            || 0;
        let fragMap;
        if (state.playbackTimeline) {
            fragMap = countFragsAtClock(state.playbackTimeline, summaryDurationSec);
        } else {
            const replayBuf = extractDataReplayFromZip(playbackPath, cacheDir);
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

        state.replayEndSummary = buildReplayEndSummary({
            replayKey,
            replayFile: path.basename(playbackPath),
            authorNickname: authorNick,
            authorRow,
            authorStats,
            players,
            meta: meta || (parsedFinished && parsedFinished.meta) || {},
            playbackTimeline: state.playbackTimeline,
            authorTeam: state.authorTeam || (authorRow && authorRow.team) || 0,
            durationSec: summaryDurationSec,
            tankName: authorRow && authorRow.tankName
        });
        state.replayEndSummary.visible = false;
        state.replayEndSummary.pending = true;
        state.replayEndSummary.showAt = new Date(Date.now() + REPLAY_SUMMARY_DELAY_MS).toISOString();
        state.replayEndSummary.endedAt = new Date().toISOString();
        playbackHoldKey = replayKey;
        markReplayPlaybackFinished(playbackPath);
        state.replayAtEnd = true;
        state.playbackClockRunning = false;
        state.status = 'playback';
        state.mode = 'playback_ended';
        state.recordingPath = playbackPath;
        state.sourceLabel = path.basename(playbackPath);
        state.playbackLoading = false;
        lastResolvedPlaybackPath = playbackPath;
        console.log('[replay-live] replay end summary:', path.basename(playbackPath));
        resetPlaybackCaches('replay_end_summary', {
            replayPath: playbackPath,
            purgeDisk: 'all',
            stopClock: true,
            resetSession: true,
            keepSessionPath: '',
            clearLiveState: true,
            keepReplayAtEnd: true,
            keepProgress: true
        });
        if (!summaryHoldActive()) {
            replayAccessTracker.reset();
            replayCacheDiffTracker.reset();
        }
        // Небольшая задержка: даём игре/итогам боя спокойно отпустить файл и
        // домассировать состояние конца реплея, прежде чем убрать его с диска.
        setTimeout(() => archiveWatchedReplay(playbackPath), 5000);
    }

    function checkPlaybackEndSummary(playbackPath) {
        if (playbackEndTriggered || !playbackPath) return;
        const sinceSelect = Date.now() - (playbackSession.replaySelectedAt || 0);
        if (sinceSelect < 20000) return;
        const duration = Math.max(
            replayDataDurationSec(),
            Number(playbackSession.applyCache && playbackSession.applyCache.replayDurationSec) || 0,
            playbackMaxProgressSec
        );
        if (duration < 25) return;

        const clock = Number(state.playbackClockSec) || 0;
        playbackMaxProgressSec = Math.max(playbackMaxProgressSec, clock);
        const nearEnd = clock >= duration - 3 || (clock / duration) >= 0.96;
        if (!nearEnd) return;

        playbackEndTriggered = true;
        triggerReplayEndSummary(playbackPath);
    }

    function resetPlaybackSummaryTracking(clearSummary) {
        playbackEndTriggered = false;
        playbackMaxProgressSec = 0;
        playbackHoldKey = '';
        if (clearSummary) {
            state.replayEndSummary = null;
            replayAccessTracker.reset();
            replayCacheDiffTracker.reset();
        }
    }

    function resetReplayEndClock() {
        clearReplayEndState(true);
    }

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
        lastSpikeHandledKey = '';
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

    function registerRoutes(app) {
        app.get('/api/replay-live', (req, res) => {
            res.json({ success: true, data: getState() });
        });

        app.get('/api/replay-live/config', (req, res) => {
            res.json({ success: true, config });
        });

        app.get('/api/replay-live/replays-list', (req, res) => {
            const items = listReplayZipCandidates({ minSize: 50000 })
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, 40)
                .map((item) => ({
                    path: item.full,
                    name: path.basename(item.full),
                    folder: path.basename(path.dirname(item.full)),
                    mtime: item.mtime,
                    size: item.size
                }));
            res.json({ success: true, items });
        });

        app.post('/api/replay-live/play', (req, res) => {
            const replayPath = String((req.body && req.body.path) || req.query.path || '').trim();
            const result = activateManualReplayPath(replayPath, { reason: 'manual_play' });
            if (!result.ok) {
                return res.status(400).json({ success: false, error: result.error || 'invalid_path' });
            }
            res.json({ success: true, path: result.path, data: getState() });
        });

        app.put('/api/replay-live/config', (req, res) => {
            const body = req.body || {};
            const prevManualPath = (config.playbackReplayPath || '').trim();
            const next = saveConfig({
                replaysDir: body.replaysDir ? String(body.replaysDir).trim() : config.replaysDir,
                gameInstallDir: body.gameInstallDir != null
                    ? String(body.gameInstallDir).trim()
                    : config.gameInstallDir,
                extraReplaysDirs: body.extraReplaysDirs != null
                    ? body.extraReplaysDirs
                    : config.extraReplaysDirs,
                playerName: body.playerName ? String(body.playerName).trim() : config.playerName,
                pollIntervalMs: body.pollIntervalMs != null ? Number(body.pollIntervalMs) : config.pollIntervalMs,
                pythonPath: body.pythonPath ? String(body.pythonPath).trim() : config.pythonPath,
                playbackReplayPath: body.playbackReplayPath != null
                    ? String(body.playbackReplayPath).trim()
                    : config.playbackReplayPath,
                autoPlaybackMinutes: body.autoPlaybackMinutes != null
                    ? Number(body.autoPlaybackMinutes)
                    : config.autoPlaybackMinutes,
                playbackAccessMinutes: body.playbackAccessMinutes != null
                    ? Number(body.playbackAccessMinutes)
                    : config.playbackAccessMinutes,
                playbackSpeed: body.playbackSpeed != null
                    ? Number(body.playbackSpeed)
                    : config.playbackSpeed,
                watchReplayCache: body.watchReplayCache != null
                    ? Boolean(body.watchReplayCache)
                    : config.watchReplayCache,
                playbackLoadDelaySec: body.playbackLoadDelaySec != null
                    ? Number(body.playbackLoadDelaySec)
                    : config.playbackLoadDelaySec
            });
            const nextManualPath = (next.playbackReplayPath || '').trim();
            if (nextManualPath
                && fs.existsSync(nextManualPath)
                && normalizedReplayPath(nextManualPath) !== normalizedReplayPath(prevManualPath)) {
                activateManualReplayPath(nextManualPath, {
                    reason: 'config_manual_path',
                    persist: false
                });
            } else {
                startWatcher();
                poll();
            }
            res.json({ success: true, config: next, data: getState() });
        });

        app.post('/api/replay-live/refresh', (req, res) => {
            const body = req.body || {};
            if (body.resetTracker || req.query.reset === '1') {
                replayAccessTracker.reset();
                replayCacheDiffTracker.reset();
                timelineCache.reset();
                replayBufCache.clear();
                battleResultsCtxCache.clear();
            }
            if (body.resetPlaybackClock || req.query.rewind === '1') {
                resetPlaybackClock();
                if (state.playbackTimeline) {
                    state.playbackTimeline.startedAt = playbackSession.startedAt;
                    state.playbackTimeline.rewindAt = Date.now();
                }
            }
            poll();
            res.json({ success: true, data: getState() });
        });
    }

    function sendPublicNoCache(res, ...parts) {
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.sendFile(path.join(deps.appRoot, 'public', ...parts));
    }

    function registerPages(app) {
        app.get('/replay-live', (req, res) => {
            sendPublicNoCache(res, 'replay-live.html');
        });
        app.get('/widget-replay-live', (req, res) => {
            sendPublicNoCache(res, 'widget-replay-live.html');
        });
        app.get('/widget-replay-summary', (req, res) => {
            sendPublicNoCache(res, 'widget-replay-summary.html');
        });
        app.get('/widget-replay-summary-carousel', (req, res) => {
            sendPublicNoCache(res, 'widget-replay-summary-carousel.html');
        });
        app.get('/widget-replay-summary-carousel-cards', (req, res) => {
            sendPublicNoCache(res, 'widget-replay-summary-carousel-cards.html');
        });
        app.get('/replay-summary.css', (req, res) => {
            sendPublicNoCache(res, 'replay-summary.css');
        });
        app.get('/replay-summary-ui.js', (req, res) => {
            sendPublicNoCache(res, 'replay-summary-ui.js');
        });
    }

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
