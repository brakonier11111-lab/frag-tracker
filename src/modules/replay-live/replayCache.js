'use strict';

const fs = require('fs');
const path = require('path');

const PATH_RE = /C:[/\\]Users[/\\][^/\0\n\r]+[/\\]Documents[/\\]TanksBlitz[/\\]replays[/\\][^\0\n\r]{5,220}?\.tbrepla(?:y)?/gi;
const CACHE_PATH_RE = /C:\/Users\/[^\0\n\r]+?\.tbreplay(?:\.bin)?/g;

function parseCacheEntryMap(buf) {
    return new Map(parseCacheEntries(buf).map((row) => [row.replayPath, row.metaHex]));
}

function parseCacheEntries(buf) {
    const entries = [];
    let match;
    CACHE_PATH_RE.lastIndex = 0;
    while ((match = CACHE_PATH_RE.exec(buf.toString('latin1'))) !== null) {
        const replayPath = normalizeReplayPath(match[0]);
        if (!isReplayArchivePath(replayPath)) continue;
        const end = match.index + match[0].length;
        const metaBuf = buf.subarray(end, end + 48);
        entries.push({
            replayPath,
            metaHex: metaBuf.toString('hex'),
            metaTs: metaBuf.length >= 12 ? metaBuf.readUInt32LE(8) : 0
        });
    }
    return entries;
}

function pickNewestSessionAmong(buf, replayPaths) {
    const allow = new Set(replayPaths);
    const entries = parseCacheEntries(buf)
        .filter((row) => allow.has(row.replayPath) && replayPathExists(row.replayPath))
        .map((row) => {
            const metaBuf = Buffer.from(row.metaHex, 'hex');
            return {
                replayPath: row.replayPath,
                sessionKey: metaBuf.readUInt32LE(0)
            };
        })
        .sort((a, b) => b.sessionKey - a.sessionKey);
    return entries[0] ? entries[0].replayPath : '';
}

function collectZipTouchIncreases(replayPaths, lastZipTouch, minDeltaMs) {
    const increases = [];
    for (const replayPath of replayPaths) {
        const activity = getReplayFileActivity(replayPath);
        if (!activity.exists || activity.lastTouchMs == null) continue;
        const touch = activity.lastTouchMs;
        const prev = lastZipTouch.has(replayPath) ? lastZipTouch.get(replayPath) : touch;
        lastZipTouch.set(replayPath, touch);
        if (touch > prev + minDeltaMs) {
            increases.push({
                replayPath,
                touch,
                delta: touch - prev
            });
        }
    }
    increases.sort((a, b) => b.delta - a.delta || b.touch - a.touch);
    return increases;
}

function readActiveReplayFromCache(cacheFilePathOrBuf) {
    try {
        const buf = Buffer.isBuffer(cacheFilePathOrBuf)
            ? cacheFilePathOrBuf
            : fs.readFileSync(cacheFilePathOrBuf);
        const entries = parseCacheEntries(buf)
            .filter((row) => replayPathExists(row.replayPath))
            .map((row) => {
                const metaBuf = Buffer.from(row.metaHex, 'hex');
                return Object.assign({}, row, { metaKey: metaBuf.readUInt32LE(0) });
            })
            .sort((a, b) => b.metaKey - a.metaKey || b.metaHex.localeCompare(a.metaHex));
        return entries[0] ? entries[0].replayPath : null;
    } catch (_) {
        return null;
    }
}

function findRecentlyAccessedAmong(replayPaths, maxAgeMs) {
    let best = null;
    for (const replayPath of replayPaths) {
        const activity = getReplayFileActivity(replayPath);
        if (!activity.exists || activity.ageMs == null || activity.ageMs > maxAgeMs) continue;
        const lastTouchMs = activity.lastTouchMs || 0;
        if (!best || lastTouchMs > (best.lastTouchMs || 0)) {
            best = {
                replayPath,
                ageMs: activity.ageMs,
                lastTouchMs
            };
        }
    }
    return best;
}

