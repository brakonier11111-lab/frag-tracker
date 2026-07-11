'use strict';

/**
 * VK Play (основной аккаунт + отдельный бот-аккаунт) интеграция: статус
 * стрима, OAuth (code + implicit flow), сбор чата, поллинг канала и система
 * наград/ролей (channel point rewards -> авто-выдача ролей через Centrifugo
 * WebSocket). Вынесено из server.js как самый большой и переплетённый кусок
 * блока интеграций — все внутренние вызовы (assignRoleToUser -> getUserRoles/
 * getUserInfo/saveRoleHistory/sendChatMessage/cancelRewardActivation) остаются
 * внутри модуля, наружу торчат только registerRoutes/startPolling/hydrateFromDb.
 *
 * saveIntegration/loadIntegration/withApiQueue остаются в server.js (общие с
 * youtube-integration) и приходят как deps, как и db/broadcastToClients/wss.
 */

// axios по умолчанию читает системные HTTP_PROXY/HTTPS_PROXY и криво их
// применяет к некоторым запросам (см. тот же фикс в twitch-integration) —
// идём напрямую, vkvideo.ru доступен без прокси.
const axios = require('axios').create({ proxy: false });
const WebSocket = require('ws');
const { createRoleRewards } = require('./roleRewards');
const { createVkplayRoutes } = require('./routes');

