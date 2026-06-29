'use strict';

const fs = require('fs');
const path = require('path');
const { createReplayLiveModule } = require('../src/modules/replay-live');

const appRoot = path.join(__dirname, '..');
const dl = process.argv[2] || 'C:/Users/ixacy/Downloads/20260622_1534__BuLLIH9I_B_KaPaMeLu_Leopard1_2313354762767627172.tbreplay';
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

const express = require('express');
const app = express();
app.use(express.json());
mod.init();
mod.registerRoutes(app);

async function postPlay() {
    const res = await fetch('http://127.0.0.1:9876/api/replay-live/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dl })
    });
    return res.json();
}

async function getState() {
    const res = await fetch('http://127.0.0.1:9876/api/replay-live');
    return res.json();
}

const server = app.listen(9876, async () => {
    try {
        await postPlay();
        const first = (await getState()).data;
        console.log('poll 0:', first.sourceLabel, first.playbackSource, first.playbackDebug?.trackerReason);

        for (let i = 1; i <= 8; i += 1) {
            await new Promise((r) => setTimeout(r, 500));
            const snap = (await getState()).data;
            console.log(`poll ${i}:`, snap.sourceLabel, snap.playbackSource, snap.playbackDebug?.trackerReason);
            if (snap.sourceLabel !== path.basename(dl)) {
                console.error('SWITCHED AWAY at poll', i);
                process.exitCode = 1;
                break;
            }
        }
    } catch (err) {
        console.error(err);
        process.exitCode = 1;
    } finally {
        server.close();
    }
});
