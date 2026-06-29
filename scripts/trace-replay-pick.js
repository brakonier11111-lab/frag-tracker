'use strict';
/**
 * Трейс выбора реплея для exclusive-extra-dir режима (Downloads).
 *
 * Зачем: детект «какой реплей открыт» в этом режиме строится на эвристиках
 * времени файлов (atime/mtime) + meta из game cache. При нескольких десятках
 * файлов в одной папке он промахивается («включается не тот реплей»). Этот
 * скрипт НЕ меняет логику модуля — он лишь читает то же состояние (папка
 * Downloads + game cache) теми же публичными хелперами и показывает, что
 * выбрал бы каждый ключевой тир каскада и ПОЧЕМУ. По нему видно, какой
 * именно сигнал мисфайрит, чтобы чинить точечно, а не вслепую.
 *
 * Запуск: node scripts/trace-replay-pick.js
 *   (запусти СРАЗУ после того, как воспроизвёл баг — открыл реплей в игре,
 *    а виджет показал не тот)
 */

const fs = require('fs');
const path = require('path');
const {
    replayBasenameKey,
    replayCacheDir,
    listReplayCacheFiles,
    parseCacheEntries,
    getReplayFileActivity
} = require('../src/modules/replay-live/replayCache');

// Те же константы, что в index.js — держим в синхроне руками.
const HOT_ZIP_ACCESS_MS = 60 * 1000;
const ZIP_JUST_OPENED_MS = 45 * 1000;

const APP_ROOT = path.join(__dirname, '..');

function loadConfig() {
    const candidates = [
        path.join(process.env.APPDATA || '', 'frag-tracker', 'replay-live-config.json'),
        path.join(APP_ROOT, 'replay-live-config.json')
    ];
    for (const p of candidates) {
        if (p && fs.existsSync(p)) {
            try {
                return { cfg: JSON.parse(fs.readFileSync(p, 'utf8')), path: p };
            } catch (e) { /* try next */ }
        }
    }
    return { cfg: {}, path: '(не найден)' };
}

function fmtAge(ms) {
    if (ms == null) return 'n/a';
    const m = ms / 60000;
    if (m < 60) return m.toFixed(1) + ' мин';
    return (m / 60).toFixed(1) + ' ч';
}

function sessionKeyOf(metaHex) {
    try {
        const b = Buffer.from(metaHex, 'hex');
        return b.length >= 4 ? b.readUInt32LE(0) : 0;
    } catch (e) {
        return 0;
    }
}

