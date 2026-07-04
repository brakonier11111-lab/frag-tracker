'use strict';
/** Тайминги и reason-наборы replay-live. Вынесены из index.js 1:1. */

const STRONG_CACHE_REASONS = new Set([
    'cache_switch',
    'cache_switch_multi',
    'cache_meta',
    'cache_meta_pos',
    'cache_zip_spike',
    'cache_zip_spike_multi',
    'cache_file_touch'
]);
const WEAK_CACHE_REASONS = new Set([
    'cache_boot_active',
    'cache_boot_wait',
    'cache_session',
    'cache_hold',
    'cache_active_read',
    'cache_idle',
    'cache_ambiguous'
]);
const GAME_CACHE_INTENT_MS = 15 * 1000;
const ZIP_JUST_OPENED_MS = 45 * 1000;
const ZIP_SWITCH_TOUCH_DELTA_MS = 1500;
const GAME_CACHE_OPEN_MS = 45 * 1000;
const GAME_CACHE_STALE_MS = 3 * 60 * 1000;
const HOT_ZIP_ACCESS_MS = 60 * 1000;
const ZIP_LIVE_MS = 3000;
const ZIP_PAUSE_MS = 90 * 1000;
const ZIP_PAUSE_IGNORE_MS = 60 * 60 * 1000;
const CLOCK_SYNC_DELTA_SEC = 0.35;
const GAME_POS_EXTRAPOLATE_MAX_SEC = 0.2;
const GAME_POS_STALE_MS = 2500;
const PLAYBACK_IDLE_GRACE_MS = 15_000;
const STICKY_META_SILENCE_MS = 4 * 60 * 1000;
const STICKY_SESSION_MAX_MS = 60 * 60 * 1000;
const REPLAY_SUMMARY_TTL_MS = 3 * 60 * 1000;
const REPLAY_SUMMARY_DELAY_MS = 10_000;

module.exports = {
    STRONG_CACHE_REASONS,
    WEAK_CACHE_REASONS,
    GAME_CACHE_INTENT_MS,
    ZIP_JUST_OPENED_MS,
    ZIP_SWITCH_TOUCH_DELTA_MS,
    GAME_CACHE_OPEN_MS,
    GAME_CACHE_STALE_MS,
    HOT_ZIP_ACCESS_MS,
    ZIP_LIVE_MS,
    ZIP_PAUSE_MS,
    ZIP_PAUSE_IGNORE_MS,
    CLOCK_SYNC_DELTA_SEC,
    GAME_POS_EXTRAPOLATE_MAX_SEC,
    GAME_POS_STALE_MS,
    PLAYBACK_IDLE_GRACE_MS,
    STICKY_META_SILENCE_MS,
    STICKY_SESSION_MAX_MS,
    REPLAY_SUMMARY_TTL_MS,
    REPLAY_SUMMARY_DELAY_MS
};
