'use strict';
/**
 * ЭКСПЕРИМЕНТ (read-only): какой реплей РЕАЛЬНО загружен/играет в игре?
 *
 * Идея: когда ты смотришь реплей, игра постоянно пишет твою ТЕКУЩУЮ ПОЗИЦИЮ в
 * game cache. Значит у активного реплея запись в кэше меняется снова и снова
 * (позиция двигается), а у всех остальных стоит на месте. Этот скрипт каждую
 * секунду читает кэш и считает, у какого реплея запись меняется чаще всего —
 * это и есть «тот, что ты запустил».
 *
 * В отличие от прошлого вотчера, тут важна НЕ одна вспышка, а изменения ВО
 * ВРЕМЕНИ: активный реплей наберёт много изменений, остальные 0-1.
 *
 * Запуск:  node scripts/watch-active-replay.js
 * Останов: Ctrl+C (или сам через 5 минут)
 *
 * Как тестировать: запусти скрипт, ЗАПУСТИ реплей в игре и посмотри ~30 секунд.
 * Скрипт каждые 5с печатает «лидера» — у кого позиция двигается.
 */

const fs = require('fs');
const path = require('path');
const {
    replayBasenameKey, replayCacheDir, listReplayCacheFiles, parseCacheEntries
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
const extraKeys = new Set();
for (const dir of extraDirs) {
    try {
        for (const name of fs.readdirSync(dir)) {
            if (name.endsWith('.tbreplay')) extraKeys.add(replayBasenameKey(name));
        }
    } catch (e) { /* skip */ }
}

function sessionKey(metaHex) {
    try { const b = Buffer.from(metaHex, 'hex'); return b.length >= 4 ? b.readUInt32LE(0) : 0; }
    catch (e) { return 0; }
}
function now() { return new Date().toTimeString().slice(0, 8); }

let prevHex = new Map();        // replayPath -> metaHex
const changeCount = new Map();  // replayPath -> сколько раз менялась запись
let firstPoll = true;
let ticks = 0;

console.log('Слежу за game cache:', replayCacheDir(cfg.replaysDir));
console.log('\n>>> ЗАПУСТИ реплей в игре и смотри ~30 секунд. <<<');
console.log('Каждые 5с печатаю, у какого реплея позиция двигается (= активный).\n');

function tick() {
    const files = listReplayCacheFiles(cfg.replaysDir);
    if (!files.length) return;
    let buf;
    try { buf = fs.readFileSync(files[0].full); } catch (e) { return; }
    const entries = parseCacheEntries(buf);

    if (!firstPoll) {
        for (const e of entries) {
            if (prevHex.get(e.replayPath) !== undefined && prevHex.get(e.replayPath) !== e.metaHex) {
                changeCount.set(e.replayPath, (changeCount.get(e.replayPath) || 0) + 1);
            }
        }
    }
    prevHex = new Map(entries.map(e => [e.replayPath, e.metaHex]));
    firstPoll = false;
    ticks += 1;

    if (ticks % 5 === 0) {
        const ranked = [...changeCount.entries()]
            .map(([rp, cnt]) => ({ rp, cnt, inExtra: extraKeys.has(replayBasenameKey(path.basename(rp))) }))
            .sort((a, b) => b.cnt - a.cnt)
            .slice(0, 5);
        console.log(`[${now()}] за ${ticks}с — кто меняется чаще всего:`);
        if (!ranked.length || ranked[0].cnt === 0) {
            console.log('   (пока ничего не двигается — запусти реплей в игре)');
        } else {
            for (const r of ranked) {
                if (r.cnt === 0) continue;
                const tag = r.inExtra ? ' ← Downloads' : '';
                console.log(`   ${String(r.cnt).padStart(3)} изм | ${path.basename(r.rp).slice(0, 56)}${tag}`);
            }
        }
        console.log('');
    }
}

const timer = setInterval(tick, 1000);
setTimeout(() => { clearInterval(timer); console.log('\n5 минут, стоп.'); process.exit(0); }, 5 * 60 * 1000);
