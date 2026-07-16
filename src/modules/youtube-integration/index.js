'use strict';

/**
 * YouTube Live интеграция: статус эфира, OAuth, автопоиск активного live,
 * поллинг статистики и сбор чата. Вынесено из server.js — делит таблицу
 * stream_integrations и функции saveIntegration/loadIntegration с VK Play
 * (которые пока остаются в server.js), поэтому получает их как deps вместо
 * дублирования.
 */

// axios по умолчанию читает системные HTTP_PROXY/HTTPS_PROXY и криво их
// применяет к некоторым запросам (см. тот же фикс в twitch-integration) —
// идём напрямую, googleapis.com доступен без прокси.
const axios = require('axios').create({ proxy: false });
const querystring = require('querystring');

function defaultYoutubeIntegration() {
    return {
        connected: false,
        channel: null,
        liveTitle: null,
        chatEnabled: false,
        viewers: 0,
        likes: 0,
        tokens: null,
        liveChatId: null,
        nextPageToken: null,
        videoId: null,       // ручной override текущего стрима
        manualVideoId: false, // true — videoId задан вручную, авто-детект не трогает/не сбрасывает его
        pollIntervalSec: 60, // базовый интервал опроса YouTube (секунды)
        lastPollTime: 0,     // последний успешный опрос videos.list/liveChat
        lastLiveDetectTime: 0, // последний авто-поиск активного live (чтобы не жечь квоту)
        seenSubscriberIds: new Set(), // subscription.id уже отслеженных подписчиков (дедуп алертов)
        subscribersInitialized: false // false = первый опрос подписчиков ещё не сделан (будет базой без алертов)
    };
}

