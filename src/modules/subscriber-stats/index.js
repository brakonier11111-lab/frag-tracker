'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Учёт новых фолловеров/подписчиков по всем платформам (Twitch/YouTube/VK Play).
 * Каждое событие, которое интеграции рассылают в виджет через broadcastToClients
 * (TWITCH_NEW_FOLLOWER / YOUTUBE_NEW_SUBSCRIBER / VKPLAY_NEW_FOLLOWER /
 * VKPLAY_NEW_PAID_SUBSCRIBER), параллельно пишется сюда в subscriber_events.
 *
 * Даёт две вещи:
 *  1. «Лог» — сырой список последних событий (проверить после стрима, что всё
 *     реально прилетает с именами).
 *  2. Статистику по дням: сколько новых на каждой платформе и всего.
 *
 * record() вызывается интеграциями через deps.recordSubscriberEvent (прокинут в
 * registerModules), сами роуты — на странице subscriber-stats.html.
 */

// Группируем по локальному дню стримера (Москва, UTC+3). created_at пишется в UTC
// через CURRENT_TIMESTAMP, поэтому при группировке/выводе смещаем на +3 часа, иначе
// поздний вечерний стрим «разрезался» бы по гринвичской полуночи на два дня.
const DAY_TZ_OFFSET = '+3 hours';

