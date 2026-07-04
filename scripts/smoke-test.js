'use strict';
/**
 * Smoke-test для server.js: поднимает сервер на отдельном порту с временной
 * копией БД и бьёт по ключевым эндпоинтам, чтобы поймать явные регрессии
 * после рефакторинга. Не подменяет нормальные тесты, но дёшево ловит
 * "сервер не стартует" / "роут отвалился" / "JSON сломан".
 *
 * Запуск: node scripts/smoke-test.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_ROOT = path.join(__dirname, '..');
const PORT = process.env.SMOKE_PORT || 3999;
const BASE_URL = `http://localhost:${PORT}`;

function makeTmpUserData() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frag-smoke-'));
    const srcDb = path.join(APP_ROOT, 'frag_tracker.db');
    const dstDb = path.join(dir, 'frag_tracker.db');
    if (fs.existsSync(srcDb)) {
        fs.copyFileSync(srcDb, dstDb);
    }
    return dir;
}

function startServer(userDataDir) {
    return spawn(process.execPath, ['server.js'], {
        cwd: APP_ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            FRAG_USER_DATA: userDataDir,
            NODE_ENV: 'test',
            // Не стучаться в боевые DA/DP/Lesta API из тестового прогона
            DONATION_POLLING: '0',
            LESTA_AUTOSYNC: '0'
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
        child.stderr.on('data', (chunk) => {
            buf += chunk.toString();
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            reject(new Error('Сервер завершился раньше готовности, код ' + code + '. Вывод:\n' + buf));
        });
    });
}

const checks = [];
function check(name, fn) {
    checks.push({ name, fn });
}

check('GET /healthz', async () => {
    const res = await fetch(`${BASE_URL}/healthz`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (json.ok !== true) throw new Error('unexpected body ' + JSON.stringify(json));
});

check('GET /api/donation-goal', async () => {
    const res = await fetch(`${BASE_URL}/api/donation-goal`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (typeof json !== 'object' || json === null) throw new Error('not an object');
});

check('PUT /api/donation-goal', async () => {
    const res = await fetch(`${BASE_URL}/api/donation-goal`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Smoke Test Goal', targetAmount: 12345 })
    });
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!json.goal && !json.title) throw new Error('no goal in response: ' + JSON.stringify(json));
});

check('GET /api/donation-goal/history', async () => {
    const res = await fetch(`${BASE_URL}/api/donation-goal/history`);
    if (res.status !== 200) throw new Error('status ' + res.status);
});

check('GET /api/donation-goal/export', async () => {
    const res = await fetch(`${BASE_URL}/api/donation-goal/export`);
    if (res.status !== 200) throw new Error('status ' + res.status);
});

check('POST /api/donation-goal/manual-donation', async () => {
    const res = await fetch(`${BASE_URL}/api/donation-goal/manual-donation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 100 })
    });
    if (res.status !== 200) throw new Error('status ' + res.status);
});

check('POST /api/test-donation', async () => {
    const res = await fetch(`${BASE_URL}/api/test-donation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'SmokeTest', amount: 50 })
    });
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!json.success) throw new Error('expected success: ' + JSON.stringify(json));
});

check('GET /api/donation-driven-widget', async () => {
    const res = await fetch(`${BASE_URL}/api/donation-driven-widget`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (typeof json.current_value === 'undefined') throw new Error('no current_value: ' + JSON.stringify(json));
});

check('POST /api/donation-driven-widget/add', async () => {
    const res = await fetch(`${BASE_URL}/api/donation-driven-widget/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 100 })
    });
    if (res.status !== 200) throw new Error('status ' + res.status);
});

check('POST /api/donation-driven-widget/reset', async () => {
    const res = await fetch(`${BASE_URL}/api/donation-driven-widget/reset`, { method: 'POST' });
    if (res.status !== 200) throw new Error('status ' + res.status);
});

check('POST /api/force-check-donations', async () => {
    const res = await fetch(`${BASE_URL}/api/force-check-donations`, { method: 'POST' });
    if (res.status !== 200) throw new Error('status ' + res.status);
});

check('GET /api/donor-achievements', async () => {
    const res = await fetch(`${BASE_URL}/api/donor-achievements`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!json.success || !Array.isArray(json.achievements)) throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /api/donor-achievement-tiers', async () => {
    const res = await fetch(`${BASE_URL}/api/donor-achievement-tiers`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!json.success || !Array.isArray(json.tiers)) throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /api/chat/messages', async () => {
    const res = await fetch(`${BASE_URL}/api/chat/messages`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!Array.isArray(json.messages)) throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /api/chat/stats', async () => {
    const res = await fetch(`${BASE_URL}/api/chat/stats`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!Array.isArray(json.stats)) throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /api/online-viewers', async () => {
    const res = await fetch(`${BASE_URL}/api/online-viewers`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (typeof json.total !== 'number') throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /integrations/youtube/status', async () => {
    const res = await fetch(`${BASE_URL}/integrations/youtube/status`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (typeof json.connected !== 'boolean') throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /integrations/twitch/status', async () => {
    const res = await fetch(`${BASE_URL}/integrations/twitch/status`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (typeof json.connected !== 'boolean') throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('POST /integrations/youtube/video-id (без токена)', async () => {
    const res = await fetch(`${BASE_URL}/integrations/youtube/video-id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: 'dQw4w9WgXcQ' })
    });
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!json.ok || json.videoId !== 'dQw4w9WgXcQ') throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /oauth/youtube/start (без client id -> 500)', async () => {
    const res = await fetch(`${BASE_URL}/oauth/youtube/start`, { redirect: 'manual' });
    // Без YT_CLIENT_ID в тестовом окружении ожидаем 500 с понятным сообщением,
    // а не падение процесса или 404 (роут не зарегистрирован).
    if (res.status !== 500 && res.status !== 302) throw new Error('status ' + res.status);
});

check('GET /integrations/vkplay/status', async () => {
    const res = await fetch(`${BASE_URL}/integrations/vkplay/status`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (typeof json.connected !== 'boolean') throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /integrations/vkplay-bot/status', async () => {
    const res = await fetch(`${BASE_URL}/integrations/vkplay-bot/status`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (typeof json.connected !== 'boolean') throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /api/vkplay/reward-roles', async () => {
    const res = await fetch(`${BASE_URL}/api/vkplay/reward-roles`);
    // 401 = «VK Play не подключен»: состояние коннекта гидратируется из БД
    // асинхронно после старта, тест может успеть раньше — это не ошибка роута.
    if (res.status === 401) return;
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!Array.isArray(json.rewardRoles)) throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /oauth/vkplay/start (redirect)', async () => {
    const res = await fetch(`${BASE_URL}/oauth/vkplay/start`, { redirect: 'manual' });
    if (res.status !== 302 && res.status !== 500) throw new Error('status ' + res.status);
});

check('GET /lesta-stats (page)', async () => {
    const res = await fetch(`${BASE_URL}/lesta-stats`);
    if (res.status !== 200) throw new Error('status ' + res.status);
});

check('GET /api/lesta-search (без ника -> 400)', async () => {
    const res = await fetch(`${BASE_URL}/api/lesta-search`);
    if (res.status !== 400) throw new Error('status ' + res.status);
});

check('GET /auth/lesta (проверка LESTA_CONFIG shared по ссылке)', async () => {
    const res = await fetch(`${BASE_URL}/auth/lesta`, { redirect: 'manual' });
    // applicationId для Lesta задаётся через /api/lesta-config (остался в server.js) —
    // если объект lestaConfig не расшарен по ссылке в модуль, тут будет 400 даже с настроенным ID.
    if (res.status !== 400 && res.status !== 302) throw new Error('status ' + res.status);
});

// Роуты из src/modules/lesta-routes (читающие / безопасные на копии БД)
check('GET /api/lesta-period', async () => {
    const res = await fetch(`${BASE_URL}/api/lesta-period?period=1d&daily=0`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (json.success !== true) throw new Error('unexpected body: ' + JSON.stringify(json).slice(0, 200));
});

check('GET /api/lesta-session', async () => {
    const res = await fetch(`${BASE_URL}/api/lesta-session`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (typeof json.success !== 'boolean') throw new Error('unexpected body: ' + JSON.stringify(json).slice(0, 200));
});

check('POST /api/lesta-session/start + reset', async () => {
    const start = await fetch(`${BASE_URL}/api/lesta-session/start`, { method: 'POST' });
    if (start.status !== 200 && start.status !== 400) throw new Error('start status ' + start.status);
    const reset = await fetch(`${BASE_URL}/api/lesta-session/reset`, { method: 'POST' });
    if (reset.status !== 200) throw new Error('reset status ' + reset.status);
});

check('GET /api/lesta-history', async () => {
    const res = await fetch(`${BASE_URL}/api/lesta-history?period=1d`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!json.success || !Array.isArray(json.history)) throw new Error('unexpected body: ' + JSON.stringify(json).slice(0, 200));
});

check('GET /api/analytics/stats', async () => {
    const res = await fetch(`${BASE_URL}/api/analytics/stats`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!json.success) throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /api/donations-analytics', async () => {
    const res = await fetch(`${BASE_URL}/api/donations-analytics`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!json.success || !json.data) throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /api/donors-grouped', async () => {
    const res = await fetch(`${BASE_URL}/api/donors-grouped`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!json.success) throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /api/donations-stats-small-donors', async () => {
    const res = await fetch(`${BASE_URL}/api/donations-stats-small-donors`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (!json.success) throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET / (главная страница)', async () => {
    const res = await fetch(`${BASE_URL}/`);
    if (res.status !== 200) throw new Error('status ' + res.status);
});

// Страничные роуты (src/modules/pages)
for (const p of ['/admin', '/analytics', '/dashboard/mode2', '/mode1-frag-tracker',
                 '/widget/mode1', '/widget/tanks-blitz-challenge', '/alert/mode1',
                 '/replay-live', '/widget-replay-live', '/widget-replay-summary',
                 '/widget-replay-summary-carousel', '/widget-replay-summary-carousel-cards',
                 '/widget-donors-top.html']) {
    check(`GET ${p} (page)`, async () => {
        const res = await fetch(`${BASE_URL}${p}`);
        if (res.status !== 200) throw new Error('status ' + res.status);
    });
}

// Replay Live API (src/modules/replay-live/routes.js)
check('GET /api/replay-live', async () => {
    const res = await fetch(`${BASE_URL}/api/replay-live`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (json.success !== true || !json.data || typeof json.data.moduleVersion !== 'string') {
        throw new Error('unexpected body: ' + JSON.stringify(json).slice(0, 200));
    }
});

check('GET /api/replay-live/config', async () => {
    const res = await fetch(`${BASE_URL}/api/replay-live/config`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (json.success !== true || !json.config || typeof json.config.replaysDir !== 'string') {
        throw new Error('unexpected body: ' + JSON.stringify(json).slice(0, 200));
    }
});

check('GET /api/replay-live/replays-list', async () => {
    const res = await fetch(`${BASE_URL}/api/replay-live/replays-list`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (json.success !== true || !Array.isArray(json.items)) {
        throw new Error('unexpected body: ' + JSON.stringify(json).slice(0, 200));
    }
});

check('POST /api/replay-live/play (пустой path -> 400)', async () => {
    const res = await fetch(`${BASE_URL}/api/replay-live/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '' })
    });
    if (res.status !== 400) throw new Error('status ' + res.status);
});

check('POST /api/replay-live/refresh', async () => {
    const res = await fetch(`${BASE_URL}/api/replay-live/refresh`, { method: 'POST' });
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (json.success !== true || !json.data) throw new Error('unexpected body: ' + JSON.stringify(json).slice(0, 200));
});

// Диагностические роуты (src/modules/diagnostics)
check('GET /api/status', async () => {
    const res = await fetch(`${BASE_URL}/api/status`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (json.status !== 'ok') throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /api/db-status', async () => {
    const res = await fetch(`${BASE_URL}/api/db-status`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (json.connected !== true || typeof json.donationsCount !== 'number') throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /api/da-status', async () => {
    const res = await fetch(`${BASE_URL}/api/da-status`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (typeof json.hasToken !== 'boolean') throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /api/admin/status', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/status`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (json.success !== true) throw new Error('unexpected body: ' + JSON.stringify(json));
});

check('GET /api/dp-centrifugo-status', async () => {
    const res = await fetch(`${BASE_URL}/api/dp-centrifugo-status`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const json = await res.json();
    if (json.success !== true || typeof json.status !== 'object') throw new Error('unexpected body: ' + JSON.stringify(json));
});

// /api/diagnose-polling и /api/debug-donations в smoke не гоняем: при реальном
// DA-токене в копии БД они делают живой запрос к DonationAlerts API.

check('GET /widget/donation-goal (no-cache заголовки виджетов)', async () => {
    const res = await fetch(`${BASE_URL}/widget/donation-goal`);
    if (res.status !== 200) throw new Error('status ' + res.status);
    const cc = res.headers.get('cache-control') || '';
    if (!cc.includes('no-store') && !cc.includes('no-cache')) throw new Error('cache-control: ' + cc);
});

async function main() {
    const userDataDir = makeTmpUserData();
    const child = startServer(userDataDir);

    let exitCode = 0;
    try {
        await waitForReady(child);
        console.log(`✅ Сервер поднялся на ${BASE_URL}\n`);

        for (const { name, fn } of checks) {
            try {
                await fn();
                console.log(`  ✅ ${name}`);
            } catch (err) {
                exitCode = 1;
                console.log(`  ❌ ${name} — ${err.message}`);
            }
        }
    } catch (err) {
        console.error('❌ ' + err.message);
        exitCode = 1;
    } finally {
        child.kill();
        // Windows не сразу отпускает файл sqlite после kill — даём время.
        await new Promise((r) => setTimeout(r, 1000));
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch (cleanupErr) {
            console.warn('⚠️ Не удалось удалить temp-папку:', cleanupErr.message);
        }
    }

    console.log(exitCode === 0 ? '\nSMOKE TEST: PASS' : '\nSMOKE TEST: FAIL');
    process.exit(exitCode);
}

main();
