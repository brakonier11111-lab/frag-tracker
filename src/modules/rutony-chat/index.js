'use strict';

/**
 * Rutony Chat (локальный чат-оверлей) через WebSocket ws://localhost:8383.
 * Полностью изолирован от YouTube/VKPlay интеграций — свой WebSocket,
 * своё состояние подключения, единственная точка пересечения с остальным
 * сервером — таблица chat_messages.
 */

const WebSocket = require('ws');

function createRutonyChatModule(deps) {
    const { db } = deps;

    let rutonyIntegration = {
        connected: false,
        lastError: null
    };
    let rutonyWs = null;
    let rutonyRetryTimeout = null;

    function startRutonyChat() {
        try {
            if (rutonyWs) {
                try { rutonyWs.close(); } catch(_) {}
                rutonyWs = null;
            }
            const tryUrls = ['ws://localhost:8383', 'ws://127.0.0.1:8383', 'ws://localhost:8383/Chat'];
            let idx = 0;

            const connectNext = () => {
                const url = tryUrls[idx++ % tryUrls.length];
                const wsClient = new WebSocket(url);
                let opened = false;

                wsClient.on('open', () => {
                    opened = true;
                    rutonyWs = wsClient;
                    rutonyIntegration.connected = true;
                    rutonyIntegration.lastError = null;
                    console.log(`✅ Подключено к Rutony Chat: ${url}`);
                });

                wsClient.on('message', (buf) => {
                    try {
                        const text = buf.toString();
                        let data = null;
                        try { data = JSON.parse(text); } catch (_) { return; }

                        // Поддержка нескольких форматов
                        const type = data.type || data.Type || '';
                        const username = data.username || data.Username || data.user || 'User';
                        const messageText = data.text || data.Text || data.message || data.Message || '';
                        const isModerator = !!(data.is_moderator || data.IsModerator);
                        const isOwner = !!(data.is_owner || data.IsOwner);
                        const createdIso = (data.timestamp || data.Timestamp)
                            ? new Date(data.timestamp || data.Timestamp).toISOString()
                            : new Date().toISOString();

                        if (!messageText) return;

                        // Дедупликация за последние 5 минут
                        db.get('SELECT id FROM chat_messages WHERE platform = ? AND username = ? AND message = ? AND created_at > datetime("now", "-5 minutes")',
                            ['rutony', username, messageText], (err, row) => {
                            if (!err && !row) {
                                db.run(`INSERT INTO chat_messages (platform, channel_url, user_id, username, message, is_moderator, is_owner, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                                    'rutony',
                                    'rutony://local',
                                    username,
                                    username,
                                    messageText,
                                    isModerator ? 1 : 0,
                                    isOwner ? 1 : 0,
                                    createdIso
                                ]);
                            }
                        });
                    } catch (e) {
                        console.warn('⚠️ Ошибка обработки сообщения Rutony:', e.message);
                    }
                });

                wsClient.on('close', () => {
                    rutonyIntegration.connected = false;
                    if (rutonyRetryTimeout) clearTimeout(rutonyRetryTimeout);
                    rutonyRetryTimeout = setTimeout(connectNext, 2000);
                });

                wsClient.on('error', (err) => {
                    rutonyIntegration.connected = false;
                    rutonyIntegration.lastError = err?.message || String(err);
                    try { wsClient.close(); } catch(_) {}
                    if (rutonyRetryTimeout) clearTimeout(rutonyRetryTimeout);
                    rutonyRetryTimeout = setTimeout(connectNext, 1500);
                });
            };

            connectNext();
        } catch (e) {
            rutonyIntegration.connected = false;
            rutonyIntegration.lastError = e?.message || String(e);
            if (rutonyRetryTimeout) clearTimeout(rutonyRetryTimeout);
            rutonyRetryTimeout = setTimeout(startRutonyChat, 3000);
        }
    }

    function registerRoutes(app) {
        app.get('/integrations/rutony/status', (req, res) => {
            res.json({ connected: rutonyIntegration.connected, lastError: rutonyIntegration.lastError });
        });
    }

    return { registerRoutes, startRutonyChat };
}

module.exports = { createRutonyChatModule };