function findRecentReplayFromGameCache(replaysDir, maxAgeMs) {
    const files = listReplayCacheFiles(replaysDir);
    if (!files.length) return null;
    try {
        const buf = fs.readFileSync(files[0].full);
        const paths = parseCacheEntries(buf).map((row) => row.replayPath);
        return findRecentlyAccessedAmong(paths, maxAgeMs);
    } catch (_) {
        return null;
    }
}

function replayCacheDir(replaysDir) {
    return path.join(path.dirname(replaysDir), 'cache');
}

function normalizeReplayPath(raw) {
    if (!raw) return '';
    let replayPath = String(raw).replace(/\0/g, '').trim();
    if (replayPath.endsWith('.tbrepla')) replayPath += 'y';
    return path.normalize(replayPath);
}

function replayBasenameKey(name) {
    return String(name || '').toLowerCase()
        .replace(/\.tbreplay\.bin$/i, '')
        .replace(/\.tbreplay$/i, '')
        .replace(/\s*\(\d+\)\s*$/, '')
        .trim();
}

function isReplayArchiveName(name) {
    const n = String(name || '').toLowerCase();
    if (!n || n.startsWith('recording_')) return false;
    return n.endsWith('.tbreplay') || n.endsWith('.tbreplay.bin');
}

function isReplayArchivePath(replayPath) {
    return isReplayArchiveName(path.basename(String(replayPath || '')));
}

function replayArchiveBasename(replayPath) {
    let base = path.basename(String(replayPath || ''));
    base = base.replace(/\.tbreplay\.bin$/i, '');
    base = base.replace(/\.tbreplay$/i, '');
    return base;
}

