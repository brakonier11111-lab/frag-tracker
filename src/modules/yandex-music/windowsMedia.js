'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_APP_IDS = [
    'ru.yandex.desktop.music',
    'Yandex.Music',
    'YandexMusic'
];

const PS_SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'get-windows-now-playing.ps1');

const MEDIA_ART_CANDIDATES = [
    path.join(__dirname, '..', '..', '..', 'scripts', 'media-art', 'out', 'media-art.exe'),
    path.join(__dirname, '..', '..', '..', 'scripts', 'media-art', 'bin', 'Release', 'net9.0-windows10.0.19041.0', 'win-x64', 'media-art.exe'),
    path.join(__dirname, '..', '..', '..', 'scripts', 'media-art', 'bin', 'Release', 'net8.0-windows10.0.19041.0', 'win-x64', 'media-art.exe')
];

function resolveMediaArtExe() {
    for (const candidate of MEDIA_ART_CANDIDATES) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch (_) { /* noop */ }
    }
    return MEDIA_ART_CANDIDATES[0];
}

const MEDIA_ART_EXE = resolveMediaArtExe();

function normalizeAppIds(list) {
    const seen = new Set();
    const out = [];
    for (const item of (list || DEFAULT_APP_IDS)) {
        const id = String(item || '').trim();
        if (!id) continue;
        const key = id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(id);
    }
    return out.length ? out : DEFAULT_APP_IDS.slice();
}

function matchesAppId(sessionAppId, allowedAppIds) {
    const hay = String(sessionAppId || '').toLowerCase();
    if (!hay) return false;
    return allowedAppIds.some((needle) => {
        const n = String(needle || '').toLowerCase();
        return hay === n || hay.includes(n) || n.includes(hay);
    });
}

function queryWindowsMediaSessions() {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', PS_SCRIPT
        ], {
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
            timeout: 20000,
            windowsHide: true
        }, (err, stdout, stderr) => {
            if (err) {
                const detail = (stderr || err.message || '').trim();
                return reject(new Error(detail || 'windows_media_query_failed'));
            }
            const raw = String(stdout || '').trim();
            if (!raw) return resolve([]);
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) return resolve(parsed);
                if (parsed && typeof parsed === 'object') return resolve([parsed]);
                return resolve([]);
            } catch (parseErr) {
                return reject(new Error(`windows_media_json_parse: ${parseErr.message}`));
            }
        });
    });
}

function pickYandexMusicSession(sessions, allowedAppIds) {
    const allowed = normalizeAppIds(allowedAppIds);
    const matches = (sessions || []).filter((row) => matchesAppId(row.appId, allowed));
    if (!matches.length) return null;

    const score = (row) => {
        const status = String(row.status || '').toLowerCase();
        if (status === 'playing') return 300;
        if (status === 'paused') return 200;
        if (status === 'changing') return 150;
        if (status === 'stopped') return 50;
        return 100;
    };

    return matches.slice().sort((a, b) => score(b) - score(a))[0];
}

function pickPrimaryAppId(options) {
    const ids = normalizeAppIds(options.appIds);
    return ids[0] || DEFAULT_APP_IDS[0];
}

function readYandexMusicArt(options) {
    return new Promise((resolve, reject) => {
        const appId = pickPrimaryAppId(options || {});
        const args = [appId];
        const child = require('child_process').spawn(MEDIA_ART_EXE, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const chunks = [];
        let stderr = '';
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', (spawnErr) => reject(spawnErr));
        child.on('close', (code) => {
            if (code === 2 || code === 3) {
                return resolve({ ok: false, reason: 'no_art' });
            }
            if (code !== 0) {
                const detail = stderr.trim() || `media_art_exit_${code}`;
                return reject(new Error(detail));
            }
            const buf = Buffer.concat(chunks);
            const nl = buf.indexOf(10);
            if (nl <= 0 || nl >= buf.length - 1) {
                return resolve({ ok: false, reason: 'empty_art' });
            }
            const contentType = buf.slice(0, nl).toString('utf8').trim() || 'image/jpeg';
            const bytes = buf.slice(nl + 1);
            if (!bytes.length) {
                return resolve({ ok: false, reason: 'empty_art' });
            }
            resolve({ ok: true, contentType, bytes });
        });
    });
}

async function readYandexMusicNowPlaying(options) {
    options = options || {};
    const sessions = await queryWindowsMediaSessions();
    const row = pickYandexMusicSession(sessions, options.appIds);
    if (!row) {
        return {
            active: false,
            playing: false,
            status: 'idle',
            appId: '',
            title: '',
            artist: '',
            album: ''
        };
    }

    const status = String(row.status || '').toLowerCase();
    const title = String(row.title || '').trim();
    const artist = String(row.artist || '').trim();
    const album = String(row.album || '').trim();
    const hasTrack = Boolean(title || artist);

    return {
        active: hasTrack,
        playing: status === 'playing',
        paused: status === 'paused',
        status: hasTrack ? status : 'idle',
        appId: row.appId || '',
        title,
        artist,
        album
    };
}

module.exports = {
    readYandexMusicNowPlaying,
    readYandexMusicArt,
    queryWindowsMediaSessions,
    normalizeAppIds,
    DEFAULT_APP_IDS
};
