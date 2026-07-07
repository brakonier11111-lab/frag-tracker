'use strict';

/**
 * Роуты VKPlay-интеграции (status/oauth/config/bot/rewards/roles) — вынесены
 * из index.js 1:1. Общее состояние и функции — через хаб h (vkplayIntegration/
 * vkplayBotIntegration переприсваиваются, поэтому в хабе они accessor-свойства).
 */

const axios = require('axios');
const express = require('express');
const querystring = require('querystring');

function createVkplayRoutes(h) {
    function registerRoutes(app) {
        app.get('/integrations/vkplay/status', async (req, res) => {
            // Если channelUrl отсутствует, но есть токен - обновляем данные
            if (!h.vkplayIntegration.channelUrl && h.vkplayIntegration.connected && h.vkplayIntegration.tokens?.access_token) {
                console.log('🔄 channelUrl отсутствует, обновляем данные VK Play...');
                
                // Сначала пробуем загрузить из БД
                try {
                    const vkplay = await h.loadIntegration('vkplay');
                    if (vkplay && vkplay.channel_url) {
                        h.vkplayIntegration.channelUrl = vkplay.channel_url;
                        if (!h.vkplayIntegration.channel) h.vkplayIntegration.channel = vkplay.channel_name;
                        if (!h.vkplayIntegration.liveTitle) h.vkplayIntegration.liveTitle = vkplay.live_title;
                        console.log('✅ Данные загружены из БД:', { channelUrl: h.vkplayIntegration.channelUrl });
                    }
                } catch (e) {
                    console.warn('⚠️ Ошибка загрузки VK Play из БД:', e.message);
                }
                
                // Если все еще нет channelUrl, запрашиваем через API
                if (!h.vkplayIntegration.channelUrl && h.vkplayIntegration.tokens?.access_token) {
                    try {
                        console.log('📡 Запрашиваем данные пользователя через API...');
                        // Пробуем оба варианта URL (api и apidev)
                        let currentUser;
                        try {
                            currentUser = await axios.get('https://api.live.vkvideo.ru/v1/current_user', {
                                headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
                            });
                        } catch (apiError) {
                            if (apiError?.response?.status === 404) {
                                console.log('⚠️ api.live.vkvideo.ru вернул 404, пробуем apidev.live.vkvideo.ru...');
                                currentUser = await axios.get('https://apidev.live.vkvideo.ru/v1/current_user', {
                                    headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
                                });
                            } else {
                                throw apiError;
                            }
                        }
                        
                        const data = currentUser.data?.data;
                        if (data && data.channel?.url) {
                            h.vkplayIntegration.channelUrl = data.channel.url;
                            console.log('✅ channelUrl получен из API:', h.vkplayIntegration.channelUrl);
                            
                            // Получаем данные канала
                            try {
                                let channelData;
                                try {
                                    channelData = await axios.get('https://api.live.vkvideo.ru/v1/channel', {
                                        params: { channel_url: h.vkplayIntegration.channelUrl },
                                        headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
                                    });
                                } catch (apiError) {
                                    if (apiError?.response?.status === 404) {
                                        console.log('⚠️ api.live.vkvideo.ru вернул 404 для channel, пробуем apidev...');
                                        channelData = await axios.get('https://apidev.live.vkvideo.ru/v1/channel', {
                                            params: { channel_url: h.vkplayIntegration.channelUrl },
                                            headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
                                        });
                                    } else {
                                        throw apiError;
                                    }
                                }
                                
                                const channelInfo = channelData.data?.data;
                                if (channelInfo) {
                                    h.vkplayIntegration.channel = channelInfo.channel?.nick || h.vkplayIntegration.channelUrl;
                                    h.vkplayIntegration.liveTitle = channelInfo.stream?.title || 'Нет активного стрима';
                                    h.vkplayIntegration.viewers = h.getVKPlayViewersFromChannelInfo(channelInfo);
                                    // Берем лайки из counters с учетом разных возможных полей
                                    h.vkplayIntegration.likes = h.getVKPlayLikesFromChannelInfo(channelInfo, h.vkplayIntegration.likes);
                                    h.vkplayIntegration.chatEnabled = !!channelInfo.channel?.web_socket_channels?.chat;
                                    
                                    // Сохраняем в БД
                                    await h.saveIntegration('vkplay', {
                                        tokens: h.vkplayIntegration.tokens,
                                        expires_at: h.vkplayIntegration.expires_at,
                                        channel: h.vkplayIntegration.channel,
                                        channelUrl: h.vkplayIntegration.channelUrl,
                                        liveTitle: h.vkplayIntegration.liveTitle,
                                        viewers: h.vkplayIntegration.viewers,
                                        likes: h.vkplayIntegration.likes,
                                        chatEnabled: h.vkplayIntegration.chatEnabled
                                    });
                                    
                                    console.log('✅ Данные канала обновлены:', {
                                        channel: h.vkplayIntegration.channel,
                                        liveTitle: h.vkplayIntegration.liveTitle
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
            
          res.json(h.vkplayIntegration);
        });

        app.get('/oauth/vkplay/start', (req, res) => {
            const clientId = process.env.VKPLAY_CLIENT_ID;
            // ВАЖНО: redirect_uri должен ТОЧНО совпадать с тем, что указано в настройках приложения VK Play
            // Проверьте в настройках приложения: http://localhost:3000/oauth/vkplay/callback
            const redirectUri = process.env.VKPLAY_REDIRECT_URI || `http://localhost:${h.port}/oauth/vkplay/callback`;
            
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
                const redirectUri = process.env.VKPLAY_REDIRECT_URI || `http://localhost:${h.port}/oauth/vkplay/callback`;
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
                h.vkplayIntegration.connected = true;
                h.vkplayIntegration.tokens = tokens;
                h.vkplayIntegration.expires_at = nowSec + (tokens.expires_in || 0);

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
                        h.vkplayIntegration.channelUrl = channelUrl;
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
                                    h.vkplayIntegration.channel = channelInfo.channel?.nick || channelUrl;
                                    h.vkplayIntegration.liveTitle = channelInfo.stream?.title || 'Нет активного стрима';
                                    h.vkplayIntegration.viewers = h.getVKPlayViewersFromChannelInfo(channelInfo);
                                    h.vkplayIntegration.likes = h.getVKPlayLikesFromChannelInfo(channelInfo, h.vkplayIntegration.likes);
                                    h.vkplayIntegration.chatEnabled = !!channelInfo.channel?.web_socket_channels?.chat;
                                    
                                    console.log('✅ Данные канала получены:', {
                                        channel: h.vkplayIntegration.channel,
                                        liveTitle: h.vkplayIntegration.liveTitle,
                                        viewers: h.vkplayIntegration.viewers,
                                        likes: h.vkplayIntegration.likes,
                                        chatEnabled: h.vkplayIntegration.chatEnabled
                                    });
                                    
                                    // Сохраняем в БД
                                    await h.saveIntegration('vkplay', {
                                        tokens: tokens,
                                        expires_at: h.vkplayIntegration.expires_at,
                                        channel: h.vkplayIntegration.channel,
                                        channelUrl: channelUrl,
                                        liveTitle: h.vkplayIntegration.liveTitle,
                                        viewers: h.vkplayIntegration.viewers,
                                        likes: h.vkplayIntegration.likes,
                                        chatEnabled: h.vkplayIntegration.chatEnabled
                                    });
                                    
                                    console.log(`✅ VK Play авторизация завершена: ${h.vkplayIntegration.channel} | ${h.vkplayIntegration.liveTitle}`);
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
                            await h.saveIntegration('vkplay', {
                                tokens: tokens,
                                expires_at: h.vkplayIntegration.expires_at,
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
                        await h.saveIntegration('vkplay', {
                            tokens: tokens,
                            expires_at: h.vkplayIntegration.expires_at,
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
                        await h.saveIntegration('vkplay', {
                            tokens: tokens,
                            expires_at: h.vkplayIntegration.expires_at,
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
                : `http://localhost:${h.port}/oauth-vkplay-implicit.html`;
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
                h.vkplayIntegration.connected = true;
                h.vkplayIntegration.tokens = { access_token, token_type, expire_time };
                // Получим current_user для статуса
                try {
                    const me = await axios.get('https://api.live.vkvideo.ru/v1/current_user', {
                        headers: { Authorization: `Bearer ${access_token}` }
                    });
                    const data = me.data && me.data.data;
                    if (data) {
                        const channelUrl = data.channel?.url || (data.channels && data.channels[0]?.url) || null;
                        h.vkplayIntegration.channel = channelUrl;
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
            h.vkplayIntegration = { connected: false, channel: null, liveTitle: null, chatEnabled: false, viewers: 0, tokens: null, expires_at: 0, channelUrl: null };
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
            const redirectUri = process.env.VKPLAY_BOT_REDIRECT_URI || `http://localhost:${h.port}/oauth/vkplay-bot/callback`;
            
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
                const redirectUri = process.env.VKPLAY_BOT_REDIRECT_URI || `http://localhost:${h.port}/oauth/vkplay-bot/callback`;
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
                
                h.vkplayBotIntegration.connected = true;
                h.vkplayBotIntegration.tokens = tokens;
                h.vkplayBotIntegration.expires_at = nowSec + (tokens.expires_in || 0);
                
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
                        h.vkplayBotIntegration.userId = userData.user?.id || null;
                        h.vkplayBotIntegration.userNick = userData.user?.nick || null;
                        const channelUrl = userData.channel?.url || (userData.channels && userData.channels[0]?.url) || null;
                        h.vkplayBotIntegration.channelUrl = channelUrl;
                        h.vkplayBotIntegration.channel = userData.user?.nick || channelUrl;
                        
                        console.log(`✅ VK Play Bot авторизация завершена: ${h.vkplayBotIntegration.userNick} (ID: ${h.vkplayBotIntegration.userId})`);
                    }
                } catch (e) {
                    console.warn('⚠️ Не удалось получить информацию о боте:', e?.response?.data || e.message);
                }
                
                // Сохраняем в БД (всегда, даже если не удалось получить данные пользователя)
                try {
                    await h.saveIntegration('vkplay_bot', {
                        tokens: h.vkplayBotIntegration.tokens,
                        expires_at: h.vkplayBotIntegration.expires_at,
                        channel: h.vkplayBotIntegration.channel,
                        channelUrl: h.vkplayBotIntegration.channelUrl,
                        userId: h.vkplayBotIntegration.userId,
                        userNick: h.vkplayBotIntegration.userNick
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
            const redirectUri = process.env.VKPLAY_BOT_REDIRECT_URI || `http://localhost:${h.port}/oauth/vkplay-bot/callback`;
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
                connected: h.vkplayBotIntegration.connected,
                channel: h.vkplayBotIntegration.channel,
                channelUrl: h.vkplayBotIntegration.channelUrl,
                userId: h.vkplayBotIntegration.userId,
                userNick: h.vkplayBotIntegration.userNick
            });
        });

        // Выход бота

        app.post('/oauth/vkplay-bot/logout', async (req, res) => {
            try {
                // Удаляем данные из БД
                h.db.run('DELETE FROM stream_integrations WHERE platform = ?', ['vkplay_bot'], (err) => {
                    if (err) {
                        console.error('❌ Ошибка удаления данных бота из БД:', err);
                    } else {
                        console.log('✅ Данные VK Play Bot удалены из БД');
                    }
                });
                
                // Очищаем в памяти
                h.vkplayBotIntegration = { connected: false, channel: null, channelUrl: null, tokens: null, expires_at: 0, userId: null, userNick: null };
                res.json({ ok: true });
            } catch (error) {
                console.error('❌ Ошибка при выходе бота:', error);
                res.status(500).json({ error: 'Logout failed' });
            }
        });

        // Сбор чата VK Play

        app.get('/api/vkplay/roles', async (req, res) => {
            try {
                if (!h.vkplayIntegration.connected || !h.vkplayIntegration.tokens || !h.vkplayIntegration.channelUrl) {
                    console.warn('⚠️ VK Play не подключен для получения ролей');
                    return res.status(401).json({ error: 'VK Play не подключен' });
                }

                console.log('📋 Запрос ролей VK Play:');
                console.log('   Channel URL:', h.vkplayIntegration.channelUrl);
                console.log('   Access token:', h.vkplayIntegration.tokens.access_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');

                // Пробуем оба варианта URL (api и apidev)
                let response;
                try {
                    response = await axios.get('https://api.live.vkvideo.ru/v1/channel_roles', {
                        params: { channel_url: h.vkplayIntegration.channelUrl },
                        headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
                    });
                } catch (apiError) {
                    if (apiError?.response?.status === 404) {
                        console.log('⚠️ api.live.vkvideo.ru вернул 404 для roles, пробуем apidev...');
                        response = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_roles', {
                            params: { channel_url: h.vkplayIntegration.channelUrl },
                            headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
                if (!h.vkplayIntegration.connected || !h.vkplayIntegration.tokens || !h.vkplayIntegration.channelUrl) {
                    console.warn('⚠️ VK Play не подключен для получения наград');
                    return res.status(401).json({ error: 'VK Play не подключен' });
                }

                console.log('🎁 Запрос наград VK Play:');
                console.log('   Channel URL:', h.vkplayIntegration.channelUrl);
                console.log('   Access token:', h.vkplayIntegration.tokens.access_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');

                // Пробуем оба варианта URL (api и apidev)
                let response;
                try {
                    response = await axios.get('https://api.live.vkvideo.ru/v1/channel_point/rewards', {
                        params: { channel_url: h.vkplayIntegration.channelUrl },
                        headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
                    });
                } catch (apiError) {
                    if (apiError?.response?.status === 404) {
                        console.log('⚠️ api.live.vkvideo.ru вернул 404 для rewards, пробуем apidev...');
                        response = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_point/rewards', {
                            params: { channel_url: h.vkplayIntegration.channelUrl },
                            headers: { Authorization: `Bearer ${h.vkplayIntegration.tokens.access_token}` }
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
            if (!h.vkplayIntegration.connected || !h.vkplayIntegration.channelUrl) {
                return res.status(401).json({ error: 'VK Play не подключен' });
            }

            h.db.all(
                'SELECT * FROM vkplay_reward_roles WHERE channel_url = ? ORDER BY created_at DESC',
                [h.vkplayIntegration.channelUrl],
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

                if (!reward_id || !role_id || !h.vkplayIntegration.channelUrl) {
                    return res.status(400).json({ error: 'Не указаны обязательные параметры' });
                }

                h.db.run(
                    `INSERT OR REPLACE INTO vkplay_reward_roles 
                    (reward_id, reward_name, role_id, role_name, channel_url, enabled, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                    [reward_id, reward_name || '', role_id, role_name || '', h.vkplayIntegration.channelUrl, enabled ? 1 : 0],
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

            h.db.run('DELETE FROM vkplay_reward_roles WHERE id = ?', [id], function(err) {
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

            const channelUrl = h.vkplayIntegration.channelUrl;
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

            h.db.all(query, params, async (err, rows) => {
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
                                h.getUserInfo(row.user_id).then(userInfo => {
                                    if (userInfo && userInfo.nick && userInfo.nick.trim() !== '') {
                                        const retrievedNick = userInfo.nick.trim();
                                        console.log(`🔄 Обновляем ник для userId=${row.user_id}: "${retrievedNick}"`);
                                        
                                        // Обновляем в БД для всех записей с этим userId
                                        return new Promise((resolve) => {
                                            h.db.run(
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
    return { registerRoutes };
}

module.exports = { createVkplayRoutes };
