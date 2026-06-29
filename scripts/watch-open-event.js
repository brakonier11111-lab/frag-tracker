'use strict';
/**
 * РЕШАЮЩИЙ ЭКСПЕРИМЕНТ (read-only) для глубокого фикса.
 *
 * Гипотеза: игра читает .tbreplay только в момент ОТКРЫТИЯ и тогда же пишет
 * game cache. Значит в секунду изменения кэша у только что открытого файла
 * atime подскочит «в ноль», а фоновое загрязнение от приложения с этим моментом
 * не совпадёт. Ловим кэш каждые 0.5с и в момент его изменения мгновенно снимаем
 * atime всех файлов в Downloads — открытый должен быть самым свежим.
 *
 * Запуск:  node scripts/watch-open-event.js
 * Тест:    запусти КОНКРЕТНЫЙ реплей в игре, запомни какой. Скрипт напечатает
 *          снимок. Скажи мне — совпал ли «самый свежий atime» с тем, что открыл.
 * Останов: Ctrl+C (или сам через 5 минут)
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

function snapshotExtraAtimes() {
    const now = Date.now();
    const rows = [];
    for (const dir of extraDirs) {
        let names; try { names = fs.readdirSync(dir); } catch (e) { continue; }
        for (const name of names) {
            if (!name.endsWith('.tbreplay') || name.startsWith('recording_')) continue;
            try {
                const s = fs.statSync(path.join(dir, name));
                rows.push({ name, atimeAgeS: (now - s.atimeMs) / 1000 });
            } catch (e) {}
        }
    }
    return rows.sort((a, b) => a.atimeAgeS - b.atimeAgeS);
}

function changedCacheEntries(buf, prev) {
    const cur = new Map(parseCacheEntries(buf).map(e => [e.replayPath, e.metaHex]));
    const changed = [];
    for (const [rp, hex] of cur) if (prev.get(rp) !== undefined && prev.get(rp) !== hex) changed.push(rp);
    return { cur, changed };
}

let prev = new Map();
let lastMtime = 0;
let firstPoll = true;
function now() { return new Date().toTimeString().slice(0, 8); }

console.log('Слежу за game cache:', replayCacheDir(cfg.replaysDir));
console.log('\n>>> Запусти КОНКРЕТНЫЙ реплей в игре (запомни какой). <<<');
console.log('Жду момент открытия (изменение кэша)...\n');

function tick() {
    const files = listReplayCacheFiles(cfg.replaysDir);
    if (!files.length) return;
    const mtime = files[0].mtime;
    let buf; try { buf = fs.readFileSync(files[0].full); } catch (e) { return; }

    if (firstPoll) { prev = changedCacheEntries(buf, prev).cur; lastMtime = mtime; firstPoll = false; return; }

    if (mtime !== lastMtime) {
        const { cur, changed } = changedCacheEntries(buf, prev);
        const atimes = snapshotExtraAtimes();
        console.log(`\n========== [${now()}] КЭШ ИЗМЕНИЛСЯ (открытие реплея?) ==========`);
        console.log('Самые свежие по atime В ЭТОТ МОМЕНТ (топ-5):');
        atimes.slice(0, 5).forEach((r, i) => {
            console.log(`  ${i === 0 ? '>>' : '  '} ${r.atimeAgeS.toFixed(1).padStart(6)}с назад | ${r.name.slice(0, 56)}`);
        });
        const changedExtra = changed.filter(rp => extraDirs.some(d => {
            try { return fs.readdirSync(d).some(n => replayBasenameKey(n) === replayBasenameKey(path.basename(rp))); } catch (e) { return false; }
        }));
        console.log('Записи кэша, что изменились (в Downloads):', changedExtra.map(rp => path.basename(rp).slice(0, 40)).join(', ') || '—');
        console.log('=> Скажи: какой реплей ты ОТКРЫЛ? Совпал ли он с «>>» строкой?');
        prev = cur;
        lastMtime = mtime;
    }
}

const timer = setInterval(tick, 500);
setTimeout(() => { clearInterval(timer); console.log('\n5 минут, стоп.'); process.exit(0); }, 5 * 60 * 1000);
