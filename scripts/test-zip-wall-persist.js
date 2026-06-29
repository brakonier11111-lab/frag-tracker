'use strict';

const fs = require('fs');
const path = require('path');
const { createReplayLiveModule } = require('../src/modules/replay-live');

const appRoot = path.join(__dirname, '..');
const replaysDir = path.join(process.env.USERPROFILE || '', 'Documents', 'TanksBlitz', 'replays');
const names = fs.readdirSync(replaysDir).filter((n) => n.endsWith('.tbreplay'));
const replayPath = path.join(replaysDir, names[names.length - 1]);

const cfgPath = path.join(appRoot, 'replay-live-config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.playbackReplayPath = replayPath;
cfg.watchReplayCache = true;
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

const mod = createReplayLiveModule({
    appRoot,
    userData: appRoot,
    cacheDir: path.join(appRoot, 'replay-live-cache')
});
mod.init();

const now = new Date();
fs.utimesSync(replayPath, now, now);

function snap(label) {
    const s = mod.getState();
    console.log(label, {
        clock: s.playbackClockSec,
        source: s.clockSource,
        intro: s.introPhase,
        battle: s.battleClockRunning
    });
}

setTimeout(() => snap('after 12s no re-touch'), 12000);
setTimeout(() => {
    snap('after 15s');
    mod.stopWatcher();
    cfg.playbackReplayPath = '';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}, 15000);