function replayPathExists(replayPath) {
    if (!replayPath) return false;
    if (fs.existsSync(replayPath)) return true;
    const alt = replayPath.replace(/\//g, '\\');
    return alt !== replayPath && fs.existsSync(alt);
}

function listReplayCacheFiles(replaysDir) {
    const dir = replayCacheDir(replaysDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((name) => /^replay_.+L\.dat$/i.test(name))
        .map((name) => {
            const full = path.join(dir, name);
            try {
                const stat = fs.statSync(full);
                return stat.isFile() ? { full, name, mtime: stat.mtimeMs, size: stat.size } : null;
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
}

function extractReplayPaths(buf) {
    const text = buf.toString('latin1');
    const paths = [];
    let match;
    PATH_RE.lastIndex = 0;
    while ((match = PATH_RE.exec(text)) !== null) {
        const replayPath = normalizeReplayPath(match[0]);
        if (isReplayArchivePath(replayPath)) paths.push(replayPath);
    }
    return paths;
}

function readLastReplayFromCache(cacheFilePath) {
    try {
        const buf = fs.readFileSync(cacheFilePath);
        const paths = extractReplayPaths(buf);
        if (!paths.length) return null;
        for (let i = paths.length - 1; i >= 0; i -= 1) {
            if (replayPathExists(paths[i])) return paths[i];
        }
        return null;
    } catch (_) {
        return null;
    }
}

function getReplayFileActivity(replayPath) {
    if (!replayPathExists(replayPath)) {
        return { exists: false, ageMs: null, atimeMs: null, mtimeMs: null, lastTouchMs: null };
    }
    try {
        const normalized = path.normalize(replayPath);
        const stat = fs.statSync(normalized);
        const atimeMs = stat.atimeMs || stat.mtimeMs;
        const mtimeMs = stat.mtimeMs;
        const lastTouchMs = Math.max(atimeMs, mtimeMs);
        return {
            exists: true,
            ageMs: Date.now() - lastTouchMs,
            atimeMs,
            mtimeMs,
            lastTouchMs
        };
    } catch (err) {
        return { exists: false, ageMs: null, error: err.message };
    }
}

function findRecentlyAccessedReplay(replaysDir, accessMs, options) {
    options = options || {};
    const minSize = options.minSize == null ? 50000 : options.minSize;
    if (!fs.existsSync(replaysDir)) return null;

    const now = Date.now();
    let best = null;

    let names;
    try {
        names = fs.readdirSync(replaysDir);
    } catch (_) {
        return null;
    }

    for (const name of names) {
        if (!isReplayArchiveName(name)) continue;
        const full = path.join(replaysDir, name);
        try {
            const stat = fs.statSync(full);
            if (!stat.isFile() || stat.size < minSize) continue;
            const lastTouchMs = Math.max(stat.atimeMs || 0, stat.mtimeMs || 0);
            const ageMs = now - lastTouchMs;
            if (ageMs > accessMs) continue;
            if (!best || lastTouchMs > best.lastTouchMs) {
                best = {
                    replayPath: full,
                    lastTouchMs,
                    ageMs,
                    atimeMs: stat.atimeMs,
                    mtimeMs: stat.mtimeMs
                };
            }
        } catch (_) { /* noop */ }
    }

    return best;
}

const ZIP_ACTIVE_MS = 60 * 1000;
const MULTI_META_ZIP_MS = 90 * 1000;

function isReplayZipLive(activity, liveMs) {
    return Boolean(activity.exists && activity.ageMs != null && activity.ageMs <= liveMs);
}

function pickChangedByZipAccess(replayPaths, maxAgeMs) {
    const recent = findRecentlyAccessedAmong(replayPaths, maxAgeMs);
    return recent ? recent.replayPath : '';
}

function createReplayCacheDiffTracker() {
    let bootstrapped = false;
    let lastEntries = new Map();
    let lastZipTouch = new Map();
    let lastSelectedPath = '';
    let sessionMetaAt = 0;
    let lastCacheMtimeMs = 0;

    function resolve(replaysDir, options) {
        options = options || {};
        const zipActiveMs = Math.max(15_000, Number(options.zipActiveMs) || ZIP_ACTIVE_MS);
        const sessionMetaTtlMs = Math.max(60_000, Number(options.sessionMetaTtlMs) || 5 * 60 * 1000);
        const multiMetaZipMs = Math.max(zipActiveMs, Number(options.multiMetaZipMs) || MULTI_META_ZIP_MS);
        const zipMinDeltaMs = Math.max(100, Number(options.zipMinDeltaMs) || 250);

        const files = listReplayCacheFiles(replaysDir);
        if (!files.length) {
            return {
                replayPath: '',
                isActive: false,
                reason: 'no_cache',
                bootstrapped
            };
        }

        const cacheFile = files[0];
        let stat;
        let buf;
        try {
            stat = fs.statSync(cacheFile.full);
            buf = fs.readFileSync(cacheFile.full);
        } catch (_) {
            return {
                replayPath: '',
                isActive: false,
                reason: 'cache_read_error',
                bootstrapped
            };
        }

        const current = parseCacheEntryMap(buf);
        const cacheAgeMs = Date.now() - stat.mtimeMs;
        const activeByMeta = readActiveReplayFromCache(buf);
        const metaChanges = [];
        const wasBootstrapped = bootstrapped;
        const cachePaths = [...current.keys()];

        if (bootstrapped) {
            for (const [replayPath, meta] of current.entries()) {
                const prevMeta = lastEntries.get(replayPath);
                if (prevMeta == null || prevMeta !== meta) {
                    metaChanges.push(replayPath);
                }
            }
        } else {
            for (const replayPath of cachePaths) {
                const activity = getReplayFileActivity(replayPath);
                if (activity.exists && activity.lastTouchMs != null) {
                    lastZipTouch.set(replayPath, activity.lastTouchMs);
                }
            }
        }

        const zipIncreases = bootstrapped
            ? collectZipTouchIncreases(cachePaths, lastZipTouch, zipMinDeltaMs)
            : [];

        lastEntries = current;
        bootstrapped = true;

        let pick = '';
        let reason = 'cache_idle';

        const cacheMtimeMs = stat.mtimeMs;
        const cacheTouched = wasBootstrapped
            && lastCacheMtimeMs > 0
            && cacheMtimeMs > lastCacheMtimeMs + zipMinDeltaMs;
        lastCacheMtimeMs = cacheMtimeMs;

        function pickOpenReplayFromCache() {
            if (!activeByMeta || !replayPathExists(activeByMeta)) return '';
            if (cacheAgeMs <= 2 * 60 * 1000) return activeByMeta;
            const activity = getReplayFileActivity(activeByMeta);
            if (isReplayZipLive(activity, zipActiveMs)) return activeByMeta;
            if (cacheAgeMs <= Math.max(sessionMetaTtlMs, 5 * 60 * 1000)) return activeByMeta;
            return '';
        }

        if (!wasBootstrapped) {
            pick = pickOpenReplayFromCache();
            reason = pick ? 'cache_boot_active' : 'cache_boot_wait';
        } else {
            const switchMeta = metaChanges.filter((replayPath) => replayPath !== lastSelectedPath);

            if (cacheTouched && activeByMeta && replayPathExists(activeByMeta)) {
                pick = activeByMeta;
                reason = 'cache_file_touch';
            } else if (switchMeta.length === 1) {
                pick = switchMeta[0];
                reason = 'cache_switch';
            } else if (switchMeta.length > 1) {
                pick = pickNewestSessionAmong(buf, switchMeta)
                    || pickChangedByZipAccess(switchMeta, multiMetaZipMs);
                reason = pick ? 'cache_switch_multi' : 'cache_ambiguous';
            } else if (metaChanges.length === 1 && metaChanges[0] === lastSelectedPath) {
                pick = lastSelectedPath;
                reason = 'cache_meta_pos';
            } else if (lastSelectedPath && metaChanges.includes(lastSelectedPath)) {
                pick = lastSelectedPath;
                reason = 'cache_meta_pos';
            } else if (zipIncreases.length === 1) {
                pick = zipIncreases[0].replayPath;
                reason = 'cache_zip_spike';
            } else if (zipIncreases.length > 1) {
                const notCurrent = lastSelectedPath
                    ? zipIncreases.filter((row) => row.replayPath !== lastSelectedPath)
                    : zipIncreases;
                const spike = (notCurrent.length ? notCurrent : zipIncreases)[0];
                if (spike) {
                    pick = spike.replayPath;
                    reason = 'cache_zip_spike_multi';
                }
            } else if (lastSelectedPath && sessionMetaAt > 0
                && (Date.now() - sessionMetaAt) <= sessionMetaTtlMs) {
                pick = lastSelectedPath;
                reason = 'cache_session';
            } else if (lastSelectedPath) {
                const activity = getReplayFileActivity(lastSelectedPath);
                if (isReplayZipLive(activity, zipActiveMs)) {
                    pick = lastSelectedPath;
                    reason = 'cache_hold';
                }
            } else if (metaChanges.length === 1) {
                pick = metaChanges[0];
                reason = 'cache_meta';
            }
        }

        if (!pick) {
            pick = pickOpenReplayFromCache();
            if (pick) reason = 'cache_active_read';
        }

        if (pick && replayPathExists(pick)) {
            lastSelectedPath = pick;
            if (metaChanges.includes(pick)
                || reason === 'cache_meta_pos'
                || reason === 'cache_session'
                || reason === 'cache_hold'
                || reason === 'cache_zip_spike'
                || reason === 'cache_zip_spike_multi'
                || reason === 'cache_meta'
                || reason === 'cache_switch'
                || reason === 'cache_switch_multi'
                || reason === 'cache_boot_active'
                || reason === 'cache_active_read'
                || reason === 'cache_file_touch') {
                sessionMetaAt = Date.now();
            }
            const activity = getReplayFileActivity(pick);
            const pickLive = isReplayZipLive(activity, zipActiveMs);
            const weakReason = reason === 'cache_session'
                || reason === 'cache_hold'
                || reason === 'cache_active_read'
                || reason === 'cache_boot_wait'
                || reason === 'cache_idle';
            if (!pickLive && weakReason) {
                return {
                    replayPath: '',
                    isActive: false,
                    reason: 'cache_stale',
                    source: 'cache_diff',
                    cacheFile: cacheFile.name,
                    cacheAgeMs,
                    changedCount: metaChanges.length,
                    zipSpikes: zipIncreases.length,
                    activeReplay: activeByMeta ? path.basename(activeByMeta) : '',
                    stalePick: path.basename(pick),
                    bootstrapped
                };
            }
            return {
                replayPath: pick,
                isActive: true,
                reason,
                source: 'cache_diff',
                cacheFile: cacheFile.name,
                cacheAgeMs,
                changedCount: metaChanges.length,
                zipSpikes: zipIncreases.length,
                activeReplay: activeByMeta ? path.basename(activeByMeta) : '',
                bootstrapped
            };
        }

        lastSelectedPath = '';
        sessionMetaAt = 0;
        return {
            replayPath: '',
            isActive: false,
            reason: metaChanges.length ? 'cache_ambiguous' : reason,
            source: 'cache_diff',
            cacheFile: cacheFile.name,
            cacheAgeMs,
            changedCount: metaChanges.length,
            zipSpikes: zipIncreases.length,
            activeReplay: activeByMeta ? path.basename(activeByMeta) : '',
            bootstrapped
        };
    }

    function syncSelection(replayPath) {
        if (!replayPath) return;
        if (lastSelectedPath !== replayPath) {
            lastSelectedPath = replayPath;
        }
    }

    function reset() {
        bootstrapped = false;
        lastEntries = new Map();
        lastZipTouch = new Map();
        lastSelectedPath = '';
        sessionMetaAt = 0;
        lastCacheMtimeMs = 0;
    }

    return { resolve, reset, syncSelection };
}

function resolveReplayFromGameCache(replaysDir, options) {
    options = options || {};
    const accessMs = Math.max(30_000, Number(options.accessMs) || 5 * 60 * 1000);
    const freshnessMs = Math.max(60_000, Number(options.freshnessMs) || 15 * 60 * 1000);

    const files = listReplayCacheFiles(replaysDir);
    if (files.length) {
        const newest = files[0];
        const cacheAge = Date.now() - newest.mtime;
        const activePath = readActiveReplayFromCache(newest.full);
        if (activePath) {
            const activity = getReplayFileActivity(activePath);
            const zipRecent = activity.exists && activity.ageMs != null && activity.ageMs <= accessMs;
            const cacheFresh = cacheAge <= freshnessMs;
            if (cacheFresh || zipRecent) {
                return {
                    replayPath: activePath,
                    source: cacheFresh ? 'game_cache_active' : 'cache_active_zip',
                    cacheFile: newest.full,
                    cacheMtime: newest.mtime,
                    cacheAgeMs: cacheAge,
                    isFresh: cacheFresh,
                    zipRecentlyUsed: zipRecent,
                    zipAccessAgeMs: activity.ageMs,
                    zipAtimeMs: activity.atimeMs,
                    zipMtimeMs: activity.mtimeMs,
                    isActive: true
                };
            }
        }
    }

    const byAccess = findRecentReplayFromGameCache(replaysDir, accessMs);
    if (byAccess) {
        return {
            replayPath: byAccess.replayPath,
            source: 'cache_zip',
            cacheFile: '',
            cacheMtime: 0,
            cacheAgeMs: null,
            isFresh: true,
            zipRecentlyUsed: true,
            zipAccessAgeMs: byAccess.ageMs,
            zipAtimeMs: null,
            zipMtimeMs: null,
            isActive: true
        };
    }

    return null;
}

function readReplayCacheEntry(replaysDir, replayPath) {
    if (!replayPath) return null;
    const files = listReplayCacheFiles(replaysDir);
    if (!files.length) return null;

    let buf;
    try {
        buf = fs.readFileSync(files[0].full);
    } catch (_) {
        return null;
    }

    const normalizedPath = path.normalize(replayPath).toLowerCase();
    const baseKey = replayBasenameKey(path.basename(replayPath));
    let entry = parseCacheEntries(buf).find((row) => (
        path.normalize(row.replayPath).toLowerCase() === normalizedPath
    ));
    if (!entry) {
        entry = parseCacheEntries(buf).find((row) => (
            replayBasenameKey(path.basename(row.replayPath)) === baseKey
        ));
    }
    if (!entry) return null;

    const metaBuf = Buffer.from(entry.metaHex, 'hex');
    return {
        cacheFile: files[0].name,
        replayPath: entry.replayPath,
        metaHex: entry.metaHex,
        metaBuf,
        sessionKey: metaBuf.length >= 4 ? metaBuf.readUInt32LE(0) : 0,
        metaTs: metaBuf.length >= 12 ? metaBuf.readUInt32LE(8) : 0
    };
}

function inspectReplayMeta(metaBuf, replayDurationSec) {
    if (!metaBuf || !metaBuf.length) return null;
    const slots = [];
    for (let off = 0; off + 4 <= metaBuf.length; off += 4) {
        const asFloat = metaBuf.readFloatLE(off);
        slots.push({
            off,
            u32: metaBuf.readUInt32LE(off),
            float: Number.isFinite(asFloat) ? Math.round(asFloat * 1000) / 1000 : null
        });
    }
    return {
        len: metaBuf.length,
        hex: metaBuf.toString('hex'),
        sessionKey: metaBuf.length >= 4 ? metaBuf.readUInt32LE(0) : null,
        metaTs: metaBuf.length >= 12 ? metaBuf.readUInt32LE(8) : null,
        parsedPosition: parseReplayPositionFromMeta(metaBuf, replayDurationSec),
        slots
    };
}

function parseReplayPositionFromMeta(metaBuf, replayDurationSec) {
    if (!metaBuf || metaBuf.length < 16) return null;
    const maxSec = replayDurationSec > 0 ? replayDurationSec + 5 : 600;

    function acceptSeconds(value) {
        if (!Number.isFinite(value) || value < 0 || value > maxSec) return null;
        if (value >= 0.05) return Math.round(value * 10) / 10;
        return null;
    }

    const preferred = acceptSeconds(metaBuf.readFloatLE(24));
    if (preferred != null) return preferred;

    const floatCandidates = [];
    for (let off = 4; off + 4 <= metaBuf.length; off += 4) {
        if (off === 24) continue;
        const value = acceptSeconds(metaBuf.readFloatLE(off));
        if (value != null) floatCandidates.push({ off, value });
    }
    if (floatCandidates.length === 1) return floatCandidates[0].value;
    if (floatCandidates.length > 1) {
        const at24 = floatCandidates.find((row) => row.off === 24);
        if (at24) return at24.value;
        floatCandidates.sort((a, b) => a.value - b.value);
        return floatCandidates[0].value;
    }

    return null;
}

function diffMetaReplayPosition(oldMetaHex, newMetaHex, replayDurationSec) {
    if (!oldMetaHex || !newMetaHex || oldMetaHex === newMetaHex) return null;

    const oldBuf = Buffer.from(oldMetaHex, 'hex');
    const newBuf = Buffer.from(newMetaHex, 'hex');
    const maxSec = replayDurationSec > 0 ? replayDurationSec + 5 : 600;
    let best = null;

    for (let off = 0; off < Math.min(oldBuf.length, newBuf.length) - 3; off += 4) {
        if (oldBuf.readUInt32LE(off) === newBuf.readUInt32LE(off)) continue;

        const value = newBuf.readFloatLE(off);
        const prev = oldBuf.readFloatLE(off);
        if (!Number.isFinite(value) || value < 0 || value > maxSec) continue;
        if (!Number.isFinite(prev)) continue;

        const delta = value - prev;
        if (delta < -2 || delta > 45) continue;
        if (value < 0.05 && off !== 24) continue;

        if (best == null || off === 24 || Math.abs(delta) < Math.abs(best.delta)) {
            best = { off, value: Math.round(value * 10) / 10, delta };
        }
    }

    return best ? best.value : null;
}

module.exports = {
    replayBasenameKey,
    isReplayArchiveName,
    isReplayArchivePath,
    replayArchiveBasename,
    replayCacheDir,
    listReplayCacheFiles,
    readLastReplayFromCache,
    readActiveReplayFromCache,
    findRecentlyAccessedAmong,
    findRecentReplayFromGameCache,
    resolveReplayFromGameCache,
    createReplayCacheDiffTracker,
    parseCacheEntryMap,
    parseCacheEntries,
    findRecentlyAccessedReplay,
    getReplayFileActivity,
    extractReplayPaths,
    replayPathExists,
    readReplayCacheEntry,
    parseReplayPositionFromMeta,
    inspectReplayMeta,
    diffMetaReplayPosition
};
