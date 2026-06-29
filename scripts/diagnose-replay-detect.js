'use strict';

const fs = require('fs');
const path = require('path');
const { createReplayLiveModule } = require('../src/modules/replay-live');
const { getReplayFileActivity } = require('../src/modules/replay-live/replayCache');

const replayPath = process.argv[2];
if (!replayPath) {
    console.error('Usage: node diagnose-replay-detect.js <path.tbreplay>');
    process.exit(1);
}

const appRoot = path.join(__dirname, '..');
const configPath = path.join(appRoot, 'replay-live-config.json');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
cfg.playbackReplayPath = '';
cfg.watchReplayCache = true;
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

const mod = createReplayLiveModule({
    appRoot,
    userData: appRoot,
    cacheDir: path.join(appRoot, 'replay-live-cache')
});
mod.init();

function snap(label) {
    const s = mod.getState();
    console.log(`\n=== ${label} ===`);
    console.log('status/mode', s.status, s.mode);
    console.log('source', s.sourceLabel);
    console.log('playbackSource', s.playbackSource);
    console.log('playbackLoading', s.playbackLoading);
    console.log('playerCount', s.playerCount);
    console.log('playbackDebug', JSON.stringify(s.playbackDebug));
    console.log('config.extra', s.config?.extraReplaysDirs);
    console.log('config.manual', s.config?.playbackReplayPath);
}

async function main() {
    snap('before touch');
    const activity = getReplayFileActivity(replayPath);
    console.log('file activity', activity);

    // simulate game opening file
    const now = new Date();
    fs.utimesSync(replayPath, now, now);

    for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        snap(`poll ${i + 1}`);
        const s = mod.getState();
        if (s.status === 'playback' && s.sourceLabel === path.basename(replayPath) && s.playerCount > 0) {
            console.log('\nOK: detected and loaded');
            return;
        }
    }
    console.log('\nFAIL: not detected');
    process.exitCode = 1;
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
