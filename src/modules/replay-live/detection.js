'use strict';
/**
 * Детект «какой реплей открыт» для replay-live — самый хрупкий каскад модуля
 * (см. resolveExclusiveExtraDirPick). Вынесен из index.js 1:1.
 *
 * h — host-объект из index.js: общее мутабельное состояние проброшено через
 * defineProperty-геттеры/сеттеры (playbackSession, config, playbackHoldKey…),
 * плюс функции, оставшиеся в index.js. Не менять порядок тиров каскада без
 * трейса (scripts/trace-replay-pick.js) — фикс одного бага исторически
 * возвращал другой.
 */

const fs = require('fs');
const path = require('path');
const {
    listReplayCacheFiles,
    parseCacheEntries,
    getReplayFileActivity,
    readReplayCacheEntry,
    readActiveReplayFromCache,
    replayPathExists,
    replayBasenameKey,
    isReplayArchiveName
} = require('./replayCache');
const {
    STRONG_CACHE_REASONS,
    WEAK_CACHE_REASONS,
    GAME_CACHE_INTENT_MS,
    ZIP_JUST_OPENED_MS,
    ZIP_SWITCH_TOUCH_DELTA_MS,
    HOT_ZIP_ACCESS_MS,
    STICKY_SESSION_MAX_MS
} = require('./constants');