function main() {
    const { cfg, path: cfgPath } = loadConfig();
    console.log('Конфиг:', cfgPath);
    const extraDirs = (cfg.extraReplaysDirs || []).filter(Boolean);
    console.log('extraReplaysDirs:', extraDirs);
    if (!extraDirs.length) {
        console.log('Нет extraReplaysDirs — exclusive режим не активен, выходим.');
        return;
    }

    // 1. Все .tbreplay в extra dirs с активностью
    const files = [];
    for (const dir of extraDirs) {
        if (!fs.existsSync(dir)) { console.log('⚠️ dir не существует:', dir); continue; }
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.tbreplay') || name.startsWith('recording_')) continue;
            const full = path.join(dir, name);
            const act = getReplayFileActivity(full);
            files.push({
                name, full,
                baseKey: replayBasenameKey(name),
                ageMs: act.ageMs,
                atimeMs: act.atimeMs,
                mtimeMs: act.mtimeMs
            });
        }
    }
    files.sort((a, b) => (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity));

    // 2. Game cache: маппинг по basename key
    const cacheDir = replayCacheDir(cfg.replaysDir);
    const cacheFiles = listReplayCacheFiles(cfg.replaysDir);
    const cacheByKey = new Map();
    let cacheMtimeMs = 0;
    if (cacheFiles.length) {
        cacheMtimeMs = cacheFiles[0].mtime;
        const buf = fs.readFileSync(cacheFiles[0].full);
        for (const row of parseCacheEntries(buf)) {
            const key = replayBasenameKey(path.basename(row.replayPath));
            const prev = cacheByKey.get(key);
            if (!prev || row.metaTs > prev.metaTs) {
                cacheByKey.set(key, { ...row, sessionKey: sessionKeyOf(row.metaHex) });
            }
        }
    }

    console.log('\nGame cache:', cacheDir, cacheFiles.length ? `(свежесть ${fmtAge(Date.now() - cacheMtimeMs)})` : '(не найден)');

    // 3. Таблица кандидатов
    // metaTs (байты 8-11 meta) — похоже на Unix-секунды; интерпретируем как метку
    // времени, когда игра трогала запись. Не подвержено петле atime (модуль кэш не пишет).
    function metaTsAge(metaTs) {
        if (!metaTs) return null;
        // пробуем как Unix-секунды
        const asSec = Date.now() / 1000 - metaTs;
        if (asSec > 0 && asSec < 86400 * 400) return asSec * 1000; // в пределах ~год — правдоподобно
        return null;
    }

    console.log('\n=== Кандидаты в extra dir (сортировка по свежести atime) ===');
    console.log('  age(touch) | atime>mtime? | в cache? | sessionKey | metaTs-age | feedbackLoop? | файл');
    for (const f of files.slice(0, 15)) {
        const cacheRow = cacheByKey.get(f.baseKey);
        const atimeFresherThanMtime = f.atimeMs > f.mtimeMs + 1000;
        const hot = f.ageMs != null && f.ageMs <= HOT_ZIP_ACCESS_MS;
        const mtimeOld = (Date.now() - f.mtimeMs) > 10 * 60 * 1000;
        const feedbackLoop = hot && atimeFresherThanMtime && mtimeOld;
        const mAge = cacheRow ? metaTsAge(cacheRow.metaTs) : null;
        console.log(
            `  ${fmtAge(f.ageMs).padEnd(9)} | ${String(atimeFresherThanMtime).padEnd(11)} | ${(cacheRow ? 'да' : 'нет').padEnd(7)} | ${String(cacheRow ? cacheRow.sessionKey : '-').padEnd(10)} | ${(mAge != null ? fmtAge(mAge) : 'n/a').padEnd(10)} | ${(feedbackLoop ? 'ДА ⚠️' : 'нет').padEnd(8)} | ${f.name.slice(0, 44)}`
        );
    }

    // Кто свежее всех по metaTs (потенциальный чистый сигнал «что игра открыла последним»)
    let freshestMeta = null;
    for (const [, row] of cacheByKey) {
        const a = metaTsAge(row.metaTs);
        if (a == null) continue;
        if (!freshestMeta || a < freshestMeta.age) freshestMeta = { row, age: a };
    }
    console.log('\n• Самый свежий по metaTs (игра трогала последним):');
    console.log('    →', freshestMeta ? path.basename(freshestMeta.row.replayPath).slice(0, 50) + '  (' + fmtAge(freshestMeta.age) + ' назад)' : '(n/a — metaTs не похож на timestamp)');

    // 4. Что выбрал бы каждый тир
    console.log('\n=== Что выберет каждый сигнал ===');

    const freshestTouched = files.find(f => f.ageMs != null && f.ageMs <= ZIP_JUST_OPENED_MS);
    console.log('• pickFreshestTouchedExtraDirZip (idle bootstrap, ≤45с по atime):');
    console.log('    →', freshestTouched ? freshestTouched.name.slice(0, 50) : '(ничего — нет файлов свежее 45с)');

    const hotZips = files.filter(f => f.ageMs != null && f.ageMs <= HOT_ZIP_ACCESS_MS);
    console.log(`• hot zips (≤60с по atime): ${hotZips.length} шт`);
    if (hotZips.length === 1) {
        console.log('    → единственный hot →', hotZips[0].name.slice(0, 50), '(pickLiveExtraDirZipDirect возьмёт его)');
    } else if (hotZips.length > 1) {
        console.log('    ⚠️ НЕСКОЛЬКО hot zip одновременно — direct pick откажется, решает meta/touch-delta:');
        for (const h of hotZips) console.log('        -', fmtAge(h.ageMs).padEnd(9), h.name.slice(0, 44));
    }

    let maxSessionKey = null;
    for (const [, row] of cacheByKey) {
        if (!maxSessionKey || row.sessionKey > maxSessionKey.sessionKey) maxSessionKey = row;
    }
    console.log('• max sessionKey в cache (классическая ловушка statista):');
    console.log('    →', maxSessionKey ? path.basename(maxSessionKey.replayPath).slice(0, 50) : '(нет записей)');

    console.log('\nЕсли «idle bootstrap» / «max sessionKey» указывают на СТАРЫЙ файл,');
    console.log('а реально открыт другой — это и есть промах. Колонка feedbackLoop=ДА');
    console.log('показывает файлы, чей atime подкручен парсингом самого модуля.');
}

main();
