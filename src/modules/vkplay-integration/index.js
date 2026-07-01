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

const axios = require('axios');
const querystring = require('querystring');
const WebSocket = require('ws');
const express = require('express');

function createVkplayIntegrationModule(deps) {
    const { db, saveIntegration, loadIntegration, withApiQueue, broadcastToClients, wss } = deps;
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
    function getVKPlayLikesFromChannelInfo(channelInfo, previousLikes) {
        if (!channelInfo) return previousLikes || 0;
        const stream = channelInfo.stream || {};
        const streamCounters = stream.counters || {};
        const channelCounters = channelInfo.channel?.counters || {};
        const count = channelInfo.count || stream.count || channelInfo.data?.count || {};
        // VK Play API: reactions в stream.reactions — массив [{type:"heart",count:9}, ...]
        const reactionsObj = streamCounters.reactions || channelCounters.reactions || {};
        const reactionsArr = stream.reactions || streamCounters.reactions || channelCounters.reactions;

        const candidates = [
            streamCounters.likes,
            streamCounters.likes_count,
            streamCounters.like_count,
            channelCounters.likes,
            channelCounters.likes_count,
            channelCounters.like_count,
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
        // stream.reactions = [{type:"heart",count:9}] — суммируем count по всем реакциям
        const arr = Array.isArray(reactionsArr) ? reactionsArr : (reactionsObj.items || reactionsObj.list || []);
        if (arr.length) {
            let sum = 0;
            for (const r of arr) {
                const c = r?.count ?? r?.value ?? r?.likes ?? r?.total;
                if (c != null) sum += Number(c) || 0;
            }
            if (bestLikes == null || sum > bestLikes) bestLikes = sum;
        }
        if (bestLikes != null) return bestLikes;
        return previousLikes || 0;
    }

    // Нормализация зрителей VK Play: пробуем разные пути в ответе API
    function getVKPlayViewersFromChannelInfo(channelInfo) {
        if (!channelInfo) return 0;
        const stream = channelInfo.stream || {};
        const counters = stream.counters || {};
        const channelCounters = channelInfo.channel?.counters || {};
        const count = channelInfo.count || stream.count || channelInfo.data?.count || {};

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
            stream.spectators,
            channelCounters.viewers,
            channelCounters.viewers_count,
            channelCounters.spectators
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
                // Проверяем, есть ли уже такое сообщение
                db.get('SELECT id FROM chat_messages WHERE platform = ? AND user_id = ? AND message = ? AND created_at > datetime("now", "-5 minutes")', 
                    ['vkplay', msg.author?.id, msg.parts?.[0]?.text?.content], (err, row) => {
                    if (!err && !row) {
                        // Сохраняем новое сообщение
                        db.run(`INSERT INTO chat_messages (platform, channel_url, user_id, username, message, is_moderator, is_owner, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                            'vkplay',
                            vkplayIntegration.channelUrl,
                            msg.author?.id,
                            msg.author?.nick,
                            msg.parts?.[0]?.text?.content || '',
                            msg.author?.is_moderator ? 1 : 0,
                            msg.author?.is_owner ? 1 : 0,
                            new Date(msg.created_at * 1000).toISOString()
                        ]);
                    }
                });
            }
        } catch (error) {
            console.warn('⚠️ Ошибка сбора чата VK Play:', error?.response?.data || error.message);
        }
    }

    async function updateVKPlayData() {
        if (!VKPLAY_POLLING_ENABLED) return;
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
            if (error.response?.status === 401) {
                console.warn('🔑 Токен истек, требуется повторная авторизация');
                vkplayIntegration.connected = false;
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

    async function getUserRoles(userId) {
        try {
            if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
                return [];
            }

            let response;
            try {
                response = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_roles/user', {
                    params: {
                        channel_url: vkplayIntegration.channelUrl,
                        user_id: userId
                    },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    try {
                        response = await axios.get('https://api.live.vkvideo.ru/v1/channel_roles/user', {
                            params: {
                                channel_url: vkplayIntegration.channelUrl,
                                user_id: userId
                            },
                            headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                        });
                    } catch (error2) {
                        // Если 404 - это может означать, что у пользователя просто нет ролей
                        if (error2?.response?.status === 404) {
                            console.log(`ℹ️ У пользователя ${userId} нет ролей (404)`);
                            return []; // Возвращаем пустой массив, а не null
                        }
                        throw error2;
                    }
                } else {
                    throw apiError;
                }
            }

            const roles = response.data?.data?.roles || [];
            console.log(`👤 Роли пользователя ${userId}:`, roles.map(r => r.name || r.id).join(', ') || 'нет ролей');
            return roles;
        } catch (error) {
            // Если ошибка 404 - у пользователя просто нет ролей
            if (error?.response?.status === 404) {
                console.log(`ℹ️ У пользователя ${userId} нет ролей (404)`);
                return []; // Возвращаем пустой массив
            }
            console.error('❌ Ошибка получения ролей пользователя:', error?.response?.status || error.message);
            return []; // Возвращаем пустой массив вместо null
        }
    }

    // Проверка наличия роли у пользователя
    async function userHasRole(userId, roleId) {
        const roles = await getUserRoles(userId);
        if (!roles || roles.length === 0) return false;
        return roles.some(role => role.id === roleId);
    }

    async function sendChatMessage(message, userId = null, useBot = false) {
        try {
            // Выбираем интеграцию (бота или основной аккаунт)
            const integration = useBot ? vkplayBotIntegration : vkplayIntegration;
            const integrationName = useBot ? 'бот' : 'основной аккаунт';
            
            if (!integration.connected || !integration.tokens || !integration.channelUrl) {
                if (useBot) {
                    console.warn('⚠️ VK Play Bot не подключен для отправки сообщения');
                } else {
                    console.warn('⚠️ VK Play не подключен для отправки сообщения');
                }
                return false;
            }

            // Получаем информацию о пользователе для упоминания
            let userNick = null;
            if (userId) {
                try {
                    const userInfo = await getUserInfo(userId);
                    userNick = userInfo?.nick || null;
                } catch (e) {
                    console.warn('⚠️ Не удалось получить информацию о пользователе:', e);
                }
            }

            // Получаем stream_id для отправки сообщения
            let streamId = null;
            try {
                let channelData;
                try {
                    channelData = await axios.get('https://apidev.live.vkvideo.ru/v1/channel', {
                        params: { channel_url: integration.channelUrl },
                        headers: { Authorization: `Bearer ${integration.tokens.access_token}` }
                    });
                } catch (apiError) {
                    if (apiError?.response?.status === 404) {
                        channelData = await axios.get('https://api.live.vkvideo.ru/v1/channel', {
                            params: { channel_url: integration.channelUrl },
                            headers: { Authorization: `Bearer ${integration.tokens.access_token}` }
                        });
                    } else {
                        throw apiError;
                    }
                }
                
                streamId = channelData.data?.data?.stream?.id || null;
                if (!streamId) {
                    console.warn('⚠️ Не удалось получить stream_id, сообщение может не отправиться');
                }
            } catch (e) {
                console.warn('⚠️ Ошибка получения stream_id:', e?.response?.data || e.message);
            }

            // Формируем сообщение согласно документации API
            const messageParts = [];
            
            // Если указан userId, добавляем упоминание в начале (даже если ник не получен)
            // Согласно документации, для mention нужен id, а nick опционален
            if (userId) {
                messageParts.push({
                    mention: {
                        id: userId,
                        nick: userNick || ''  // Ник опционален, можно оставить пустым
                    }
                });
                messageParts.push({
                    text: {
                        content: ', ' + message
                    }
                });
                console.log(`📝 Формируем сообщение с упоминанием пользователя: userId=${userId}, nick=${userNick || 'не получен'}`);
            } else {
                messageParts.push({
                    text: {
                        content: message
                    }
                });
                console.log('📝 Формируем сообщение без упоминания (userId не указан)');
            }

            // Отправляем сообщение в чат согласно документации: POST /v1/chat/message/send
            const requestBody = {
                parts: messageParts
            };
            
            const requestParams = {
                channel_url: integration.channelUrl
            };
            
            if (streamId) {
                requestParams.stream_id = streamId;
            }

            let response;
            try {
                response = await axios.post(
                    'https://apidev.live.vkvideo.ru/v1/chat/message/send',
                    requestBody,
                    {
                        params: requestParams,
                        headers: { Authorization: `Bearer ${integration.tokens.access_token}` }
                    }
                );
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    response = await axios.post(
                        'https://api.live.vkvideo.ru/v1/chat/message/send',
                        requestBody,
                        {
                            params: requestParams,
                            headers: { Authorization: `Bearer ${integration.tokens.access_token}` }
                        }
                    );
                } else {
                    throw apiError;
                }
            }

            console.log(`✅ Сообщение отправлено в чат от ${integrationName}: ${message}`);
            return true;
        } catch (error) {
            console.error(`❌ Ошибка отправки сообщения в чат от ${useBot ? 'бота' : 'основного аккаунта'}:`, error?.response?.data || error.message);
            // Если API для отправки сообщений недоступен, логируем предупреждение
            if (error.response?.status === 404 || error.response?.status === 501) {
                console.warn('⚠️ API для отправки сообщений в чат недоступен. Возможно, нужны дополнительные права доступа.');
            } else if (error.response?.status === 403) {
                console.warn('⚠️ Доступ запрещен. Проверьте права доступа (scope: chat:message:send)');
            }
            return false;
        }
    }

    async function cancelRewardActivation(rewardId, userId, rewardPrice) {
        try {
            if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
                console.warn('⚠️ VK Play не подключен для отмены награды');
                return false;
            }

            console.log(`🔄 Попытка отмены награды ${rewardId} для пользователя ${userId}...`);

            // Получаем список запросов наград (demands) - ищем активный запрос от этого пользователя
            let demandsResponse;
            try {
                demandsResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_point/reward/demands', {
                    params: {
                        channel_url: vkplayIntegration.channelUrl,
                        limit: 100,
                        offset: 0
                    },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    demandsResponse = await axios.get('https://api.live.vkvideo.ru/v1/channel_point/reward/demands', {
                        params: {
                            channel_url: vkplayIntegration.channelUrl,
                            limit: 100,
                            offset: 0
                        },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } else {
                    throw apiError;
                }
            }

            const demands = demandsResponse.data?.data?.demands || [];
            console.log(`🔍 Найдено ${demands.length} запросов наград, ищем запрос от пользователя ${userId} для награды ${rewardId}...`);

            // Ищем запрос от этого пользователя для этой награды (может быть pending, accepted, completed)
            const userDemand = demands.find(d => 
                d.user?.id === userId && 
                d.reward?.id === rewardId
            );

            if (!userDemand) {
                console.warn(`⚠️ Запрос награды не найден для userId=${userId}, rewardId=${rewardId}`);
                return false;
            }

            console.log(`✅ Найден запрос награды: ID=${userDemand.id}, статус=${userDemand.status}`);

            // Пытаемся отклонить запрос (это должно вернуть баллы)
            try {
                let rejectResponse;
                try {
                    rejectResponse = await axios.post(
                        'https://apidev.live.vkvideo.ru/v1/channel_point/reward/demand/reject',
                        { demands: [{ id: userDemand.id }] },
                        {
                            params: { channel_url: vkplayIntegration.channelUrl },
                            headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                        }
                    );
                } catch (apiError) {
                    if (apiError?.response?.status === 404) {
                        rejectResponse = await axios.post(
                            'https://api.live.vkvideo.ru/v1/channel_point/reward/demand/reject',
                            { demands: [{ id: userDemand.id }] },
                            {
                                params: { channel_url: vkplayIntegration.channelUrl },
                                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                            }
                        );
                    } else {
                        throw apiError;
                    }
                }

                console.log(`✅ Запрос награды отклонен (ID: ${userDemand.id}), баллы должны быть возвращены пользователю ${userId}`);
                return true;
            } catch (error) {
                console.error('❌ Ошибка при попытке отклонить запрос награды:', error?.response?.status, error?.response?.data || error.message);
                // Если ошибка 400 или 404, возможно запрос уже обработан
                if (error?.response?.status === 400 || error?.response?.status === 404) {
                    console.warn(`⚠️ Запрос награды уже обработан или не может быть отклонен (статус: ${userDemand.status})`);
                }
                return false;
            }
        } catch (error) {
            console.error('❌ Ошибка отмены награды:', error?.response?.status, error?.response?.data || error.message);
            return false;
        }
    }

    async function getUserInfo(userId) {
        try {
            if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
                console.warn(`⚠️ VK Play не подключен, невозможно получить ник пользователя ${userId}`);
                return null;
            }

            // Метод 1: Пробуем получить информацию через chat/member
            let response;
            try {
                response = await axios.get('https://apidev.live.vkvideo.ru/v1/chat/member', {
                    params: {
                        channel_url: vkplayIntegration.channelUrl,
                        user_id: userId
                    },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
                
                const user = response.data?.data?.user || response.data?.data?.member?.user || response.data?.user;
                if (user && user.nick && typeof user.nick === 'string' && user.nick.trim() !== '') {
                    const nick = user.nick.trim();
                    console.log(`✅ Получен ник пользователя ${userId} через chat/member: "${nick}"`);
                    return { ...user, nick };
                }
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    try {
                        response = await axios.get('https://api.live.vkvideo.ru/v1/chat/member', {
                            params: {
                                channel_url: vkplayIntegration.channelUrl,
                                user_id: userId
                            },
                            headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                        });
                        
                        const user = response.data?.data?.user || response.data?.data?.member?.user || response.data?.user;
                        if (user && user.nick && typeof user.nick === 'string' && user.nick.trim() !== '') {
                            const nick = user.nick.trim();
                            console.log(`✅ Получен ник пользователя ${userId} через chat/member (основной API): "${nick}"`);
                            return { ...user, nick };
                        }
                    } catch (error2) {
                        console.warn(`⚠️ Не удалось получить ник пользователя ${userId} через chat/member:`, error2?.response?.status || error2.message);
                    }
                } else {
                    console.warn(`⚠️ Ошибка получения ника пользователя ${userId} через chat/member:`, apiError?.response?.status || apiError.message);
                }
            }
            
            // Метод 2: Если API не сработал, пробуем получить ник из сохраненных сообщений чата
            try {
                const chatNick = await new Promise((resolve) => {
                    db.get(
                        'SELECT username FROM chat_messages WHERE platform = ? AND user_id = ? AND username IS NOT NULL AND username != "" ORDER BY created_at DESC LIMIT 1',
                        ['vkplay', userId],
                        (err, row) => {
                            if (!err && row && row.username && row.username.trim() !== '') {
                                const nick = row.username.trim();
                                console.log(`✅ Получен ник пользователя ${userId} из сообщений чата: "${nick}"`);
                                resolve(nick);
                            } else {
                                resolve(null);
                            }
                        }
                    );
                });
                
                if (chatNick) {
                    return { nick: chatNick, id: userId };
                }
            } catch (dbError) {
                console.warn(`⚠️ Ошибка получения ника из БД для userId=${userId}:`, dbError);
            }

            // Метод 3: Пробуем получить через список участников чата (chat/members)
            try {
                let membersResponse;
                try {
                    membersResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/chat/members', {
                        params: {
                            channel_url: vkplayIntegration.channelUrl,
                            limit: 200  // Максимум участников
                        },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } catch (apiError) {
                    if (apiError?.response?.status === 404) {
                        membersResponse = await axios.get('https://api.live.vkvideo.ru/v1/chat/members', {
                            params: {
                                channel_url: vkplayIntegration.channelUrl,
                                limit: 200
                            },
                            headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                        });
                    } else {
                        throw apiError;
                    }
                }
                
                const users = membersResponse.data?.data?.users || [];
                const foundUser = users.find(u => u.id === userId);
                if (foundUser && foundUser.nick && typeof foundUser.nick === 'string' && foundUser.nick.trim() !== '') {
                    const nick = foundUser.nick.trim();
                    console.log(`✅ Получен ник пользователя ${userId} через chat/members: "${nick}"`);
                    return { ...foundUser, nick };
                }
            } catch (membersError) {
                // Игнорируем ошибку, пробуем следующий метод
            }

            // Метод 4: Пробуем получить через список ролей пользователя (там может быть ник)
            try {
                const rolesResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_roles/user', {
                    params: {
                        channel_url: vkplayIntegration.channelUrl,
                        user_id: userId
                    },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
                
                // В ответе может быть информация о пользователе
                const user = rolesResponse.data?.data?.user;
                if (user && user.nick && typeof user.nick === 'string' && user.nick.trim() !== '') {
                    const nick = user.nick.trim();
                    console.log(`✅ Получен ник пользователя ${userId} через channel_roles/user: "${nick}"`);
                    return { ...user, nick };
                }
            } catch (rolesError) {
                if (rolesError?.response?.status === 404) {
                    try {
                        const rolesResponse2 = await axios.get('https://api.live.vkvideo.ru/v1/channel_roles/user', {
                            params: {
                                channel_url: vkplayIntegration.channelUrl,
                                user_id: userId
                            },
                            headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                        });
                        
                        const user = rolesResponse2.data?.data?.user;
                        if (user && user.nick && typeof user.nick === 'string' && user.nick.trim() !== '') {
                            const nick = user.nick.trim();
                            console.log(`✅ Получен ник пользователя ${userId} через channel_roles/user (основной API): "${nick}"`);
                            return { ...user, nick };
                        }
                    } catch (error3) {
                        // Игнорируем ошибку
                    }
                }
            }

            console.warn(`⚠️ Ник пользователя ${userId} не найден ни одним методом`);
            return null;
        } catch (error) {
            console.warn(`⚠️ Ошибка получения информации о пользователе ${userId}:`, error?.response?.status || error.message);
            return null;
        }
    }

    async function saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, roleName, status, reason = null) {
        const channelUrl = vkplayIntegration.channelUrl;
        if (!channelUrl) {
            console.error('❌ channelUrl не установлен, невозможно сохранить историю');
            return;
        }

        // Убеждаемся, что userNick - это строка или null, а не undefined
        let finalUserNick = userNick && typeof userNick === 'string' && userNick.trim() !== '' ? userNick.trim() : null;
        
        // Если ник не передан, пытаемся получить его перед сохранением
        if (!finalUserNick && userId) {
            try {
                const userInfo = await getUserInfo(userId);
                if (userInfo && userInfo.nick && userInfo.nick.trim() !== '') {
                    finalUserNick = userInfo.nick.trim();
                    console.log(`✅ Ник получен перед сохранением истории для userId=${userId}: "${finalUserNick}"`);
                }
            } catch (err) {
                console.warn(`⚠️ Не удалось получить ник для userId=${userId} перед сохранением истории:`, err?.message || err);
            }
        }
        
        console.log(`📝 Сохранение истории роли:`, {
            userId,
            userNick_original: userNick,
            userNick_final: finalUserNick || 'NULL',
            rewardId,
            rewardName,
            roleId,
            roleName,
            status,
            reason,
            channelUrl
        });

        db.run(
            `INSERT INTO vkplay_role_history 
            (user_id, user_nick, reward_id, reward_name, role_id, role_name, status, reason, channel_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, finalUserNick, rewardId, rewardName, roleId, roleName, status, reason, channelUrl],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка сохранения истории роли:', err);
                } else {
                    const historyId = this.lastID;
                    console.log(`✅ История роли сохранена (ID: ${historyId}): ${status} для пользователя ${userId} (${finalUserNick || 'без ника'}), награда: ${rewardName}, роль: ${roleName}`);
                    
                    // Если ник не был сохранен, пытаемся получить его асинхронно и обновить запись
                    if (!finalUserNick && userId) {
                        console.log(`⚠️ Ник не был сохранен для userId=${userId}, пытаемся получить через getUserInfo...`);
                        getUserInfo(userId).then(userInfo => {
                            if (userInfo && userInfo.nick && userInfo.nick.trim() !== '') {
                                const retrievedNick = userInfo.nick.trim();
                                console.log(`✅ Ник получен для userId=${userId}: ${retrievedNick}, обновляем запись ID=${historyId} в БД...`);
                                // Обновляем запись в БД с полученным ником
                                db.run(
                                    'UPDATE vkplay_role_history SET user_nick = ? WHERE id = ?',
                                    [retrievedNick, historyId],
                                    function(updateErr) {
                                        if (updateErr) {
                                            console.error('❌ Ошибка обновления ника в истории:', updateErr);
                                        } else {
                                            console.log(`✅ Ник "${retrievedNick}" обновлен в истории для userId=${userId} (ID записи: ${historyId})`);
                                            // Отправляем обновление через WebSocket
                                            if (wss && wss.clients) {
                                                const message = JSON.stringify({
                                                    type: 'VKPLAY_ROLE_HISTORY_UPDATE',
                                                    data: { userId, userNick: retrievedNick }
                                                });
                                                wss.clients.forEach((client) => {
                                                    if (client.readyState === WebSocket.OPEN) {
                                                        try {
                                                            client.send(message);
                                                        } catch (error) {
                                                            console.error('❌ Ошибка отправки обновления ника:', error);
                                                        }
                                                    }
                                                });
                                            }
                                        }
                                    }
                                );
                            } else {
                                console.warn(`⚠️ Не удалось получить ник для userId=${userId} через getUserInfo`);
                            }
                        }).catch(err => {
                            console.error(`❌ Ошибка получения ника для userId=${userId}:`, err);
                        });
                    }
                    
                    // Отправляем обновление через WebSocket всем подключенным клиентам
                    if (wss && wss.clients) {
                        const message = JSON.stringify({
                            type: 'VKPLAY_ROLE_HISTORY_UPDATE',
                            data: {
                                id: this.lastID,
                                userId,
                                userNick: finalUserNick,
                                rewardId,
                                rewardName,
                                roleId,
                                roleName,
                                status,
                                reason,
                                timestamp: new Date().toISOString()
                            }
                        });
                        
                        let sentCount = 0;
                        wss.clients.forEach((client) => {
                            if (client.readyState === WebSocket.OPEN) {
                                try {
                                    client.send(message);
                                    sentCount++;
                                } catch (error) {
                                    console.error('❌ Ошибка отправки WebSocket сообщения:', error);
                                }
                            }
                        });
                        if (sentCount > 0) {
                            console.log(`📤 Отправлено обновление истории через WebSocket ${sentCount} клиентам`);
                        }
                    } else {
                        console.warn('⚠️ WebSocket сервер не доступен для отправки обновления истории');
                    }
                }
            }
        );
    }

    async function assignRoleToUser(userId, roleId, rewardId, rewardName) {
        try {
            if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
                console.warn('⚠️ VK Play не подключен для выдачи роли');
                return { success: false, reason: 'not_connected' };
            }

            // Получаем информацию о пользователе (ник)
            let userNick = null;
            const userInfo = await getUserInfo(userId);
            if (userInfo && userInfo.nick) {
                userNick = userInfo.nick;
                console.log(`✅ Ник пользователя ${userId} получен в assignRoleToUser: ${userNick}`);
            } else {
                console.warn(`⚠️ Не удалось получить ник пользователя ${userId} в assignRoleToUser`);
            }

            // Получаем имя роли из базы данных
            return new Promise((resolve) => {
                db.get(
                    'SELECT role_name FROM vkplay_reward_roles WHERE reward_id = ? AND channel_url = ?',
                    [rewardId, vkplayIntegration.channelUrl],
                    async (err, row) => {
                        const finalRoleName = row?.role_name || rewardName;

                        // Проверяем, есть ли уже эта роль у пользователя
                        const hasRole = await userHasRole(userId, roleId);
                        if (hasRole) {
                            console.log(`⚠️ У пользователя ${userId} уже есть роль ${roleId}`);
                            
                            // СНАЧАЛА сохраняем в историю, что роль уже есть
                            await saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'rejected', 'Роль уже есть у пользователя');
                            console.log(`✅ Запись в истории сохранена: роль уже есть у пользователя ${userId}`);
                            
                            // Затем получаем информацию о награде для получения цены
                            let rewardsResponse;
                            try {
                                rewardsResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_point/rewards', {
                                    params: { channel_url: vkplayIntegration.channelUrl },
                                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                                });
                            } catch (apiError) {
                                if (apiError?.response?.status === 404) {
                                    rewardsResponse = await axios.get('https://api.live.vkvideo.ru/v1/channel_point/rewards', {
                                        params: { channel_url: vkplayIntegration.channelUrl },
                                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                                    });
                                } else {
                                    throw apiError;
                                }
                            }

                            const reward = rewardsResponse.data?.data?.rewards?.find(r => r.id === rewardId);
                            const rewardPrice = reward?.price || 0;

                            // Отменяем активацию награды (возвращаем баллы)
                            console.log(`🔄 Отмена награды ${rewardId} для пользователя ${userId}...`);
                            const cancelResult = await cancelRewardActivation(rewardId, userId, rewardPrice);
                            if (cancelResult) {
                                console.log(`✅ Награда отменена, баллы возвращены пользователю ${userId}`);
                            } else {
                                console.warn(`⚠️ Не удалось отменить награду для пользователя ${userId} (возможно, награда уже обработана)`);
                            }

                            // Отправляем сообщение в чат от имени бота (если подключен) или основного аккаунта
                            // Упоминаем пользователя по userId, чтобы он получил уведомление
                            const message = `у вас уже есть роль "${finalRoleName}", баллы возвращены`;
                            console.log(`📨 Отправляем сообщение пользователю ${userId} (${userNick || 'ник не получен'}): "${message}"`);
                            let sent = false;
                            if (vkplayBotIntegration.connected) {
                                sent = await sendChatMessage(message, userId, true);
                            }
                            if (!sent) {
                                await sendChatMessage(message, userId, false);
                            }

                            resolve({ success: false, reason: 'already_has_role', message: 'Роль уже есть, баллы возвращены' });
                            return;
                        }

                        try {
                            // Получаем текущие роли пользователя, чтобы не потерять существующие
                            const currentRoles = await getUserRoles(userId);
                            const currentRoleIds = currentRoles.map(r => r.id);
                            
                            console.log(`📋 Текущие роли пользователя ${userId}:`, currentRoleIds.length > 0 ? currentRoleIds.join(', ') : 'нет ролей');
                            
                            // Проверяем, есть ли уже эта роль
                            if (currentRoleIds.includes(roleId)) {
                                console.log(`ℹ️ У пользователя ${userId} уже есть роль ${finalRoleName}, пропускаем выдачу`);
                                // Сохраняем в историю как "assigned" (роль уже была)
                                await saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'assigned', 'Роль уже была у пользователя');
                                
                                // Отправляем сообщение в чат от имени бота (если подключен) или основного аккаунта
                                // Упоминаем пользователя по userId, чтобы он получил уведомление
                                const message = `у вас уже есть роль "${finalRoleName}"`;
                                console.log(`📨 Отправляем сообщение пользователю ${userId} (${userNick || 'ник не получен'}): "${message}"`);
                                let sent = false;
                                if (vkplayBotIntegration.connected) {
                                    sent = await sendChatMessage(message, userId, true);
                                }
                                if (!sent) {
                                    await sendChatMessage(message, userId, false);
                                }
                                
                                resolve({ success: true, reason: 'already_has_role' });
                                return;
                            }

                            // Добавляем новую роль к существующим
                            const rolesToSet = [...currentRoleIds, roleId].map(id => ({ id }));
                            console.log(`🎯 Выдаем роли пользователю ${userId}:`, rolesToSet.map(r => r.id).join(', '));

                            // Выдаем роль (вместе с существующими)
                            let response;
                            let apiError = null;
                            try {
                                response = await axios.post(
                                    'https://apidev.live.vkvideo.ru/v1/channel_roles/user/set',
                                    { roles: rolesToSet },
                                    {
                                        params: {
                                            channel_url: vkplayIntegration.channelUrl,
                                            user_id: userId
                                        },
                                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                                    }
                                );
                                console.log(`✅ Роль успешно выдана через apidev API`);
                            } catch (error1) {
                                apiError = error1;
                                if (error1?.response?.status === 404 || error1?.response?.status === 502) {
                                    // Fallback на основной API
                                    try {
                                        response = await axios.post(
                                            'https://api.live.vkvideo.ru/v1/channel_roles/user/set',
                                            { roles: rolesToSet },
                                            {
                                                params: {
                                                    channel_url: vkplayIntegration.channelUrl,
                                                    user_id: userId
                                                },
                                                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                                            }
                                        );
                                        console.log(`✅ Роль успешно выдана через основной API`);
                                        apiError = null; // Успешно получили ответ
                                    } catch (error2) {
                                        // Если и основной API вернул ошибку, проверяем статус
                                        if (error2?.response?.status === 404 || error2?.response?.status === 502) {
                                            // 404 или 502 - временная ошибка сервера, но роль может быть выдана
                                            // Проверяем, выдалась ли роль
                                            console.log(`⚠️ Ошибка ${error2?.response?.status} при выдаче роли, проверяем через 2 секунды...`);
                                            setTimeout(async () => {
                                                const rolesAfter = await getUserRoles(userId);
                                                if (rolesAfter && rolesAfter.some(r => r.id === roleId)) {
                                                    console.log(`✅ Роль ${finalRoleName} выдана пользователю ${userId} (проверено после ${error2?.response?.status})`);
                                                    await saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'assigned', null);
                                                    
                                                    // Отправляем сообщение в чат от имени бота (если подключен) или основного аккаунта
                                                    const message = `вам выдана роль "${finalRoleName}"`;
                                                    let sent = false;
                                                    if (vkplayBotIntegration.connected) {
                                                        sent = await sendChatMessage(message, userId, true);
                                                    }
                                                    if (!sent) {
                                                        await sendChatMessage(message, userId, false);
                                                    }
                                                } else {
                                                    console.error(`❌ Роль не выдана после ${error2?.response?.status} ошибки`);
                                                    await saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'error', `Ошибка ${error2?.response?.status}: роль не выдана`);
                                                }
                                            }, 2000);
                                            resolve({ success: false, reason: 'error', error: `Ошибка ${error2?.response?.status}: проверяем выдачу роли` });
                                            return;
                                        }
                                        throw error2;
                                    }
                                } else {
                                    throw error1;
                                }
                            }

                            // Если получили успешный ответ
                            if (response && !apiError) {
                                console.log(`✅ Роль ${finalRoleName} выдана пользователю ${userId} (${userNick || 'без ника'})`);
                                
                                // Проверяем, что роль действительно выдана
                                setTimeout(async () => {
                                    const rolesAfter = await getUserRoles(userId);
                                    if (rolesAfter && rolesAfter.some(r => r.id === roleId)) {
                                        console.log(`✅ Роль ${finalRoleName} подтверждена у пользователя ${userId}`);
                                    } else {
                                        console.warn(`⚠️ Роль ${finalRoleName} не найдена у пользователя ${userId} после выдачи`);
                                    }
                                }, 1000);
                                
                                // Сохраняем в историю
                                await saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'assigned', null);
                                
                                // Отправляем сообщение в чат от имени бота (если подключен) или основного аккаунта
                                // Упоминаем пользователя по userId, чтобы он получил уведомление
                                const message = `вам выдана роль "${finalRoleName}"`;
                                console.log(`📨 Отправляем сообщение пользователю ${userId} (${userNick || 'ник не получен'}): "${message}"`);
                                let sent = false;
                                if (vkplayBotIntegration.connected) {
                                    sent = await sendChatMessage(message, userId, true);
                                }
                                if (!sent) {
                                    await sendChatMessage(message, userId, false);
                                }
                                
                                resolve({ success: true });
                            }
                        } catch (error) {
                            console.error('❌ Ошибка выдачи роли:', error?.response?.status || error.message);
                            // Проверяем, может роль все-таки выдалась (например, при 404 или 502)
                            if (error?.response?.status === 404 || error?.response?.status === 502) {
                                setTimeout(async () => {
                                    const rolesAfter = await getUserRoles(userId);
                                    if (rolesAfter && rolesAfter.some(r => r.id === roleId)) {
                                        console.log(`✅ Роль ${finalRoleName} выдана пользователю ${userId} (проверено после ${error?.response?.status})`);
                                        saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'assigned', null);
                                        
                                        // Отправляем сообщение в чат от имени бота (если подключен) или основного аккаунта
                                        // Упоминаем пользователя по userId, чтобы он получил уведомление
                                        const message = `вам выдана роль "${finalRoleName}"`;
                                        console.log(`📨 Отправляем сообщение пользователю ${userId} (${userNick || 'ник не получен'}): "${message}"`);
                                        let sent = false;
                                        if (vkplayBotIntegration.connected) {
                                            sent = await sendChatMessage(message, userId, true);
                                        }
                                        if (!sent) {
                                            await sendChatMessage(message, userId, false);
                                        }
                                    } else {
                                        await saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'error', error.message);
                                    }
                                }, 2000);
                                resolve({ success: false, reason: 'error', error: error.message });
                            } else {
                                saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'error', error.message);
                                resolve({ success: false, reason: 'error', error: error.message });
                            }
                        }
                    }
                );
            });
        } catch (error) {
            console.error('❌ Ошибка выдачи роли:', error?.response?.data || error.message);
            return { success: false, reason: 'error', error: error.message };
        }
    }

    async function getWebSocketToken(channels = 'channel_point_rewards') {
        try {
            if (!vkplayIntegration.connected || !vkplayIntegration.tokens) {
                return null;
            }

            let response;
            try {
                response = await axios.get('https://apidev.live.vkvideo.ru/v1/websocket/subscription_token', {
                    params: { channels },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    response = await axios.get('https://api.live.vkvideo.ru/v1/websocket/subscription_token', {
                        params: { channels },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } else {
                    throw apiError;
                }
            }

            const token = response.data?.data?.channel_tokens?.[0]?.token || null;
            if (token) {
                console.log(`✅ WebSocket токен получен для каналов: ${channels}`);
            } else {
                console.warn(`⚠️ WebSocket токен не получен для каналов: ${channels}`);
                console.warn('   Ответ API:', JSON.stringify(response.data, null, 2));
            }
            return token;
        } catch (error) {
            console.error('❌ Ошибка получения WebSocket токена:', error?.response?.data || error.message);
            return null;
        }
    }

    async function connectVKPlayRewardsWebSocket() {
        if (!VKPLAY_POLLING_ENABLED) return;
        if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
            return;
        }

        try {
            // Получаем токен для подписки
            // Пробуем оба варианта: channel_point_rewards и channel_points
            let wsToken = await getWebSocketToken('channel_point_rewards');
            if (!wsToken) {
                console.log('⚠️ Не удалось получить токен для channel_point_rewards, пробуем channel_points...');
                wsToken = await getWebSocketToken('channel_points');
            }
            if (!wsToken) {
                console.warn('⚠️ Не удалось получить WebSocket токен для наград (ни channel_point_rewards, ни channel_points)');
                return;
            }

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

    function registerRoutes(app) {
        app.get('/integrations/vkplay/status', async (req, res) => {
            // Если channelUrl отсутствует, но есть токен - обновляем данные
            if (!vkplayIntegration.channelUrl && vkplayIntegration.connected && vkplayIntegration.tokens?.access_token) {
                console.log('🔄 channelUrl отсутствует, обновляем данные VK Play...');
                
                // Сначала пробуем загрузить из БД
                try {
                    const vkplay = await loadIntegration('vkplay');
                    if (vkplay && vkplay.channel_url) {
                        vkplayIntegration.channelUrl = vkplay.channel_url;
                        if (!vkplayIntegration.channel) vkplayIntegration.channel = vkplay.channel_name;
                        if (!vkplayIntegration.liveTitle) vkplayIntegration.liveTitle = vkplay.live_title;
                        console.log('✅ Данные загружены из БД:', { channelUrl: vkplayIntegration.channelUrl });
                    }
                } catch (e) {
                    console.warn('⚠️ Ошибка загрузки VK Play из БД:', e.message);
                }
                
                // Если все еще нет channelUrl, запрашиваем через API
                if (!vkplayIntegration.channelUrl && vkplayIntegration.tokens?.access_token) {
                    try {
                        console.log('📡 Запрашиваем данные пользователя через API...');
                        // Пробуем оба варианта URL (api и apidev)
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
                        
                        const data = currentUser.data?.data;
                        if (data && data.channel?.url) {
                            vkplayIntegration.channelUrl = data.channel.url;
                            console.log('✅ channelUrl получен из API:', vkplayIntegration.channelUrl);
                            
                            // Получаем данные канала
                            try {
                                let channelData;
                                try {
                                    channelData = await axios.get('https://api.live.vkvideo.ru/v1/channel', {
                                        params: { channel_url: vkplayIntegration.channelUrl },
                                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                                    });
                                } catch (apiError) {
                                    if (apiError?.response?.status === 404) {
                                        console.log('⚠️ api.live.vkvideo.ru вернул 404 для channel, пробуем apidev...');
                                        channelData = await axios.get('https://apidev.live.vkvideo.ru/v1/channel', {
                                            params: { channel_url: vkplayIntegration.channelUrl },
                                            headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                                        });
                                    } else {
                                        throw apiError;
                                    }
                                }
                                
                                const channelInfo = channelData.data?.data;
                                if (channelInfo) {
                                    vkplayIntegration.channel = channelInfo.channel?.nick || vkplayIntegration.channelUrl;
                                    vkplayIntegration.liveTitle = channelInfo.stream?.title || 'Нет активного стрима';
                                    vkplayIntegration.viewers = getVKPlayViewersFromChannelInfo(channelInfo);
                                    // Берем лайки из counters с учетом разных возможных полей
                                    vkplayIntegration.likes = getVKPlayLikesFromChannelInfo(channelInfo, vkplayIntegration.likes);
                                    vkplayIntegration.chatEnabled = !!channelInfo.channel?.web_socket_channels?.chat;
                                    
                                    // Сохраняем в БД
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
                                    
                                    console.log('✅ Данные канала обновлены:', {
                                        channel: vkplayIntegration.channel,
                                        liveTitle: vkplayIntegration.liveTitle
                                    });
                                }
                            } catch (channelError) {
                                console.warn('⚠️ Ошибка получения данных канала:', channelError?.response?.data || channelError.message);
                            }
                        }
                    } catch (e) {
                        console.error('❌ Ошибка получения данных пользователя:', e?.response?.data || e.message);
                    }
                }
            }
            
          res.json(vkplayIntegration);
        });

        app.get('/oauth/vkplay/start', (req, res) => {
            const clientId = process.env.VKPLAY_CLIENT_ID;
            // ВАЖНО: redirect_uri должен ТОЧНО совпадать с тем, что указано в настройках приложения VK Play
            // Проверьте в настройках приложения: http://localhost:3000/oauth/vkplay/callback
            const redirectUri = process.env.VKPLAY_REDIRECT_URI || `http://localhost:${port}/oauth/vkplay/callback`;
            
            // Убираем возможные пробелы
            const cleanRedirectUri = redirectUri.trim();
            
            if (!clientId) return res.status(500).send('VK Play OAuth is not configured (VKPLAY_CLIENT_ID missing).');
            
            console.log('🔍 Проверка redirect_uri:');
            console.log('   Ожидается (из настроек приложения): http://localhost:3000/oauth/vkplay/callback');
            console.log('   Используется:', cleanRedirectUri);
            console.log('   Совпадает:', cleanRedirectUri === 'http://localhost:3000/oauth/vkplay/callback' ? '✅ ДА' : '❌ НЕТ');
            
            if (cleanRedirectUri !== 'http://localhost:3000/oauth/vkplay/callback') {
                console.error('⚠️ ВНИМАНИЕ: redirect_uri не совпадает с настройками приложения!');
                console.error('   Убедитесь, что в config.env указано:');
                console.error('   VKPLAY_REDIRECT_URI=http://localhost:3000/oauth/vkplay/callback');
                console.error('   Или что в настройках приложения VK Play указан правильный URL');
            }
            
            const state = Math.random().toString(36).slice(2);
            
            // Используем scope из рабочего примера TRULA-music + дополнительные для получения наград и ролей
            // https://auth.live.vkvideo.ru/app/oauth2/authorize?client_id=5d0wgtm144f3ojky&response_type=code&scope=channel:points:rewards,channel:points:rewards:demands,chat:message:send&redirect_uri=https://trula-music.ru/auth/vkpll/
            // Дополнительно добавляем:
            // - channel:points - для получения списка наград (GET /v1/channel_point/rewards требует channel:points)
            // - channel:roles - для получения списка ролей (GET /v1/channel_roles требует channel:roles)
            const scopes = [
                'channel:points',              // Получение списка наград (GET /v1/channel_point/rewards)
                'channel:points:rewards',       // Управление наградами за баллы канала
                'channel:points:rewards:demands', // Запросы наград за баллы канала
                'channel:roles',                // Управление ролями (GET /v1/channel_roles)
                'chat:message:send'           // Отправка сообщений в чат
            ].join(',');  // Через запятую, как указано в документации
            
            const params = {
                client_id: clientId,
                redirect_uri: cleanRedirectUri,  // Используем очищенный redirect_uri
                response_type: 'code',
                scope: scopes,  // Указываем scope согласно документации
                state
            };
            const authUrl = `https://auth.live.vkvideo.ru/app/oauth2/authorize?${querystring.stringify(params)}`;
            
            console.log('🔐 VK Play OAuth start →');
            console.log('   URL:', authUrl);
            console.log('   Параметры:', JSON.stringify(params, null, 2));
            console.log('   Запрашиваемые разрешения (scope):', params.scope);
            console.log('   - channel:points - Получение списка наград');
            console.log('   - channel:points:rewards - Управление наградами за баллы канала');
            console.log('   - channel:points:rewards:demands - Запросы наград за баллы канала');
            console.log('   - channel:roles - Управление ролями');
            console.log('   - chat:message:send - Отправка сообщений в чат');
            
            res.redirect(authUrl);
        });


        app.get('/oauth/vkplay/callback', async (req, res) => {
            try {
                const { code, state, error, error_description } = req.query;
                
                // Детальное логирование для отладки
                console.log('📥 VK Play OAuth callback получен:');
                console.log('   code:', code ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');
                console.log('   state:', state || 'ОТСУТСТВУЕТ');
                console.log('   error:', error || 'НЕТ');
                console.log('   error_description:', error_description || 'НЕТ');
                console.log('   Все query параметры:', JSON.stringify(req.query, null, 2));
                
                if (error) {
                    console.error('❌ VK Play OAuth error:', error);
                    console.error('   Описание:', error_description);
                    console.error('   Все параметры:', req.query);
                    
                    // Если ошибка invalid_scope, это может означать:
                    // 1. Приложение в VK Play настроено с неверными scope
                    // 2. VK Play требует scope, но мы их не указали
                    // 3. Названия scope неверны
                    if (error === 'invalid_scope') {
                        console.error('💡 Решение для invalid_scope:');
                        console.error('   ⚠️  Ошибка invalid_scope возникает, даже когда scope не указаны в URL');
                        console.error('   Это означает, что проблема в настройках приложения в VK Play');
                        console.error('');
                        console.error('   📋 Что нужно сделать:');
                        console.error('   1. Откройте панель управления приложением VK Play');
                        console.error('   2. Найдите раздел "Разрешения" или "Permissions" / "Scope"');
                        console.error('   3. УДАЛИТЕ все указанные scope (оставьте пустым)');
                        console.error('   4. Или убедитесь, что указаны только правильные scope:');
                        console.error('      - channel:points');
                        console.error('      - channel:points:rewards');
                        console.error('      - channel:points:rewards:demands');
                        console.error('      - channel:roles');
                        console.error('      - channel:chat:write');
                        console.error('   5. Сохраните настройки');
                        console.error('   6. Попробуйте авторизоваться снова');
                        console.error('');
                        console.error('   🔄 Альтернативное решение:');
                        console.error('   - Создайте новое приложение в VK Play');
                        console.error('   - Не указывайте scope при создании приложения');
                        console.error('   - Используйте новые client_id и client_secret');
                    }
                    
                    return res.status(400).send(`VK Play OAuth error: ${error} ${error_description || ''}`);
                }
                if (!code) return res.status(400).send('Missing code');
                const clientId = process.env.VKPLAY_CLIENT_ID;
                const clientSecret = process.env.VKPLAY_CLIENT_SECRET;
                // ВАЖНО: redirect_uri должен ТОЧНО совпадать с тем, что указано в настройках приложения VK Play
                const redirectUri = process.env.VKPLAY_REDIRECT_URI || `http://localhost:${port}/oauth/vkplay/callback`;
                const cleanRedirectUri = redirectUri.trim();  // Убираем возможные пробелы
                
                if (!clientId || !clientSecret) return res.status(500).send('VK Play OAuth is not configured (client id/secret).');
                
                console.log('🔍 Проверка redirect_uri в callback:');
                console.log('   Ожидается (из настроек приложения): http://localhost:3000/oauth/vkplay/callback');
                console.log('   Используется:', cleanRedirectUri);
                console.log('   Совпадает:', cleanRedirectUri === 'http://localhost:3000/oauth/vkplay/callback' ? '✅ ДА' : '❌ НЕТ');
                
                if (cleanRedirectUri !== 'http://localhost:3000/oauth/vkplay/callback') {
                    console.error('⚠️ ВНИМАНИЕ: redirect_uri не совпадает с настройками приложения!');
                    console.error('   Это может быть причиной ошибки авторизации.');
                }

                // Проверяем правильность ключей
                console.log('🔍 Проверка ключей VK Play:');
                console.log('   Client ID:', clientId ? `${clientId.substring(0, 8)}...${clientId.substring(clientId.length - 4)}` : 'ОТСУТСТВУЕТ');
                console.log('   Client ID длина:', clientId?.length || 0);
                console.log('   Client Secret:', clientSecret ? `${clientSecret.substring(0, 8)}...${clientSecret.substring(clientSecret.length - 4)}` : 'ОТСУТСТВУЕТ');
                console.log('   Client Secret длина:', clientSecret?.length || 0);
                console.log('   Redirect URI:', cleanRedirectUri);
                console.log('   Code:', code ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');
                
                // ВАЖНО: Используем СЕКРЕТНЫЙ ключ приложения, НЕ публичный!
                // Публичный ключ приложения НЕ используется в OAuth CodeFlow
                if (!clientId || !clientSecret) {
                    console.error('❌ Ошибка: Client ID или Client Secret отсутствуют');
                    return res.status(500).send('VK Play OAuth is not configured (client id/secret).');
                }
                
                // Проверяем правильность Client Secret по первым символам
                const EXPECTED_CLIENT_ID = 'fw5rnkh3nd335l2l';
                const EXPECTED_CLIENT_SECRET_START = 'Ehw6AYlh'; // Первые 8 символов правильного секретного ключа
                const EXPECTED_CLIENT_SECRET_END = 'QokR'; // Последние 4 символа правильного секретного ключа
                
                if (clientId !== EXPECTED_CLIENT_ID) {
                    console.error('❌ ОШИБКА: Client ID не совпадает с ожидаемым!');
                    console.error('   Ожидается:', EXPECTED_CLIENT_ID);
                    console.error('   Получено:', clientId);
                }
                
                if (clientSecret && clientSecret.length === 64) {
                    const secretStart = clientSecret.substring(0, 8);
                    const secretEnd = clientSecret.substring(clientSecret.length - 5);
                    
                    if (secretStart !== EXPECTED_CLIENT_SECRET_START || secretEnd !== EXPECTED_CLIENT_SECRET_END) {
                        console.error('❌ ОШИБКА: Client Secret не совпадает с ожидаемым!');
                        console.error('   Ожидается начало:', EXPECTED_CLIENT_SECRET_START);
                        console.error('   Получено начало:', secretStart);
                        console.error('   Ожидается конец:', EXPECTED_CLIENT_SECRET_END);
                        console.error('   Получено конец:', secretEnd);
                        console.error('');
                        console.error('💡 Проверьте файл config.env:');
                        console.error('   VKPLAY_CLIENT_SECRET должен быть: Ehw6AYlhTL2MocgL4kdvdc7Aus94sO4l9vozahaFl9CHktYm3M9Vv67f6Qo7QokR');
                        console.error('   НЕ используйте публичный ключ приложения!');
                    } else {
                        console.log('✅ Client Secret проверен: начало и конец совпадают');
                    }
                } else {
                    console.warn('⚠️ ВНИМАНИЕ: Client Secret имеет неожиданную длину. Ожидается 64 символа.');
                }
                
                // Убираем возможные пробелы и переносы строк из ключей
                const cleanClientId = clientId.trim();
                const cleanClientSecret = clientSecret.trim();
                
                const basic = Buffer.from(`${cleanClientId}:${cleanClientSecret}`).toString('base64');
                console.log('🔄 Обмен кода на токен...');
                console.log('   Basic Auth (первые 20 символов):', basic.substring(0, 20) + '...');
                console.log('   Client ID (очищенный):', cleanClientId);
                console.log('   Client Secret (первые 12 символов):', cleanClientSecret.substring(0, 12) + '...');
                
                // Пробуем оба варианта URL для обмена токена
                // VK Play API может требовать client_id и client_secret в теле запроса
                let tokenRes;
                try {
                    // Согласно документации: обмен кода на токен
                    // POST https://api.live.vkvideo.ru/oauth/server/token
                    // Тело: grant_type=authorization_code&code=...&redirect_uri=...
                    // Заголовок: Authorization: Basic <base64(client_id:secret)>
                    // НЕ передаем client_id и client_secret в теле запроса!
                    const tokenData = querystring.stringify({
                        grant_type: 'authorization_code',
                        code,
                        redirect_uri: cleanRedirectUri
                    });
                    
                    console.log('📤 Отправка запроса на обмен кода на токен...');
                    console.log('   URL: https://api.live.vkvideo.ru/oauth/server/token');
                    console.log('   Метод: POST');
                    console.log('   Headers: Authorization: Basic <base64(client_id:secret)>');
                    console.log('   Body: grant_type=authorization_code&code=...&redirect_uri=...');
                    
                    tokenRes = await axios.post(
                        'https://api.live.vkvideo.ru/oauth/server/token',
                        tokenData,
                        {
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Authorization': `Basic ${basic}`
                            }
                        }
                    );
                    console.log('✅ Токен получен от api.live.vkvideo.ru');
                } catch (tokenError) {
                    console.error('❌ Ошибка обмена кода на токен (метод 1: Basic Auth + параметры в теле):');
                    console.error('   Status:', tokenError?.response?.status);
                    console.error('   Data:', JSON.stringify(tokenError?.response?.data, null, 2));
                    console.error('   Message:', tokenError.message);
                    
                    // Проверяем, не ошибка ли это из-за неправильных ключей
                    if (tokenError?.response?.status === 401 || tokenError?.response?.status === 403) {
                        console.error('');
                        console.error('💡 Возможные причины ошибки 401/403:');
                        console.error('   1. Неправильный Client ID или Client Secret');
                        console.error('   2. Использован публичный ключ вместо секретного');
                        console.error('   3. Ключи перепутаны местами');
                        console.error('   4. Ключи содержат лишние пробелы или символы');
                        console.error('');
                        console.error('📋 Проверьте в config.env:');
                        console.error('   VKPLAY_CLIENT_ID=fw5rnkh3nd335l2l');
                        console.error('   VKPLAY_CLIENT_SECRET=Ehw6AYlhTL2MocgL4kdvdc7Aus94sO4l9vozahaFl9CHktYm3M9Vv67f6Qo7QokR');
                        console.error('   НЕ используйте публичный ключ приложения!');
                        console.error('');
                        console.log('🔄 Пробуем метод 2: только Basic Auth (без параметров в теле)...');
                        
                        // Метод 2: Только Basic Auth (без client_id и client_secret в теле)
                        try {
                            tokenRes = await axios.post(
                                'https://api.live.vkvideo.ru/oauth/server/token',
                                querystring.stringify({
                                    grant_type: 'authorization_code',
                                    code,
                                    redirect_uri: cleanRedirectUri  // Используем очищенный redirect_uri
                                }),
                                {
                                    headers: {
                                        'Content-Type': 'application/x-www-form-urlencoded',
                                        'Authorization': `Basic ${basic}`
                                    }
                                }
                            );
                            console.log('✅ Токен получен методом 2 (только Basic Auth)');
                        } catch (method2Error) {
                            console.error('❌ Метод 2 тоже не сработал:');
                            console.error('   Status:', method2Error?.response?.status);
                            console.error('   Data:', JSON.stringify(method2Error?.response?.data, null, 2));
                            
                            // Метод 3: Пробуем apidev
                            if (method2Error?.response?.status === 404 || tokenError?.response?.status === 404) {
                                console.log('⚠️ Пробуем apidev.live.vkvideo.ru...');
                                try {
                                    tokenRes = await axios.post(
                                        'https://apidev.live.vkvideo.ru/oauth/server/token',
                                        querystring.stringify({
                                            grant_type: 'authorization_code',
                                            code,
                                            redirect_uri: cleanRedirectUri
                                        }),
                                        {
                                            headers: {
                                                'Content-Type': 'application/x-www-form-urlencoded',
                                                'Authorization': `Basic ${basic}`
                                            }
                                        }
                                    );
                                    console.log('✅ Токен получен от apidev.live.vkvideo.ru');
                                } catch (apidevError) {
                                    console.error('❌ apidev.live.vkvideo.ru тоже вернул ошибку:');
                                    console.error('   Status:', apidevError?.response?.status);
                                    console.error('   Data:', JSON.stringify(apidevError?.response?.data, null, 2));
                                    throw apidevError;
                                }
                            } else {
                                throw method2Error;
                            }
                        }
                    } else if (tokenError?.response?.status === 404) {
                        console.log('⚠️ api.live.vkvideo.ru вернул 404 для token, пробуем apidev...');
                        try {
                            tokenRes = await axios.post(
                                'https://apidev.live.vkvideo.ru/oauth/server/token',
                                querystring.stringify({
                                    grant_type: 'authorization_code',
                                    code,
                                    redirect_uri: cleanRedirectUri
                                }),
                                {
                                    headers: {
                                        'Content-Type': 'application/x-www-form-urlencoded',
                                        'Authorization': `Basic ${basic}`
                                    }
                                }
                            );
                            console.log('✅ Токен получен от apidev.live.vkvideo.ru');
                        } catch (apidevError) {
                            console.error('❌ apidev.live.vkvideo.ru тоже вернул ошибку:');
                            console.error('   Status:', apidevError?.response?.status);
                            console.error('   Data:', JSON.stringify(apidevError?.response?.data, null, 2));
                            throw apidevError;
                        }
                    } else {
                        throw tokenError;
                    }
                }

                const tokens = tokenRes.data; // access_token, refresh_token, expires_in, token_type
                console.log('✅ Токен получен:', {
                    access_token: tokens.access_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ',
                    refresh_token: tokens.refresh_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ',
                    expires_in: tokens.expires_in,
                    token_type: tokens.token_type
                });
                
                const nowSec = Math.floor(Date.now() / 1000);
                vkplayIntegration.connected = true;
                vkplayIntegration.tokens = tokens;
                vkplayIntegration.expires_at = nowSec + (tokens.expires_in || 0);

                // Получим текущего пользователя/канал для статуса
                try {
                    console.log('📡 Запрос данных пользователя через API...');
                    let me;
                    try {
                        me = await axios.get('https://api.live.vkvideo.ru/v1/current_user', {
                            headers: { Authorization: `Bearer ${tokens.access_token}` }
                        });
                    } catch (apiError) {
                        if (apiError?.response?.status === 404) {
                            console.log('⚠️ api.live.vkvideo.ru вернул 404, пробуем apidev.live.vkvideo.ru...');
                            me = await axios.get('https://apidev.live.vkvideo.ru/v1/current_user', {
                                headers: { Authorization: `Bearer ${tokens.access_token}` }
                            });
                        } else {
                            throw apiError;
                        }
                    }
                    
                    const data = me.data && me.data.data;
                    console.log('👤 Данные пользователя получены:', {
                        hasData: !!data,
                        channelUrl: data?.channel?.url,
                        channelsCount: data?.channels?.length || 0
                    });
                    
                    if (data) {
                        const channelUrl = data.channel?.url || (data.channels && data.channels[0]?.url) || null;
                        vkplayIntegration.channelUrl = channelUrl;
                        console.log('✅ channelUrl установлен:', channelUrl);
                        
                        // Получим данные канала и активного стрима
                        if (channelUrl) {
                            try {
                                console.log('📺 Запрос данных канала...');
                                let channelData;
                                try {
                                    channelData = await axios.get('https://api.live.vkvideo.ru/v1/channel', {
                                        params: { channel_url: channelUrl },
                                        headers: { Authorization: `Bearer ${tokens.access_token}` }
                                    });
                                } catch (apiError) {
                                    if (apiError?.response?.status === 404) {
                                        console.log('⚠️ api.live.vkvideo.ru вернул 404 для channel, пробуем apidev...');
                                        channelData = await axios.get('https://apidev.live.vkvideo.ru/v1/channel', {
                                            params: { channel_url: channelUrl },
                                            headers: { Authorization: `Bearer ${tokens.access_token}` }
                                        });
                                    } else {
                                        throw apiError;
                                    }
                                }
                                
                                const channelInfo = channelData.data?.data;
                                if (channelInfo) {
                                    vkplayIntegration.channel = channelInfo.channel?.nick || channelUrl;
                                    vkplayIntegration.liveTitle = channelInfo.stream?.title || 'Нет активного стрима';
                                    vkplayIntegration.viewers = getVKPlayViewersFromChannelInfo(channelInfo);
                                    vkplayIntegration.likes = getVKPlayLikesFromChannelInfo(channelInfo, vkplayIntegration.likes);
                                    vkplayIntegration.chatEnabled = !!channelInfo.channel?.web_socket_channels?.chat;
                                    
                                    console.log('✅ Данные канала получены:', {
                                        channel: vkplayIntegration.channel,
                                        liveTitle: vkplayIntegration.liveTitle,
                                        viewers: vkplayIntegration.viewers,
                                        likes: vkplayIntegration.likes,
                                        chatEnabled: vkplayIntegration.chatEnabled
                                    });
                                    
                                    // Сохраняем в БД
                                    await saveIntegration('vkplay', {
                                        tokens: tokens,
                                        expires_at: vkplayIntegration.expires_at,
                                        channel: vkplayIntegration.channel,
                                        channelUrl: channelUrl,
                                        liveTitle: vkplayIntegration.liveTitle,
                                        viewers: vkplayIntegration.viewers,
                                        likes: vkplayIntegration.likes,
                                        chatEnabled: vkplayIntegration.chatEnabled
                                    });
                                    
                                    console.log(`✅ VK Play авторизация завершена: ${vkplayIntegration.channel} | ${vkplayIntegration.liveTitle}`);
                                    console.log(`✅ channelUrl сохранен в БД: ${channelUrl}`);
                                } else {
                                    console.warn('⚠️ Данные канала не получены из ответа');
                                }
                            } catch (channelError) {
                                console.error('❌ Ошибка получения данных канала:');
                                console.error('   Status:', channelError?.response?.status);
                                console.error('   Data:', JSON.stringify(channelError?.response?.data, null, 2));
                                console.error('   Message:', channelError.message);
                            }
                        } else {
                            console.warn('⚠️ channelUrl не найден в данных пользователя');
                            // Сохраняем хотя бы токены, даже если channelUrl не получен
                            await saveIntegration('vkplay', {
                                tokens: tokens,
                                expires_at: vkplayIntegration.expires_at,
                                channel: null,
                                channelUrl: null,
                                liveTitle: null,
                                viewers: 0,
                                chatEnabled: false
                            });
                            console.log('✅ Токены VK Play сохранены в БД (без channelUrl)');
                        }
                    } else {
                        console.warn('⚠️ Данные пользователя не получены из ответа');
                        // Сохраняем хотя бы токены
                        await saveIntegration('vkplay', {
                            tokens: tokens,
                            expires_at: vkplayIntegration.expires_at,
                            channel: null,
                            channelUrl: null,
                            liveTitle: null,
                            viewers: 0,
                            chatEnabled: false
                        });
                        console.log('✅ Токены VK Play сохранены в БД (без данных пользователя)');
                    }
                } catch (e) {
                    console.error('❌ Ошибка получения данных пользователя:');
                    console.error('   Status:', e?.response?.status);
                    console.error('   Data:', JSON.stringify(e?.response?.data, null, 2));
                    console.error('   Message:', e.message);
                    // Сохраняем хотя бы токены, даже если произошла ошибка
                    try {
                        await saveIntegration('vkplay', {
                            tokens: tokens,
                            expires_at: vkplayIntegration.expires_at,
                            channel: null,
                            channelUrl: null,
                            liveTitle: null,
                            viewers: 0,
                            chatEnabled: false
                        });
                        console.log('✅ Токены VK Play сохранены в БД (после ошибки)');
                    } catch (saveError) {
                        console.error('❌ Ошибка сохранения токенов:', saveError);
                    }
                }

                res.redirect('/stream-integrations.html');
            } catch (err) {
                console.error('VK Play OAuth callback error:', err?.response?.data || err.message);
                res.status(500).send('VK Play OAuth error');
            }
        });

        // Implicit Flow (клиентский) — альтернативный упрощенный вариант

        app.get('/oauth/vkplay/start-implicit', (req, res) => {
            const clientId = process.env.VKPLAY_CLIENT_ID;
            const redirectUri = (process.env.HTTPS_ENABLED === 'true')
                ? (process.env.VKPLAY_REDIRECT_URI || `https://localhost:${process.env.HTTPS_PORT || 3443}/oauth-vkplay-implicit.html`)
                : `http://localhost:${port}/oauth-vkplay-implicit.html`;
            if (!clientId) return res.status(500).send('VK Play OAuth is not configured (VKPLAY_CLIENT_ID missing).');
            const state = Math.random().toString(36).slice(2);
            
            // Используем те же scope, что и в CodeFlow
            const scopes = [
                'channel:points',
                'channel:points:rewards',
                'channel:points:rewards:demands',
                'channel:roles',
                'chat:message:send'
            ].join(',');
            
            const params = {
                client_id: clientId,
                redirect_uri: redirectUri,
                response_type: 'token',
                scope: scopes,
                state
            };
            
            const authUrl = `https://auth.live.vkvideo.ru/app/oauth2/authorize?${querystring.stringify(params)}`;
            console.log('🔐 VK Play OAuth start (implicit) →', authUrl);
            console.log('📋 Параметры авторизации:', params);
            console.log('💡 Запрашиваемые разрешения (scope):', params.scope);
            res.redirect(authUrl);
        });


        app.post('/oauth/vkplay/implicit', express.json(), async (req, res) => {
            try {
                const { access_token, token_type, expire_time } = req.body || {};
                if (!access_token) return res.status(400).json({ error: 'missing access_token' });
                vkplayIntegration.connected = true;
                vkplayIntegration.tokens = { access_token, token_type, expire_time };
                // Получим current_user для статуса
                try {
                    const me = await axios.get('https://api.live.vkvideo.ru/v1/current_user', {
                        headers: { Authorization: `Bearer ${access_token}` }
                    });
                    const data = me.data && me.data.data;
                    if (data) {
                        const channelUrl = data.channel?.url || (data.channels && data.channels[0]?.url) || null;
                        vkplayIntegration.channel = channelUrl;
                    }
                } catch (e) {
                    console.warn('VK Play current_user (implicit) failed:', e?.response?.data || e.message);
                }
                res.json({ ok: true });
            } catch (e) {
                console.error('VK Play implicit store error:', e.message);
                res.status(500).json({ error: 'internal_error' });
            }
        });

        // Отладка параметров VK Play OAuth

        app.get('/oauth/vkplay/debug', (req, res) => {
            res.json({
                env: {
                    VKPLAY_CLIENT_ID: !!process.env.VKPLAY_CLIENT_ID,
                    VKPLAY_REDIRECT_URI: process.env.VKPLAY_REDIRECT_URI,
                    HTTPS_ENABLED: process.env.HTTPS_ENABLED,
                    HTTPS_PORT: process.env.HTTPS_PORT
                }
            });
        });

        // /oauth/youtube/logout вынесен в src/modules/youtube-integration


        app.post('/oauth/vkplay/logout', (req, res) => {
            vkplayIntegration = { connected: false, channel: null, liveTitle: null, chatEnabled: false, viewers: 0, tokens: null, expires_at: 0, channelUrl: null };
            res.json({ ok: true });
        });

        // ===================================
        // VK Play Bot OAuth (отдельный аккаунт для чат-бота)
        // ===================================

        // Старт авторизации бота

        app.get('/oauth/vkplay-bot/start', (req, res) => {
            const clientId = process.env.VKPLAY_BOT_CLIENT_ID;
            // ВАЖНО: redirect_uri должен ТОЧНО совпадать с тем, что указано в настройках приложения VK Play
            // Проверьте в настройках приложения: http://localhost:3000/oauth/vkplay-bot/callback
            const redirectUri = process.env.VKPLAY_BOT_REDIRECT_URI || `http://localhost:${port}/oauth/vkplay-bot/callback`;
            
            // Убираем возможные пробелы
            const cleanRedirectUri = redirectUri.trim();
            
            if (!clientId) {
                return res.status(500).send('VK Play Bot OAuth is not configured (VKPLAY_BOT_CLIENT_ID missing).');
            }
            
            // Проверяем правильность client_id
            const EXPECTED_BOT_CLIENT_ID = 'umv46nrqcxbvzxhz';
            if (clientId.trim() !== EXPECTED_BOT_CLIENT_ID) {
                console.error('❌ ОШИБКА: Client ID бота не совпадает!');
                console.error('   Ожидается:', EXPECTED_BOT_CLIENT_ID);
                console.error('   Получено:', clientId.trim());
                console.error('   Проверьте файл config.env');
            }
            
            console.log('🔍 Проверка параметров авторизации бота:');
            console.log('   Client ID:', clientId.trim() === EXPECTED_BOT_CLIENT_ID ? '✅ Правильный' : '❌ Неправильный');
            console.log('   Redirect URI (ожидается): http://localhost:3000/oauth/vkplay-bot/callback');
            console.log('   Redirect URI (используется):', cleanRedirectUri);
            console.log('   Совпадает:', cleanRedirectUri === 'http://localhost:3000/oauth/vkplay-bot/callback' ? '✅ ДА' : '❌ НЕТ');
            
            if (cleanRedirectUri !== 'http://localhost:3000/oauth/vkplay-bot/callback') {
                console.error('⚠️ ВНИМАНИЕ: redirect_uri не совпадает с настройками приложения!');
                console.error('   Убедитесь, что в config.env указано:');
                console.error('   VKPLAY_BOT_REDIRECT_URI=http://localhost:3000/oauth/vkplay-bot/callback');
                console.error('   Или что в настройках приложения VK Play "Xasya Bot" указан правильный URL');
                console.error('   URL должен быть ТОЧНО: http://localhost:3000/oauth/vkplay-bot/callback');
                console.error('   (без пробелов, без слеша в конце, каждый URL на отдельной строке)');
            }
            
            const state = Math.random().toString(36).slice(2);
            
            // Используем тот же подход, что и в обычной авторизации VK Play
            // Scope указываем через запятую, как в рабочем примере
            const scopes = [
                'channel:points',
                'channel:points:rewards',
                'channel:points:rewards:demands',
                'channel:roles',
                'chat:message:send'
            ].join(',');
            
            const params = {
                client_id: clientId.trim(),  // Убираем пробелы из client_id
                redirect_uri: cleanRedirectUri,  // Используем очищенный redirect_uri
                response_type: 'code',
                scope: scopes,  // Указываем scope как в обычной авторизации
                state
            };
            
            const authUrl = `https://auth.live.vkvideo.ru/app/oauth2/authorize?${querystring.stringify(params)}`;
            
            console.log('🤖 VK Play Bot OAuth start →');
            console.log('   URL:', authUrl);
            console.log('   Параметры:', JSON.stringify(params, null, 2));
            console.log('   Запрашиваемые разрешения (scope):', params.scope);
            console.log('   📋 Список scope:');
            console.log('      ✅ channel:points - Получение списка наград');
            console.log('      ✅ channel:points:rewards - Управление наградами за баллы канала');
            console.log('      ✅ channel:points:rewards:demands - Запросы наград за баллы канала');
            console.log('      ✅ channel:roles - Управление ролями');
            console.log('      ✅ chat:message:send - Отправка сообщений в чат (ОБЯЗАТЕЛЬНО для работы бота!)');
            console.log('');
            console.log('   ⚠️ ВАЖНО: Убедитесь, что в настройках приложения VK Play "Xasya Bot":');
            console.log('   1. Указан redirect_uri: http://localhost:3000/oauth/vkplay-bot/callback');
            console.log('   2. В разделе "Разрешения" (Permissions/Scope) включено разрешение:');
            console.log('      - chat:message:send (Отправка сообщений в чат)');
            console.log('   3. Или оставьте раздел "Разрешения" пустым - scope будут запрошены автоматически');
            
            res.redirect(authUrl);
        });

        // Callback для авторизации бота

        app.get('/oauth/vkplay-bot/callback', async (req, res) => {
            try {
                const { code, state, error, error_description } = req.query;
                
                // Детальное логирование для отладки
                console.log('📥 VK Play Bot OAuth callback получен:');
                console.log('   code:', code ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');
                console.log('   state:', state || 'ОТСУТСТВУЕТ');
                console.log('   error:', error || 'НЕТ');
                console.log('   error_description:', error_description || 'НЕТ');
                console.log('   Все query параметры:', JSON.stringify(req.query, null, 2));
                
                if (error) {
                    console.error('❌ VK Play Bot OAuth error:', error);
                    console.error('   Описание:', error_description);
                    console.error('   Все параметры:', req.query);
                    
                    // Если ошибка invalid_scope, это может означать:
                    // 1. Приложение в VK Play настроено с неверными scope
                    // 2. VK Play требует scope, но мы их не указали
                    // 3. Названия scope неверны
                    if (error === 'invalid_scope') {
                        console.error('💡 Решение для invalid_scope:');
                        console.error('   ⚠️  Ошибка invalid_scope возникает, даже когда scope не указаны в URL');
                        console.error('   Это означает, что проблема в настройках приложения в VK Play');
                        console.error('');
                        console.error('   📋 Что нужно сделать:');
                        console.error('   1. Откройте панель управления приложением VK Play "Xasya Bot"');
                        console.error('   2. Найдите раздел "Разрешения" или "Permissions" / "Scope"');
                        console.error('   3. УДАЛИТЕ все указанные scope (оставьте пустым)');
                        console.error('   4. Или убедитесь, что указаны только правильные scope:');
                        console.error('      - channel:points');
                        console.error('      - channel:points:rewards');
                        console.error('      - channel:points:rewards:demands');
                        console.error('      - channel:roles');
                        console.error('      - chat:message:send');
                        console.error('   5. Сохраните настройки');
                        console.error('   6. Попробуйте авторизоваться снова');
                    }
                    
                    return res.status(400).send(`VK Play Bot OAuth error: ${error} ${error_description || ''}`);
                }
                if (!code) return res.status(400).send('Missing code');
                
                const clientId = process.env.VKPLAY_BOT_CLIENT_ID;
                const clientSecret = process.env.VKPLAY_BOT_CLIENT_SECRET;
                // ВАЖНО: redirect_uri должен ТОЧНО совпадать с тем, что указано в настройках приложения VK Play
                const redirectUri = process.env.VKPLAY_BOT_REDIRECT_URI || `http://localhost:${port}/oauth/vkplay-bot/callback`;
                const cleanRedirectUri = redirectUri.trim();  // Убираем возможные пробелы
                
                if (!clientId || !clientSecret) {
                    return res.status(500).send('VK Play Bot OAuth is not configured (client id/secret).');
                }
                
                console.log('🔍 Проверка redirect_uri в callback для бота:');
                console.log('   Ожидается (из настроек приложения): http://localhost:3000/oauth/vkplay-bot/callback');
                console.log('   Используется:', cleanRedirectUri);
                console.log('   Совпадает:', cleanRedirectUri === 'http://localhost:3000/oauth/vkplay-bot/callback' ? '✅ ДА' : '❌ НЕТ');
                
                if (cleanRedirectUri !== 'http://localhost:3000/oauth/vkplay-bot/callback') {
                    console.error('⚠️ ВНИМАНИЕ: redirect_uri не совпадает с настройками приложения!');
                    console.error('   Это может быть причиной ошибки авторизации.');
                }

                // Проверяем правильность ключей
                console.log('🔍 Проверка ключей VK Play Bot:');
                console.log('   Client ID:', clientId ? `${clientId.substring(0, 8)}...${clientId.substring(clientId.length - 4)}` : 'ОТСУТСТВУЕТ');
                console.log('   Client ID длина:', clientId?.length || 0);
                console.log('   Client Secret:', clientSecret ? `${clientSecret.substring(0, 8)}...${clientSecret.substring(clientSecret.length - 4)}` : 'ОТСУТСТВУЕТ');
                console.log('   Client Secret длина:', clientSecret?.length || 0);
                console.log('   Redirect URI:', cleanRedirectUri);
                console.log('   Code:', code ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');
                
                // ВАЖНО: Используем СЕКРЕТНЫЙ ключ приложения, НЕ публичный!
                // Публичный ключ приложения НЕ используется в OAuth CodeFlow
                if (!clientId || !clientSecret) {
                    console.error('❌ Ошибка: Client ID или Client Secret отсутствуют');
                    return res.status(500).send('VK Play Bot OAuth is not configured (client id/secret).');
                }
                
                // Проверяем правильность Client Secret по первым символам
                const EXPECTED_BOT_CLIENT_ID = 'umv46nrqcxbvzxhz';
                const EXPECTED_BOT_CLIENT_SECRET_START = 'kMLoAl9w'; // Первые 8 символов правильного секретного ключа
                const EXPECTED_BOT_CLIENT_SECRET_END = 'Db71c'; // Последние 5 символов правильного секретного ключа
                
                if (clientId !== EXPECTED_BOT_CLIENT_ID) {
                    console.error('❌ ОШИБКА: Client ID бота не совпадает с ожидаемым!');
                    console.error('   Ожидается:', EXPECTED_BOT_CLIENT_ID);
                    console.error('   Получено:', clientId);
                }
                
                if (clientSecret && clientSecret.length === 64) {
                    const secretStart = clientSecret.substring(0, 8);
                    const secretEnd = clientSecret.substring(clientSecret.length - 5);
                    
                    if (secretStart !== EXPECTED_BOT_CLIENT_SECRET_START || secretEnd !== EXPECTED_BOT_CLIENT_SECRET_END) {
                        console.error('❌ ОШИБКА: Client Secret бота не совпадает с ожидаемым!');
                        console.error('   Ожидается начало:', EXPECTED_BOT_CLIENT_SECRET_START);
                        console.error('   Получено начало:', secretStart);
                        console.error('   Ожидается конец:', EXPECTED_BOT_CLIENT_SECRET_END);
                        console.error('   Получено конец:', secretEnd);
                        console.error('');
                        console.error('💡 Проверьте файл config.env:');
                        console.error('   VKPLAY_BOT_CLIENT_SECRET должен быть: kMLoAl9wJyF5OIkX6hc0u5xJQDVrq8g3fgkLHziSgT62N5lm0eiYt2psJSgDb71c');
                        console.error('   НЕ используйте публичный ключ приложения!');
                    } else {
                        console.log('✅ Client Secret бота проверен: начало и конец совпадают');
                    }
                } else {
                    console.warn('⚠️ ВНИМАНИЕ: Client Secret бота имеет неожиданную длину. Ожидается 64 символа.');
                }
                
                // Убираем возможные пробелы и переносы строк из ключей
                const cleanClientId = clientId.trim();
                const cleanClientSecret = clientSecret.trim();
                const basic = Buffer.from(`${cleanClientId}:${cleanClientSecret}`).toString('base64');
                
                // Обмен кода на токен
                let tokenRes;
                const tokenData = querystring.stringify({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: cleanRedirectUri
                });
                
                try {
                    tokenRes = await axios.post(
                        'https://api.live.vkvideo.ru/oauth/server/token',
                        tokenData,
                        {
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Authorization': `Basic ${basic}`
                            }
                        }
                    );
                } catch (tokenError) {
                    console.error('❌ Ошибка обмена кода на токен для бота:');
                    console.error('   Status:', tokenError?.response?.status);
                    console.error('   Data:', JSON.stringify(tokenError?.response?.data, null, 2));
                    console.error('   Message:', tokenError.message);
                    
                    if (tokenError?.response?.status === 400) {
                        const errorData = tokenError?.response?.data;
                        if (errorData?.error === 'invalid_grant') {
                            console.error('💡 Ошибка invalid_grant обычно означает:');
                            console.error('   1. Код авторизации уже использован или истек');
                            console.error('   2. redirect_uri не совпадает с тем, что был в запросе авторизации');
                            console.error('   3. Проверьте, что redirect_uri в настройках приложения точно совпадает');
                        }
                    }
                    
                    if (tokenError?.response?.status === 404) {
                        try {
                            console.log('🔄 Пробуем apidev.live.vkvideo.ru...');
                            tokenRes = await axios.post(
                                'https://apidev.live.vkvideo.ru/oauth/server/token',
                                tokenData,
                                {
                                    headers: {
                                        'Content-Type': 'application/x-www-form-urlencoded',
                                        'Authorization': `Basic ${basic}`
                                    }
                                }
                            );
                            console.log('✅ Токен получен от apidev.live.vkvideo.ru');
                        } catch (error2) {
                            console.error('❌ apidev.live.vkvideo.ru тоже вернул ошибку:');
                            console.error('   Status:', error2?.response?.status);
                            console.error('   Data:', JSON.stringify(error2?.response?.data, null, 2));
                            return res.status(500).send(`Token exchange failed: ${error2?.response?.data?.error || error2.message}`);
                        }
                    } else {
                        return res.status(500).send(`Token exchange failed: ${tokenError?.response?.data?.error || tokenError.message}`);
                    }
                }
                
                const tokens = tokenRes.data; // access_token, refresh_token, expires_in, token_type
                console.log('✅ Токен получен для бота:', {
                    access_token: tokens.access_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ',
                    refresh_token: tokens.refresh_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ',
                    expires_in: tokens.expires_in,
                    token_type: tokens.token_type
                });
                console.log('   📋 Запрошенные scope включают:');
                console.log('      ✅ chat:message:send - Отправка сообщений в чат (ОБЯЗАТЕЛЬНО для работы бота!)');
                console.log('      ✅ channel:points, channel:points:rewards, channel:points:rewards:demands, channel:roles');
                console.log('   💡 Если бот не может отправлять сообщения, проверьте, что scope chat:message:send был одобрен при авторизации');
                
                const nowSec = Math.floor(Date.now() / 1000);
                
                vkplayBotIntegration.connected = true;
                vkplayBotIntegration.tokens = tokens;
                vkplayBotIntegration.expires_at = nowSec + (tokens.expires_in || 0);
                
                // Получаем информацию о боте
                try {
                    let userResponse;
                    try {
                        userResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/current_user', {
                            headers: { Authorization: `Bearer ${tokens.access_token}` }
                        });
                    } catch (apiError) {
                        if (apiError?.response?.status === 404) {
                            userResponse = await axios.get('https://api.live.vkvideo.ru/v1/current_user', {
                                headers: { Authorization: `Bearer ${tokens.access_token}` }
                            });
                        } else {
                            throw apiError;
                        }
                    }
                    
                    const userData = userResponse.data?.data;
                    if (userData) {
                        vkplayBotIntegration.userId = userData.user?.id || null;
                        vkplayBotIntegration.userNick = userData.user?.nick || null;
                        const channelUrl = userData.channel?.url || (userData.channels && userData.channels[0]?.url) || null;
                        vkplayBotIntegration.channelUrl = channelUrl;
                        vkplayBotIntegration.channel = userData.user?.nick || channelUrl;
                        
                        console.log(`✅ VK Play Bot авторизация завершена: ${vkplayBotIntegration.userNick} (ID: ${vkplayBotIntegration.userId})`);
                    }
                } catch (e) {
                    console.warn('⚠️ Не удалось получить информацию о боте:', e?.response?.data || e.message);
                }
                
                // Сохраняем в БД (всегда, даже если не удалось получить данные пользователя)
                try {
                    await saveIntegration('vkplay_bot', {
                        tokens: vkplayBotIntegration.tokens,
                        expires_at: vkplayBotIntegration.expires_at,
                        channel: vkplayBotIntegration.channel,
                        channelUrl: vkplayBotIntegration.channelUrl,
                        userId: vkplayBotIntegration.userId,
                        userNick: vkplayBotIntegration.userNick
                    });
                    console.log('✅ Токены VK Play Bot сохранены в БД');
                } catch (saveError) {
                    console.error('❌ Ошибка сохранения токенов бота:', saveError);
                }
                
                // Redirect back to integrations page (как в обычном VK Play)
                res.redirect('/stream-integrations.html');
            } catch (error) {
                console.error('❌ Ошибка авторизации VK Play Bot:', error);
                res.status(500).send('Authorization failed');
            }
        });

        // Тестовый endpoint для проверки параметров авторизации бота

        app.get('/oauth/vkplay-bot/test', (req, res) => {
            const clientId = process.env.VKPLAY_BOT_CLIENT_ID;
            const redirectUri = process.env.VKPLAY_BOT_REDIRECT_URI || `http://localhost:${port}/oauth/vkplay-bot/callback`;
            const cleanRedirectUri = redirectUri.trim();
            const cleanClientId = clientId ? clientId.trim() : null;
            
            const EXPECTED_BOT_CLIENT_ID = 'umv46nrqcxbvzxhz';
            const EXPECTED_REDIRECT_URI = 'http://localhost:3000/oauth/vkplay-bot/callback';
            
            const scopes = [
                'channel:points',
                'channel:points:rewards',
                'channel:points:rewards:demands',
                'channel:roles',
                'chat:message:send'
            ].join(',');
            
            const params = {
                client_id: cleanClientId,
                redirect_uri: cleanRedirectUri,
                response_type: 'code',
                scope: scopes,
                state: 'test123'
            };
            
            const authUrl = `https://auth.live.vkvideo.ru/app/oauth2/authorize?${querystring.stringify(params)}`;
            
            res.send(`
                <html>
                    <head>
                        <title>Тест авторизации VK Play Bot</title>
                        <style>
                            body { font-family: Arial, sans-serif; padding: 20px; background: #0a0a14; color: #fff; }
                            .section { margin: 20px 0; padding: 15px; background: #1a1a2e; border-radius: 5px; }
                            .ok { color: #00ff00; }
                            .error { color: #ff0000; }
                            .warning { color: #ffaa00; }
                            pre { background: #000; padding: 10px; border-radius: 5px; overflow-x: auto; }
                            a { color: #00f0ff; }
                        </style>
                    </head>
                    <body>
                        <h1>🔍 Тест авторизации VK Play Bot</h1>
                        
                        <div class="section">
                            <h2>Проверка параметров:</h2>
                            <p><strong>Client ID:</strong> 
                                <span class="${cleanClientId === EXPECTED_BOT_CLIENT_ID ? 'ok' : 'error'}">
                                    ${cleanClientId || 'ОТСУТСТВУЕТ'} 
                                    ${cleanClientId === EXPECTED_BOT_CLIENT_ID ? '✅' : '❌'}
                                </span>
                            </p>
                            <p><strong>Ожидается:</strong> ${EXPECTED_BOT_CLIENT_ID}</p>
                            
                            <p><strong>Redirect URI:</strong> 
                                <span class="${cleanRedirectUri === EXPECTED_REDIRECT_URI ? 'ok' : 'error'}">
                                    ${cleanRedirectUri || 'ОТСУТСТВУЕТ'} 
                                    ${cleanRedirectUri === EXPECTED_REDIRECT_URI ? '✅' : '❌'}
                                </span>
                            </p>
                            <p><strong>Ожидается:</strong> ${EXPECTED_REDIRECT_URI}</p>
                        </div>
                        
                        <div class="section">
                            <h2>Параметры запроса:</h2>
                            <pre>${JSON.stringify(params, null, 2)}</pre>
                        </div>
                        
                        <div class="section">
                            <h2>URL авторизации:</h2>
                            <pre>${authUrl}</pre>
                            <p><a href="${authUrl}" target="_blank">🔗 Попробовать авторизацию</a></p>
                        </div>
                        
                        <div class="section">
                            <h2>⚠️ Что проверить в настройках приложения VK Play "Xasya Bot":</h2>
                            <ol>
                                <li>Откройте панель управления приложением в VK Play</li>
                                <li>Найдите раздел "Список допустимых URL для редиректа"</li>
                                <li>Убедитесь, что указан ТОЧНО: <code>http://localhost:3000/oauth/vkplay-bot/callback</code></li>
                                <li>Каждый URL должен быть на отдельной строке (не через запятую)</li>
                                <li>Без пробелов в начале и конце</li>
                                <li>Без слеша в конце</li>
                            </ol>
                        </div>
                        
                        <div class="section">
                            <h2>📋 Scope (разрешения):</h2>
                            <p>Запрашиваемые разрешения:</p>
                            <ul>
                                <li>channel:points</li>
                                <li>channel:points:rewards</li>
                                <li>channel:points:rewards:demands</li>
                                <li>channel:roles</li>
                                <li>chat:message:send</li>
                            </ul>
                            <p class="warning">⚠️ Если возникает ошибка, попробуйте убрать scope из настроек приложения или оставить их пустыми</p>
                        </div>
                    </body>
                </html>
            `);
        });

        // Статус бота

        app.get('/integrations/vkplay-bot/status', (req, res) => {
            res.json({
                connected: vkplayBotIntegration.connected,
                channel: vkplayBotIntegration.channel,
                channelUrl: vkplayBotIntegration.channelUrl,
                userId: vkplayBotIntegration.userId,
                userNick: vkplayBotIntegration.userNick
            });
        });

        // Выход бота

        app.post('/oauth/vkplay-bot/logout', async (req, res) => {
            try {
                // Удаляем данные из БД
                db.run('DELETE FROM stream_integrations WHERE platform = ?', ['vkplay_bot'], (err) => {
                    if (err) {
                        console.error('❌ Ошибка удаления данных бота из БД:', err);
                    } else {
                        console.log('✅ Данные VK Play Bot удалены из БД');
                    }
                });
                
                // Очищаем в памяти
                vkplayBotIntegration = { connected: false, channel: null, channelUrl: null, tokens: null, expires_at: 0, userId: null, userNick: null };
                res.json({ ok: true });
            } catch (error) {
                console.error('❌ Ошибка при выходе бота:', error);
                res.status(500).json({ error: 'Logout failed' });
            }
        });

        // Сбор чата VK Play

        app.get('/api/vkplay/roles', async (req, res) => {
            try {
                if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
                    console.warn('⚠️ VK Play не подключен для получения ролей');
                    return res.status(401).json({ error: 'VK Play не подключен' });
                }

                console.log('📋 Запрос ролей VK Play:');
                console.log('   Channel URL:', vkplayIntegration.channelUrl);
                console.log('   Access token:', vkplayIntegration.tokens.access_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');

                // Пробуем оба варианта URL (api и apidev)
                let response;
                try {
                    response = await axios.get('https://api.live.vkvideo.ru/v1/channel_roles', {
                        params: { channel_url: vkplayIntegration.channelUrl },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } catch (apiError) {
                    if (apiError?.response?.status === 404) {
                        console.log('⚠️ api.live.vkvideo.ru вернул 404 для roles, пробуем apidev...');
                        response = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_roles', {
                            params: { channel_url: vkplayIntegration.channelUrl },
                            headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                        });
                    } else {
                        throw apiError;
                    }
                }

                console.log('✅ Роли получены:', response.data?.data?.roles?.length || 0, 'ролей');
                res.json(response.data);
            } catch (error) {
                console.error('❌ Ошибка получения ролей:');
                console.error('   Status:', error?.response?.status);
                console.error('   Data:', JSON.stringify(error?.response?.data, null, 2));
                console.error('   Message:', error.message);
                res.status(error?.response?.status || 500).json({ 
                    error: error?.response?.data || error.message 
                });
            }
        });

        // Получение списка наград канала

        app.get('/api/vkplay/rewards', async (req, res) => {
            try {
                if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
                    console.warn('⚠️ VK Play не подключен для получения наград');
                    return res.status(401).json({ error: 'VK Play не подключен' });
                }

                console.log('🎁 Запрос наград VK Play:');
                console.log('   Channel URL:', vkplayIntegration.channelUrl);
                console.log('   Access token:', vkplayIntegration.tokens.access_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');

                // Пробуем оба варианта URL (api и apidev)
                let response;
                try {
                    response = await axios.get('https://api.live.vkvideo.ru/v1/channel_point/rewards', {
                        params: { channel_url: vkplayIntegration.channelUrl },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } catch (apiError) {
                    if (apiError?.response?.status === 404) {
                        console.log('⚠️ api.live.vkvideo.ru вернул 404 для rewards, пробуем apidev...');
                        response = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_point/rewards', {
                            params: { channel_url: vkplayIntegration.channelUrl },
                            headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                        });
                    } else {
                        throw apiError;
                    }
                }

                console.log('✅ Награды получены:', response.data?.data?.rewards?.length || 0, 'наград');
                res.json(response.data);
            } catch (error) {
                console.error('❌ Ошибка получения наград:');
                console.error('   Status:', error?.response?.status);
                console.error('   Data:', JSON.stringify(error?.response?.data, null, 2));
                console.error('   Message:', error.message);
                res.status(error?.response?.status || 500).json({ 
                    error: error?.response?.data || error.message 
                });
            }
        });

        // Получение списка связей награда-роль

        app.get('/api/vkplay/reward-roles', (req, res) => {
            if (!vkplayIntegration.connected || !vkplayIntegration.channelUrl) {
                return res.status(401).json({ error: 'VK Play не подключен' });
            }

            db.all(
                'SELECT * FROM vkplay_reward_roles WHERE channel_url = ? ORDER BY created_at DESC',
                [vkplayIntegration.channelUrl],
                (err, rows) => {
                    if (err) {
                        console.error('❌ Ошибка получения связей:', err);
                        return res.status(500).json({ error: err.message });
                    }
                    res.json({ rewardRoles: rows });
                }
            );
        });

        // Сохранение/обновление связи награда-роль

        app.post('/api/vkplay/reward-roles', express.json(), (req, res) => {
            try {
                const { reward_id, reward_name, role_id, role_name, enabled = true } = req.body;

                if (!reward_id || !role_id || !vkplayIntegration.channelUrl) {
                    return res.status(400).json({ error: 'Не указаны обязательные параметры' });
                }

                db.run(
                    `INSERT OR REPLACE INTO vkplay_reward_roles 
                    (reward_id, reward_name, role_id, role_name, channel_url, enabled, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                    [reward_id, reward_name || '', role_id, role_name || '', vkplayIntegration.channelUrl, enabled ? 1 : 0],
                    function(err) {
                        if (err) {
                            console.error('❌ Ошибка сохранения связи:', err);
                            return res.status(500).json({ error: err.message });
                        }
                        res.json({ success: true, id: this.lastID });
                    }
                );
            } catch (error) {
                console.error('❌ Ошибка обработки запроса:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Удаление связи награда-роль

        app.delete('/api/vkplay/reward-roles/:id', (req, res) => {
            const { id } = req.params;

            db.run('DELETE FROM vkplay_reward_roles WHERE id = ?', [id], function(err) {
                if (err) {
                    console.error('❌ Ошибка удаления связи:', err);
                    return res.status(500).json({ error: err.message });
                }
                res.json({ success: true });
            });
        });

        // Получение истории выдачи ролей

        app.get('/api/vkplay/role-history', (req, res) => {
            const { limit = 100, offset = 0, status = null } = req.query;

            const channelUrl = vkplayIntegration.channelUrl;
            if (!channelUrl) {
                console.warn('⚠️ channelUrl не установлен для истории ролей');
                return res.json({ history: [] });
            }

            // Возвращаем только награды со связками (где role_id не пустой)
            let query = 'SELECT * FROM vkplay_role_history WHERE channel_url = ? AND role_id != "" AND role_id IS NOT NULL';
            const params = [channelUrl];

            if (status && status !== 'all') {
                query += ' AND status = ?';
                params.push(status);
            }

            query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
            params.push(parseInt(limit), parseInt(offset));

            console.log('📜 Запрос истории ролей (только со связками):', { channelUrl, status, limit, offset });

            db.all(query, params, async (err, rows) => {
                if (err) {
                    console.error('❌ Ошибка получения истории ролей:', err);
                    return res.status(500).json({ error: err.message });
                }
                console.log(`✅ История ролей получена: ${rows?.length || 0} записей (только со связками)`);
                
                // Обновляем ники для записей, где их нет (с ограничением по времени)
                if (rows && rows.length > 0) {
                    const updatePromises = [];
                    const userIdsToUpdate = new Set(); // Кэш для избежания дублирования запросов
                    
                    for (const row of rows) {
                        // Если у записи нет ника, пытаемся получить его
                        if ((!row.user_nick || row.user_nick.trim() === '') && !userIdsToUpdate.has(row.user_id)) {
                            userIdsToUpdate.add(row.user_id);
                            
                            updatePromises.push(
                                getUserInfo(row.user_id).then(userInfo => {
                                    if (userInfo && userInfo.nick && userInfo.nick.trim() !== '') {
                                        const retrievedNick = userInfo.nick.trim();
                                        console.log(`🔄 Обновляем ник для userId=${row.user_id}: "${retrievedNick}"`);
                                        
                                        // Обновляем в БД для всех записей с этим userId
                                        return new Promise((resolve) => {
                                            db.run(
                                                'UPDATE vkplay_role_history SET user_nick = ? WHERE user_id = ? AND (user_nick IS NULL OR user_nick = "")',
                                                [retrievedNick, row.user_id],
                                                function(updateErr) {
                                                    if (updateErr) {
                                                        console.error(`❌ Ошибка обновления ника для userId=${row.user_id}:`, updateErr);
                                                        resolve(null);
                                                    } else {
                                                        // Обновляем ник во всех строках с этим userId для текущего ответа
                                                        rows.forEach(r => {
                                                            if (r.user_id === row.user_id && (!r.user_nick || r.user_nick.trim() === '')) {
                                                                r.user_nick = retrievedNick;
                                                            }
                                                        });
                                                        console.log(`✅ Ник "${retrievedNick}" обновлен для userId=${row.user_id} (обновлено ${this.changes} записей)`);
                                                        resolve(retrievedNick);
                                                    }
                                                }
                                            );
                                        });
                                    }
                                    return null;
                                }).catch(err => {
                                    console.warn(`⚠️ Не удалось получить ник для userId=${row.user_id}:`, err?.message || err);
                                    return null;
                                })
                            );
                        }
                    }
                    
                    // Ждем обновления ников (но не блокируем ответ слишком долго - максимум 3 секунды)
                    if (updatePromises.length > 0) {
                        console.log(`🔄 Обновляем ники для ${updatePromises.length} уникальных пользователей...`);
                        const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('timeout'), 3000));
                        await Promise.race([Promise.allSettled(updatePromises), timeoutPromise]);
                    }
                }
                
                // Логируем первые несколько записей для отладки
                if (rows && rows.length > 0) {
                    console.log('📋 Примеры записей из истории:');
                    rows.slice(0, 3).forEach((row, index) => {
                        console.log(`   ${index + 1}. user_id: ${row.user_id}, user_nick: "${row.user_nick || 'NULL'}", reward: ${row.reward_name}, role: ${row.role_name}, status: ${row.status}`);
                    });
                }
                
                res.json({ history: rows || [] });
            });
        });

        // Получение списка ролей пользователя
    }

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

    return { registerRoutes, startPolling, hydrateFromDb };
}

module.exports = { createVkplayIntegrationModule };