function createSubscriberStatsModule(deps) {
    const { db, broadcastToClients } = deps;

    db.run(`CREATE TABLE IF NOT EXISTS subscriber_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,       -- twitch | youtube | vkplay
        event_type TEXT NOT NULL,     -- follower | paid_subscriber
        username TEXT,
        plan TEXT,                    -- тариф платной подписки VK Play (Кореш/Бро/...)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания subscriber_events:', err);
    });

    /**
     * Записать событие нового подписчика/фолловера.
     * @param {{platform:string, eventType:string, username?:string, plan?:string}} ev
     */
    function record(ev) {
        if (!ev || !ev.platform || !ev.eventType) return;
        db.run(
            `INSERT INTO subscriber_events (platform, event_type, username, plan) VALUES (?, ?, ?, ?)`,
            [ev.platform, ev.eventType, ev.username || null, ev.plan || null],
            (err) => {
                if (err) console.warn('⚠️ subscriber_events insert:', err.message);
                else broadcastTodaySnapshot();
            }
        );
    }

    // Для конструктора виджетов: тот же агрегат, что отдаёт GET /api/subscribers/stats
    // в поле today, но пушится сразу после записи события — без ожидания опроса.
    function broadcastTodaySnapshot() {
        if (typeof broadcastToClients !== 'function') return;
        const todayStr = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
        db.all(
            `SELECT
                SUM(CASE WHEN platform='twitch' THEN 1 ELSE 0 END) AS twitch,
                SUM(CASE WHEN platform='youtube' THEN 1 ELSE 0 END) AS youtube,
                SUM(CASE WHEN platform='vkplay' AND event_type='follower' THEN 1 ELSE 0 END) AS vkplay,
                SUM(CASE WHEN platform='vkplay' AND event_type='paid_subscriber' THEN 1 ELSE 0 END) AS vkplay_paid,
                COUNT(*) AS total
             FROM subscriber_events
             WHERE strftime('%Y-%m-%d', created_at, ?) = ?`,
            [DAY_TZ_OFFSET, todayStr],
            (err, rows) => {
                if (err || !rows || !rows[0]) return;
                const today = rows[0];
                broadcastToClients({
                    type: 'SUBSCRIBER_STATS_UPDATE',
                    today: {
                        date: todayStr,
                        twitch: today.twitch || 0,
                        youtube: today.youtube || 0,
                        vkplay: today.vkplay || 0,
                        vkplay_paid: today.vkplay_paid || 0,
                        total: today.total || 0
                    }
                });
            }
        );
    }

    function registerRoutes(app) {
        // Сырой лог последних событий — «проверить после стрима, что всё пришло»
        app.get('/api/subscribers/log', (req, res) => {
            const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
            db.all(
                `SELECT id, platform, event_type, username, plan,
                        strftime('%d.%m.%Y %H:%M:%S', created_at, ?) AS time_local,
                        created_at
                 FROM subscriber_events
                 ORDER BY id DESC
                 LIMIT ?`,
                [DAY_TZ_OFFSET, limit],
                (err, rows) => {
                    if (err) {
                        console.error('Ошибка чтения лога подписчиков:', err);
                        return res.status(500).json({ error: 'Ошибка чтения лога' });
                    }
                    res.json({ events: rows || [] });
                }
            );
        });

        // Агрегированная статистика по дням + сводка за сегодня
        app.get('/api/subscribers/stats', (req, res) => {
            const days = Math.min(parseInt(req.query.days, 10) || 14, 90);
            db.all(
                `SELECT
                    strftime('%Y-%m-%d', created_at, ?) AS date,
                    SUM(CASE WHEN platform='twitch' THEN 1 ELSE 0 END) AS twitch,
                    SUM(CASE WHEN platform='youtube' THEN 1 ELSE 0 END) AS youtube,
                    SUM(CASE WHEN platform='vkplay' AND event_type='follower' THEN 1 ELSE 0 END) AS vkplay,
                    SUM(CASE WHEN platform='vkplay' AND event_type='paid_subscriber' THEN 1 ELSE 0 END) AS vkplay_paid,
                    COUNT(*) AS total
                 FROM subscriber_events
                 GROUP BY date
                 ORDER BY date DESC
                 LIMIT ?`,
                [DAY_TZ_OFFSET, days],
                (err, rows) => {
                    if (err) {
                        console.error('Ошибка статистики подписчиков:', err);
                        return res.status(500).json({ error: 'Ошибка статистики' });
                    }
                    const list = rows || [];
                    // Сегодня по локальному дню стримера (UTC+3)
                    const todayStr = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
                    const today = list.find(r => r.date === todayStr)
                        || { date: todayStr, twitch: 0, youtube: 0, vkplay: 0, vkplay_paid: 0, total: 0 };
                    // Итого за весь период выборки
                    const totalAll = list.reduce((a, r) => ({
                        twitch: a.twitch + r.twitch,
                        youtube: a.youtube + r.youtube,
                        vkplay: a.vkplay + r.vkplay,
                        vkplay_paid: a.vkplay_paid + r.vkplay_paid,
                        total: a.total + r.total
                    }), { twitch: 0, youtube: 0, vkplay: 0, vkplay_paid: 0, total: 0 });
                    res.json({ success: true, today, days: list, totalAll });
                }
            );
        });

        // Очистка лога (с бэкапом на диск) — удобно обнулить тестовые события перед стримом
        app.post('/api/subscribers/reset', (req, res) => {
            const dir = path.join(deps.userData || __dirname, 'backups');
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            } catch (e) {
                return res.status(500).json({ error: 'Не удалось подготовить папку бэкапа' });
            }
            const file = path.join(dir, `subscriber_events_backup_${Date.now()}.json`);
            db.all('SELECT * FROM subscriber_events', (err, rows) => {
                if (err) return res.status(500).json({ error: 'Ошибка чтения перед сбросом' });
                try {
                    fs.writeFileSync(file, JSON.stringify(rows || [], null, 2), 'utf8');
                } catch (e) {
                    return res.status(500).json({ error: 'Не удалось создать бэкап, сброс отменён' });
                }
                db.run('DELETE FROM subscriber_events', (delErr) => {
                    if (delErr) return res.status(500).json({ error: 'Ошибка сброса' });
                    console.log(`🧹 Лог подписчиков обнулён (${(rows || []).length} строк, бэкап: ${file})`);
                    res.json({ success: true, deleted: (rows || []).length });
                });
            });
        });
    }

    return { record, registerRoutes };
}

module.exports = { createSubscriberStatsModule };
