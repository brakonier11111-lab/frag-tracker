'use strict';
/**
 * Юнит-тест чистой функции classifyDonationForPolling (src/core/donation-poll-filter.js).
 * Без сети, БД и сервера — проверяет саму логику дедупа опроса донат-платформ,
 * которая раньше была инлайн внутри checkForNewDonations и не имела покрытия.
 *
 * Запуск: node scripts/test-donation-poll-filter.js
 */

const { classifyDonationForPolling } = require('../src/core/donation-poll-filter');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 2 * DAY_MS;
const NOW = Date.parse('2026-07-03T12:00:00Z');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const results = [];
function step(name, fn) {
    try {
        fn();
        results.push(true);
        console.log(`  ✅ ${name}`);
    } catch (err) {
        results.push(false);
        console.log(`  ❌ ${name} — ${err.message}`);
    }
}

step('свежий числовой донат без истории — обрабатывается', () => {
    const r = classifyDonationForPolling(
        { id: 500, created_at: new Date(NOW - 60000).toISOString() },
        { processedIds: new Set(), lastSeenDonationId: null, nowMs: NOW, maxAgeMs: MAX_AGE_MS }
    );
    assert(r.action === 'process', 'action = ' + r.action);
    assert(r.isNumericId === true, 'isNumericId должен быть true');
});

step('донат старше 2 дней по created_at (строка) — пропускается по времени', () => {
    const r = classifyDonationForPolling(
        { id: 501, created_at: new Date(NOW - 3 * DAY_MS).toISOString() },
        { processedIds: new Set(), lastSeenDonationId: null, nowMs: NOW, maxAgeMs: MAX_AGE_MS }
    );
    assert(r.action === 'skip_old_by_time', 'action = ' + r.action);
});

step('донат старше 2 дней по created_at_ts (число, секунды) — пропускается по времени', () => {
    const r = classifyDonationForPolling(
        { id: 502, created_at_ts: Math.floor((NOW - 3 * DAY_MS) / 1000) },
        { processedIds: new Set(), lastSeenDonationId: null, nowMs: NOW, maxAgeMs: MAX_AGE_MS }
    );
    assert(r.action === 'skip_old_by_time', 'action = ' + r.action);
});

step('id уже в processedIds — пропускается как дубль, даже если новее по времени', () => {
    const r = classifyDonationForPolling(
        { id: 503, created_at: new Date(NOW - 1000).toISOString() },
        { processedIds: new Set(['503']), lastSeenDonationId: null, nowMs: NOW, maxAgeMs: MAX_AGE_MS }
    );
    assert(r.action === 'skip_already_processed', 'action = ' + r.action);
});

step('числовой id <= lastSeenDonationId (DonationAlerts) — пропускается как старый', () => {
    const r = classifyDonationForPolling(
        { id: 100, created_at: new Date(NOW - 1000).toISOString() },
        { processedIds: new Set(), lastSeenDonationId: '150', nowMs: NOW, maxAgeMs: MAX_AGE_MS }
    );
    assert(r.action === 'skip_old_by_id', 'action = ' + r.action);
});

step('числовой id > lastSeenDonationId — обрабатывается', () => {
    const r = classifyDonationForPolling(
        { id: 200, created_at: new Date(NOW - 1000).toISOString() },
        { processedIds: new Set(), lastSeenDonationId: '150', nowMs: NOW, maxAgeMs: MAX_AGE_MS }
    );
    assert(r.action === 'process', 'action = ' + r.action);
});

step('id с префиксом dp_ (DonatePay) — lastSeenDonationId (числовой, от DA) на него НЕ влияет', () => {
    const r = classifyDonationForPolling(
        { id: 'dp_5', created_at: new Date(NOW - 1000).toISOString() },
        { processedIds: new Set(), lastSeenDonationId: '999999', nowMs: NOW, maxAgeMs: MAX_AGE_MS }
    );
    assert(r.action === 'process', 'action = ' + r.action);
    assert(r.isNumericId === false, 'isNumericId должен быть false для dp_5');
});

step('донат без created_at и без created_at_ts — время не проверяется, идёт дальше по цепочке', () => {
    const r = classifyDonationForPolling(
        { id: 700 },
        { processedIds: new Set(), lastSeenDonationId: null, nowMs: NOW, maxAgeMs: MAX_AGE_MS }
    );
    assert(r.action === 'process', 'action = ' + r.action);
});

step('пограничный случай: id === lastSeenDonationId — пропускается (не строго больше)', () => {
    const r = classifyDonationForPolling(
        { id: 150, created_at: new Date(NOW - 1000).toISOString() },
        { processedIds: new Set(), lastSeenDonationId: '150', nowMs: NOW, maxAgeMs: MAX_AGE_MS }
    );
    assert(r.action === 'skip_old_by_id', 'action = ' + r.action);
});

const exitCode = results.every(Boolean) ? 0 : 1;
console.log(exitCode === 0 ? '\nDONATION POLL FILTER TEST: PASS' : '\nDONATION POLL FILTER TEST: FAIL');
process.exit(exitCode);
