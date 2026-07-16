'use strict';

/**
 * Twitch: онлайн + чат БЕЗ user OAuth (App Access Token, client_credentials) +
 * анонимный IRC-чат — как и раньше. Плюс отдельный user-OAuth flow бродкастера
 * (scope moderator:read:followers) только для EventSub channel.follow —
 * отслеживание новых фолловеров канала в реальном времени через webhook.
 */

const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');
const WebSocket = require('ws');

// Twitch-домены доступны напрямую (проверено), но axios по умолчанию читает
// системные HTTP_PROXY/HTTPS_PROXY и криво их применяет к этим запросам
// ("plain HTTP request was sent to HTTPS port") — принудительно идём напрямую.
const twitchAxiosOpts = { proxy: false };

const EVENTSUB_MESSAGE_TYPE_HEADER = 'twitch-eventsub-message-type';
const EVENTSUB_SIGNATURE_HEADER = 'twitch-eventsub-message-signature';
const EVENTSUB_MESSAGE_ID_HEADER = 'twitch-eventsub-message-id';
const EVENTSUB_TIMESTAMP_HEADER = 'twitch-eventsub-message-timestamp';

function defaultTwitchIntegration() {
    return {
        connected: false,
        channel: null,
        liveTitle: null,
        chatEnabled: false,
        viewers: 0
    };
}

function defaultTwitchUserAuth() {
    return {
        connected: false,
        userId: null,
        userNick: null,
        channel: null,
        tokens: null,
        expires_at: 0,
        followersSubscriptionActive: false
    };
}

