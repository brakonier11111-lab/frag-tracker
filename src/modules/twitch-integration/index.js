'use strict';

/**
 * Twitch: онлайн + чат БЕЗ user OAuth. Онлайн — через App Access Token
 * (client_credentials grant, id.twitch.tv/oauth2/token) для Helix Get Streams.
 * Чат — анонимное чтение IRC по WebSocket (irc-ws.chat.twitch.tv), без токена:
 * стандартный публичный способ читать чат Twitch (ник justinfan<random>).
 * Поэтому здесь нет /oauth/twitch/*, нет saveIntegration/loadIntegration —
 * App Access Token не персистится в БД, просто перезапрашивается при рестарте.
 */

const axios = require('axios');
const WebSocket = require('ws');

// Twitch-домены доступны напрямую (проверено), но axios по умолчанию читает
// системные HTTP_PROXY/HTTPS_PROXY и криво их применяет к этим запросам
// ("plain HTTP request was sent to HTTPS port") — принудительно идём напрямую.
const twitchAxiosOpts = { proxy: false };

function defaultTwitchIntegration() {
    return {
        connected: false,
        channel: null,
        liveTitle: null,
        chatEnabled: false,
        viewers: 0
    };
}

function createTwitchIntegrationModule(deps) {
    const { db, withApiQueue } = deps;

    let twitchIntegration = defaultTwitchIntegration();

    let appToken = null; // { token, expiresAt } — unix seconds
    let ws = null;
    let reconnectTimeout = null;
    let reconnectDelay = 2000;

    function isConfigured() {
        return !!(process.env.TW_CLIENT_ID && process.env.TW_CLIENT_SECRET && process.env.TW_CHANNEL);
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

        db.run(`INSERT INTO chat_messages (platform, channel_url, user_id, username, message, is_moderator, is_owner, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
            'twitch',
            twitchIntegration.channel || process.env.TW_CHANNEL || 'twitch',
            userId,
            username,
            message,
            isModerator,
            isOwner,
            new Date().toISOString()
        ]);
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

    function registerRoutes(app) {
        app.get('/integrations/twitch/status', (req, res) => {
            res.json(twitchIntegration);
        });
    }

    return {
        registerRoutes,
        startPolling,
        connectTwitchChat,
        getState: () => twitchIntegration
    };
}

module.exports = { createTwitchIntegrationModule };
