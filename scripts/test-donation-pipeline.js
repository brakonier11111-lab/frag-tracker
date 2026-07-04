'use strict';
/**
 * Регресс-тест донат-пайплайна: поднимает сервер на копии БД (как smoke-test)
 * и проверяет СЕМАНТИКУ обработки доната, а не только «роут отвечает»:
 *   - тест-донат увеличивает total_donated и timer_seconds, попадает в donations
 *   - донат двигает Blitz Challenge (session_balance)
 *   - webhook DonatePay отключён (2026-07-03): отвечает success, но не создаёт донат —
 *     единственный источник DonatePay теперь поллинг newTransactions, как в MiniChat
 *
 * Запуск: node scripts/test-donation-pipeline.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3');

const APP_ROOT = path.join(__dirname, '..');
const PORT = process.env.PIPELINE_TEST_PORT || 3998;
const BASE_URL = `http://localhost:${PORT}`;

function makeTmpUserData() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frag-pipeline-'));
    const srcDb = path.join(APP_ROOT, 'frag_tracker.db');
    const dstDb = path.join(dir, 'frag_tracker.db');
    if (fs.existsSync(srcDb)) {
        fs.copyFileSync(srcDb, dstDb);
    }
    return dir;
}

// Обнуляем webhook-секрет в КОПИИ БД, чтобы бить в /webhook/donatepay без подписи
function clearWebhookSecret(userDataDir) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(path.join(userDataDir, 'frag_tracker.db'));
        db.run('UPDATE app_state SET dp_webhook_secret = NULL WHERE id = 1', (err) => {
            db.close(() => (err ? reject(err) : resolve()));
        });
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
            // Пустой секрет: dotenv не перезапишет уже установленную переменную,
            // а в копии БД dp_webhook_secret обнулён — webhook работает без подписи
            DP_WEBHOOK_SECRET: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function waitForReady(child, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => {
            reject(new Error('Сервер не вышел на готовность за ' + timeoutMs + 'мс. Вывод:\n' + buf));
        }, timeoutMs);
        child.stdout.on('data', (chunk) => {
            buf += chunk.toString();
            if (buf.includes('FRAG_SERVER_READY:')) {
                clearTimeout(timer);
                resolve();
            }
        });
        child.stderr.on('data', (chunk) => { buf += chunk.toString(); });
        child.on('exit', (code) => {
            clearTimeout(timer);
            reject(new Error('Сервер завершился раньше готовности, код ' + code + '. Вывод:\n' + buf));
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, opts) {
    const res = await fetch(BASE_URL + url, opts);
    if (!res.ok && res.status !== 400) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}
const post = (url, body) => getJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
});

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

async function getState() {
    const s = await getJson('/api/state');
    return s.state || s;
}

async function findDonations(idPrefix) {
    const d = await getJson('/api/donations?limit=50');
    const rows = d.donations || d || [];
    return rows.filter((r) => String(r.id).startsWith(idPrefix));
}

const results = [];
async function step(name, fn) {
    try {
        await fn();
        results.push([true, name]);
        console.log(`  ✅ ${name}`);
    } catch (err) {
        results.push([false, name]);
        console.log(`  ❌ ${name} — ${err.message}`);
    }
}

async function main() {
    const userDataDir = makeTmpUserData();
    await clearWebhookSecret(userDataDir);
    const child = startServer(userDataDir);

    let exitCode = 0;
    try {
        await waitForReady(child);
        console.log(`✅ Сервер поднялся на ${BASE_URL}\n`);

        // Включаем Blitz Challenge, чтобы проверить его связь с донатами
        await getJson('/api/blitz-challenge', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true, winrate: { enabled: true } })
        });

        const state0 = await getState();
        const blitz0 = (await getJson('/api/blitz-challenge')).challenge;
        const stamp = Date.now();

        await step('тест-донат обрабатывается', async () => {
            const r = await post('/api/test-donation', { username: 'PipelineTest', amount: 150 });
            assert(r.success, 'нет success');
            await sleep(900);
        });

        await step('total_donated вырос ровно на сумму доната', async () => {
            const s = await getState();
            const diff = (s.total_donated || 0) - (state0.total_donated || 0);
            assert(Math.abs(diff - 150) < 0.01, `total_donated diff = ${diff}, ожидалось 150`);
        });

        await step('timer_seconds увеличился (режим 2)', async () => {
            const s = await getState();
            assert((s.timer_seconds || 0) > (state0.timer_seconds || 0),
                `timer_seconds ${state0.timer_seconds} -> ${s.timer_seconds}`);
        });

        await step('донат записан в таблицу donations', async () => {
            const rows = await findDonations('test_');
            assert(rows.some((r) => r.username === 'PipelineTest' && Math.abs(r.amount - 150) < 0.01),
                'запись test_ с amount=150 не найдена');
        });

        await step('Blitz Challenge получил донат (session_balance)', async () => {
            const b = (await getJson('/api/blitz-challenge')).challenge;
            const diff = (b.sessionBalance || 0) - (blitz0.sessionBalance || 0);
            assert(Math.abs(diff - 150) < 0.01, `sessionBalance diff = ${diff}, ожидалось 150`);
        });

        // === Точная математика начислений (фраги/таймер/кастом) ===
        // Ставим известные настройки, чтобы проверять НЕ «стало больше», а точные значения.
        await getJson('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                frag_cost: 100, frag_amount: 1, current_balance: 0,
                cost_per_minute: 60, timer_discount: 0, timer_discount_until_ts: 0, timer_paused: 1,
                custom_unit_cost: 70, custom_unit_amount: 1, custom_current_balance: 0
            })
        });
        await sleep(300);
        const stateMath0 = await getState();

        await step('донат 250₽ при цене фрага 100₽: +2 фрага, остаток 50₽', async () => {
            const r = await post('/api/test-donation', { username: 'MathTest', amount: 250 });
            assert(r.success, 'нет success');
            await sleep(900);
            const s = await getState();
            const fragsDiff = (s.frags_needed || 0) - (stateMath0.frags_needed || 0);
            assert(fragsDiff === 2, `frags_needed diff = ${fragsDiff}, ожидалось 2`);
            assert(Math.abs((s.current_balance || 0) - 50) < 0.01,
                `current_balance = ${s.current_balance}, ожидалось 50`);
        });

        await step('тот же донат: таймер +250 сек ровно (60₽/мин, пауза)', async () => {
            const s = await getState();
            const diff = (s.timer_seconds || 0) - (stateMath0.timer_seconds || 0);
            assert(diff === 250, `timer_seconds diff = ${diff}, ожидалось 250`);
        });

        await step('тот же донат: кастом (70₽/ед) +3 единицы, остаток 40₽', async () => {
            const s = await getState();
            const unitsDiff = (s.custom_units_needed || 0) - (stateMath0.custom_units_needed || 0);
            assert(unitsDiff === 3, `custom_units_needed diff = ${unitsDiff}, ожидалось 3`);
            assert(Math.abs((s.custom_current_balance || 0) - 40) < 0.01,
                `custom_current_balance = ${s.custom_current_balance}, ожидалось 40`);
        });

        await step('в donations записаны frags_earned/time_earned/custom_units_earned', async () => {
            const rows = await findDonations('test_');
            const row = rows.find((r) => r.username === 'MathTest');
            assert(row, 'запись MathTest не найдена');
            assert(row.frags_earned === 2, `frags_earned = ${row.frags_earned}, ожидалось 2`);
            assert(row.time_earned === 250, `time_earned = ${row.time_earned}, ожидалось 250`);
            assert(row.custom_units_earned === 3, `custom_units_earned = ${row.custom_units_earned}, ожидалось 3`);
        });

        await step('скидка 30₽/мин: донат 50₽ даёт +100 сек (30₽/мин → 2 сек/₽)', async () => {
            await post('/api/state', { timer_discount: 30, timer_discount_until_ts: 0 });
            await sleep(300);
            const before = await getState();
            const r = await post('/api/test-donation', { username: 'DiscountTest', amount: 50 });
            assert(r.success, 'нет success');
            await sleep(900);
            const s = await getState();
            const diff = (s.timer_seconds || 0) - (before.timer_seconds || 0);
            assert(diff === 100, `timer_seconds diff = ${diff}, ожидалось 100`);
            await post('/api/state', { timer_discount: 0 });
        });

        await step('температура: донат греет currentAmount на сумму доната', async () => {
            // минимальное охлаждение, чтобы замер был детерминированным
            await post('/api/temperature/settings', { coolingRate: 1 });
            let t = (await getJson('/api/temperature/status')).temperatureMode;
            if (!t.active) {
                await post('/api/temperature/toggle', {});
                t = (await getJson('/api/temperature/status')).temperatureMode;
            }
            assert(t.active, 'режим температуры не включился');
            const before = t.currentAmount || 0;
            await post('/api/test-donation', { username: 'HeatTest', amount: 40 });
            await sleep(900);
            const after = (await getJson('/api/temperature/status')).temperatureMode.currentAmount || 0;
            // допускаем лёгкое охлаждение между замерами
            assert(after - before > 38, `нагрев = ${after - before}, ожидалось ~40`);
            await post('/api/temperature/toggle', {}); // выключаем обратно
        });

        await step('ручной донат /api/manual-donation обрабатывается', async () => {
            const before = await getState();
            const r = await post('/api/manual-donation', { username: 'ManualTest', amount: 80 });
            assert(r.success, 'нет success');
            await sleep(900);
            const s = await getState();
            const diff = (s.total_donated || 0) - (before.total_donated || 0);
            assert(Math.abs(diff - 80) < 0.01, `total_donated diff = ${diff}, ожидалось 80`);
            const rows = await findDonations('manual_');
            assert(rows.some((row) => row.username === 'ManualTest' && Math.abs(row.amount - 80) < 0.01),
                'запись manual_ не найдена');
        });

        const dupId = stamp; // уникальный числовой id для dp_
        const webhookPayload = { type: 'donation', status: 'success', id: dupId, sum: 100, what: 'DupDonor', comment: 'dup-test' };
        const stateBeforeDup = await getState();

        await step('webhook DonatePay отключён: отвечает success, но донат не создаёт', async () => {
            const r = await post('/webhook/donatepay', webhookPayload);
            assert(r.success, 'webhook не вернул success: ' + JSON.stringify(r));
            await post('/webhook/donatepay', webhookPayload);
            await post('/webhook/donatepay', webhookPayload);
            await sleep(900);
            const rows = await findDonations('dp_' + dupId);
            assert(rows.length === 0, `webhook должен быть no-op, найдено ${rows.length} записей dp_${dupId}`);
            const s = await getState();
            const diff = (s.total_donated || 0) - (stateBeforeDup.total_donated || 0);
            assert(Math.abs(diff) < 0.01, `total_donated diff = ${diff}, ожидалось 0 (webhook отключён)`);
        });

        if (results.some(([ok]) => !ok)) exitCode = 1;
    } catch (err) {
        console.error('❌ ' + err.message);
        exitCode = 1;
    } finally {
        child.kill();
        await sleep(1000);
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch (cleanupErr) {
            console.warn('⚠️ Не удалось удалить temp-папку:', cleanupErr.message);
        }
    }

    console.log(exitCode === 0 ? '\nPIPELINE TEST: PASS' : '\nPIPELINE TEST: FAIL');
    process.exit(exitCode);
}

main();
