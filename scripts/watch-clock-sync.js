'use strict';
/**
 * ДИАГНОСТИКА (read-only): показывает в реальном времени, откуда виджет берёт
 * часы (clockSource) и как меняется playbackClockSec — чтобы увидеть момент
 * загрузки реплея и то, насколько плавно/резко часы корректируются, когда
 * появляется реальная позиция из игры (clockSource становится 'game_cache').
 *
 * Запуск:  node scripts/watch-clock-sync.js
 * Тест:    запусти скрипт, ЗАТЕМ открой реплей в игре и смотри первые ~20-30с.
 * Останов: Ctrl+C (или сам через 5 минут)
 */

const BASE_URL = process.env.REPLAY_LIVE_URL || 'http://localhost:3000';

function now() { return new Date().toTimeString().slice(0, 8) + '.' + String(Date.now() % 1000).padStart(3, '0'); }

let prevClock = null;
let prevSource = null;

async function tick() {
    let j;
    try {
        const r = await fetch(BASE_URL + '/api/replay-live');
        j = await r.json();
    } catch (e) {
        console.log(`[${now()}] сервер недоступен: ${e.message}`);
        return;
    }

    const clock = Number(j.playbackClockSec) || 0;
    const source = j.clockSource || j.playbackDebug?.clockSource || '?';
    const running = !!j.playbackClockRunning;
    const status = j.status;
    const replay = j.sourceLabel || j.activeReplayPath || '(нет)';

    const sourceChanged = source !== prevSource;
    const jump = prevClock != null ? clock - prevClock : 0;
    const bigJump = Math.abs(jump) > 1.5; // ожидаем ~1с в тик; больше — скачок

    if (sourceChanged || bigJump || prevClock == null) {
        const marker = sourceChanged ? '  <<< СМЕНА ИСТОЧНИКА' : (bigJump ? `  <<< СКАЧОК ${jump > 0 ? '+' : ''}${jump.toFixed(2)}с` : '');
        console.log(`[${now()}] status=${status} clock=${clock.toFixed(2)}с source=${source} running=${running} | ${replay}${marker}`);
    }

    prevClock = clock;
    prevSource = source;
}

console.log('Слежу за', BASE_URL + '/api/replay-live', '(4 раза/сек)');
console.log('Открой реплей в игре и наблюдай первые 20-30 секунд.\n');

const timer = setInterval(tick, 250);
setTimeout(() => { clearInterval(timer); console.log('\n5 минут, стоп.'); process.exit(0); }, 5 * 60 * 1000);
