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
const { createBattleTrackerModule } = require('./modules/battle-tracker');
const { createViewerVotingModule } = require('./modules/viewer-voting');
const { createSubscriberStatsModule } = require('./modules/subscriber-stats');
const { createWidgetConstructorModule } = require('./modules/widget-constructor');

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

    // Учёт новых фолловеров/подписчиков по платформам — создаём до интеграций,
    // чтобы прокинуть record() в них (пишут события параллельно с broadcast в виджет)
    const subscriberStats = createSubscriberStatsModule(deps);
    subscriberStats.registerRoutes(app);

    // Активность зрителей в Tanks Blitz Challenge: сообщения в чате двигают прогресс
    // такой же наградой, как донат — интеграции получают колбэк поверх общих deps.
    // Плюс recordSubscriberEvent — чтобы фолловеры/подписки писались в статистику.
    const chatAwareDeps = Object.assign({}, deps, {
        onChatMessage: blitz.onChatMessageCounted,
        recordSubscriberEvent: subscriberStats.record
    });

    const youtube = createYoutubeIntegrationModule(chatAwareDeps);
    youtube.registerRoutes(app);
    youtube.startPolling();

    const vkplay = createVkplayIntegrationModule(chatAwareDeps);
    vkplay.registerRoutes(app);
    vkplay.startPolling();

    const twitch = createTwitchIntegrationModule(chatAwareDeps);
    twitch.registerRoutes(app);
    twitch.startPolling();
    twitch.connectTwitchChat();
    twitch.startFollowersTracking();

    // Активность зрителей: лайки (YouTube + VK Play) синкаются в прогресс той же схемой
    // baseline+delta, что и медали Lesta. Перед синком — свежие данные с платформ.
    async function syncActivityLikesTick() {
        try {
            if (youtube.getState().connected) await deps.withApiQueue('youtube', () => youtube.refreshData());
        } catch (e) { /* noop */ }
        try {
            if (vkplay.getState().connected) await deps.withApiQueue('vkplay', () => vkplay.refreshData({ force: true }));
        } catch (e) { /* noop */ }
        blitz.syncBlitzActivityLikes(youtube.getState().likes, vkplay.getState().likes);
    }
    setInterval(() => { syncActivityLikesTick().catch(() => {}); }, 30000);
    syncActivityLikesTick().catch(() => {});

    const onlineViewers = createOnlineViewersModule({
        ...deps,
        getYoutubeState: youtube.getState,
        getVkplayState: vkplay.getState,
        getTwitchState: twitch.getState
    });
    onlineViewers.registerRoutes(app);
    onlineViewers.startBroadcasting();

    const lestaOAuth = createLestaOAuthModule(deps);
    lestaOAuth.registerPages(app);
    lestaOAuth.registerRoutes(app);

    const donationsAnalytics = createDonationsAnalyticsModule(deps);
    donationsAnalytics.registerRoutes(app);

    const bossOrders = createBossOrdersModule(deps);
    bossOrders.registerPages(app);
    bossOrders.registerRoutes(app);

    const battleTracker = createBattleTrackerModule(deps);
    battleTracker.registerPages(app);
    battleTracker.registerRoutes(app);

    const viewerVoting = createViewerVotingModule(deps);
    viewerVoting.registerPages(app);
    viewerVoting.registerRoutes(app);

    const widgetConstructor = createWidgetConstructorModule(deps);
    widgetConstructor.registerRoutes(app);

    return { blitz, replayLive, yandexMusic, roulette, razblog, donorAchievements, chatStats, youtube, vkplay, twitch, onlineViewers, lestaOAuth, donationsAnalytics, bossOrders, battleTracker, viewerVoting, subscriberStats, widgetConstructor };
}

module.exports = { registerModules };