function createReplayDetection(h) {
    let extraDirPollTimer = null;

    function scheduleExtraDirReplayPoll() {
        if (extraDirPollTimer) clearTimeout(extraDirPollTimer);
        extraDirPollTimer = setTimeout(() => {
            extraDirPollTimer = null;
            h.poll();
        }, 150);
    }

    function resolveFreshAccessReplayPick(signals) {
        const spike = signals && signals.access && signals.access.freshSpike;
        if (!spike || !spike.path || !replayPathExists(spike.path)) return null;
        if (h.isFinishedReplayPath(spike.path) && !h.shouldAllowReplayRestart(spike.path)) return null;
        return {
            path: spike.path,
            source: 'access_tracker',
            reason: 'access_spike'
        };
    }

    function findNewerExtraDirLiveReplay(currentPath) {
        const pick = findLatestLiveReplayPick();
        if (!pick || !pick.path) return '';
        if (currentPath && h.normalizedReplayPath(pick.path) === h.normalizedReplayPath(currentPath)) return '';
        const activity = getReplayFileActivity(pick.path);
        if (activity.ageMs == null || activity.ageMs > HOT_ZIP_ACCESS_MS) return '';
        return pick.path;
    }

    function resolveExtraDirOpenedReplayPick(signals) {
        const accessPath = signals && signals.access && signals.access.replayPath;
        if (accessPath && h.isPathInExtraReplaysDirs(accessPath) && replayPathExists(accessPath)) {
            const activity = getReplayFileActivity(accessPath);
            if (activity.ageMs != null && activity.ageMs <= h.playbackAccessWindowMs()) {
                if (!h.isFinishedReplayPath(accessPath) || h.shouldAllowReplayRestart(accessPath)) {
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
        const current = h.playbackSession.path || h.lastResolvedPlaybackPath || '';
        if (current && h.normalizedReplayPath(current) === h.normalizedReplayPath(pick.path)) return null;
        if (h.isFinishedReplayPath(pick.path) && !h.shouldAllowReplayRestart(pick.path)) return null;
        return pick;
    }

    function pickExtraDirReplayIfNew(extraPick) {
        if (!extraPick || !extraPick.path) return null;
        const current = h.playbackSession.path || h.lastResolvedPlaybackPath || '';
        if (current && h.normalizedReplayPath(current) === h.normalizedReplayPath(extraPick.path)) {
            return null;
        }
        h.clearFinishedReplayMark();
        h.playbackHoldKey = '';
        return returnPlaybackPick(extraPick, { extraDirPriority: true });
    }

    function findLatestLiveReplayPick() {
        const candidates = h.listReplayZipCandidates({
            minSize: 50000,
            windowMs: h.playbackAccessWindowMs()
        })
            .filter((item) => h.isPathInExtraReplaysDirs(item.full))
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
            if (touchAge <= h.playbackAccessWindowMs()) {
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
        const cacheFiles = listReplayCacheFiles(h.resolveGameCacheReplaysDir());
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
        return readReplayCacheEntry(h.resolveGameCacheReplaysDir(), replayPath);
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
        h.lastMetaHexByBasename.clear();
        h.clearFinishedReplayMark();
        h.playbackEndTriggered = false;
        h.lastSeenGameCacheMtimeMs = 0;
        h.lastGameCacheActivePath = '';
        h.playbackHoldKey = '';
        h.replayCacheDiffTracker.reset();
        h.replayAccessTracker.reset();
        h.timelineCache.reset();
        h.replayBufCache.clear();
        h.battleResultsCtxCache.clear();
    }

    function beginFreshExclusiveReplay(replayPath, reason) {
        resetExclusiveReplayWatchState();
        h.hardResetAllReplayState(replayPath, reason || 'game_switch', { force: true });
        h.saveConfig({ playbackReplayPath: replayPath });
        h.lastGameCacheActivePath = h.normalizedReplayPath(replayPath);
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
        for (const dir of h.normalizeExtraReplaysDirs(h.config.extraReplaysDirs)) {
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
        if (h.isPathInExtraReplaysDirs(replayPath) && replayPathExists(replayPath)) {
            return replayPath;
        }
        const base = path.basename(replayPath);
        for (const dir of h.normalizeExtraReplaysDirs(h.config.extraReplaysDirs)) {
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
        for (const dir of h.normalizeExtraReplaysDirs(h.config.extraReplaysDirs)) {
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
                const prevHex = h.lastMetaHexByBasename.get(baseKey);
                const metaChanged = prevHex != null && prevHex !== row.metaHex;
                h.lastMetaHexByBasename.set(baseKey, row.metaHex);

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
        for (const dir of h.normalizeExtraReplaysDirs(h.config.extraReplaysDirs)) {
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
        return h.playbackSession.path || h.lastResolvedPlaybackPath || '';
    }

    function clearExclusiveIdleSession() {
        h.playbackSession = h.defaultPlaybackSessionFields('');
        h.lastResolvedPlaybackPath = '';
        h.lastActivePlaybackAt = 0;
        h.lastMetaHexByBasename.clear();
        if ((h.config.playbackReplayPath || '').trim()) {
            h.saveConfig({ playbackReplayPath: '' });
        }
    }

    function collectGameIntentExtraDirBasenames(cache, signals) {
        const keys = new Set();
        const cacheSig = signals && signals.cache;
        if (cacheSig && cacheSig.replayPath && !WEAK_CACHE_REASONS.has(cacheSig.reason)) {
            const extra = mapGameCachePathToExtraDir(cacheSig.replayPath);
            if (extra && h.isPathInExtraReplaysDirs(extra)) {
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

        for (const dir of h.normalizeExtraReplaysDirs(h.config.extraReplaysDirs)) {
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
        if (h.normalizedReplayPath(fromPath) === h.normalizedReplayPath(toPath)) return false;
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
            if (!extraPath || !h.isPathInExtraReplaysDirs(extraPath)) continue;
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
            if (h.isFinishedReplayPath(row.path) && !h.shouldAllowReplayRestart(row.path)) continue;
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
        if (!extraPath || !replayPathExists(extraPath) || !h.isPathInExtraReplaysDirs(extraPath)) return null;
        if (h.isFinishedReplayPath(extraPath) && !h.shouldAllowReplayRestart(extraPath)) return null;

        const zipLive = h.isZipActiveForPlayback(extraPath);
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
            if (extraPath && replayPathExists(extraPath) && h.isZipActiveForPlayback(extraPath)) {
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
        const manualPath = (h.config.playbackReplayPath || '').trim();
        if (manualPath
            && replayPathExists(manualPath)
            && h.isPathInExtraReplaysDirs(manualPath)
            && manualReasons.has(h.playbackSession.lastDetectReason)) {
            return {
                path: manualPath,
                source: 'manual',
                reason: h.playbackSession.lastDetectReason,
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
        const current = h.playbackSession.path || h.lastResolvedPlaybackPath || '';
        if (!current || !replayPathExists(current) || !h.isPathInExtraReplaysDirs(current)) return null;
        if (h.shouldHoldPlaybackAfterEnd(current)) return null;
        if (h.isFinishedReplayPath(current) && !h.shouldAllowReplayRestart(current)) return null;

        const cache = readGameCacheBuffer();
        if (extraDirHasFreshMetaChangeForOther(current, cache)) return null;

        const signals = h.resolvePlaybackSignals();
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

        const selectedAt = h.playbackSession.replaySelectedAt || h.lastActivePlaybackAt || 0;
        if (!selectedAt) return null;

        const replayDurSec = Math.max(
            h.replayDataDurationSec(),
            Number(h.state.replayDataDurationSec) || 0,
            Number(h.playbackSession.applyCache && h.playbackSession.applyCache.replayDurationSec) || 0
        );
        const clockSec = h.playbackSession.clockRunning
            ? h.getPlaybackClockSec()
            : (h.playbackSession.lastKnownClockSec || 0);

        if (h.state.replayAtEnd) return null;
        if (replayDurSec > 0 && clockSec >= replayDurSec - 0.5) return null;

        const sessionAgeMs = Date.now() - selectedAt;
        const maxSessionMs = replayDurSec > 0
            ? replayDurSec * 1000 + 180_000
            : STICKY_SESSION_MAX_MS;
        if (sessionAgeMs > maxSessionMs) return null;

        const entry = readGameCacheEntry(current);
        return {
            path: current,
            metaHex: entry ? entry.metaHex : (h.playbackSession.lastMetaHex || ''),
            reason: 'session_continue',
            source: 'session_hold'
        };
    }

    function pickAccessSpikeExtraReplay(signals, cache) {
        const spike = signals && signals.access && signals.access.freshSpike;
        if (!spike || !spike.path || !h.isPathInExtraReplaysDirs(spike.path)) return null;
        if (!replayPathExists(spike.path)) return null;

        const activity = getReplayFileActivity(spike.path);
        if (activity.ageMs == null || activity.ageMs > HOT_ZIP_ACCESS_MS * 3) return null;

        const current = h.playbackSession.path || h.lastResolvedPlaybackPath || '';
        if (current && h.normalizedReplayPath(current) === h.normalizedReplayPath(spike.path)) {
            return null;
        }

        if (!cache || !cache.buf) return null;

        const base = replayBasenameKey(path.basename(spike.path));
        const row = parseCacheEntries(cache.buf).find((entry) => (
            replayBasenameKey(path.basename(entry.replayPath)) === base
        ));
        if (!row) return null;

        const prevHex = h.lastMetaHexByBasename.get(base);
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
        if (!h.usesExclusiveExtraReplayDirs()) return null;

        const active = resolveActiveExtraDirReplayFromCache(signals);
        if (active && active.path) {
            const spikePick = pickAccessSpikeExtraReplay(signals, readGameCacheBuffer());
            const reason = spikePick && h.normalizedReplayPath(spikePick.path) === h.normalizedReplayPath(active.path)
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
        if (!h.usesExclusiveExtraReplayDirs()) return null;

        const gamePick = resolveGameOpenedExtraDirReplay(signals);
        if (gamePick) return gamePick;

        const manualReasons = new Set(['manual_play', 'manual_path', 'config_manual_path']);
        const manualPath = h.playbackSession.path || (h.config.playbackReplayPath || '').trim();
        if (manualPath
            && replayPathExists(manualPath)
            && h.isPathInExtraReplaysDirs(manualPath)
            && manualReasons.has(h.playbackSession.lastDetectReason)) {
            return {
                path: manualPath,
                source: 'manual',
                reason: h.playbackSession.lastDetectReason
            };
        }

        return null;
    }

    function tryHoldCurrentExtraDirSession(gameActivePath) {
        const current = h.playbackSession.path || h.lastResolvedPlaybackPath || '';
        if (!current || !replayPathExists(current) || !h.isPathInExtraReplaysDirs(current)) return null;
        if (h.shouldHoldPlaybackAfterEnd(current)) return null;

        const cache = readGameCacheBuffer();
        if (extraDirHasFreshMetaChangeForOther(current, cache)) return null;

        if (gameActivePath
            && h.normalizedReplayPath(gameActivePath) !== h.normalizedReplayPath(current)) {
            return null;
        }

        if (h.isFinishedReplayPath(current) && !h.shouldAllowReplayRestart(current)) return null;

        const manualReasons = new Set(['manual_play', 'manual_path', 'config_manual_path']);
        if (manualReasons.has(h.playbackSession.lastDetectReason)) {
            return {
                path: current,
                source: 'session_hold',
                reason: 'manual_hold'
            };
        }

        if (gameActivePath && h.normalizedReplayPath(gameActivePath) === h.normalizedReplayPath(current)) {
            return {
                path: current,
                source: 'session_hold',
                reason: 'game_playing'
            };
        }

        const selectedAt = h.playbackSession.replaySelectedAt || h.lastActivePlaybackAt || 0;
        if (!selectedAt) return null;

        if (h.playbackSession.clockRunning) {
            return {
                path: current,
                source: 'session_hold',
                reason: 'session_hold'
            };
        }

        return null;
    }

    function readCacheLiveActivePath() {
        const cacheFiles = listReplayCacheFiles(h.resolveGameCacheReplaysDir());
        if (!cacheFiles.length) return null;
        try {
            const cacheStat = fs.statSync(cacheFiles[0].full);
            if (Date.now() - cacheStat.mtimeMs > 3 * 60 * 1000) return null;
            const activePath = readActiveReplayFromCache(fs.readFileSync(cacheFiles[0].full));
            if (activePath && replayPathExists(activePath) && h.isZipActiveForPlayback(activePath)) {
                return activePath;
            }
        } catch (_) { /* noop */ }
        return null;
    }

    function pickReplayFromSignals(signals) {
        if (h.playbackHoldKey && h.summaryHoldActive()) return null;

        const { access, cache } = signals;
        const accessPick = h.pickAccessReplayPath(access);

        if (accessPick) {
            const cachePath = cache && cache.replayPath ? cache.replayPath : '';
            const sameAsCache = cachePath
                && h.normalizedReplayPath(cachePath) === h.normalizedReplayPath(accessPick.path);
            const cacheWantsSwitch = cache && cache.isActive && cachePath && !sameAsCache
                && replayPathExists(cachePath)
                && STRONG_CACHE_REASONS.has(cache.reason)
                && h.isZipActiveForPlayback(cachePath);

            if (!cacheWantsSwitch
                || access.freshSpike
                || h.isPathInExtraReplaysDirs(accessPick.path)
                || !h.isPathInPrimaryReplaysDir(accessPick.path)) {
                return h.guardReplayPick(accessPick, signals);
            }
        }

        if (cache.isActive && cache.replayPath && replayPathExists(cache.replayPath)) {
            if (!h.isFinishedReplayPath(cache.replayPath)
                || h.shouldAllowReplayRestart(cache.replayPath)) {
                if (STRONG_CACHE_REASONS.has(cache.reason) || h.isZipActiveForPlayback(cache.replayPath)) {
                    return h.guardReplayPick({
                        path: cache.replayPath,
                        source: 'cache_diff',
                        reason: cache.reason
                    }, signals);
                }
            }
        }

        const cacheLive = readCacheLiveActivePath();
        if (cacheLive && (!h.isFinishedReplayPath(cacheLive) || h.shouldAllowReplayRestart(cacheLive))) {
            return h.guardReplayPick({
                path: cacheLive,
                source: 'cache_diff',
                reason: 'cache_active_live'
            }, signals);
        }

        const sole = h.findSoleZipLiveReplayPath();
        if (sole && (!h.isFinishedReplayPath(sole) || h.shouldAllowReplayRestart(sole))) {
            return h.guardReplayPick({
                path: sole,
                source: 'zip_scan',
                reason: 'sole_zip_live'
            }, signals);
        }

        return null;
    }

    function returnPlaybackPick(pick, debugExtra) {
        h.markPlaybackSelection(pick.path, pick.reason);
        h.state.playbackDebug = Object.assign({}, h.state.playbackDebug || {}, {
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

    return {
        scheduleExtraDirReplayPoll,
        resolveFreshAccessReplayPick,
        findNewerExtraDirLiveReplay,
        resolveExtraDirOpenedReplayPick,
        pickExtraDirReplayIfNew,
        findLatestLiveReplayPick,
        readGameCacheBuffer,
        readGameCacheEntry,
        canonicalCacheReplayPath,
        metaSessionKeyFromHex,
        resetExclusiveReplayWatchState,
        beginFreshExclusiveReplay,
        exclusiveReplaySessionKey,
        extraDirHasFreshMetaChangeForOther,
        findExtraDirReplayByBasenameKey,
        mapGameCachePathToExtraDir,
        listExtraDirCacheLinkedCandidates,
        pickFreshestTouchedExtraDirZip,
        currentExclusivePlaybackPath,
        clearExclusiveIdleSession,
        collectGameIntentExtraDirBasenames,
        pickJustOpenedExtraDirZipNotCurrent,
        scanLiveExtraDirZips,
        pickLiveExtraDirZipDirect,
        shouldSwitchExclusiveExtraDirReplay,
        pickLiveExtraDirReplayFromCache,
        pickMetaChangedExtraDirReplay,
        pickCacheDiffExtraDirReplay,
        resolveExclusiveExtraDirPick,
        tryContinueExclusiveExtraPlayback,
        pickAccessSpikeExtraReplay,
        resolveActiveExtraDirReplayFromCache,
        resolveGameOpenedExtraDirReplay,
        resolveRecentlyOpenedReplayPath,
        tryHoldCurrentExtraDirSession,
        readCacheLiveActivePath,
        pickReplayFromSignals,
        returnPlaybackPick
    };
}

module.exports = { createReplayDetection };
