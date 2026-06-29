'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const ARCHIVE = path.join(ROOT, '_archive');

const KEEP = new Set([
    'index.html', 'admin.html', 'analytics.html', 'menu.html',
    'mode1-frag-tracker.html', 'mode2-timer.html', 'tank-queue.html',
    'donation-management.html', 'donation-goal.html', 'donations-dashboard.html',
    'donation-driven-widget.html', 'frag-stats.html', 'chat-stats.html',
    'lesta-stats.html', 'stream-integrations.html', 'stream-stats-widgets.html',
    'tanks-blitz-challenge.html', 'donor-achievements.html', 'schedule.html',
    'tournament.html', 'alert-replay.html', 'alert-mode1.html', 'alert-mode2.html', 'alert-mode3.html',
    'widget-mode1.html', 'widget-mode2.html', 'widget-mode3.html',
    'widget-donation-goal.html', 'widget-donation-driven.html', 'widget-donation-driven-damage.html',
    'widget-tanks-blitz-challenge.html', 'widget-tank-queue.html', 'widget-tank-queue-obs.html',
    'widget-donors-top.html', 'widget-donors-top-unified.html', 'widget-donors-top-daily.html',
    'widget-stream-online.html', 'widget-stream-likes.html', 'widget-stream-likes-tank.html',
    'widget-stream-duration.html', 'widget-stream-duration-borderless.html',
    'widget-schedule.html', 'widget-roulette.html', 'widget-roulette-text.html',
    'widget-last-donation.html', 'widget-tournament-scores.html', 'widget-tournament-bracket.html',
    'widget-donation-bar.html', 'rewards-manager.html', 'vkplay-rewards.html',
    'oauth-vkplay-implicit.html', 'components', 'styles', 'uploads', 'widget-assets', '_archive'
]);

const TEST_PATTERNS = [
    /^test-/i, /^debug-/i, /^check-/i, /^fix-/i, /^adjust-/i, /^remove-/i,
    /^force-/i, /^database-init/, /^setup-widget/, /^donor-tiers/,
    /^donation-bar-(enhanced|obs|themes|customizable)/,
    /^widget-timer-d+/, /^widget-temperature/, /^widget-mode2-copy/,
    /^widget-mode2-borderless/, /^widget-slowdown/, /^widget-modes-/,
    /^widget-marathon/, /^widget-donors-top-experiment/,
    /^index-new/, /^index-modern/, /^dashboard-new/,
    /^donations-analytics/, /^lesta-test/, /^lesta-api-test/, /^donatepay-test/,
    /^donation-alerts-test/, /^websocket-test/, /^test-analytics/
];

function shouldArchive(name) {
    if (KEEP.has(name)) return false;
    return TEST_PATTERNS.some(p => p.test(name));
}

if (!fs.existsSync(ARCHIVE)) fs.mkdirSync(ARCHIVE, { recursive: true });

let moved = 0;
for (const name of fs.readdirSync(ROOT)) {
    if (name === '_archive' || name === 'components' || name === 'styles' || name === 'uploads' || name === 'widget-assets') continue;
    const full = path.join(ROOT, name);
    if (!fs.statSync(full).isFile()) continue;
    if (!shouldArchive(name)) continue;
    fs.renameSync(full, path.join(ARCHIVE, name));
    console.log('archived', name);
    moved++;
}
console.log('Done. Moved', moved, 'files to public/_archive/');
