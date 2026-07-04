'use strict';
/**
 * HTTP-роуты и страницы replay-live. Логики здесь нет — всё делегируется
 * в index.js через api. config/state/playbackSession внутри модуля
 * переприсваиваются (saveConfig, emptyState), поэтому передаются геттерами,
 * а не прямыми ссылками.
 */

const fs = require('fs');
const path = require('path');

function createReplayLiveRoutes(api) {
    function registerRoutes(app) {
        app.get('/api/replay-live', (req, res) => {
            res.json({ success: true, data: api.getState() });
        });

        app.get('/api/replay-live/config', (req, res) => {
            res.json({ success: true, config: api.getConfig() });
        });

        app.get('/api/replay-live/replays-list', (req, res) => {
            const items = api.listReplayZipCandidates({ minSize: 50000 })
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
            const result = api.activateManualReplayPath(replayPath, { reason: 'manual_play' });
            if (!result.ok) {
                return res.status(400).json({ success: false, error: result.error || 'invalid_path' });
            }
            res.json({ success: true, path: result.path, data: api.getState() });
        });

        app.put('/api/replay-live/config', (req, res) => {
            const body = req.body || {};
            const config = api.getConfig();
            const prevManualPath = (config.playbackReplayPath || '').trim();
            const next = api.saveConfig({
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
                && api.normalizedReplayPath(nextManualPath) !== api.normalizedReplayPath(prevManualPath)) {
                api.activateManualReplayPath(nextManualPath, {
                    reason: 'config_manual_path',
                    persist: false
                });
            } else {
                api.startWatcher();
                api.poll();
            }
            res.json({ success: true, config: next, data: api.getState() });
        });

        app.post('/api/replay-live/refresh', (req, res) => {
            const body = req.body || {};
            if (body.resetTracker || req.query.reset === '1') {
                api.resetTrackers();
            }
            if (body.resetPlaybackClock || req.query.rewind === '1') {
                api.resetPlaybackClock();
                const state = api.getInternalState();
                if (state.playbackTimeline) {
                    state.playbackTimeline.startedAt = api.getPlaybackSession().startedAt;
                    state.playbackTimeline.rewindAt = Date.now();
                }
            }
            api.poll();
            res.json({ success: true, data: api.getState() });
        });
    }

    function sendPublicNoCache(res, ...parts) {
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.sendFile(path.join(api.appRoot, 'public', ...parts));
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

    return { registerRoutes, registerPages };
}

module.exports = { createReplayLiveRoutes };
