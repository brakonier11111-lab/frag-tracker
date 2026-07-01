'use strict';
/**
 * ЭКСПЕРИМЕНТ (read-only): бывает ли ВТОРОЕ изменение записи в game cache после
 * открытия реплея — например, в момент, когда закончилась загрузка и реально
 * начался бой (а не в момент клика "play" в меню игры)?
 *
 * Мы уже знаем: во время самого просмотра (после начала боя) кэш НЕ обновляется
 * (проверено scripts/watch-active-replay.js — 230с без единого изменения).
 * Вопрос сейчас другой и точнее: есть ли изменения В ОКНЕ ЗАГРУЗКИ — между
 * кликом "play" и стартом боя (обычно первые секунды/десятки секунд)?
 *
 * Запуск:  node scripts/watch-cache-second-write.js
 * Тест:    запусти скрипт, ЗАТЕМ открой реплей и не трогай ничего 20-30 секунд.
 *          Смотри одновременно на экран игры — когда реально появилась картинка
 *          боя (не загрузочный экран) — запомни примерно секунду по своим часам.
 * Останов: Ctrl+C (или сам через 3 минуты)
 */

const fs = require('fs');
const path = require('path');
const {
    replayBasenameKey, replayCacheDir, listReplayCacheFiles, parseCacheEntries
} = require('../src/modules/replay-live/replayCache');

const APP_ROOT = path.join(__dirname, '..');
function loadConfig() {
    for (const p of [
        path.join(process.env.APPDATA || '', 'frag-tracker', 'replay-live-config.json'),
        path.join(APP_ROOT, 'replay-live-config.json')
    ]) {
        if (p && fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {} }
    }
    return {};
}
const cfg = loadConfig();
const extraDirs = (cfg.extraReplaysDirs || []).filter(Boolean);

function extraKeys() {
    const keys = new Set();
    for (const dir of extraDirs) {
        try { for (const n of fs.readdirSync(dir)) if (n.endsWith('.tbreplay')) keys.add(replayBasenameKey(n)); } catch (e) {}
    }
    return keys;
}

let prev = new Map();
let firstPoll = true;
let lastMtime = 0;
const startedAt = Date.now();
function sinceStartSec() { return ((Date.now() - startedAt) / 1000).toFixed(1); }
function now() { return new Date().toTimeString().slice(0, 8); }

console.log('Слежу за game cache:', replayCacheDir(cfg.replaysDir));
console.log('\n>>> Открой реплей и не трогай ~30 секунд. Засеки на глаз, когда реально начался бой. <<<\n');

function tick() {
    const files = listReplayCacheFiles(cfg.replaysDir);
    if (!files.length) return;
    const mtime = files[0].mtime;
    let buf; try { buf = fs.readFileSync(files[0].full); } catch (e) { return; }
    const keys = extraKeys();
    const cur = new Map();
    for (const row of parseCacheEntries(buf)) {
        const k = replayBasenameKey(path.basename(row.replayPath));
        if (keys.has(k)) cur.set(k, row.metaHex);
    }

    if (firstPoll) { prev = cur; lastMtime = mtime; firstPoll = false; return; }

    if (mtime !== lastMtime) {
        const changed = [];
        for (const [k, h] of cur) if (prev.get(k) !== undefined && prev.get(k) !== h) changed.push(k);
        if (changed.length) {
            console.log(`[t+${sinceStartSec()}с | ${now()}] КЭШ ИЗМЕНИЛСЯ: ${changed.join(', ')}`);
        } else {
            console.log(`[t+${sinceStartSec()}с | ${now()}] кэш тронут (mtime), но записи наших файлов не изменились`);
        }
        prev = cur;
        lastMtime = mtime;
    }
}

const timer = setInterval(tick, 500);
setTimeout(() => { clearInterval(timer); console.log('\n3 минуты, стоп.'); process.exit(0); }, 3 * 60 * 1000);
