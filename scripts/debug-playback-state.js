'use strict';

const fs = require('fs');
const path = require('path');
const { createReplayLiveModule } = require('../src/modules/replay-live');

const replaysDir = path.join(process.env.USERPROFILE || '', 'Documents', 'TanksBlitz', 'replays');
const replayPath = process.argv[2] || path.join(
    replaysDir,
    '20260625_2202__Xasya_Bat_Chatillon25t_15126825059318601.tbreplay'
);

const appRoot = path.join(__dirname, '..');
const userData = appRoot;
const configPath = path.join(userData, 'replay-live-config.json');

const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
cfg.playbackReplayPath = replayPath;
cfg.watchReplayCache = false;
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

const mod = createReplayLiveModule({ appRoot, userData, cacheDir: path.join(userData, 'replay-live-cache') });
mod.init();

function snapshot(label) {
    const s = mod.getState();
    console.log('\n===', label, '===');
    console.log('status', s.status, 'mode', s.mode);
    console.log('moduleVersion', s.moduleVersion);
    console.log('players', s.playerCount, 'author', s.authorNickname, 'authorTeam', s.authorTeam);
    console.log('playbackTimeline', s.playbackTimeline ? {
        players: s.playbackTimeline.players?.length,
        authorTeam: s.playbackTimeline.authorTeam,
        teamHp: s.playbackTimeline.teamHp,
        hitCount: s.playbackTimeline.hitCount
    } : null);
    console.log('teamHp', s.teamHp);
    console.log('playbackLoading', s.playbackLoading);
    console.log('clock', s.playbackClockSec, 'running', s.playbackClockRunning, 'source', s.clockSource);
    if (s.players?.length) {
        console.log('sample player', s.players[0]);
    }
}

async function main() {
    snapshot('initial');
    for (let i = 0; i < 8; i++) {
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setTimeout(r, 50));
    }
    snapshot('after defer');
    await new Promise((r) => setTimeout(r, 500));
    snapshot('after 500ms');
    mod.stopWatcher();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
