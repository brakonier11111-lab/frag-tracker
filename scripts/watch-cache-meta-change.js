'use strict';
/**
 * ЭКСПЕРИМЕНТ (read-only): проверяем, можно ли надёжно определить «какой реплей
 * открыл пользователь» по ИЗМЕНЕНИЮ записи в game cache, а не по времени файла.
 *
 * Каждую секунду читаем replay_*.dat, и если meta-хеш какой-то записи изменился
 * с прошлого тика — печатаем её (= игра только что тронула этот реплей). Сравни
 * с тем, что ты реально открыл: если печатает ровно твой файл — сигнал чистый и
 * можно строить на нём надёжный детект.
 *
 * Запуск:  node scripts/watch-cache-meta-change.js
 * Останов: Ctrl+C (или сам остановится через 5 минут)
 */

const fs = require('fs');
const path = require('path');
const {
    replayBasenameKey,
    replayCacheDir,
    listReplayCacheFiles,
    parseCacheEntries,
    replayPathExists
} = require('../src/modules/replay-live/replayCache');

const APP_ROOT = path.join(__dirname, '..');

function loadConfig() {
    const candidates = [
        path.join(process.env.APPDATA || '', 'frag-tracker', 'replay-live-config.json'),
        path.join(APP_ROOT, 'replay-live-config.json')
    ];
    for (const p of candidates) {
        if (p && fs.existsSync(p)) {
            try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { /* next */ }
        }
    }
    return {};
}

const cfg = loadConfig();
const extraDirs = (cfg.extraReplaysDirs || []).filter(Boolean);

function isInExtraDir(replayPath) {
    const key = replayBasenameKey(path.basename(replayPath));
    for (const dir of extraDirs) {
        try {
            for (const name of fs.readdirSync(dir)) {
                if (replayBasenameKey(name) === key) return path.join(dir, name);
            }
        } catch (e) { /* skip */ }
    }
    return '';
}

function now() {
    return new Date().toTimeString().slice(0, 8);
}

let prev = new Map();      // replayPath -> metaHex
let firstPoll = true;
let lastCacheMtime = 0;

console.log('Слежу за game cache:', replayCacheDir(cfg.replaysDir));
console.log('extraReplaysDirs:', extraDirs);
console.log('\nОткрой реплей в игре. Жду изменений записей в кэше...\n');

function tick() {
    const files = listReplayCacheFiles(cfg.replaysDir);
    if (!files.length) return;
    const cacheMtime = files[0].mtime;
    let buf;
    try { buf = fs.readFileSync(files[0].full); } catch (e) { return; }

    const entries = parseCacheEntries(buf);
    const cur = new Map();
    for (const e of entries) cur.set(e.replayPath, e.metaHex);

    if (firstPoll) {
        prev = cur;
        firstPoll = false;
        lastCacheMtime = cacheMtime;
        return;
    }

    const changed = [];
    for (const [rp, hex] of cur) {
        if (prev.get(rp) !== hex) changed.push(rp);
    }

    if (changed.length) {
        const cacheFresh = cacheMtime !== lastCacheMtime;
        console.log(`[${now()}] кэш ${cacheFresh ? 'ОБНОВИЛСЯ' : 'тот же mtime'} | изменённых записей: ${changed.length}`);
        for (const rp of changed) {
            const extra = isInExtraDir(rp);
            const tag = extra ? '  ← В Downloads (кандидат)' : '';
            console.log('   • ' + path.basename(rp).slice(0, 60) + tag);
        }
        console.log('');
    }

    prev = cur;
    lastCacheMtime = cacheMtime;
}

const timer = setInterval(tick, 1000);
setTimeout(() => {
    clearInterval(timer);
    console.log('\n5 минут прошло, останавливаюсь. Перезапусти при необходимости.');
    process.exit(0);
}, 5 * 60 * 1000);
