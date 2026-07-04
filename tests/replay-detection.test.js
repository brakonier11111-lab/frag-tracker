'use strict';
/**
 * Юнит-тесты детект-каскада replay-live (src/modules/replay-live/detection.js).
 * Детект — исторически самая хрупкая логика проекта («фикс одного бага
 * возвращал другой»), эти тесты фиксируют ключевые контракты тиров.
 *
 * h собирается фейковый; файловые сигналы — настоящие temp-файлы
 * (getReplayFileActivity/replayPathExists импортируются detection.js напрямую).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createReplayDetection } = require('../src/modules/replay-live/detection');
const { STICKY_SESSION_MAX_MS } = require('../src/modules/replay-live/constants');

function makeTmpDirs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-detect-test-'));
    const extraDir = path.join(root, 'extra');
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(extraDir);
    fs.mkdirSync(cacheDir);
    return { root, extraDir, cacheDir };
}

function writeReplay(dir, name, ageMs) {
    const full = path.join(dir, name);
    fs.writeFileSync(full, Buffer.alloc(64, 1));
    if (ageMs) {
        const t = (Date.now() - ageMs) / 1000;
        fs.utimesSync(full, t, t);
    }
    return full;
}

function makeHost(dirs, overrides) {
    const calls = { saveConfig: [], markPlaybackSelection: [], poll: 0 };
    const h = Object.assign({
        config: { extraReplaysDirs: [dirs.extraDir], playbackReplayPath: '' },
        playbackSession: { path: '', lastDetectReason: '', replaySelectedAt: 0, clockRunning: false, lastKnownClockSec: 0, applyCache: null, lastMetaHex: '' },
        state: { playbackDebug: null, replayAtEnd: false, replayDataDurationSec: 0 },
        lastResolvedPlaybackPath: '',
        lastActivePlaybackAt: 0,
        playbackHoldKey: '',
        playbackEndTriggered: false,
        lastSeenGameCacheMtimeMs: 0,
        lastGameCacheActivePath: '',
        lastMetaHexByBasename: new Map(),
        replayAccessTracker: { reset() {} },
        replayCacheDiffTracker: { reset() {} },
        timelineCache: { reset() {} },
        replayBufCache: new Map(),
        battleResultsCtxCache: new Map(),

        poll: () => { calls.poll += 1; },
        isFinishedReplayPath: () => false,
        shouldAllowReplayRestart: () => true,
        normalizedReplayPath: (p) => (p ? path.normalize(String(p)).toLowerCase() : ''),
        playbackAccessWindowMs: () => 10 * 60 * 1000,
        isPathInExtraReplaysDirs: (p) => Boolean(p) && path.normalize(p).toLowerCase().startsWith(path.normalize(dirs.extraDir).toLowerCase()),
        isPathInPrimaryReplaysDir: () => false,
        listReplayZipCandidates: () => [],
        clearFinishedReplayMark: () => {},
        resolveGameCacheReplaysDir: () => dirs.cacheDir,
        saveConfig: (next) => { calls.saveConfig.push(next); Object.assign(h.config, next); return h.config; },
        hardResetAllReplayState: () => {},
        defaultPlaybackSessionFields: (p) => ({ path: p || '', lastDetectReason: '', replaySelectedAt: 0, clockRunning: false, lastKnownClockSec: 0, applyCache: null, lastMetaHex: '' }),
        usesExclusiveExtraReplayDirs: () => true,
        resolvePlaybackSignals: () => ({ access: null, cache: null }),
        shouldHoldPlaybackAfterEnd: () => false,
        replayDataDurationSec: () => 0,
        getPlaybackClockSec: () => 0,
        isZipActiveForPlayback: () => false,
        summaryHoldActive: () => false,
        pickAccessReplayPath: () => null,
        guardReplayPick: (pick) => pick,
        markPlaybackSelection: (p, r) => { calls.markPlaybackSelection.push({ path: p, reason: r }); },
        findSoleZipLiveReplayPath: () => '',
        normalizeExtraReplaysDirs: (raw) => (Array.isArray(raw) ? raw : [])
    }, overrides || {});
    return { h, calls };
}

test('metaSessionKeyFromHex: uint32LE из первых 4 байт, мусор -> 0', () => {
    const dirs = makeTmpDirs();
    const det = createReplayDetection(makeHost(dirs).h);
    assert.strictEqual(det.metaSessionKeyFromHex('01000000'), 1);
    assert.strictEqual(det.metaSessionKeyFromHex('ff000000deadbeef'), 255);
    assert.strictEqual(det.metaSessionKeyFromHex(''), 0);
    assert.strictEqual(det.metaSessionKeyFromHex('zz'), 0);
    assert.strictEqual(det.metaSessionKeyFromHex('0102'), 0); // меньше 4 байт
});

test('exclusiveReplaySessionKey: basename-ключ без (N) и расширения + metaHex', () => {
    const dirs = makeTmpDirs();
    const det = createReplayDetection(makeHost(dirs).h);
    const a = det.exclusiveReplaySessionKey('C:\\x\\Boec_5405.tbreplay', 'aa');
    const b = det.exclusiveReplaySessionKey('C:\\y\\Boec_5405 (1).tbreplay', 'aa');
    assert.strictEqual(a, b); // копия «file (1)» — тот же реплей
    assert.notStrictEqual(a, det.exclusiveReplaySessionKey('C:\\x\\Boec_5405.tbreplay', 'bb'));
});

test('shouldSwitchExclusiveExtraDirReplay: свежесть цели и дельта касаний', () => {
    const dirs = makeTmpDirs();
    const det = createReplayDetection(makeHost(dirs).h);
    const oldFrom = writeReplay(dirs.extraDir, 'from.tbreplay', 120_000);
    const freshTo = writeReplay(dirs.extraDir, 'to.tbreplay', 0);
    const staleTo = writeReplay(dirs.extraDir, 'stale.tbreplay', 300_000);

    assert.strictEqual(det.shouldSwitchExclusiveExtraDirReplay(oldFrom, oldFrom), false, 'тот же путь');
    assert.strictEqual(det.shouldSwitchExclusiveExtraDirReplay(oldFrom, freshTo), true, 'свежая цель, разница касаний > 1.5с');
    assert.strictEqual(det.shouldSwitchExclusiveExtraDirReplay(oldFrom, staleTo), false, 'цель старше ZIP_JUST_OPENED_MS');
    assert.strictEqual(det.shouldSwitchExclusiveExtraDirReplay('', freshTo), true, 'нет текущего — переключаемся');
});

test('resolveExclusiveExtraDirPick: без текущего берётся свежекинутый zip (zip_open)', () => {
    const dirs = makeTmpDirs();
    const { h } = makeHost(dirs);
    const det = createReplayDetection(h);
    writeReplay(dirs.extraDir, 'old.tbreplay', 10 * 60 * 1000);
    const fresh = writeReplay(dirs.extraDir, 'fresh.tbreplay', 0);

    const pick = det.resolveExclusiveExtraDirPick({ access: null, cache: null });
    assert.ok(pick, 'pick ожидался');
    assert.strictEqual(path.normalize(pick.path), path.normalize(fresh));
    assert.strictEqual(pick.reason, 'zip_open');
    assert.strictEqual(pick.source, 'extra_dir');
});

test('resolveExclusiveExtraDirPick: старые файлы без сигналов -> null', () => {
    const dirs = makeTmpDirs();
    const { h } = makeHost(dirs);
    const det = createReplayDetection(h);
    writeReplay(dirs.extraDir, 'old1.tbreplay', 10 * 60 * 1000);
    writeReplay(dirs.extraDir, 'old2.tbreplay', 20 * 60 * 1000);

    assert.strictEqual(det.resolveExclusiveExtraDirPick({ access: null, cache: null }), null);
});

test('tryContinueExclusiveExtraPlayback: живая сессия удерживается (session_continue)', () => {
    const dirs = makeTmpDirs();
    const { h } = makeHost(dirs);
    const current = writeReplay(dirs.extraDir, 'current.tbreplay', 0);
    h.playbackSession.path = current;
    h.playbackSession.replaySelectedAt = Date.now() - 5000;
    const det = createReplayDetection(h);

    const held = det.tryContinueExclusiveExtraPlayback();
    assert.ok(held, 'сессия должна удержаться');
    assert.strictEqual(held.reason, 'session_continue');
    assert.strictEqual(held.source, 'session_hold');
});

test('tryContinueExclusiveExtraPlayback: конец реплея или протухшая сессия -> null', () => {
    const dirs = makeTmpDirs();
    const { h } = makeHost(dirs);
    const current = writeReplay(dirs.extraDir, 'current.tbreplay', 0);
    h.playbackSession.path = current;
    h.playbackSession.replaySelectedAt = Date.now() - 5000;
    h.state.replayAtEnd = true;
    const det = createReplayDetection(h);
    assert.strictEqual(det.tryContinueExclusiveExtraPlayback(), null, 'replayAtEnd');

    h.state.replayAtEnd = false;
    h.playbackSession.replaySelectedAt = Date.now() - STICKY_SESSION_MAX_MS - 1000;
    assert.strictEqual(det.tryContinueExclusiveExtraPlayback(), null, 'сессия старше лимита');
});

test('pickExtraDirReplayIfNew: тот же реплей -> null, новый -> выбор + сброс hold', () => {
    const dirs = makeTmpDirs();
    const { h, calls } = makeHost(dirs);
    const det = createReplayDetection(h);
    const a = writeReplay(dirs.extraDir, 'a.tbreplay', 0);
    const b = writeReplay(dirs.extraDir, 'b.tbreplay', 0);

    h.playbackSession.path = a;
    assert.strictEqual(det.pickExtraDirReplayIfNew({ path: a, source: 's', reason: 'r' }), null);

    h.playbackHoldKey = 'held';
    const picked = det.pickExtraDirReplayIfNew({ path: b, source: 'extra_dir', reason: 'zip_open' });
    assert.ok(picked);
    assert.strictEqual(path.normalize(picked.path), path.normalize(b));
    assert.strictEqual(h.playbackHoldKey, '', 'hold должен сброситься');
    assert.strictEqual(calls.markPlaybackSelection.length, 1);
});

test('clearExclusiveIdleSession: сбрасывает сессию через сеттеры и чистит manual path', () => {
    const dirs = makeTmpDirs();
    const { h, calls } = makeHost(dirs);
    const det = createReplayDetection(h);
    h.playbackSession.path = 'X';
    h.lastResolvedPlaybackPath = 'X';
    h.lastActivePlaybackAt = 123;
    h.lastMetaHexByBasename.set('k', 'v');
    h.config.playbackReplayPath = 'X';

    det.clearExclusiveIdleSession();
    assert.strictEqual(h.playbackSession.path, '');
    assert.strictEqual(h.lastResolvedPlaybackPath, '');
    assert.strictEqual(h.lastActivePlaybackAt, 0);
    assert.strictEqual(h.lastMetaHexByBasename.size, 0);
    assert.deepStrictEqual(calls.saveConfig, [{ playbackReplayPath: '' }]);
});

test('resolveRecentlyOpenedReplayPath: manual-выбор удерживается', () => {
    const dirs = makeTmpDirs();
    const { h } = makeHost(dirs);
    const manual = writeReplay(dirs.extraDir, 'manual.tbreplay', 10 * 60 * 1000);
    h.playbackSession.path = manual;
    h.playbackSession.lastDetectReason = 'manual_play';
    const det = createReplayDetection(h);

    const pick = det.resolveRecentlyOpenedReplayPath({ access: null, cache: null });
    assert.ok(pick);
    assert.strictEqual(pick.source, 'manual');
    assert.strictEqual(pick.reason, 'manual_play');
});
