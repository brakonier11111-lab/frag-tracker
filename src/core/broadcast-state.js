'use strict';
/**
 * Рассылка состояния клиентам по WebSocket: getBroadcastState — чистая
 * функция-вайтлист (полный state БД -> публичное подмножество для виджетов,
 * плюс живой пересчёт stream_timer_initial_elapsed_sec), broadcastStateUpdate —
 * обёртка с фоллбэком на чтение состояния из БД, если fullState не передан.
 * Вынесено из server.js 1:1. Deps: dbRead, broadcastToClients, getWssClientCount.
 */

function createBroadcastState({ dbRead, broadcastToClients, getWssClientCount }) {
    function getBroadcastState(fullState) {
        // Если fullState не передан, возвращаем null, чтобы broadcastStateUpdate мог получить состояние из БД
        if (!fullState) {
            return null;
        }

        // Вычисляем актуальное прошедшее время для таймера стрима
        const now = Math.floor(Date.now() / 1000);
        let currentStreamElapsedSec = fullState.stream_timer_initial_elapsed_sec || 0;
        if (fullState.stream_timer_last_update_ts && fullState.stream_timer_last_update_ts > 0) {
            const elapsedSinceLastUpdate = now - fullState.stream_timer_last_update_ts;
            currentStreamElapsedSec += Math.max(0, elapsedSinceLastUpdate);
        } else if (fullState.stream_timer_started_ts && fullState.stream_timer_started_ts > 0) {
            const elapsedSinceStart = now - fullState.stream_timer_started_ts;
            currentStreamElapsedSec += Math.max(0, elapsedSinceStart);
        }

        return {
            current_mode: fullState.current_mode,
            // Mode 1: Frag Tracker
            frags_needed: fullState.frags_needed,
            frags_done: fullState.frags_done,
            current_balance: fullState.current_balance,
            total_donated: fullState.total_donated,
            frag_cost: fullState.frag_cost,
            frag_amount: fullState.frag_amount,
            frag_name: fullState.frag_name,
            // Stream timer initial elapsed seconds (for widget) - вычисляем актуальное время
            stream_timer_initial_elapsed_sec: currentStreamElapsedSec,
            stream_timer_last_update_ts: fullState.stream_timer_last_update_ts,
            stream_timer_started_ts: fullState.stream_timer_started_ts,
            widget_left_label: fullState.widget_left_label,
            widget_right_label: fullState.widget_right_label,
            widget_progress_label: fullState.widget_progress_label,
            widget_bg_opacity: fullState.widget_bg_opacity,
            widget_cost_font_size: fullState.widget_cost_font_size,
            widget_opacity: fullState.widget_opacity,
            widget_background_blur: fullState.widget_background_blur,
            external_stats_url: fullState.external_stats_url,
            external_auto_sync: fullState.external_auto_sync,
            external_last_battles: fullState.external_last_battles,
            external_last_frag_per_battle: fullState.external_last_frag_per_battle,
            external_last_calc_frags: fullState.external_last_calc_frags,
            // Mode 2: Timer
            timer_seconds: fullState.timer_seconds,
            timer_paused: fullState.timer_paused,
            cost_per_minute: fullState.cost_per_minute,
            timer_discount: fullState.timer_discount,
            timer_discount_until_ts: fullState.timer_discount_until_ts,
            timer_alert_text: fullState.timer_alert_text,
            // Mode 2: Slowdown
            timer_slowdown_active: fullState.timer_slowdown_active,
            timer_slowdown_factor: fullState.timer_slowdown_factor,
            timer_slowdown_until_ts: fullState.timer_slowdown_until_ts,
            timer_manual_time_added: fullState.timer_manual_time_added || 0,
            // Mode 3: Custom Tracker
            custom_goal_name: fullState.custom_goal_name,
            custom_units_needed: fullState.custom_units_needed,
            custom_units_done: fullState.custom_units_done,
            custom_current_balance: fullState.custom_current_balance,
            custom_unit_cost: fullState.custom_unit_cost,
            custom_unit_amount: fullState.custom_unit_amount,
            custom_widget_left_label: fullState.custom_widget_left_label,
            custom_widget_right_label: fullState.custom_widget_right_label,
            custom_alert_text: fullState.custom_alert_text,
            // Common
            theme_mode1: fullState.theme_mode1,
            theme_mode2: fullState.theme_mode2,
            theme_mode3: fullState.theme_mode3,
            da_access_token: fullState.da_access_token,
            // Lesta Games data
            lesta_nickname: fullState.lesta_nickname,
            lesta_account_id: fullState.lesta_account_id,
            lesta_access_token: fullState.lesta_access_token,
            lesta_auto_sync: fullState.lesta_auto_sync,
            lesta_last_battles: fullState.lesta_last_battles,
            lesta_last_frags: fullState.lesta_last_frags,
            lesta_last_wins: fullState.lesta_last_wins,
            lesta_last_losses: fullState.lesta_last_losses,
            lesta_last_win_rate: fullState.lesta_last_win_rate,
            lesta_last_frags_per_battle: fullState.lesta_last_frags_per_battle,
            lesta_last_damage_dealt: fullState.lesta_last_damage_dealt,
            lesta_last_damage_received: fullState.lesta_last_damage_received,
            lesta_last_xp: fullState.lesta_last_xp,
            lesta_last_max_frags: fullState.lesta_last_max_frags,
            lesta_last_frags8p: fullState.lesta_last_frags8p,
            lesta_last_hits: fullState.lesta_last_hits,
            lesta_last_shots: fullState.lesta_last_shots,
            lesta_last_spotted: fullState.lesta_last_spotted,
            lesta_last_capture_points: fullState.lesta_last_capture_points,
            lesta_last_dropped_capture_points: fullState.lesta_last_dropped_capture_points,
            lesta_last_survived_battles: fullState.lesta_last_survived_battles,
            lesta_last_win_and_survived: fullState.lesta_last_win_and_survived,
            lesta_last_max_xp: fullState.lesta_last_max_xp,
            lesta_last_gold: fullState.lesta_last_gold,
            lesta_last_credits: fullState.lesta_last_credits,
            lesta_last_free_xp: fullState.lesta_last_free_xp,
            lesta_previous_frags: fullState.lesta_previous_frags,
            lesta_auto_deduct: fullState.lesta_auto_deduct,
            lesta_last_sync_time: fullState.lesta_last_sync_time
        };
    }

    function broadcastStateUpdate(fullState) {
        // Если fullState не передан, получаем его из базы данных
        if (!fullState) {
            dbRead.get('SELECT * FROM app_state WHERE id = 1', (err, state) => {
                if (err) {
                    console.error('❌ Ошибка получения состояния для broadcast:', err);
                    return;
                }
                if (state) {
                    const broadcastState = getBroadcastState(state);
                    if (process.env.DEBUG_STATE === '1') {
                        console.log('📢 Broadcast STATE_UPDATE to', getWssClientCount(), 'clients');
                    }
                    broadcastToClients({
                        type: 'STATE_UPDATE',
                        state: broadcastState
                    });
                    // Дополнительно шлем специализированное событие для алерт-страниц
                    broadcastToClients({
                        type: 'SET_ALERT_OPACITY',
                        opacity: broadcastState.widget_bg_opacity || 0.95
                    });
                }
            });
            return;
        }

        const broadcastState = getBroadcastState(fullState);
        if (process.env.DEBUG_STATE === '1') {
            console.log('📢 Broadcast STATE_UPDATE to', getWssClientCount(), 'clients');
        }
        broadcastToClients({
            type: 'STATE_UPDATE',
            state: broadcastState
        });
        // Дополнительно шлем специализированное событие для алерт-страниц
        broadcastToClients({
            type: 'SET_ALERT_OPACITY',
            opacity: broadcastState.widget_bg_opacity || 0.95
        });
    }

    return { getBroadcastState, broadcastStateUpdate };
}

module.exports = { createBroadcastState };
