'use strict';
/**
 * Регресс-тест Lesta-синка: самое опасное место приложения — автосписание
 * фрагов из режима 1 при получении новой статистики от Lesta API.
 *
 * Поднимает сервер на копии БД (автосинк выключен LESTA_AUTOSYNC=0, донат-опрос
 * выключен) и подаёт статистику через тестовую инъекцию /api/lesta-test-stats/inject
 * (доступна только в NODE_ENV=test). Проверяет:
 *   - новые бои + рост фрагов → фраги списываются (frags_needed ↓, frags_done ↑)
 *   - списание не уходит в минус (списываем не больше, чем нужно сделать)
 *   - пересчёт API (счётчики упали) → ничего не списывается и не добавляется
 *   - скачок больше лимита (LESTA_MAX_BATTLES_DELTA) → тоже игнорируется
 *
 * Запуск: node scripts/test-lesta-sync.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3');

const APP_ROOT = path.join(__dirname, '..');
const PORT = process.env.LESTA_TEST_PORT || 3997;
const BASE_URL = `http://localhost:${PORT}`;

const BASE = { battles: 1000, frags: 500, wins: 600, losses: 400, damage_dealt: 2000000, xp: 800000 };

function makeTmpUserData() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frag-lesta-'));
    const srcDb = require('../src/bootstrap/paths').resolveDbPath();
    fs.copyFileSync(srcDb, path.join(dir, 'frag_tracker.db'));
    return dir;
}

// Приводим копию БД к известному базовому состоянию Lesta + фраг-трекера
function seedDb(userDataDir) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(path.join(userDataDir, 'frag_tracker.db'));
        db.run(
            `UPDATE app_state SET
                lesta_last_battles = ?, lesta_last_frags = ?, lesta_last_wins = ?,
                lesta_last_losses = ?, lesta_last_damage_dealt = ?, lesta_last_xp = ?,
                lesta_previous_frags = ?,
                frags_needed = 5, frags_done = 0,
                lesta_session_started_at = 0
             WHERE id = 1`,
            [BASE.battles, BASE.frags, BASE.wins, BASE.losses, BASE.damage_dealt, BASE.xp, BASE.frags],
            (err) => db.close(() => (err ? reject(err) : resolve()))
        );
    });
}

function startServer(userDataDir) {
    return spawn(process.execPath, ['server.js'], {
        cwd: APP_ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            FRAG_USER_DATA: userDataDir,
            NODE_ENV: 'test',
            DONATION_POLLING: '0',
            LESTA_AUTOSYNC: '0'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function waitForReady(child, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('Сервер не готов за ' + timeoutMs + 'мс:\n' + buf)), timeoutMs);
        child.stdout.on('data', (c) => { buf += c.toString(); if (buf.includes('FRAG_SERVER_READY:')) { clearTimeout(timer); resolve(); } });
        child.stderr.on('data', (c) => { buf += c.toString(); });
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error('Сервер упал до готовности, код ' + code + ':\n' + buf)); });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inject(partial) {
    const res = await fetch(`${BASE_URL}/api/lesta-test-stats/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...BASE, ...partial })
    });
    const json = await res.json();
    if (!json.success) throw new Error('inject не сработал: ' + JSON.stringify(json));
    await sleep(900);
}

async function getState() {
    const res = await fetch(`${BASE_URL}/api/state`);
    const json = await res.json();
    return json.state || json;
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const results = [];
async function step(name, fn) {
    try {
        await fn();
        results.push(true);
        console.log(`  ✅ ${name}`);
    } catch (err) {
        results.push(false);
        console.log(`  ❌ ${name} — ${err.message}`);
    }
}

async function main() {
    const userDataDir = makeTmpUserData();
    await seedDb(userDataDir);
    const child = startServer(userDataDir);

    let exitCode = 0;
    try {
        await waitForReady(child);
        console.log(`✅ Сервер поднялся на ${BASE_URL} (autosync off, донат-опрос off)\n`);

        await step('новые бои + фраги → автосписание из режима 1', async () => {
            // +2 боя, +3 фрага при frags_needed = 5
            await inject({ battles: BASE.battles + 2, frags: BASE.frags + 3, wins: BASE.wins + 1, losses: BASE.losses + 1 });
            const s = await getState();
            assert(s.frags_needed === 2, `frags_needed = ${s.frags_needed}, ожидалось 2`);
            assert(s.frags_done === 3, `frags_done = ${s.frags_done}, ожидалось 3`);
            assert(s.lesta_last_battles === BASE.battles + 2, `lesta_last_battles = ${s.lesta_last_battles}`);
            assert(s.lesta_last_frags === BASE.frags + 3, `lesta_last_frags = ${s.lesta_last_frags}`);
        });

        await step('списание не уходит в минус (нужно 2, пришло 4)', async () => {
            await inject({ battles: BASE.battles + 4, frags: BASE.frags + 7, wins: BASE.wins + 2, losses: BASE.losses + 2 });
            const s = await getState();
            assert(s.frags_needed === 0, `frags_needed = ${s.frags_needed}, ожидалось 0`);
            assert(s.frags_done === 5, `frags_done = ${s.frags_done}, ожидалось 5 (3 + 2, не больше needed)`);
        });

        await step('пересчёт API (счётчики упали) → ничего не меняется', async () => {
            const before = await getState();
            await inject({ battles: BASE.battles - 100, frags: BASE.frags - 50 });
            const s = await getState();
            assert(s.frags_needed === before.frags_needed, `frags_needed изменился: ${before.frags_needed} → ${s.frags_needed}`);
            assert(s.frags_done === before.frags_done, `frags_done изменился: ${before.frags_done} → ${s.frags_done}`);
        });

        await step('скачок боёв больше лимита → дельта игнорируется', async () => {
            // после прошлого шага lesta_last_battles = BASE-100; прыжок на +500 боёв
            const before = await getState();
            await inject({ battles: BASE.battles + 400, frags: BASE.frags + 300 });
            const s = await getState();
            assert(s.frags_done === before.frags_done, `frags_done изменился: ${before.frags_done} → ${s.frags_done}`);
        });

        if (results.some((ok) => !ok)) exitCode = 1;
    } catch (err) {
        console.error('❌ ' + err.message);
        exitCode = 1;
    } finally {
        child.kill();
        await sleep(1000);
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {
            console.warn('⚠️ Не удалось удалить temp-папку:', e.message);
        }
    }

    console.log(exitCode === 0 ? '\nLESTA SYNC TEST: PASS' : '\nLESTA SYNC TEST: FAIL');
    process.exit(exitCode);
}

main();
