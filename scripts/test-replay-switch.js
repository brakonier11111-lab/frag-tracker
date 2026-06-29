'use strict';

const fs = require('fs');
const path = require('path');
const { createReplayLiveModule } = require('../src/modules/replay-live');
const { getReplayFileActivity } = require('../src/modules/replay-live/replayCache');

const OLD = process.argv[2];
const NEW = process.argv[3];
if (!OLD || !NEW) {
    console.error('Usage: node test-replay-switch.js <old.tbreplay> <new.tbreplay>');
    process.exit(1);
}

const appRoot = path.join(__dirname, '..');
const configPath = path.join(appRoot, 'replay-live-config.json');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
cfg.playbackReplayPath = '';
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
    console.log('source', s.sourceLabel);
    console.log('trackerReason', s.playbackDebug?.trackerReason);
    console.log('detectSource', s.playbackDebug?.detectSource);
}

async function touch(p) {
    const now = new Date();
    fs.utimesSync(p, now, now);
}

async function main() {
    snap('idle');
    await touch(OLD);
    for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        snap(`old poll ${i + 1}`);
    }
    const before = mod.getState().sourceLabel;
    if (before !== path.basename(OLD)) {
        console.error('FAIL: old replay not loaded first, got', before);
        process.exitCode = 1;
        mod.stopWatcher();
        return;
    }

    await new Promise((r) => setTimeout(r, 2000));
    await touch(NEW);
    for (let i = 0; i < 8; i += 1) {
        await new Promise((r) => setTimeout(r, 400));
        snap(`switch poll ${i + 1}`);
        const s = mod.getState();
        if (s.sourceLabel === path.basename(NEW) && s.playerCount > 0) {
            console.log('\nOK: switched to new replay');
            mod.stopWatcher();
            return;
        }
    }
    console.error('\nFAIL: still on', mod.getState().sourceLabel);
    console.log('old activity', getReplayFileActivity(OLD));
    console.log('new activity', getReplayFileActivity(NEW));
    process.exitCode = 1;
    mod.stopWatcher();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
