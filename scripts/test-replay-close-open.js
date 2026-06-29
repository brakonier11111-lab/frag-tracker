'use strict';

const fs = require('fs');
const path = require('path');
const { createReplayLiveModule } = require('../src/modules/replay-live');

const REPLAY_A = process.argv[2];
const REPLAY_B = process.argv[3];
const STATISTA = process.argv[4];
if (!REPLAY_A || !REPLAY_B) {
    console.error('Usage: node test-replay-close-open.js <first.tbreplay> <second.tbreplay> [statista.tbreplay]');
    process.exit(1);
}

const appRoot = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(appRoot, 'replay-live-config.json'), 'utf8'));
cfg.playbackReplayPath = '';
fs.writeFileSync(path.join(appRoot, 'replay-live-config.json'), JSON.stringify(cfg, null, 2));

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
    console.log('reason', s.playbackDebug?.trackerReason);
    console.log('version', s.moduleVersion);
}

async function touch(p) {
    fs.utimesSync(p, new Date(), new Date());
}

async function wait(ms) {
    await new Promise((r) => setTimeout(r, ms));
}

async function main() {
    await touch(REPLAY_A);
    for (let i = 0; i < 5; i += 1) {
        await wait(400);
        snap(`first ${i + 1}`);
        if (mod.getState().sourceLabel === path.basename(REPLAY_A)) break;
    }

    // simulate close: wait until zip cold, force idle polls
    await wait(3000);
    for (let i = 0; i < 8; i += 1) {
        await wait(500);
        const s = mod.getState();
        snap(`idle ${i + 1}`);
        if (s.status === 'idle' || !s.sourceLabel) break;
    }

    await touch(REPLAY_B);
    for (let i = 0; i < 10; i += 1) {
        await wait(400);
        snap(`second ${i + 1}`);
        const s = mod.getState();
        const got = s.sourceLabel;
        if (STATISTA && got === path.basename(STATISTA)) {
            console.error('\nFAIL: picked statista instead of second replay');
            process.exitCode = 1;
            mod.stopWatcher();
            return;
        }
        if (got === path.basename(REPLAY_B) && s.playerCount > 0) {
            console.log('\nOK: second replay after close');
            mod.stopWatcher();
            return;
        }
    }
    console.error('\nFAIL: ended on', mod.getState().sourceLabel);
    process.exitCode = 1;
    mod.stopWatcher();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