function createVkplayIntegrationModule(deps) {
    const { db, saveIntegration, loadIntegration, withApiQueue, wss } = deps;
    const port = process.env.PORT || 3000;

    let vkplayIntegration = {
        connected: false,
        channel: null,
        liveTitle: null,
        chatEnabled: false,
        viewers: 0,
        likes: 0,
        tokens: null,
        expires_at: 0,
        channelUrl: null  // ВАЖНО: URL канала для API запросов
    };

    /** VK Play polling выключен по умолчанию — задайте VKPLAY_POLLING=1 чтобы включить */
    const VKPLAY_POLLING_ENABLED = process.env.VKPLAY_POLLING === '1';

    // Нормализация лайков VK Play: структура counters может отличаться, пробуем несколько вариантов
    // ВАЖНО: считаем лайки только по объекту ТЕКУЩЕГО стрима (stream.*), а не по
    // channel.counters — там лежит лайки канала за всю историю, они не имеют
    // отношения к "сейчас идёт эфир" и никогда не обнуляются, из-за чего лайки
    // "показывались" даже когда эфира не было вообще (та же категория бага, что
    // была с viewers/liveTitle). Если стрима нет — честный 0, не прошлое значение.
    function getVKPlayLikesFromChannelInfo(channelInfo) {
        if (!channelInfo || !channelInfo.stream) return 0;
        const stream = channelInfo.stream;
        const streamCounters = stream.counters || {};
        const count = stream.count || {};
        // VK Play API: reactions в stream.reactions — массив [{type:"heart",count:9}, ...]
        const reactionsObj = streamCounters.reactions || {};
        const reactionsArr = stream.reactions || streamCounters.reactions;

        const candidates = [
            streamCounters.likes,
            streamCounters.likes_count,
            streamCounters.like_count,
            count.likes,
            count.like_count,
            reactionsObj.likes,
            reactionsObj.like,
            reactionsObj.hearts,
            reactionsObj.heart
        ];

        let bestLikes = null;
        for (const v of candidates) {
            if (v == null) continue;
            const n = Number(v);
            if (Number.isNaN(n)) continue;
            if (bestLikes == null || n > bestLikes) bestLikes = n;
        }
        // stream.reactions = [{type:"heart",count:9}, {type:"fire",count:80}, ...] — это ВСЕ
        // реакции на стрим, а не только "лайк". У VK Play аналог лайка — реакция "heart"/"like",
        // остальные типы (fire, laugh и т.п.) не имеют отношения к счётчику лайков. Раньше здесь
        // суммировались count всех типов реакций разом, из-за чего "лайки" завышались на сумму
        // прочих эмодзи-реакций (лишние ~100-200 к настоящему числу лайков).
        const LIKE_REACTION_TYPES = new Set(['heart', 'hearts', 'like', 'likes']);
        let arr = Array.isArray(reactionsArr) ? reactionsArr : (reactionsObj.items || reactionsObj.list || []);
        if (!arr.length && reactionsArr && typeof reactionsArr === 'object' && !Array.isArray(reactionsArr)) {
            arr = Object.entries(reactionsArr)
                .filter(([k]) => k !== 'items' && k !== 'list')
                .map(([type, count]) => ({ type, count }));
        }
        if (arr.length) {
            let sum = 0;
            for (const r of arr) {
                const type = String(r?.type || '').toLowerCase();
                if (!LIKE_REACTION_TYPES.has(type)) continue;
                const c = r?.count ?? r?.value ?? r?.likes ?? r?.total;
                if (c != null) sum += Number(c) || 0;
            }
            if (bestLikes == null || sum > bestLikes) bestLikes = sum;
        }
        return bestLikes != null ? bestLikes : 0;
    }

    // Нормализация зрителей VK Play: пробуем разные пути в ответе API.
    // Только по stream.* (текущий эфир) — channel.counters это лайфтайм-статистика
    // канала, не имеет отношения к тому, идёт ли эфир сейчас (см. тот же фикс
    // для лайков выше).
    function getVKPlayViewersFromChannelInfo(channelInfo) {
        if (!channelInfo || !channelInfo.stream) return 0;
        const stream = channelInfo.stream;
        const counters = stream.counters || {};
        const count = stream.count || {};

        const candidates = [
            counters.viewers,
            counters.viewers_count,
            counters.viewer_count,
            counters.spectators,
            counters.spectator_count,
            count.viewers,
            count.viewers_count,
            count.views,
            stream.viewers,
            stream.viewers_count,
            stream.viewer_count,
            stream.spectators
        ];

        for (const v of candidates) {
            if (v != null) {
                const n = Number(v);
                if (!Number.isNaN(n)) return n;
            }
        }
        return 0;
    }

    // Rutony Chat вынесен в src/modules/rutony-chat

    // Интеграция VK Play для чат-бота (отдельный аккаунт)
    let vkplayBotIntegration = {
        connected: false,
        channel: null,
        channelUrl: null,
        tokens: null,
        expires_at: 0,
        userId: null,
        userNick: null
    };

    // Polling для проверки активированных наград (если WebSocket не работает)
    let lastCheckedDemandId = 0;

    let vkplayRewardsWs = null;
    let vkplayRewardsWsReconnectTimeout = null;

    async function collectVKPlayChat() {
        if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) return;
        
        try {
            let chatData;
            try {
                // Основной боевой API
                chatData = await axios.get('https://api.live.vkvideo.ru/v1/chat/messages', {
                    params: { 
                        channel_url: vkplayIntegration.channelUrl,
                        limit: 50
                    },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    // Как и для current_user/channel — пробуем apidev, если боевой отдает 404
                    console.log('⚠️ api.live.vkvideo.ru вернул 404 для chat/messages, пробуем apidev.live.vkvideo.ru...');
                    chatData = await axios.get('https://apidev.live.vkvideo.ru/v1/chat/messages', {
                        params: { 
                            channel_url: vkplayIntegration.channelUrl,
                            limit: 50
                        },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } else {
                    throw apiError;
                }
            }
            
            const messages = chatData.data?.data?.chat_messages || [];
            for (const msg of messages) {
                const messageText = msg.parts?.[0]?.text?.content || '';
                const insertParams = [
                    'vkplay',
                    vkplayIntegration.channelUrl,
                    msg.author?.id,
                    msg.author?.nick,
                    messageText,
                    msg.author?.is_moderator ? 1 : 0,
                    msg.author?.is_owner ? 1 : 0,
                    new Date(msg.created_at * 1000).toISOString(),
                    msg.id != null ? String(msg.id) : null
                ];
                if (msg.id != null) {
                    // Нативный ID сообщения — надёжная дедупликация без риска дропнуть настоящий повтор
                    db.run(`INSERT OR IGNORE INTO chat_messages (platform, channel_url, user_id, username, message, is_moderator, is_owner, created_at, message_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, insertParams, function (err) {
                        if (!err && this.changes > 0 && deps.onChatMessage) deps.onChatMessage('vkplay:' + msg.author?.id);
                    });
                } else {
                    // Fallback (нет msg.id в ответе API) — старая защита по контенту+времени
                    db.get('SELECT id FROM chat_messages WHERE platform = ? AND user_id = ? AND message = ? AND created_at > datetime("now", "-5 minutes")',
                        ['vkplay', msg.author?.id, messageText], (err, row) => {
                        if (!err && !row) {
                            db.run(`INSERT INTO chat_messages (platform, channel_url, user_id, username, message, is_moderator, is_owner, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, insertParams.slice(0, 8), function (insErr) {
                                if (!insErr && deps.onChatMessage) deps.onChatMessage('vkplay:' + msg.author?.id);
                            });
                        }
                    });
                }
            }
        } catch (error) {
            console.warn('⚠️ Ошибка сбора чата VK Play:', error?.response?.data || error.message);
        }
    }

    async function updateVKPlayData(options = {}) {
        const force = !!(options && options.force);
        if (!force && !VKPLAY_POLLING_ENABLED) return;
        if (!vkplayIntegration.connected || !vkplayIntegration.tokens) {
            return;
        }
        
        try {
            console.log('🔄 Обновление данных VK Play...');
            
            // Проверяем, не истек ли токен
            const now = Math.floor(Date.now() / 1000);
            if (now >= vkplayIntegration.expires_at - 60) { // обновляем за минуту до истечения
                console.log('🔄 Обновление токена VK Play...');
                // TODO: реализовать обновление токена через refresh_token
            }
            
            // Получаем данные канала (пробуем оба варианта URL)
            let currentUser;
            try {
                currentUser = await axios.get('https://api.live.vkvideo.ru/v1/current_user', {
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    console.log('⚠️ api.live.vkvideo.ru вернул 404, пробуем apidev.live.vkvideo.ru...');
                    currentUser = await axios.get('https://apidev.live.vkvideo.ru/v1/current_user', {
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } else {
                    throw apiError;
                }
            }
            
            console.log('👤 Данные пользователя:', currentUser.data?.data);
            
            const data = currentUser.data?.data;
            if (data && data.channel?.url) {
                let channelData;
                try {
                    channelData = await axios.get('https://api.live.vkvideo.ru/v1/channel', {
                        params: { channel_url: data.channel.url },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } catch (apiError) {
                    if (apiError?.response?.status === 404) {
                        console.log('⚠️ api.live.vkvideo.ru вернул 404 для channel, пробуем apidev...');
                        channelData = await axios.get('https://apidev.live.vkvideo.ru/v1/channel', {
                            params: { channel_url: data.channel.url },
                            headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                        });
                    } else {
                        throw apiError;
                    }
                }
                
                const channelInfo = channelData.data?.data;
                if (channelInfo) {
                    const oldChannel = vkplayIntegration.channel;
                    const oldTitle = vkplayIntegration.liveTitle;
                    vkplayIntegration.channel = channelInfo.channel?.nick || data.channel.url;
                    vkplayIntegration.liveTitle = channelInfo.stream?.title || 'Нет активного стрима';
                    vkplayIntegration.viewers = getVKPlayViewersFromChannelInfo(channelInfo);
                    vkplayIntegration.likes = getVKPlayLikesFromChannelInfo(channelInfo, vkplayIntegration.likes);
                    vkplayIntegration.chatEnabled = !!channelInfo.channel?.web_socket_channels?.chat;
                    vkplayIntegration.channelUrl = data.channel.url;
                    
                    // Сохраняем обновленные данные в БД
                    await saveIntegration('vkplay', {
                        tokens: vkplayIntegration.tokens,
                        expires_at: vkplayIntegration.expires_at,
                        channel: vkplayIntegration.channel,
                        channelUrl: vkplayIntegration.channelUrl,
                        liveTitle: vkplayIntegration.liveTitle,
                        viewers: vkplayIntegration.viewers,
                        likes: vkplayIntegration.likes,
                        chatEnabled: vkplayIntegration.chatEnabled
                    });
                    
                    console.log(`📺 VK Play обновлено:`);
                    console.log(`   Канал: ${oldChannel} → ${vkplayIntegration.channel}`);
                    console.log(`   Стрим: ${oldTitle} → ${vkplayIntegration.liveTitle}`);
                    console.log(`   Зрители: ${vkplayIntegration.viewers}`);
                    console.log(`   Лайки: ${vkplayIntegration.likes}`);
                    console.log(`   Чат: ${vkplayIntegration.chatEnabled ? 'включен' : 'выключен'}`);
                    
                    // Подключаемся к WebSocket наград если еще не подключены
                    // Пробуем оба варианта: channel_point_rewards и channel_points
                    const rewardsChannel = channelInfo.channel?.web_socket_channels?.channel_point_rewards || 
                                          channelInfo.channel?.web_socket_channels?.channel_points;
                    console.log('🔍 Проверка канала для наград:', {
                        channel_point_rewards: channelInfo.channel?.web_socket_channels?.channel_point_rewards,
                        channel_points: channelInfo.channel?.web_socket_channels?.channel_points,
                        allChannels: Object.keys(channelInfo.channel?.web_socket_channels || {}),
                        vkplayRewardsWs: !!vkplayRewardsWs,
                        rewardsChannel: rewardsChannel
                    });
                    if (!vkplayRewardsWs && rewardsChannel) {
                        console.log(`🔌 Найден канал для наград: ${rewardsChannel}`);
                        setTimeout(() => {
                            console.log('⏰ Вызов connectVKPlayRewardsWebSocket через setTimeout...');
                            connectVKPlayRewardsWebSocket();
                        }, 2000);
                    } else if (!rewardsChannel) {
                        console.warn('⚠️ Канал для наград не найден в web_socket_channels');
                        console.warn('   Доступные каналы:', Object.keys(channelInfo.channel?.web_socket_channels || {}));
                    } else if (vkplayRewardsWs) {
                        console.log('ℹ️ WebSocket для наград уже подключен');
                    }
                } else {
                    console.warn('⚠️ Не удалось получить данные канала');
                }
            } else {
                console.warn('⚠️ Нет данных канала в ответе пользователя');
            }
            
            // Собираем чат
            await collectVKPlayChat();
            
        } catch (error) {
            console.warn('⚠️ Ошибка обновления данных VK Play:', error?.response?.data || error.message);
            // VK возвращает просроченный/невалидный токен не всегда как HTTP 401 —
            // наблюдался 400 с телом {error:'unauthorized'}, из-за чего проверка
            // только по status===401 не срабатывала и connected/цифры зависали навсегда.
            const errCode = error.response?.data?.error;
            const isAuthError = error.response?.status === 401 || errCode === 'unauthorized' || errCode === 'invalid_token' || errCode === 'invalid_grant';
            if (isAuthError) {
                console.warn('🔑 Токен истек или невалиден, требуется повторная авторизация');
                vkplayIntegration.connected = false;
                vkplayIntegration.viewers = 0;
                vkplayIntegration.liveTitle = null;
                vkplayIntegration.chatEnabled = false;
                await saveIntegration('vkplay', {
                    tokens: vkplayIntegration.tokens,
                    expires_at: vkplayIntegration.expires_at,
                    channel: vkplayIntegration.channel,
                    channelUrl: vkplayIntegration.channelUrl,
                    liveTitle: null,
                    viewers: 0,
                    likes: vkplayIntegration.likes,
                    chatEnabled: false
                });
            }
        }
    }

    async function checkVKPlayRewardActivations() {
        if (!VKPLAY_POLLING_ENABLED) return;
        if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
            return;
        }

        try {
            // Получаем список запросов наград (активированных наград)
            let demandsResponse;
            try {
                demandsResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_point/reward/demands', {
                    params: {
                        channel_url: vkplayIntegration.channelUrl,
                        limit: 50,
                        offset: 0
                    },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    demandsResponse = await axios.get('https://api.live.vkvideo.ru/v1/channel_point/reward/demands', {
                        params: {
                            channel_url: vkplayIntegration.channelUrl,
                            limit: 50,
                            offset: 0
                        },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } else {
                    throw apiError;
                }
            }

            const demands = demandsResponse.data?.data?.demands || [];
            if (process.env.DEBUG_VK === '1') {
                console.log(`🔍 Проверка активированных наград: найдено ${demands.length} запросов`);
            }
            
            // Обрабатываем все запросы (включая выполненные)
            for (const demand of demands) {
                        const rewardId = demand.reward?.id;
                        const userId = demand.user?.id;
                        const rewardName = demand.reward?.name || 'Неизвестная награда';
                        const userName = demand.user?.nick || null;
                        const demandStatus = demand.status || 'unknown';
                        const demandId = demand.id;

                        if (!rewardId || !userId) {
                            continue;
                        }

                        // Получаем ник пользователя из разных источников
                        let finalUserName = userName;
                        
                        // Пробуем получить ник из demand.user.nick
                        if (!finalUserName && demand.user?.nick) {
                            finalUserName = demand.user.nick.trim();
                            console.log(`✅ Ник получен из demand.user.nick: "${finalUserName}"`);
                        }
                        
                        // Если все еще нет ника, пытаемся получить через API
                        if (!finalUserName) {
                            console.log(`🔍 Получаем ник пользователя ${userId} через API...`);
                            const userInfo = await getUserInfo(userId);
                            if (userInfo && userInfo.nick) {
                                finalUserName = userInfo.nick.trim();
                                console.log(`✅ Ник пользователя ${userId} получен через API: "${finalUserName}"`);
                            } else {
                                console.warn(`⚠️ Не удалось получить ник пользователя ${userId} через API`);
                            }
                        }
                        
                        if (!finalUserName) {
                            console.warn(`⚠️ Ник пользователя ${userId} не получен ни из одного источника, будет использован ID`);
                        }

                        // Проверяем, есть ли уже запись в истории для этого demand (за последние 5 минут)
                        db.get(
                            'SELECT id FROM vkplay_role_history WHERE user_id = ? AND reward_id = ? AND created_at > datetime("now", "-5 minutes")',
                            [userId, rewardId],
                            async (err, existing) => {
                                if (err) {
                                    console.error('❌ Ошибка проверки истории:', err);
                                    return;
                                }

                                // Если запись уже есть, пропускаем
                                if (existing) {
                                    console.log(`ℹ️ Запись уже есть в истории для demand ${demandId}, пропускаем`);
                                    return;
                                }

                                console.log(`🎁 Обнаружена активация награды через polling: ${rewardName} пользователем ${userId} (${finalUserName || 'без ника'}), статус: ${demandStatus}, ID: ${demandId}`);

                                // Ищем связь награда-роль
                                db.get(
                                    'SELECT * FROM vkplay_reward_roles WHERE reward_id = ? AND channel_url = ? AND enabled = 1',
                                    [rewardId, vkplayIntegration.channelUrl],
                                    async (err, row) => {
                                        if (err) {
                                            console.error('❌ Ошибка поиска связи награда-роль:', err);
                                            return;
                                        }

                                        if (!row) {
                                            console.warn(`⚠️ Связь награда-роль не найдена для rewardId=${rewardId}`);
                                            // Не сохраняем в историю, если нет связи (только награды со связками)
                                            return;
                                        }

                                        console.log(`✅ Найдена связь: ${row.reward_name} → ${row.role_name}`);
                                        
                                        // Если награда уже выполнена (status = 'accepted' или 'completed'), просто сохраняем в историю как "assigned"
                                        if (demandStatus === 'accepted' || demandStatus === 'completed' || demandStatus === 'done') {
                                            console.log(`ℹ️ Награда уже выполнена (статус: ${demandStatus}), сохраняем в историю как "assigned"`);
                                            await saveRoleHistory(userId, finalUserName, rewardId, rewardName, row.role_id, row.role_name, 'assigned', null);
                                            return;
                                        }

                                        // Если награда еще не обработана, пытаемся выдать роль
                                        const result = await assignRoleToUser(userId, row.role_id, row.reward_id, row.reward_name);
                                        if (result.success) {
                                            console.log(`✅ Роль ${row.role_name} успешно выдана пользователю ${userId}`);
                                        } else {
                                            console.log(`⚠️ Роль не выдана: ${result.reason || 'неизвестная причина'}`);
                                        }
                                    }
                                );
                            }
                        );

                // Обновляем последний проверенный ID
                if (demandId > lastCheckedDemandId) {
                    lastCheckedDemandId = demandId;
                }
            }
        } catch (error) {
            // Игнорируем ошибки polling (может быть 403 если нет прав)
            if (error?.response?.status !== 403) {
                console.warn('⚠️ Ошибка проверки активированных наград:', error?.response?.data || error.message);
            }
        }
    }

    // Роли/награды пользователей (getUserRoles..assignRoleToUser) вынесены в
    // roleRewards.js. Общее состояние — через хаб h.
    const h = {
        get vkplayIntegration() { return vkplayIntegration; },
        set vkplayIntegration(v) { vkplayIntegration = v; },
        get vkplayBotIntegration() { return vkplayBotIntegration; },
        set vkplayBotIntegration(v) { vkplayBotIntegration = v; },
        db,
        wss
    };
    const {
        getUserInfo,
        saveRoleHistory,
        assignRoleToUser
    } = createRoleRewards(h);


    async function connectVKPlayRewardsWebSocket() {
        if (!VKPLAY_POLLING_ENABLED) return;
        // не копим дублирующиеся таймеры переподключения
        if (vkplayRewardsWsReconnectTimeout) {
            clearTimeout(vkplayRewardsWsReconnectTimeout);
            vkplayRewardsWsReconnectTimeout = null;
        }
        if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
            return;
        }

        try {
            // Получаем WebSocket URL из данных канала
            let channelData;
            try {
                channelData = await axios.get('https://apidev.live.vkvideo.ru/v1/channel', {
                    params: { channel_url: vkplayIntegration.channelUrl },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    channelData = await axios.get('https://api.live.vkvideo.ru/v1/channel', {
                        params: { channel_url: vkplayIntegration.channelUrl },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } else {
                    throw apiError;
                }
            }
            
            // Пробуем оба варианта: channel_point_rewards и channel_points
            const webSocketChannels = channelData.data?.data?.channel?.web_socket_channels || {};
            const rewardsChannel = webSocketChannels.channel_point_rewards || webSocketChannels.channel_points;
            
            if (!rewardsChannel) {
                console.warn('⚠️ WebSocket канал для наград не доступен');
                console.warn('   Доступные каналы:', Object.keys(webSocketChannels));
                return;
            }
            
            console.log(`✅ Найден канал для наград: ${rewardsChannel}`);
            
            // Подключаемся к WebSocket через Centrifugo
            // Согласно документации, нужно использовать pubsub-dev.live.vkvideo.ru или pubsub.live.vkvideo.ru
            // И подключиться через Centrifugo протокол
            const wsUrl = `wss://pubsub-dev.live.vkvideo.ru/connection/websocket?format=json&cf_protocol_version=v2`;
            
            if (vkplayRewardsWs) {
                try { vkplayRewardsWs.close(); } catch(_) {}
            }

            console.log(`🔌 Подключение к WebSocket: ${wsUrl}`);
            console.log(`🔌 Подключение к WebSocket: ${wsUrl}`);
            vkplayRewardsWs = new WebSocket(wsUrl);

            vkplayRewardsWs.on('open', async () => {
                console.log('✅ WebSocket для наград VK Play подключен');
                
                // Получаем токен для подключения к pubsub
                try {
                    const pubsubTokenResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/websocket/token', {
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                    
                    const pubsubToken = pubsubTokenResponse.data?.data?.token;
                    if (!pubsubToken) {
                        console.error('❌ Не удалось получить токен для pubsub');
                        return;
                    }

                    // Отправляем команду подключения с токеном
                    const connectMessage = {
                        id: 1,
                        method: 'connect',
                        params: {
                            token: pubsubToken
                        }
                    };
                    
                    vkplayRewardsWs.send(JSON.stringify(connectMessage));
                    console.log('📤 Отправлена команда подключения к Centrifugo');
                } catch (error) {
                    console.error('❌ Ошибка получения токена pubsub:', error?.response?.data || error.message);
                }
            });

            vkplayRewardsWs.on('message', async (data) => {
                try {
                    const rawMessage = data.toString();
                    console.log('📨 Получено WebSocket сообщение (raw):', rawMessage);
                    
                    let message;
                    try {
                        message = JSON.parse(rawMessage);
                    } catch (parseError) {
                        console.error('❌ Ошибка парсинга JSON:', parseError);
                        console.error('   Сырые данные:', rawMessage);
                        return;
                    }

                    console.log('📨 Событие награды VK Play (parsed):', JSON.stringify(message, null, 2));

                    // Проверяем различные форматы сообщений Centrifugo
                    let rewardId = null;
                    let userId = null;
                    let rewardName = null;
                    let userName = null;

                    // Формат 1: Прямые поля
                    if (message.reward?.id) rewardId = message.reward.id;
                    if (message.user?.id) userId = message.user.id;
                    if (message.reward?.name) rewardName = message.reward.name;
                    if (message.user?.nick) userName = message.user.nick;

                    // Формат 2: Вложенные в data
                    if (!rewardId && message.data?.reward?.id) rewardId = message.data.reward.id;
                    if (!userId && message.data?.user?.id) userId = message.data.user.id;
                    if (!rewardName && message.data?.reward?.name) rewardName = message.data.reward.name;
                    if (!userName && message.data?.user?.nick) userName = message.data.user.nick;

                    // Формат 3: Centrifugo публикация (result.data)
                    if (!rewardId && message.result?.data?.reward?.id) rewardId = message.result.data.reward.id;
                    if (!userId && message.result?.data?.user?.id) userId = message.result.data.user.id;
                    if (!rewardName && message.result?.data?.reward?.name) rewardName = message.result.data.reward.name;
                    if (!userName && message.result?.data?.user?.nick) userName = message.result.data.user.nick;

                    // Формат 4: В публикации (publication.data)
                    if (!rewardId && message.publication?.data?.reward?.id) rewardId = message.publication.data.reward.id;
                    if (!userId && message.publication?.data?.user?.id) userId = message.publication.data.user.id;
                    if (!rewardName && message.publication?.data?.reward?.name) rewardName = message.publication.data.reward.name;
                    if (!userName && message.publication?.data?.user?.nick) userName = message.publication.data.user.nick;

                    // Проверяем тип события
                    const eventType = message.type || message.event || message.result?.data?.type || message.publication?.data?.type;
                    console.log(`🔍 Тип события: ${eventType}, rewardId: ${rewardId}, userId: ${userId}`);

                    // Обрабатываем активацию награды
                    if (eventType === 'reward_activated' || eventType === 'channel_point_reward_activated' || 
                        message.type === 'reward_activated' || message.event === 'reward_activated' ||
                        (rewardId && userId)) {
                        
                        if (!rewardId || !userId) {
                            console.warn('⚠️ Не удалось извлечь rewardId или userId из сообщения');
                            console.warn('   Структура сообщения:', JSON.stringify(message, null, 2));
                            return;
                        }

                        console.log(`🎁 Обработка активации награды: rewardId=${rewardId}, userId=${userId}, rewardName=${rewardName || 'неизвестно'}`);

                        // Ищем связь награда-роль
                        db.get(
                            'SELECT * FROM vkplay_reward_roles WHERE reward_id = ? AND channel_url = ? AND enabled = 1',
                            [rewardId, vkplayIntegration.channelUrl],
                            async (err, row) => {
                                if (err) {
                                    console.error('❌ Ошибка поиска связи награда-роль:', err);
                                    return;
                                }

                                // Получаем ник пользователя, если его нет в сообщении
                                let finalUserName = userName;
                                if (finalUserName && typeof finalUserName === 'string' && finalUserName.trim() !== '') {
                                    finalUserName = finalUserName.trim();
                                    console.log(`✅ Ник пользователя ${userId} получен из WebSocket события: "${finalUserName}"`);
                                } else {
                                    console.log(`🔍 Ник не найден в WebSocket событии для userId=${userId}, пытаемся получить через API...`);
                                    const userInfo = await getUserInfo(userId);
                                    finalUserName = userInfo?.nick || null;
                                    if (finalUserName) {
                                        console.log(`✅ Ник пользователя ${userId} получен через API: "${finalUserName}"`);
                                    } else {
                                        console.warn(`⚠️ Не удалось получить ник пользователя ${userId} ни из WebSocket события, ни через API`);
                                    }
                                }

                                if (!row) {
                                    console.warn(`⚠️ Связь награда-роль не найдена для rewardId=${rewardId}, channelUrl=${vkplayIntegration.channelUrl}`);
                                    // Сохраняем в историю как "не найдена связь"
                                    await saveRoleHistory(userId, finalUserName, rewardId, rewardName || 'Неизвестная награда', '', '', 'error', 'Связь награда-роль не найдена');
                                    return;
                                }

                                console.log(`✅ Найдена связь: ${row.reward_name} → ${row.role_name}`);
                                console.log(`🎁 Награда ${row.reward_name} активирована пользователем ${userId} (${finalUserName || 'без ника'}), выдаем роль ${row.role_name}`);
                                
                                const result = await assignRoleToUser(userId, row.role_id, row.reward_id, row.reward_name);
                                if (result.success) {
                                    console.log(`✅ Роль ${row.role_name} успешно выдана пользователю ${userId}`);
                                } else {
                                    console.log(`⚠️ Роль не выдана: ${result.reason || 'неизвестная причина'}`);
                                }
                            }
                        );
                    } else {
                        console.log(`ℹ️ Игнорируем событие типа: ${eventType}`);
                    }
                } catch (error) {
                    console.error('❌ Ошибка обработки WebSocket сообщения:', error);
                    console.error('   Stack:', error.stack);
                }
            });

            vkplayRewardsWs.on('error', (error) => {
                console.error('❌ Ошибка WebSocket наград:', error);
            });

            vkplayRewardsWs.on('close', () => {
                console.log('⚠️ WebSocket для наград VK Play отключен, переподключение через 10 секунд...');
                vkplayRewardsWsReconnectTimeout = setTimeout(connectVKPlayRewardsWebSocket, 10000);
            });

        } catch (error) {
            console.error('❌ Ошибка подключения WebSocket для наград:', error);
            vkplayRewardsWsReconnectTimeout = setTimeout(connectVKPlayRewardsWebSocket, 10000);
        }
    }

    // Роуты вынесены в routes.js (1:1), обвязка — через тот же хаб h.
    Object.assign(h, {
        saveIntegration,
        loadIntegration,
        port,
        getVKPlayLikesFromChannelInfo: (...a) => getVKPlayLikesFromChannelInfo(...a),
        getVKPlayViewersFromChannelInfo: (...a) => getVKPlayViewersFromChannelInfo(...a),
        getUserInfo: (...a) => getUserInfo(...a)
    });
    const { registerRoutes } = createVkplayRoutes(h);


    function startPolling() {
        if (VKPLAY_POLLING_ENABLED) {
            setInterval(() => withApiQueue('vkplay', () => updateVKPlayData()), 5000);
            setInterval(() => withApiQueue('vkplay-rewards', () => checkVKPlayRewardActivations()), 10000);
        }
    }

    async function hydrateFromDb() {
                const vkplay = await loadIntegration('vkplay');
                if (vkplay && vkplay.access_token) {
                    vkplayIntegration = {
                        connected: true,
                        channel: vkplay.channel_name,
                        liveTitle: vkplay.live_title,
                        chatEnabled: !!vkplay.chat_enabled,
                        viewers: vkplay.viewers_count || 0,
                        likes: vkplay.likes_count || 0,
                        tokens: {
                            access_token: vkplay.access_token,
                            refresh_token: vkplay.refresh_token
                        },
                        expires_at: vkplay.expires_at || 0,
                        channelUrl: vkplay.channel_url
                    };
                    console.log('✅ VK Play интеграция загружена из БД:', {
                        channel: vkplayIntegration.channel,
                        channelUrl: vkplayIntegration.channelUrl,
                        liveTitle: vkplayIntegration.liveTitle,
                        connected: vkplayIntegration.connected
                    });
                    
                    // Если channelUrl отсутствует, обновляем данные
                    if (!vkplayIntegration.channelUrl && vkplayIntegration.tokens?.access_token && VKPLAY_POLLING_ENABLED) {
                        console.log('🔄 channelUrl отсутствует, обновляем данные через API...');
                        setTimeout(() => {
                            updateVKPlayData();
                        }, 2000);
                    }
                }

                // VK Play Bot
                const vkplayBot = await loadIntegration('vkplay_bot');
                if (vkplayBot && vkplayBot.access_token) {
                    vkplayBotIntegration = {
                        connected: true,
                        channel: vkplayBot.channel_name,
                        channelUrl: vkplayBot.channel_url,
                        tokens: {
                            access_token: vkplayBot.access_token,
                            refresh_token: vkplayBot.refresh_token
                        },
                        expires_at: vkplayBot.expires_at || 0,
                        userId: vkplayBot.user_id || null,
                        userNick: vkplayBot.user_nick || null
                    };
                    console.log('✅ VK Play Bot интеграция загружена из БД:', {
                        userNick: vkplayBotIntegration.userNick,
                        userId: vkplayBotIntegration.userId,
                        channelUrl: vkplayBotIntegration.channelUrl,
                        connected: vkplayBotIntegration.connected
                    });
                }
    }

    return { registerRoutes, startPolling, hydrateFromDb, getState: () => vkplayIntegration, refreshData: (opts) => updateVKPlayData(opts) };
}

module.exports = { createVkplayIntegrationModule };
