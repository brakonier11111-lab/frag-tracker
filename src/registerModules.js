'use strict';

const { createBlitzChallengeModule } = require('./modules/blitz-challenge');
const { createReplayLiveModule } = require('./modules/replay-live');
const { createYandexMusicModule } = require('./modules/yandex-music');
const { registerRouletteRoutes } = require('./modules/roulette');
const { createRazblogModule } = require('./modules/razblog');
const { createDonorAchievementsModule } = require('./modules/donor-achievements');
const { createChatStatsModule } = require('./modules/chat-stats');
const { createRutonyChatModule } = require('./modules/rutony-chat');
const { createYoutubeIntegrationModule } = require('./modules/youtube-integration');

/**
 * Подключает вынесенные модули к Express-приложению.
 * @returns {{ blitz, replayLive, yandexMusic, razblog, donorAchievements, chatStats, rutonyChat, youtube }}
 */
function registerModules(app, deps, config) {
    const blitz = createBlitzChallengeModule(deps);
    blitz.registerPages(app);
    blitz.registerRoutes(app);

    const replayLive = createReplayLiveModule(deps);
    replayLive.registerPages(app);
    replayLive.registerRoutes(app);
    replayLive.init();

    const yandexMusic = createYandexMusicModule(deps);
    yandexMusic.registerPages(app);
    yandexMusic.registerRoutes(app);
    yandexMusic.init();

    registerRouletteRoutes(app, deps.db);

    const razblog = createRazblogModule(deps, config);
    razblog.registerPages(app);
    razblog.registerRoutes(app);

    const donorAchievements = createDonorAchievementsModule(deps);
    donorAchievements.registerRoutes(app);

    const chatStats = createChatStatsModule(deps);
    chatStats.registerRoutes(app);

    const rutonyChat = createRutonyChatModule(deps);
    rutonyChat.registerRoutes(app);

    const youtube = createYoutubeIntegrationModule(deps);
    youtube.registerRoutes(app);
    youtube.startPolling();

    return { blitz, replayLive, yandexMusic, razblog, donorAchievements, chatStats, rutonyChat, youtube };
}

module.exports = { registerModules };
