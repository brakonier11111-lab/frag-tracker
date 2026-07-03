'use strict';

const { createBlitzChallengeModule } = require('./modules/blitz-challenge');
const { createReplayLiveModule } = require('./modules/replay-live');
const { createYandexMusicModule } = require('./modules/yandex-music');
const { createRouletteModule } = require('./modules/roulette');
const { createRazblogModule } = require('./modules/razblog');
const { createDonorAchievementsModule } = require('./modules/donor-achievements');
const { createChatStatsModule } = require('./modules/chat-stats');
const { createYoutubeIntegrationModule } = require('./modules/youtube-integration');
const { createVkplayIntegrationModule } = require('./modules/vkplay-integration');
const { createTwitchIntegrationModule } = require('./modules/twitch-integration');
const { createOnlineViewersModule } = require('./modules/online-viewers');
const { createLestaOAuthModule } = require('./modules/lesta-oauth');
const { createDonationsAnalyticsModule } = require('./modules/donations-analytics');
const { createBossOrdersModule } = require('./modules/boss-orders');

/**
 * Подключает вынесенные модули к Express-приложению.
 * @returns {{ blitz, replayLive, yandexMusic, razblog, donorAchievements, chatStats, youtube, vkplay, onlineViewers, lestaOAuth, donationsAnalytics }}
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

    const roulette = createRouletteModule(deps);
    roulette.registerRoutes(app);

    const razblog = createRazblogModule(deps, config);
    razblog.registerPages(app);
    razblog.registerRoutes(app);

    const donorAchievements = createDonorAchievementsModule(deps);
    donorAchievements.registerRoutes(app);

    const chatStats = createChatStatsModule(deps);
    chatStats.registerRoutes(app);

    const youtube = createYoutubeIntegrationModule(deps);
    youtube.registerRoutes(app);
    youtube.startPolling();

    const vkplay = createVkplayIntegrationModule(deps);
    vkplay.registerRoutes(app);
    vkplay.startPolling();

    const twitch = createTwitchIntegrationModule(deps);
    twitch.registerRoutes(app);
    twitch.startPolling();
    twitch.connectTwitchChat();

    const onlineViewers = createOnlineViewersModule({
        ...deps,
        getYoutubeState: youtube.getState,
        getVkplayState: vkplay.getState,
        getTwitchState: twitch.getState
    });
    onlineViewers.registerRoutes(app);

    const lestaOAuth = createLestaOAuthModule(deps);
    lestaOAuth.registerPages(app);
    lestaOAuth.registerRoutes(app);

    const donationsAnalytics = createDonationsAnalyticsModule(deps);
    donationsAnalytics.registerRoutes(app);

    const bossOrders = createBossOrdersModule(deps);
    bossOrders.registerPages(app);
    bossOrders.registerRoutes(app);

    return { blitz, replayLive, yandexMusic, roulette, razblog, donorAchievements, chatStats, youtube, vkplay, twitch, onlineViewers, lestaOAuth, donationsAnalytics, bossOrders };
}

module.exports = { registerModules };