function createYoutubeIntegrationModule(deps) {
    const { db, saveIntegration, loadIntegration, withApiQueue, broadcastToClients } = deps;
    const port = process.env.PORT || 3000;

    let youtubeIntegration = defaultYoutubeIntegration();

    // Персистентность seenSubscriberIds/subscribersInitialized — без этого рестарт
    // сервера каждый раз сбрасывал базу подписчиков заново, и все, кто подписался
    // между последним опросом и рестартом, никогда не засчитывались как «новые».
    db.run(`CREATE TABLE IF NOT EXISTS youtube_seen_subscribers (
        subscription_id TEXT PRIMARY KEY
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания youtube_seen_subscribers:', err);
    });

    function persistSeenSubscriberIds(ids) {
        for (const id of ids) {
            db.run('INSERT OR IGNORE INTO youtube_seen_subscribers (subscription_id) VALUES (?)', [id], () => {});
        }
    }

    function trimSeenSubscribersInDb(keepIds) {
        db.run('DELETE FROM youtube_seen_subscribers', () => {
            persistSeenSubscriberIds(keepIds);
        });
    }

    // Поиск активного live-стрима YouTube.
    // Используем совместимый запрос liveBroadcasts(mine=true) без broadcastStatus
    // и фильтруем по lifeCycleStatus на нашей стороне.
    async function detectActiveYouTubeLive(tokens, { allowSearchFallback = false } = {}) {
        let videoId = null;
        let snippet = null;
        let source = null;

        try {
            const live = await axios.get('https://www.googleapis.com/youtube/v3/liveBroadcasts', {
                params: {
                    part: 'id,snippet,status',
                    broadcastType: 'all',
                    mine: true,
                    maxResults: 50
                },
                headers: { Authorization: `Bearer ${tokens.access_token}` }
            });

            const items = (live.data?.items || []).filter(i => i?.id);
            // Раньше при отсутствии реально идущего эфира фолбэчились на items (ЛЮБЫЕ
            // трансляции, включая завершённые) и брали самую свежую по дате — это
            // навсегда "залипало" на последнем закончившемся стриме как на "активном".
            // Теперь: нет live/livestarting/testing — значит эфира сейчас нет, и точка.
            const liveLike = items.filter(i => {
                const lc = String(i?.status?.lifeCycleStatus || '').toLowerCase();
                return lc === 'live' || lc === 'livestarting' || lc === 'testing';
            });

            if (liveLike.length) {
                const selected = liveLike
                    .slice()
                    .sort((a, b) => {
                        const aTs = Date.parse(a?.snippet?.actualStartTime || a?.snippet?.scheduledStartTime || 0) || 0;
                        const bTs = Date.parse(b?.snippet?.actualStartTime || b?.snippet?.scheduledStartTime || 0) || 0;
                        return bTs - aTs;
                    })[0];
                videoId = selected.id;
                snippet = selected.snippet || null;
                source = 'liveBroadcasts.mine.liveLike';
            }
        } catch (e) {
            console.warn('⚠️ YouTube detect: liveBroadcasts(mine) не сработал:', e?.response?.data || e.message);
        }

        // Fallback по search включаем только вручную (дороже по квоте).
        if (!videoId && allowSearchFallback) {
            try {
                const searchMine = await axios.get('https://www.googleapis.com/youtube/v3/search', {
                    params: {
                        part: 'snippet',
                        type: 'video',
                        eventType: 'live',
                        forMine: true,
                        maxResults: 1,
                        order: 'date'
                    },
                    headers: { Authorization: `Bearer ${tokens.access_token}` }
                });
                const sItem = (searchMine.data?.items || [])[0];
                if (sItem?.id?.videoId) {
                    videoId = sItem.id.videoId;
                    snippet = sItem.snippet || null;
                    source = 'search.forMine';
                }
            } catch (searchErr) {
                console.warn('⚠️ YouTube detect: search(forMine) не сработал:', searchErr?.response?.data || searchErr.message);
            }
        }

        return { videoId, snippet, source };
    }

    // Сбор чата YouTube Live
    async function collectYouTubeChat() {
        if (!youtubeIntegration.connected || !youtubeIntegration.tokens || !youtubeIntegration.liveChatId) return;
        try {
            const params = {
                part: 'snippet,authorDetails',
                liveChatId: youtubeIntegration.liveChatId,
                maxResults: 200
            };
            if (youtubeIntegration.nextPageToken) params.pageToken = youtubeIntegration.nextPageToken;

            const chat = await axios.get('https://www.googleapis.com/youtube/v3/liveChat/messages', {
                params,
                headers: { Authorization: `Bearer ${youtubeIntegration.tokens.access_token}` }
            });

            youtubeIntegration.nextPageToken = chat.data?.nextPageToken || null;
            const items = chat.data?.items || [];

            for (const it of items) {
                const sn = it.snippet || {};
                const ad = it.authorDetails || {};
                const text = sn.displayMessage || '';
                const publishedAt = sn.publishedAt ? new Date(sn.publishedAt).toISOString() : new Date().toISOString();
                const insertParams = [
                    'youtube',
                    youtubeIntegration.channel || 'youtube',
                    ad.channelId || ad.channelUrl || ad.displayName || 'unknown',
                    ad.displayName || 'YouTube User',
                    text,
                    ad.isChatModerator ? 1 : 0,
                    ad.isChatOwner ? 1 : 0,
                    publishedAt
                ];

                if (it.id) {
                    // Нативный ID сообщения liveChatMessage — надёжная дедупликация без риска дропнуть настоящий повтор
                    db.run(`INSERT OR IGNORE INTO chat_messages (platform, channel_url, user_id, username, message, is_moderator, is_owner, created_at, message_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...insertParams, it.id], function (err) {
                        if (!err && this.changes > 0 && deps.onChatMessage) deps.onChatMessage('youtube:' + insertParams[2]);
                    });
                } else {
                    db.get('SELECT id FROM chat_messages WHERE platform = ? AND user_id = ? AND message = ? AND created_at > datetime("now", "-5 minutes")',
                        ['youtube', insertParams[2], text], (err, row) => {
                        if (!err && !row) {
                            db.run(`INSERT INTO chat_messages (platform, channel_url, user_id, username, message, is_moderator, is_owner, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, insertParams, function (insErr) {
                                if (!insErr && deps.onChatMessage) deps.onChatMessage('youtube:' + insertParams[2]);
                            });
                        }
                    });
                }
            }
        } catch (e) {
            console.warn('⚠️ Ошибка сбора чата YouTube:', e?.response?.data || e.message);
        }
    }

    // Обновление данных YouTube (только по уже выбранному videoId) с настраиваемым интервалом опроса
    async function updateYouTubeData() {
        if (!youtubeIntegration.connected || !youtubeIntegration.tokens) return;

        // Учитываем настраиваемый интервал опроса
        const now = Date.now();
        const intervalMs = (youtubeIntegration.pollIntervalSec || 60) * 1000;
        if (youtubeIntegration.lastPollTime && now - youtubeIntegration.lastPollTime < intervalMs) {
            return;
        }
        youtubeIntegration.lastPollTime = now;

        try {
            let videoId = youtubeIntegration.videoId || null;
            const detectCooldownMs = 5 * 60 * 1000; // раз в 5 минут синхронизируем active live

            // Ручной videoId (задан по ссылке) авто-детект не трогает вообще.
            // Иначе — если videoId не задан, или периодически для синхронизации, ищем active live.
            const shouldRedetect = !youtubeIntegration.manualVideoId &&
                (!videoId || !youtubeIntegration.lastLiveDetectTime || (now - youtubeIntegration.lastLiveDetectTime >= detectCooldownMs));
            if (shouldRedetect) {
                const hadVideoIdBeforeDetect = !!videoId;
                const detected = await detectActiveYouTubeLive(youtubeIntegration.tokens, { allowSearchFallback: false });
                youtubeIntegration.lastLiveDetectTime = now;
                if (detected.videoId) {
                    const switched = videoId && detected.videoId !== videoId;
                    videoId = detected.videoId;
                    youtubeIntegration.videoId = videoId;
                    if (detected.snippet?.title) youtubeIntegration.liveTitle = detected.snippet.title;
                    if (!youtubeIntegration.channel && detected.snippet?.channelTitle) {
                        youtubeIntegration.channel = detected.snippet.channelTitle;
                    }
                    if (switched) {
                        console.log(`🔄 YouTube: переключили активный эфир на более свежий (videoId=${videoId})`);
                    } else if (!hadVideoIdBeforeDetect) {
                        console.log(`✅ YouTube: найден активный эфир автоматически (videoId=${videoId})`);
                    }
                } else if (hadVideoIdBeforeDetect || youtubeIntegration.viewers || youtubeIntegration.liveTitle) {
                    // Live-трансляций сейчас нет, а в состоянии (в т.ч. загруженном из БД при
                    // старте сервера) остались данные от прошлого эфира — сбрасываем, а не
                    // оставляем застывшие цифры висеть до следующего реального стрима.
                    console.log('🔴 YouTube: активного эфира нет, сбрасываем онлайн/чат');
                    videoId = null;
                    youtubeIntegration.videoId = null;
                    youtubeIntegration.liveChatId = null;
                    youtubeIntegration.chatEnabled = false;
                    youtubeIntegration.viewers = 0;
                    youtubeIntegration.liveTitle = null;
                    youtubeIntegration.likes = 0;
                    await saveIntegration('youtube', {
                        tokens: youtubeIntegration.tokens,
                        channel: youtubeIntegration.channel,
                        liveTitle: null,
                        viewers: 0,
                        likes: 0,
                        chatEnabled: false,
                        pollIntervalSec: youtubeIntegration.pollIntervalSec || 60
                    });
                    return;
                } else {
                    // Не нашли эфир и текущего videoId не было — выходим тихо
                    return;
                }
            }

            let snippet = null;
            let liveDetails = null;
            let stats = null;

            // Получаем статистику, liveStreamingDetails и snippet по видео
            try {
                const videoResp = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
                    params: {
                        part: 'snippet,statistics,liveStreamingDetails',
                        id: videoId
                    },
                    headers: { Authorization: `Bearer ${youtubeIntegration.tokens.access_token}` }
                });
                const vItems = videoResp.data.items || [];
                const v = vItems[0];
                if (v) {
                    snippet = v.snippet || null;
                    stats = v.statistics || {};
                    liveDetails = v.liveStreamingDetails || {};
                } else {
                    console.warn('⚠️ videos.list не вернул данных для videoId =', videoId);
                }
            } catch (videoErr) {
                console.warn('⚠️ Ошибка получения videos.snippet/statistics/liveStreamingDetails:', videoErr?.response?.data || videoErr.message);
            }

            if (snippet) {
                const newTitle = snippet.title || youtubeIntegration.liveTitle || null;
                youtubeIntegration.liveTitle = newTitle;
                if (!youtubeIntegration.channel && snippet.channelTitle) {
                    youtubeIntegration.channel = snippet.channelTitle;
                }
            }

            // liveChatId берем из liveStreamingDetails.activeLiveChatId (надежнее, чем из liveBroadcasts)
            const chatId = liveDetails && liveDetails.activeLiveChatId ? liveDetails.activeLiveChatId : youtubeIntegration.liveChatId || null;
            youtubeIntegration.liveChatId = chatId;
            youtubeIntegration.chatEnabled = !!chatId;

            // Обновляем онлайн и лайки, если есть статистика
            if (stats || liveDetails) {
                const likes = stats && stats.likeCount != null ? parseInt(stats.likeCount, 10) || 0 : (youtubeIntegration.likes || 0);
                const viewers = liveDetails && liveDetails.concurrentViewers != null
                    ? parseInt(liveDetails.concurrentViewers, 10) || 0
                    : (youtubeIntegration.viewers || 0);

                youtubeIntegration.likes = likes;
                youtubeIntegration.viewers = viewers;
            }

            // Сохраняем обновленные данные в БД
            await saveIntegration('youtube', {
                tokens: youtubeIntegration.tokens,
                channel: youtubeIntegration.channel,
                liveTitle: youtubeIntegration.liveTitle,
                viewers: youtubeIntegration.viewers,
                likes: youtubeIntegration.likes,
                chatEnabled: youtubeIntegration.chatEnabled,
                pollIntervalSec: youtubeIntegration.pollIntervalSec || 60
            });

            // Собираем чат (если есть liveChatId)
            await collectYouTubeChat();
        } catch (e) {
            const status = e?.response?.status;
            if (status === 401) {
                console.warn('⚠️ YouTube API: Токен истек или невалиден. Требуется повторная авторизация.');
                youtubeIntegration.connected = false;
                await saveIntegration('youtube', {
                    tokens: youtubeIntegration.tokens,
                    channel: youtubeIntegration.channel,
                    liveTitle: youtubeIntegration.liveTitle,
                    viewers: youtubeIntegration.viewers,
                    likes: youtubeIntegration.likes,
                    chatEnabled: false,
                    pollIntervalSec: youtubeIntegration.pollIntervalSec || 60
                });
            } else if (status === 403) {
                console.warn('⚠️ YouTube API: Доступ запрещен. Проверьте права доступа приложения.');
            } else {
                console.warn('⚠️ Ошибка обновления данных YouTube:', e?.response?.data || e.message);
            }
        }
    }

    // Обновление access_token YouTube через refresh_token. В отличие от остального
    // YouTube-модуля (который при истечении токена просто гасит connected до ручной
    // переавторизации), фоновому опросу подписчиков нужен self-healing токен, как у
    // MiniChat — иначе имена перестанут приходить через ~час. Google не возвращает
    // новый refresh_token при рефреше, поэтому сохраняем прежний.
    async function refreshYouTubeToken() {
        const refreshToken = youtubeIntegration.tokens?.refresh_token;
        const clientId = process.env.YT_CLIENT_ID;
        const clientSecret = process.env.YT_CLIENT_SECRET;
        if (!refreshToken || !clientId || !clientSecret) return false;
        try {
            const res = await axios.post('https://oauth2.googleapis.com/token', querystring.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token'
            }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            if (!res.data?.access_token) return false;
            youtubeIntegration.tokens = {
                access_token: res.data.access_token,
                refresh_token: refreshToken
            };
            youtubeIntegration.connected = true;
            await saveIntegration('youtube', {
                tokens: youtubeIntegration.tokens,
                channel: youtubeIntegration.channel,
                liveTitle: youtubeIntegration.liveTitle,
                viewers: youtubeIntegration.viewers,
                likes: youtubeIntegration.likes,
                chatEnabled: youtubeIntegration.chatEnabled,
                pollIntervalSec: youtubeIntegration.pollIntervalSec || 60
            });
            console.log('✅ YouTube: access-токен обновлён через refresh_token');
            return true;
        } catch (e) {
            console.warn('⚠️ YouTube: не удалось обновить токен:', e?.response?.data || e.message);
            return false;
        }
    }

    // Имена новых подписчиков YouTube через официальный subscriptions.list с
    // myRecentSubscribers=true (part=subscriberSnippet) — тот же путь, что у MiniChat
    // (обычный OAuth, не веб-сессия). API отдаёт последних подписчиков новыми-сверху;
    // дедуп по subscription.id в seenSubscriberIds, новые алертим в хронологическом
    // порядке. Первый опрос после старта — только база (без алерта), иначе рестарт
    // сервера дал бы шквал "новых" из истории. Подписчики, скрывшие свои подписки,
    // в выдачу не попадают — это ограничение YouTube, не наше.
    async function updateYouTubeSubscribers(isRetry = false) {
        if (!youtubeIntegration.connected || !youtubeIntegration.tokens) return;
        try {
            // myRecentSubscribers=true не гарантирует хронологическую сортировку (это не
            // задокументированный параметр YouTube API), поэтому реально новый подписчик
            // может оказаться не в первых 50 записях. Листаем все страницы, пока не
            // упрёмся в конец списка или в уже известный (seen) id — дальше него все
            // записи заведомо старые, дальше листать незачем.
            const items = [];
            let pageToken = null;
            do {
                const res = await axios.get('https://www.googleapis.com/youtube/v3/subscriptions', {
                    params: {
                        part: 'subscriberSnippet',
                        myRecentSubscribers: true,
                        maxResults: 50,
                        ...(pageToken ? { pageToken } : {})
                    },
                    headers: { Authorization: `Bearer ${youtubeIntegration.tokens.access_token}` }
                });
                const pageItems = res.data?.items || [];
                items.push(...pageItems);
                pageToken = res.data?.nextPageToken || null;
                // Если на первом опросе (subscribersInitialized уже true) встретили уже
                // известный id — дальше страницы можно не листать, там только старые.
                if (youtubeIntegration.subscribersInitialized && pageItems.some(it => youtubeIntegration.seenSubscriberIds.has(it.id))) {
                    break;
                }
            } while (pageToken);

            if (!youtubeIntegration.subscribersInitialized) {
                for (const it of items) youtubeIntegration.seenSubscriberIds.add(it.id);
                youtubeIntegration.subscribersInitialized = true;
                persistSeenSubscriberIds(items.map(it => it.id));
                return;
            }

            const fresh = items.filter(it => !youtubeIntegration.seenSubscriberIds.has(it.id));
            fresh.reverse(); // API отдаёт новыми-сверху — алертим старые→новые
            for (const it of fresh) {
                youtubeIntegration.seenSubscriberIds.add(it.id);
                persistSeenSubscriberIds([it.id]);
                const username = it.subscriberSnippet?.title || 'Аноним';
                if (broadcastToClients) {
                    broadcastToClients({ type: 'YOUTUBE_NEW_SUBSCRIBER', username });
                }
                if (deps.recordSubscriberEvent) {
                    deps.recordSubscriberEvent({ platform: 'youtube', eventType: 'follower', username });
                }
            }

            // Не даём seen-множеству расти бесконечно — обрезаем до текущего окна выдачи
            if (youtubeIntegration.seenSubscriberIds.size > 500) {
                youtubeIntegration.seenSubscriberIds = new Set(items.map(it => it.id));
                trimSeenSubscribersInDb(items.map(it => it.id));
            }
        } catch (e) {
            const status = e?.response?.status;
            if (status === 401 && !isRetry) {
                // Токен протух — рефрешим и пробуем один раз ещё
                if (await refreshYouTubeToken()) return updateYouTubeSubscribers(true);
            }
            if (status !== 401 && status !== 403) {
                console.warn('⚠️ Ошибка опроса подписчиков YouTube:', e?.response?.data || e.message);
            }
        }
    }

    function registerRoutes(app) {
        app.get('/integrations/youtube/status', async (req, res) => {
            // Если YouTube подключен, но videoId еще не выбран — пробуем мягко автопривязать активный эфир
            try {
                if (youtubeIntegration.connected && youtubeIntegration.tokens && !youtubeIntegration.videoId) {
                    const now = Date.now();
                    const detectCooldownMs = 60 * 1000; // не чаще 1 раза в минуту
                    if (!youtubeIntegration.lastLiveDetectTime || now - youtubeIntegration.lastLiveDetectTime >= detectCooldownMs) {
                        const detected = await detectActiveYouTubeLive(youtubeIntegration.tokens, { allowSearchFallback: false });
                        youtubeIntegration.lastLiveDetectTime = now;
                        if (detected.videoId) {
                            youtubeIntegration.videoId = detected.videoId;
                            if (detected.snippet?.title) youtubeIntegration.liveTitle = detected.snippet.title;
                            if (!youtubeIntegration.channel && detected.snippet?.channelTitle) {
                                youtubeIntegration.channel = detected.snippet.channelTitle;
                            }
                            await saveIntegration('youtube', {
                                tokens: youtubeIntegration.tokens,
                                channel: youtubeIntegration.channel,
                                liveTitle: youtubeIntegration.liveTitle,
                                viewers: youtubeIntegration.viewers,
                                likes: youtubeIntegration.likes,
                                chatEnabled: youtubeIntegration.chatEnabled,
                                pollIntervalSec: youtubeIntegration.pollIntervalSec || 60
                            });
                        }
                    }
                }
            } catch (e) {
                console.warn('⚠️ YouTube status: ошибка автопривязки live:', e?.response?.data || e.message);
            }
            res.json(youtubeIntegration);
        });

        app.post('/integrations/youtube/video-id', require('express').json(), (req, res) => {
            try {
                const raw = req.body?.videoId || req.body?.videoUrl || req.query.videoId || req.query.videoUrl;
                if (!raw || typeof raw !== 'string') {
                    return res.status(400).json({ error: 'videoId or videoUrl is required' });
                }

                const input = raw.trim();
                let id = input;

                // Если это полная ссылка на YouTube — вытаскиваем videoId
                try {
                    if (/^https?:\/\//i.test(input)) {
                        const u = new URL(input);
                        if (u.hostname.includes('youtube.com')) {
                            if (u.pathname === '/watch') {
                                id = u.searchParams.get('v') || '';
                            } else if (u.pathname.startsWith('/live/')) {
                                id = u.pathname.split('/live/')[1] || '';
                            } else if (u.pathname.startsWith('/shorts/')) {
                                id = u.pathname.split('/shorts/')[1] || '';
                            }
                        } else if (u.hostname === 'youtu.be') {
                            id = u.pathname.replace('/', '') || '';
                        }
                    }
                } catch (_) {}

                // Чистим videoId
                id = (id || '').trim();
                if (!id) {
                    return res.status(400).json({ error: 'Не удалось определить videoId из ссылки' });
                }

                youtubeIntegration.videoId = id;
                youtubeIntegration.manualVideoId = true;
                console.log('✅ Ручной выбор стрима YouTube, videoId =', id);
                res.json({ ok: true, videoId: id });
            } catch (e) {
                console.error('Ошибка установки YouTube videoId:', e);
                res.status(500).json({ error: 'Internal error' });
            }
        });

        // Настройка интервала опроса YouTube (в секундах)
        app.post('/integrations/youtube/poll-interval', require('express').json(), async (req, res) => {
            if (!youtubeIntegration.connected || !youtubeIntegration.tokens) {
                return res.status(401).json({ error: 'YouTube не подключен' });
            }

            const raw = req.body?.intervalSec ?? req.query.intervalSec;
            const val = parseInt(raw, 10);
            if (!Number.isFinite(val) || val <= 0) {
                return res.status(400).json({ error: 'intervalSec must be a positive integer' });
            }

            // Ограничиваем разумный диапазон, чтобы не сжечь квоту моментально
            const clamped = Math.max(30, Math.min(val, 300)); // от 30 сек до 5 минут
            youtubeIntegration.pollIntervalSec = clamped;
            youtubeIntegration.lastPollTime = 0; // чтобы сразу сделать следующий опрос по новому интервалу

            try {
                await saveIntegration('youtube', {
                    tokens: youtubeIntegration.tokens,
                    channel: youtubeIntegration.channel,
                    liveTitle: youtubeIntegration.liveTitle,
                    viewers: youtubeIntegration.viewers,
                    likes: youtubeIntegration.likes,
                    chatEnabled: youtubeIntegration.chatEnabled,
                    pollIntervalSec: youtubeIntegration.pollIntervalSec
                });
                res.json({ ok: true, pollIntervalSec: youtubeIntegration.pollIntervalSec });
            } catch (e) {
                console.warn('⚠️ Ошибка сохранения pollIntervalSec для YouTube:', e.message);
                res.status(500).json({ error: 'Ошибка сохранения настроек интервала' });
            }
        });

        // Поиск текущего live-стрима YouTube по API (однократно по кнопке)
        app.post('/integrations/youtube/find-live', async (req, res) => {
            if (!youtubeIntegration.connected || !youtubeIntegration.tokens) {
                return res.status(401).json({ error: 'YouTube не подключен' });
            }

            try {
                let videoId = null;
                let snippet = null;
                let liveDetails = null;
                let stats = null;
                const detected = await detectActiveYouTubeLive(youtubeIntegration.tokens, { allowSearchFallback: true });
                videoId = detected.videoId;
                snippet = detected.snippet;

                if (!videoId) {
                    return res.status(404).json({ error: 'Активный live-стрим не найден. Убедитесь, что эфир запущен на YouTube.' });
                }

                // Получаем статистику, liveStreamingDetails и snippet по найденному видео
                try {
                    const videoResp = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
                        params: {
                            part: 'snippet,statistics,liveStreamingDetails',
                            id: videoId
                        },
                        headers: { Authorization: `Bearer ${youtubeIntegration.tokens.access_token}` }
                    });
                    const vItems = videoResp.data.items || [];
                    const v = vItems[0];
                    if (v) {
                        snippet = snippet || v.snippet || null;
                        stats = v.statistics || {};
                        liveDetails = v.liveStreamingDetails || {};
                    } else {
                        console.warn('⚠️ YouTube find-live: videos.list не вернул данных для videoId =', videoId);
                    }
                } catch (videoErr) {
                    console.warn('⚠️ YouTube find-live: ошибка получения videos.snippet/statistics/liveStreamingDetails:', videoErr?.response?.data || videoErr.message);
                }

                // Обновляем интеграцию
                youtubeIntegration.videoId = videoId;
                if (snippet) {
                    youtubeIntegration.liveTitle = snippet.title || youtubeIntegration.liveTitle || null;
                    if (!youtubeIntegration.channel && snippet.channelTitle) {
                        youtubeIntegration.channel = snippet.channelTitle;
                    }
                }

                const chatId = liveDetails && liveDetails.activeLiveChatId ? liveDetails.activeLiveChatId : youtubeIntegration.liveChatId || null;
                youtubeIntegration.liveChatId = chatId;
                youtubeIntegration.chatEnabled = !!chatId;

                if (stats || liveDetails) {
                    const likes = stats && stats.likeCount != null ? parseInt(stats.likeCount, 10) || 0 : (youtubeIntegration.likes || 0);
                    const viewers = liveDetails && liveDetails.concurrentViewers != null
                        ? parseInt(liveDetails.concurrentViewers, 10) || 0
                        : (youtubeIntegration.viewers || 0);

                    youtubeIntegration.likes = likes;
                    youtubeIntegration.viewers = viewers;
                }

                await saveIntegration('youtube', {
                    tokens: youtubeIntegration.tokens,
                    channel: youtubeIntegration.channel,
                    liveTitle: youtubeIntegration.liveTitle,
                    viewers: youtubeIntegration.viewers,
                    likes: youtubeIntegration.likes,
                    chatEnabled: youtubeIntegration.chatEnabled
                });

                res.json({
                    ok: true,
                    source: detected.source || null,
                    videoId,
                    liveTitle: youtubeIntegration.liveTitle,
                    channel: youtubeIntegration.channel,
                    viewers: youtubeIntegration.viewers,
                    likes: youtubeIntegration.likes,
                    chatEnabled: youtubeIntegration.chatEnabled
                });
            } catch (e) {
                const status = e?.response?.status;
                if (status === 401) {
                    console.warn('⚠️ YouTube find-live: токен истек или невалиден. Требуется повторная авторизация.');
                    youtubeIntegration.connected = false;
                    await saveIntegration('youtube', {
                        tokens: youtubeIntegration.tokens,
                        channel: youtubeIntegration.channel,
                        liveTitle: youtubeIntegration.liveTitle,
                        viewers: youtubeIntegration.viewers,
                        likes: youtubeIntegration.likes,
                        chatEnabled: false
                    });
                    return res.status(401).json({ error: 'Требуется повторная авторизация YouTube.' });
                }
                if (status === 403) {
                    console.warn('⚠️ YouTube find-live: доступ запрещен. Проверьте права доступа приложения или квоту API.');
                    return res.status(403).json({ error: 'Доступ к YouTube API запрещён (403).' });
                }

                console.warn('⚠️ YouTube find-live: общая ошибка:', e?.response?.data || e.message);
                res.status(500).json({ error: 'Ошибка поиска live-стрима YouTube' });
            }
        });

        // OAuth start stubs
        app.get('/oauth/youtube/start', (req, res) => {
            const clientId = process.env.YT_CLIENT_ID;
            const redirectUri = process.env.YT_REDIRECT_URI || `http://localhost:${port}/oauth/youtube/callback`;
            if (!clientId) {
                return res.status(500).send('YouTube OAuth is not configured (YT_CLIENT_ID missing).');
            }
            const scope = [
                'https://www.googleapis.com/auth/youtube.readonly',
                'https://www.googleapis.com/auth/youtube.force-ssl'
            ].join(' ');
            const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + querystring.stringify({
                client_id: clientId,
                redirect_uri: redirectUri,
                response_type: 'code',
                access_type: 'offline',
                include_granted_scopes: 'true',
                prompt: 'consent',
                scope
            });
            res.redirect(authUrl);
        });

        app.get('/oauth/youtube/callback', async (req, res) => {
            try {
                const code = req.query.code;
                if (!code) return res.status(400).send('Missing code');
                const clientId = process.env.YT_CLIENT_ID;
                const clientSecret = process.env.YT_CLIENT_SECRET;
                const redirectUri = process.env.YT_REDIRECT_URI || `http://localhost:${port}/oauth/youtube/callback`;
                if (!clientId || !clientSecret) {
                    return res.status(500).send('YouTube OAuth is not configured (client id/secret).');
                }
                // Exchange code for token
                const tokenRes = await axios.post('https://oauth2.googleapis.com/token', querystring.stringify({
                    code,
                    client_id: clientId,
                    client_secret: clientSecret,
                    redirect_uri: redirectUri,
                    grant_type: 'authorization_code'
                }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

                const tokens = tokenRes.data; // access_token, refresh_token, expires_in
                youtubeIntegration.connected = true;
                youtubeIntegration.tokens = tokens;

                // Fetch channel basic info
                try {
                    const me = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
                        params: { part: 'snippet,statistics', mine: true },
                        headers: { Authorization: `Bearer ${tokens.access_token}` }
                    });
                    const item = me.data.items && me.data.items[0];
                    if (item) {
                        youtubeIntegration.channel = item.snippet.title;
                    }
                } catch (e) {
                    console.warn('YouTube channel fetch failed:', e?.response?.data || e.message);
                }

                // Try to get current live broadcast (title, liveChatId)
                try {
                    const detected = await detectActiveYouTubeLive(tokens, { allowSearchFallback: false });
                    if (detected.videoId) {
                        youtubeIntegration.videoId = detected.videoId;
                        youtubeIntegration.liveTitle = detected.snippet?.title || youtubeIntegration.liveTitle || null;
                    } else {
                        youtubeIntegration.liveTitle = youtubeIntegration.liveTitle || 'Нет активного стрима';
                        youtubeIntegration.chatEnabled = false;
                        youtubeIntegration.liveChatId = null;
                    }
                } catch (e) {
                    console.warn('YouTube liveBroadcasts fetch failed:', e?.response?.data || e.message);
                }

                // Save in DB
                try {
                    await saveIntegration('youtube', {
                        tokens: youtubeIntegration.tokens,
                        channel: youtubeIntegration.channel,
                        liveTitle: youtubeIntegration.liveTitle,
                        viewers: youtubeIntegration.viewers,
                        chatEnabled: youtubeIntegration.chatEnabled
                    });
                } catch (e) {
                    console.warn('⚠️ Не удалось сохранить интеграцию YouTube:', e.message);
                }

                // Redirect back to integrations page
                res.redirect('/stream-integrations.html');
            } catch (err) {
                console.error('YouTube OAuth callback error:', err?.response?.data || err.message);
                res.status(500).send('YouTube OAuth error');
            }
        });

        // Logout stub
        app.post('/oauth/youtube/logout', (req, res) => {
            youtubeIntegration = defaultYoutubeIntegration();
            res.json({ ok: true });
        });
    }

    async function hydrateFromDb() {
        const yt = await loadIntegration('youtube');
        if (yt && yt.access_token) {
            const seenIds = await new Promise((resolve) => {
                db.all('SELECT subscription_id FROM youtube_seen_subscribers', (err, rows) => {
                    resolve(err ? [] : (rows || []).map(r => r.subscription_id));
                });
            });
            youtubeIntegration = {
                connected: true,
                channel: yt.channel_name,
                liveTitle: yt.live_title,
                chatEnabled: !!yt.chat_enabled,
                viewers: yt.viewers_count || 0,
                likes: yt.likes_count || 0,
                tokens: {
                    access_token: yt.access_token,
                    refresh_token: yt.refresh_token
                },
                liveChatId: null,
                nextPageToken: null,
                videoId: yt.video_id || null,
                pollIntervalSec: yt.poll_interval_sec || 60,
                lastPollTime: 0,
                lastLiveDetectTime: 0,
                // Если раньше уже сохраняли базу подписчиков — не сбрасываем её при
                // рестарте, иначе подписавшиеся между опросами никогда не засчитаются.
                seenSubscriberIds: new Set(seenIds),
                subscribersInitialized: seenIds.length > 0
            };
            console.log(`✅ YouTube интеграция загружена из БД (подписчиков в базе: ${seenIds.length})`);
        }
    }

    function startPolling() {
        // YouTube: таймер раз в 30 сек (реальный интервал опроса — pollIntervalSec; реже тикаем, чтобы не нагружать цикл)
        setInterval(() => withApiQueue('youtube', () => updateYouTubeData()), 30000);
        // Подписчики опрашиваются отдельно (не завязано на live-статус). Раз в 60с:
        // subscriptions.list стоит 1 единицу квоты → ~1440/день при лимите 10000.
        setInterval(() => withApiQueue('youtube-subscribers', () => updateYouTubeSubscribers()), 60000);
    }

    return { registerRoutes, hydrateFromDb, startPolling, getState: () => youtubeIntegration, refreshData: () => updateYouTubeData() };
}

module.exports = { createYoutubeIntegrationModule };
