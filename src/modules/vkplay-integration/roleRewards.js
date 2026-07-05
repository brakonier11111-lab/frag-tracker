'use strict';
/**
 * VK Play: роли/награды пользователей — чтение ролей, отправка сообщений в
 * чат (основной аккаунт или бот), отмена активации награды, поиск ника
 * пользователя (4 способа), выдача роли по награде + запись истории.
 * Вынесено из index.js 1:1. Общее состояние (vkplayIntegration/
 * vkplayBotIntegration — целиком переприсваиваются в других местах index.js)
 * доступно через хаб h (геттеры/сеттеры), как в replay-live/detection.js.
 */

const axios = require('axios').create({ proxy: false });
const WebSocket = require('ws');

function createRoleRewards(h) {
    async function getUserRoles(userId) {
        try {
            if (!h.vkplayIntegration.connected || !h.vkplayIntegration.tokens || !h.vkplayIntegration.channelUrl) {
                return [];
            }

            let response;
            try {
                response = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_roles/user', {
                    params: {
                        channel_url: h.vkplayIntegration.channelUrl,
                        user_id: userId
                    },
                    headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    try {
                        response = await axios.get('https://api.live.vkvideo.ru/v1/channel_roles/user', {
                            params: {
                                channel_url: h.vkplayIntegration.channelUrl,
                                user_id: userId
                            },
                            headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
            const integration = useBot ? h.vkplayBotIntegration : h.vkplayIntegration;
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
            if (!h.vkplayIntegration.connected || !h.vkplayIntegration.tokens || !h.vkplayIntegration.channelUrl) {
                console.warn('⚠️ VK Play не подключен для отмены награды');
                return false;
            }

            console.log(`🔄 Попытка отмены награды ${rewardId} для пользователя ${userId}...`);

            // Получаем список запросов наград (demands) - ищем активный запрос от этого пользователя
            let demandsResponse;
            try {
                demandsResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_point/reward/demands', {
                    params: {
                        channel_url: h.vkplayIntegration.channelUrl,
                        limit: 100,
                        offset: 0
                    },
                    headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    demandsResponse = await axios.get('https://api.live.vkvideo.ru/v1/channel_point/reward/demands', {
                        params: {
                            channel_url: h.vkplayIntegration.channelUrl,
                            limit: 100,
                            offset: 0
                        },
                        headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
                            params: { channel_url: h.vkplayIntegration.channelUrl },
                            headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
                        }
                    );
                } catch (apiError) {
                    if (apiError?.response?.status === 404) {
                        rejectResponse = await axios.post(
                            'https://api.live.vkvideo.ru/v1/channel_point/reward/demand/reject',
                            { demands: [{ id: userDemand.id }] },
                            {
                                params: { channel_url: h.vkplayIntegration.channelUrl },
                                headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
            if (!h.vkplayIntegration.connected || !h.vkplayIntegration.tokens || !h.vkplayIntegration.channelUrl) {
                console.warn(`⚠️ VK Play не подключен, невозможно получить ник пользователя ${userId}`);
                return null;
            }

            // Метод 1: Пробуем получить информацию через chat/member
            let response;
            try {
                response = await axios.get('https://apidev.live.vkvideo.ru/v1/chat/member', {
                    params: {
                        channel_url: h.vkplayIntegration.channelUrl,
                        user_id: userId
                    },
                    headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
                                channel_url: h.vkplayIntegration.channelUrl,
                                user_id: userId
                            },
                            headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
                    h.db.get(
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
                            channel_url: h.vkplayIntegration.channelUrl,
                            limit: 200  // Максимум участников
                        },
                        headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
                    });
                } catch (apiError) {
                    if (apiError?.response?.status === 404) {
                        membersResponse = await axios.get('https://api.live.vkvideo.ru/v1/chat/members', {
                            params: {
                                channel_url: h.vkplayIntegration.channelUrl,
                                limit: 200
                            },
                            headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
                        channel_url: h.vkplayIntegration.channelUrl,
                        user_id: userId
                    },
                    headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
                                channel_url: h.vkplayIntegration.channelUrl,
                                user_id: userId
                            },
                            headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
        const channelUrl = h.vkplayIntegration.channelUrl;
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

        h.db.run(
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
                                h.db.run(
                                    'UPDATE vkplay_role_history SET user_nick = ? WHERE id = ?',
                                    [retrievedNick, historyId],
                                    function(updateErr) {
                                        if (updateErr) {
                                            console.error('❌ Ошибка обновления ника в истории:', updateErr);
                                        } else {
                                            console.log(`✅ Ник "${retrievedNick}" обновлен в истории для userId=${userId} (ID записи: ${historyId})`);
                                            // Отправляем обновление через WebSocket
                                            if (h.wss && h.wss.clients) {
                                                const message = JSON.stringify({
                                                    type: 'VKPLAY_ROLE_HISTORY_UPDATE',
                                                    data: { userId, userNick: retrievedNick }
                                                });
                                                h.wss.clients.forEach((client) => {
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
                    if (h.wss && h.wss.clients) {
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
                        h.wss.clients.forEach((client) => {
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
            if (!h.vkplayIntegration.connected || !h.vkplayIntegration.tokens || !h.vkplayIntegration.channelUrl) {
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
                h.db.get(
                    'SELECT role_name FROM vkplay_reward_roles WHERE reward_id = ? AND channel_url = ?',
                    [rewardId, h.vkplayIntegration.channelUrl],
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
                                    params: { channel_url: h.vkplayIntegration.channelUrl },
                                    headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
                                });
                            } catch (apiError) {
                                if (apiError?.response?.status === 404) {
                                    rewardsResponse = await axios.get('https://api.live.vkvideo.ru/v1/channel_point/rewards', {
                                        params: { channel_url: h.vkplayIntegration.channelUrl },
                                        headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
                            if (h.vkplayBotIntegration.connected) {
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
                                if (h.vkplayBotIntegration.connected) {
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
                                            channel_url: h.vkplayIntegration.channelUrl,
                                            user_id: userId
                                        },
                                        headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
                                                    channel_url: h.vkplayIntegration.channelUrl,
                                                    user_id: userId
                                                },
                                                headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
                                                    if (h.vkplayBotIntegration.connected) {
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
                                if (h.vkplayBotIntegration.connected) {
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
                                        if (h.vkplayBotIntegration.connected) {
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

    return {
        getUserRoles,
        userHasRole,
        sendChatMessage,
        cancelRewardActivation,
        getUserInfo,
        saveRoleHistory,
        assignRoleToUser
    };
}

module.exports = { createRoleRewards };
