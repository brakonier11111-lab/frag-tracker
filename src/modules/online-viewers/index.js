'use strict';

/**
 * Сводный онлайн YouTube + VK Play + Twitch для OBS-виджета. Не опрашивает платформы
 * сам — читает уже обновляемое состояние *-integration модулей через getState().
 */
function createOnlineViewersModule(deps) {
    const { getYoutubeState, getVkplayState, getTwitchState } = deps;

    function platformPayload(state) {
        return {
            connected: !!(state && state.connected),
            viewers: (state && state.viewers) || 0,
            channel: (state && state.channel) || null
        };
    }

    function registerRoutes(app) {
        app.get('/api/online-viewers', (req, res) => {
            const youtube = platformPayload(getYoutubeState());
            const vkplay = platformPayload(getVkplayState());
            const twitch = platformPayload(getTwitchState());
            const total = [youtube, vkplay, twitch]
                .filter((p) => p.connected)
                .reduce((sum, p) => sum + p.viewers, 0);

            res.json({ youtube, vkplay, twitch, total });
        });
    }

    return { registerRoutes };
}

module.exports = { createOnlineViewersModule };
