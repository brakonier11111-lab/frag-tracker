'use strict';

const fs = require('fs');
const path = require('path');
function normalizeReplayDirs(replaysDirOrDirs) {
    if (Array.isArray(replaysDirOrDirs)) {
        return replaysDirOrDirs.filter(Boolean);
    }
    return replaysDirOrDirs ? [replaysDirOrDirs] : [];
}

function listReplayZipFiles(replaysDirOrDirs) {
    const out = [];
    for (const replaysDir of normalizeReplayDirs(replaysDirOrDirs)) {
        if (!fs.existsSync(replaysDir)) continue;
        for (const name of fs.readdirSync(replaysDir)) {
            if (!name.endsWith('.tbreplay') || name.startsWith('recording_')) continue;
            const full = path.join(replaysDir, name);
            try {
                const stat = fs.statSync(full);
                if (stat.isFile() && stat.size > 50000) out.push(full);
            } catch (_) { /* noop */ }
        }
    }
    return out;
}

function touchMs(stat) {
    return Math.max(stat.atimeMs || 0, stat.mtimeMs || 0);
}

function createReplayAccessTracker() {
    const touchByPath = new Map();
    let activePath = '';
    let activeSince = 0;
    let bootstrapped = false;

    function bootstrap(replaysDirOrDirs) {
        if (bootstrapped) return;
        bootstrapped = true;
        for (const full of listReplayZipFiles(replaysDirOrDirs)) {
            try {
                const stat = fs.statSync(full);
                touchByPath.set(full, touchMs(stat));
            } catch (_) { /* noop */ }
        }
    }

    function resolve(replaysDirOrDirs, options) {
        options = options || {};
        const accessMs = Math.max(30_000, Number(options.accessMs) || 5 * 60 * 1000);
        const sessionMs = Math.max(5 * 60_000, Number(options.sessionMs) || 45 * 60 * 1000);
        const minDeltaMs = Number(options.minDeltaMs) || 250;
        const now = Date.now();

        bootstrap(replaysDirOrDirs);

        const increases = [];
        for (const full of listReplayZipFiles(replaysDirOrDirs)) {
            try {
                const stat = fs.statSync(full);
                const touch = touchMs(stat);
                const prev = touchByPath.has(full) ? touchByPath.get(full) : touch;
                const increased = touch > prev + minDeltaMs;
                touchByPath.set(full, touch);
                if (increased) {
                    increases.push({
                        path: full,
                        touch,
                        prev,
                        deltaMs: touch - prev
                    });
                }
            } catch (_) { /* noop */ }
        }

        let bestIncrease = null;
        if (increases.length >= 1) {
            increases.sort((a, b) => b.deltaMs - a.deltaMs || b.touch - a.touch);
            const top = increases[0];
            if (top.deltaMs >= minDeltaMs) {
                bestIncrease = top;
                const preferPath = String(options.preferPath || '').trim();
                if (preferPath) {
                    const preferTouch = touchByPath.get(preferPath) || 0;
                    const preferLive = (now - preferTouch) <= accessMs;
                    if (preferLive && top.path !== preferPath) {
                        activePath = preferPath;
                        activeSince = activeSince || now;
                        bestIncrease = increases.find((row) => row.path === preferPath) || null;
                    } else {
                        activePath = top.path;
                        activeSince = now;
                    }
                } else {
                    activePath = top.path;
                    activeSince = now;
                }
            }
        }

        if (!activePath) {
            return {
                replayPath: '',
                isActive: false,
                reason: 'no_selection',
                freshSpike: null,
                bootstrapped
            };
        }

        const lastTouch = touchByPath.get(activePath) || 0;
        const accessAgeMs = now - lastTouch;
        const fileLive = accessAgeMs <= accessMs;

        if (!fileLive) {
            activePath = '';
            activeSince = 0;
            return {
                replayPath: '',
                isActive: false,
                reason: 'access_stale',
                freshSpike: null,
                bootstrapped
            };
        }

        return {
            replayPath: activePath,
            isActive: Boolean(bestIncrease),
            reason: bestIncrease ? 'access_spike' : 'access_live',
            source: 'access_tracker',
            accessAgeMs,
            sessionAgeMs: now - activeSince,
            freshSpike: bestIncrease,
            lastIncrease: bestIncrease
                ? {
                    path: bestIncrease.path,
                    file: path.basename(bestIncrease.path),
                    deltaMs: bestIncrease.deltaMs
                }
                : null,
            bootstrapped
        };
    }

    function reset() {
        touchByPath.clear();
        activePath = '';
        activeSince = 0;
        bootstrapped = false;
    }

    function syncPreferPath(replayPath) {
        const nextPath = String(replayPath || '').trim();
        if (!nextPath) return;
        activePath = nextPath;
        activeSince = Date.now();
        try {
            const stat = fs.statSync(nextPath);
            touchByPath.set(nextPath, touchMs(stat));
        } catch (_) { /* noop */ }
    }

    return { resolve, reset, syncPreferPath };
}

module.exports = {
    createReplayAccessTracker,
    listReplayZipFiles
};
