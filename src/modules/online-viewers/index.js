'use strict';

/**
 * Сводный онлайн YouTube + VK Play + Twitch для OBS-виджета. Не опрашивает платформы
 * сам — читает уже обновляемое состояние *-integration модулей через getState().
 */
function createOnlineViewersModule(deps) {
    const { getYoutubeState, getVkplayState, getTwitchState, broadcastToClients } = deps;

    function platformPayload(state) {
        return {
            connected: !!(state && state.connected),
            viewers: (state && state.viewers) || 0,
            channel: (state && state.channel) || null
        };
    }

    function computeSnapshot() {
        const youtube = platformPayload(getYoutubeState());
        const vkplay = platformPayload(getVkplayState());
        const twitch = platformPayload(getTwitchState());
        const total = [youtube, vkplay, twitch]
            .filter((p) => p.connected)
            .reduce((sum, p) => sum + p.viewers, 0);
        return { youtube, vkplay, twitch, total };
    }

    function registerRoutes(app) {
        app.get('/api/online-viewers', (req, res) => {
            res.json(computeSnapshot());
        });
    }

    // Для конструктора виджетов и любых live-подписчиков: рассылаем снапшот по WS,
    // но только когда суммарный онлайн реально изменился — иначе спамили бы каждые
    // несколько секунд без причины (значения меняются нечасто относительно интервала).
    let lastTotal = null;
    function startBroadcasting() {
        if (typeof broadcastToClients !== 'function') return;
        setInterval(() => {
            const snapshot = computeSnapshot();
            if (snapshot.total === lastTotal) return;
            lastTotal = snapshot.total;
            broadcastToClients({ type: 'ONLINE_VIEWERS_UPDATE', ...snapshot });
        }, 10000);
    }

    return { registerRoutes, startBroadcasting };
}

module.exports = { createOnlineViewersModule };
