'use strict';

const { createBlitzChallengeModule } = require('./modules/blitz-challenge');
const { createReplayLiveModule } = require('./modules/replay-live');
const { registerRouletteRoutes } = require('./modules/roulette');
const { createRazblogModule } = require('./modules/razblog');

/**
 * Подключает вынесенные модули к Express-приложению.
 * @returns {{ blitz, replayLive, razblog }}
 */
function registerModules(app, deps, config) {
    const blitz = createBlitzChallengeModule(deps);
    blitz.registerPages(app);
    blitz.registerRoutes(app);

    const replayLive = createReplayLiveModule(deps);
    replayLive.registerPages(app);
    replayLive.registerRoutes(app);
    replayLive.init();

    registerRouletteRoutes(app, deps.db);

    const razblog = createRazblogModule(deps, config);
    razblog.registerPages(app);
    razblog.registerRoutes(app);

    return { blitz, replayLive, razblog };
}

module.exports = { registerModules };
