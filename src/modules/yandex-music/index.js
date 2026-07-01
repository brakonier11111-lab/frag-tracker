'use strict';

const crypto = require('crypto');
const path = require('path');
const { readYandexMusicNowPlaying, readYandexMusicArt, DEFAULT_APP_IDS } = require('./windowsMedia');

const MODULE_VERSION = 'yandex-music-v2-art';
const DEFAULT_POLL_MS = 1500;

function createYandexMusicModule(deps) {
    let timer = null;
    let polling = false;
    let artPolling = false;
    let config = {
        enabled: true,
        pollIntervalMs: DEFAULT_POLL_MS,
        appIds: DEFAULT_APP_IDS.slice(),
        showWhenPaused: true
    };
    let state = emptyState();
    let artCache = {
        trackKey: '',
        token: '',
        contentType: 'image/jpeg',
        bytes: null,
        updatedAt: null
    };

    function emptyState() {
        return {
            active: false,
            playing: false,
            paused: false,
            status: 'idle',
            title: '',
            artist: '',
            album: '',
            appId: '',
            label: '',
            hasArt: false,
            artToken: '',
            updatedAt: new Date().toISOString(),
            error: null
        };
    }

    function buildLabel(now) {
        if (!now || !now.active) return '';
        const artist = String(now.artist || '').trim();
        const title = String(now.title || '').trim();
        if (artist && title) return `${artist} — ${title}`;
        return title || artist || '';
    }

    function buildTrackKey(now) {
        if (!now || !now.active) return '';
        return [now.appId, now.title, now.artist, now.album].map((x) => String(x || '').trim()).join('\u0001');
    }

    function makeArtToken(trackKey, bytes) {
        return crypto.createHash('sha1').update(trackKey).update(bytes || Buffer.alloc(0)).digest('hex').slice(0, 12);
    }

    function clearArtCache() {
        artCache = {
            trackKey: '',
            token: '',
            contentType: 'image/jpeg',
            bytes: null,
            updatedAt: null
        };
    }

    async function refreshArtForTrack(trackKey) {
        if (!trackKey || artPolling) return;
        if (artCache.trackKey === trackKey && artCache.bytes) return;

        artPolling = true;
        try {
            const art = await readYandexMusicArt({ appIds: config.appIds });
            if (!art.ok || !art.bytes || !art.bytes.length) {
                if (artCache.trackKey !== trackKey) {
                    artCache = {
                        trackKey,
                        token: '',
                        contentType: 'image/jpeg',
                        bytes: null,
                        updatedAt: new Date().toISOString()
                    };
                }
                return;
            }
            artCache = {
                trackKey,
                token: makeArtToken(trackKey, art.bytes),
                contentType: art.contentType || 'image/jpeg',
                bytes: art.bytes,
                updatedAt: new Date().toISOString()
            };
            if (state.active && buildTrackKey(state) === trackKey) {
                state = Object.assign({}, state, {
                    hasArt: true,
                    artToken: artCache.token,
                    updatedAt: new Date().toISOString()
                });
            }
        } catch (_) {
            if (artCache.trackKey !== trackKey) {
                artCache = {
                    trackKey,
                    token: '',
                    contentType: 'image/jpeg',
                    bytes: null,
                    updatedAt: new Date().toISOString()
                };
            }
        } finally {
            artPolling = false;
        }
    }

    async function pollOnce() {
        if (polling) return;
        polling = true;
        try {
            const now = await readYandexMusicNowPlaying({ appIds: config.appIds });
            const show = now.active && (now.playing || (config.showWhenPaused && now.paused));
            const trackKey = show ? buildTrackKey(now) : '';

            if (!show) {
                clearArtCache();
            } else if (trackKey && trackKey !== artCache.trackKey) {
                refreshArtForTrack(trackKey);
            }

            state = {
                active: show,
                playing: Boolean(now.playing),
                paused: Boolean(now.paused),
                status: now.status || 'idle',
                title: now.title || '',
                artist: now.artist || '',
                album: now.album || '',
                appId: now.appId || '',
                label: buildLabel(now),
                hasArt: Boolean(artCache.bytes && artCache.trackKey === trackKey),
                artToken: artCache.trackKey === trackKey ? (artCache.token || '') : '',
                updatedAt: new Date().toISOString(),
                error: null
            };
        } catch (err) {
            state = Object.assign({}, state, {
                active: false,
                playing: false,
                paused: false,
                status: 'error',
                hasArt: false,
                artToken: '',
                updatedAt: new Date().toISOString(),
                error: err.message || String(err)
            });
        } finally {
            polling = false;
        }
    }

    function startPolling() {
        stopPolling();
        if (!config.enabled) return;
        pollOnce();
        timer = setInterval(pollOnce, Math.max(800, Number(config.pollIntervalMs) || DEFAULT_POLL_MS));
    }

    function stopPolling() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    function getState() {
        return Object.assign({}, state, {
            moduleVersion: MODULE_VERSION,
            config: {
                enabled: config.enabled,
                pollIntervalMs: config.pollIntervalMs,
                appIds: config.appIds.slice(),
                showWhenPaused: config.showWhenPaused
            }
        });
    }

    function registerRoutes(app) {
        app.get('/api/yandex-music/now-playing', (req, res) => {
            res.json({ success: true, data: getState() });
        });

        app.get('/api/yandex-music/art', (req, res) => {
            const token = String(req.query.t || '').trim();
            if (!token || !artCache.bytes || artCache.token !== token) {
                return res.status(404).end();
            }
            res.setHeader('Content-Type', artCache.contentType || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.send(artCache.bytes);
        });

        app.get('/api/yandex-music/config', (req, res) => {
            res.json({ success: true, config: getState().config });
        });

        app.put('/api/yandex-music/config', require('express').json(), (req, res) => {
            const body = req.body || {};
            if (body.enabled != null) config.enabled = Boolean(body.enabled);
            if (body.pollIntervalMs != null) {
                config.pollIntervalMs = Math.max(800, Number(body.pollIntervalMs) || DEFAULT_POLL_MS);
            }
            if (body.showWhenPaused != null) config.showWhenPaused = Boolean(body.showWhenPaused);
            if (body.appIds != null) {
                config.appIds = Array.isArray(body.appIds)
                    ? body.appIds.map((x) => String(x || '').trim()).filter(Boolean)
                    : String(body.appIds).split(/[\n;,|]+/).map((x) => x.trim()).filter(Boolean);
            }
            startPolling();
            res.json({ success: true, config: getState().config, data: getState() });
        });

        app.post('/api/yandex-music/refresh', async (req, res) => {
            await pollOnce();
            res.json({ success: true, data: getState() });
        });
    }

    function sendPublicNoCache(res, filename) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(path.join(deps.appRoot, 'public', filename));
    }

    function registerPages(app) {
        app.get('/yandex-music', (req, res) => {
            sendPublicNoCache(res, 'yandex-music.html');
        });
        app.get('/widget-yandex-music', (req, res) => {
            sendPublicNoCache(res, 'widget-yandex-music.html');
        });
    }

    function init() {
        if (process.platform !== 'win32') {
            state.error = 'Только Windows (System Media API)';
            return;
        }
        startPolling();
        console.log('[yandex-music] page: /yandex-music · widget: /widget-yandex-music');
    }

    function stop() {
        stopPolling();
    }

    return {
        init,
        stop,
        getState,
        registerRoutes,
        registerPages,
        pollOnce
    };
}

module.exports = { createYandexMusicModule };