function createTwitchIntegrationModule(deps) {
    const { db, saveIntegration, loadIntegration, broadcastToClients, withApiQueue } = deps;

    let twitchIntegration = defaultTwitchIntegration();
    let twitchUserAuth = defaultTwitchUserAuth();

    let appToken = null; // { token, expiresAt } — unix seconds
    let ws = null;
    let reconnectTimeout = null;
    let reconnectDelay = 2000;

    function isConfigured() {
        return !!(process.env.TW_CLIENT_ID && process.env.TW_CLIENT_SECRET && process.env.TW_CHANNEL);
    }

    function isUserOAuthConfigured() {
        return !!(process.env.TW_CLIENT_ID && process.env.TW_CLIENT_SECRET && process.env.TW_EVENTSUB_SECRET && process.env.TW_EVENTSUB_CALLBACK_URL);
    }

    async function getAppAccessToken() {
        const now = Math.floor(Date.now() / 1000);
        if (appToken && now < appToken.expiresAt - 60) {
            return appToken.token;
        }

        const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: process.env.TW_CLIENT_ID,
                client_secret: process.env.TW_CLIENT_SECRET,
                grant_type: 'client_credentials'
            },
            ...twitchAxiosOpts
        });

        appToken = {
            token: res.data.access_token,
            expiresAt: now + (res.data.expires_in || 0)
        };
        return appToken.token;
    }

    async function updateTwitchData() {
        if (!isConfigured()) return;

        try {
            const token = await getAppAccessToken();
            const res = await axios.get('https://api.twitch.tv/helix/streams', {
                params: { user_login: process.env.TW_CHANNEL },
                headers: {
                    'Client-Id': process.env.TW_CLIENT_ID,
                    'Authorization': `Bearer ${token}`
                },
                ...twitchAxiosOpts
            });

            const stream = res.data.data && res.data.data[0];
            twitchIntegration.channel = process.env.TW_CHANNEL;
            if (stream) {
                twitchIntegration.connected = true;
                twitchIntegration.viewers = stream.viewer_count || 0;
                twitchIntegration.liveTitle = stream.title || null;
            } else {
                twitchIntegration.connected = false;
                twitchIntegration.viewers = 0;
                twitchIntegration.liveTitle = null;
            }
        } catch (e) {
            console.warn('⚠️ Twitch Helix API ошибка:', e?.response?.data || e.message);
        }
    }

    function startPolling() {
        if (!isConfigured()) {
            console.log('⚠️ Twitch не настроен (TW_CLIENT_ID/TW_CLIENT_SECRET/TW_CHANNEL) — опрос не запущен');
            return;
        }
        updateTwitchData();
        setInterval(() => withApiQueue('twitch', updateTwitchData), 30000);
    }

    // --- IRC-чат (анонимное чтение) ---

    function parseIrcLine(line) {
        // Формат: [@tags] :prefix COMMAND params :trailing
        let tags = {};
        let rest = line;

        if (rest.startsWith('@')) {
            const spaceIdx = rest.indexOf(' ');
            const tagStr = rest.slice(1, spaceIdx);
            rest = rest.slice(spaceIdx + 1);
            tagStr.split(';').forEach((pair) => {
                const [k, v] = pair.split('=');
                tags[k] = v;
            });
        }

        let prefix = '';
        if (rest.startsWith(':')) {
            const spaceIdx = rest.indexOf(' ');
            prefix = rest.slice(1, spaceIdx);
            rest = rest.slice(spaceIdx + 1);
        }

        const trailingIdx = rest.indexOf(' :');
        let params;
        let trailing = null;
        if (trailingIdx !== -1) {
            params = rest.slice(0, trailingIdx).split(' ');
            trailing = rest.slice(trailingIdx + 2);
        } else {
            params = rest.split(' ');
        }

        const command = params.shift();
        return { tags, prefix, command, params, trailing };
    }

    function handlePrivmsg(parsed) {
        const message = parsed.trailing || '';
        const badges = parsed.tags.badges || '';
        const isModerator = /moderator\//.test(badges) ? 1 : 0;
        const isOwner = /broadcaster\//.test(badges) ? 1 : 0;
        const username = parsed.tags['display-name'] || (parsed.prefix.split('!')[0]) || 'Twitch User';
        const userId = parsed.tags['user-id'] || username;
        const messageId = parsed.tags.id || null;

        const insertParams = [
            'twitch',
            twitchIntegration.channel || process.env.TW_CHANNEL || 'twitch',
            userId,
            username,
            message,
            isModerator,
            isOwner,
            new Date().toISOString()
        ];

        if (messageId) {
            db.run(`INSERT OR IGNORE INTO chat_messages (platform, channel_url, user_id, username, message, is_moderator, is_owner, created_at, message_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...insertParams, messageId], function (err) {
                if (!err && this.changes > 0 && deps.onChatMessage) deps.onChatMessage('twitch:' + userId);
            });
        } else {
            db.run(`INSERT INTO chat_messages (platform, channel_url, user_id, username, message, is_moderator, is_owner, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, insertParams, function (err) {
                if (!err && deps.onChatMessage) deps.onChatMessage('twitch:' + userId);
            });
        }
    }

    function scheduleReconnect() {
        if (reconnectTimeout) return;
        reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null;
            connectTwitchChat();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    }

    function connectTwitchChat() {
        if (!isConfigured()) return;

        const channel = process.env.TW_CHANNEL.toLowerCase();
        const nick = 'justinfan' + Math.floor(10000 + Math.random() * 89999);

        ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

        ws.on('open', () => {
            reconnectDelay = 2000;
            ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
            ws.send(`NICK ${nick}`);
            ws.send(`JOIN #${channel}`);
            twitchIntegration.chatEnabled = true;
            console.log(`✅ Twitch чат подключен (анонимно): #${channel}`);
        });

        ws.on('message', (data) => {
            const lines = data.toString().split('\r\n').filter(Boolean);
            for (const line of lines) {
                if (line.startsWith('PING')) {
                    ws.send('PONG :tmi.twitch.tv');
                    continue;
                }
                const parsed = parseIrcLine(line);
                if (parsed.command === 'PRIVMSG') {
                    handlePrivmsg(parsed);
                }
            }
        });

        ws.on('close', () => {
            twitchIntegration.chatEnabled = false;
            scheduleReconnect();
        });

        ws.on('error', (err) => {
            console.warn('⚠️ Twitch чат: ошибка WebSocket:', err.message);
        });
    }

    // --- User OAuth бродкастера (только для EventSub channel.follow) ---

    function getUserRedirectUri() {
        return (process.env.TW_REDIRECT_URI || '').trim();
    }

    async function refreshUserTokenIfNeeded() {
        if (!twitchUserAuth.tokens?.refresh_token) return;
        const now = Math.floor(Date.now() / 1000);
        if (now < twitchUserAuth.expires_at - 60) return;

        try {
            const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
                params: {
                    client_id: process.env.TW_CLIENT_ID,
                    client_secret: process.env.TW_CLIENT_SECRET,
                    grant_type: 'refresh_token',
                    refresh_token: twitchUserAuth.tokens.refresh_token
                },
                ...twitchAxiosOpts
            });

            twitchUserAuth.tokens = res.data;
            twitchUserAuth.expires_at = now + (res.data.expires_in || 0);
            await saveIntegration('twitch_user', {
                tokens: twitchUserAuth.tokens,
                expires_at: twitchUserAuth.expires_at,
                userId: twitchUserAuth.userId,
                userNick: twitchUserAuth.userNick,
                channel: twitchUserAuth.channel
            });
        } catch (e) {
            console.warn('⚠️ Twitch: не удалось обновить user-токен:', e?.response?.data || e.message);
        }
    }

    async function ensureFollowersEventSubSubscription() {
        if (!isUserOAuthConfigured() || !twitchUserAuth.connected || !twitchUserAuth.userId) return;

        try {
            await refreshUserTokenIfNeeded();
            const appTok = await getAppAccessToken();

            const existing = await axios.get('https://api.twitch.tv/helix/eventsub/subscriptions', {
                params: { type: 'channel.follow', user_id: twitchUserAuth.userId },
                headers: {
                    'Client-Id': process.env.TW_CLIENT_ID,
                    'Authorization': `Bearer ${appTok}`
                },
                ...twitchAxiosOpts
            });

            const active = (existing.data?.data || []).find((sub) =>
                sub.condition?.broadcaster_user_id === twitchUserAuth.userId && sub.status === 'enabled'
            );
            if (active) {
                twitchUserAuth.followersSubscriptionActive = true;
                console.log('✅ Twitch EventSub channel.follow уже активна для канала', twitchUserAuth.channel);
                return;
            }

            const callbackUrl = process.env.TW_EVENTSUB_CALLBACK_URL.replace(/\/$/, '') + '/webhook/twitch/eventsub';
            await axios.post('https://api.twitch.tv/helix/eventsub/subscriptions', {
                type: 'channel.follow',
                version: '2',
                condition: {
                    broadcaster_user_id: twitchUserAuth.userId,
                    moderator_user_id: twitchUserAuth.userId
                },
                transport: {
                    method: 'webhook',
                    callback: callbackUrl,
                    secret: process.env.TW_EVENTSUB_SECRET
                }
            }, {
                headers: {
                    'Client-Id': process.env.TW_CLIENT_ID,
                    'Authorization': `Bearer ${appTok}`,
                    'Content-Type': 'application/json'
                },
                ...twitchAxiosOpts
            });

            twitchUserAuth.followersSubscriptionActive = true;
            console.log('✅ Twitch EventSub channel.follow подписка создана для канала', twitchUserAuth.channel);
        } catch (e) {
            twitchUserAuth.followersSubscriptionActive = false;
            console.warn('⚠️ Twitch EventSub channel.follow: ошибка подписки:', e?.response?.data || e.message);
        }
    }

    async function restoreUserAuthFromDb() {
        try {
            const row = await loadIntegration('twitch_user');
            if (!row || !row.access_token) return;

            twitchUserAuth.connected = true;
            twitchUserAuth.tokens = { access_token: row.access_token, refresh_token: row.refresh_token };
            twitchUserAuth.expires_at = row.expires_at || 0;
            twitchUserAuth.userId = row.user_id || null;
            twitchUserAuth.userNick = row.user_nick || null;
            twitchUserAuth.channel = row.channel_name || null;

            await ensureFollowersEventSubSubscription();
        } catch (e) {
            console.warn('⚠️ Twitch: не удалось восстановить user-авторизацию из БД:', e.message);
        }
    }

    function verifyEventSubSignature(req) {
        const secret = process.env.TW_EVENTSUB_SECRET;
        if (!secret || !req.rawBody) return false;

        const messageId = req.headers[EVENTSUB_MESSAGE_ID_HEADER] || '';
        const timestamp = req.headers[EVENTSUB_TIMESTAMP_HEADER] || '';
        const signature = req.headers[EVENTSUB_SIGNATURE_HEADER] || '';

        const hmacMessage = messageId + timestamp + req.rawBody.toString();
        const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(hmacMessage).digest('hex');

        if (expected.length !== signature.length) return false;
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    }

    function recordEventSubMessageOnce(messageId, callback) {
        db.run('INSERT OR IGNORE INTO twitch_eventsub_events (message_id) VALUES (?)', [messageId], function (err) {
            if (err) {
                console.warn('⚠️ Twitch EventSub: ошибка записи message_id:', err.message);
                callback(false);
                return;
            }
            callback(this.changes > 0);
        });
    }

    function registerRoutes(app) {
        app.get('/integrations/twitch/status', (req, res) => {
            res.json({ ...twitchIntegration, followers: {
                connected: twitchUserAuth.connected,
                channel: twitchUserAuth.channel,
                subscriptionActive: twitchUserAuth.followersSubscriptionActive
            } });
        });

        app.get('/oauth/twitch/start', (req, res) => {
            const clientId = process.env.TW_CLIENT_ID;
            const redirectUri = getUserRedirectUri();
            if (!clientId || !redirectUri) {
                return res.status(500).send('Twitch OAuth is not configured (TW_CLIENT_ID/TW_REDIRECT_URI missing).');
            }

            const state = Math.random().toString(36).slice(2);
            const params = {
                client_id: clientId,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: 'moderator:read:followers',
                state
            };
            const authUrl = `https://id.twitch.tv/oauth2/authorize?${querystring.stringify(params)}`;
            res.redirect(authUrl);
        });

        app.get('/oauth/twitch/callback', async (req, res) => {
            try {
                const { code, error, error_description } = req.query;
                if (error) {
                    return res.status(400).send(`Twitch OAuth error: ${error} ${error_description || ''}`);
                }
                if (!code) return res.status(400).send('Missing code');

                const clientId = process.env.TW_CLIENT_ID;
                const clientSecret = process.env.TW_CLIENT_SECRET;
                const redirectUri = getUserRedirectUri();
                if (!clientId || !clientSecret || !redirectUri) {
                    return res.status(500).send('Twitch OAuth is not configured (client id/secret/redirect missing).');
                }

                const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', null, {
                    params: {
                        client_id: clientId,
                        client_secret: clientSecret,
                        code,
                        grant_type: 'authorization_code',
                        redirect_uri: redirectUri
                    },
                    ...twitchAxiosOpts
                });

                const tokens = tokenRes.data; // access_token, refresh_token, expires_in
                const nowSec = Math.floor(Date.now() / 1000);

                twitchUserAuth.connected = true;
                twitchUserAuth.tokens = tokens;
                twitchUserAuth.expires_at = nowSec + (tokens.expires_in || 0);

                const meRes = await axios.get('https://api.twitch.tv/helix/users', {
                    headers: {
                        'Client-Id': clientId,
                        'Authorization': `Bearer ${tokens.access_token}`
                    },
                    ...twitchAxiosOpts
                });
                const me = meRes.data?.data?.[0];
                if (me) {
                    twitchUserAuth.userId = me.id;
                    twitchUserAuth.userNick = me.login;
                    twitchUserAuth.channel = me.display_name || me.login;
                }

                await saveIntegration('twitch_user', {
                    tokens,
                    expires_at: twitchUserAuth.expires_at,
                    userId: twitchUserAuth.userId,
                    userNick: twitchUserAuth.userNick,
                    channel: twitchUserAuth.channel
                });

                await ensureFollowersEventSubSubscription();

                res.redirect('/stream-integrations.html');
            } catch (err) {
                console.error('Twitch OAuth callback error:', err?.response?.data || err.message);
                res.status(500).send('Twitch OAuth error');
            }
        });

        app.post('/oauth/twitch/logout', (req, res) => {
            twitchUserAuth = defaultTwitchUserAuth();
            res.json({ ok: true });
        });

        app.post('/webhook/twitch/eventsub', (req, res) => {
            if (!verifyEventSubSignature(req)) {
                return res.status(403).send('Invalid signature');
            }

            const messageType = req.headers[EVENTSUB_MESSAGE_TYPE_HEADER];

            if (messageType === 'webhook_callback_verification') {
                return res.status(200).send(req.body.challenge);
            }

            if (messageType === 'revocation') {
                twitchUserAuth.followersSubscriptionActive = false;
                console.warn('⚠️ Twitch EventSub подписка отозвана:', req.body.subscription?.status);
                return res.status(200).send();
            }

            if (messageType === 'notification' && req.body.subscription?.type === 'channel.follow') {
                const messageId = req.headers[EVENTSUB_MESSAGE_ID_HEADER];
                recordEventSubMessageOnce(messageId, (isNew) => {
                    if (isNew) {
                        const event = req.body.event || {};
                        const username = event.user_name || event.user_login || 'Аноним';
                        broadcastToClients({
                            type: 'TWITCH_NEW_FOLLOWER',
                            username,
                            followedAt: event.followed_at || new Date().toISOString()
                        });
                        if (deps.recordSubscriberEvent) {
                            deps.recordSubscriberEvent({ platform: 'twitch', eventType: 'follower', username });
                        }
                    }
                });
                return res.status(200).send();
            }

            res.status(200).send();
        });
    }

    function startFollowersTracking() {
        if (!isUserOAuthConfigured()) {
            console.log('⚠️ Twitch EventSub (фолловеры) не настроен (TW_EVENTSUB_SECRET/TW_EVENTSUB_CALLBACK_URL/TW_REDIRECT_URI missing)');
            return;
        }
        restoreUserAuthFromDb();
    }

    return {
        registerRoutes,
        startPolling,
        connectTwitchChat,
        startFollowersTracking,
        getState: () => twitchIntegration
    };
}

module.exports = { createTwitchIntegrationModule };
