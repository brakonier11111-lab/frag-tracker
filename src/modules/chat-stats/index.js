'use strict';

/**
 * API истории и статистики чата (chat_messages). Вынесено из server.js —
 * чисто DB-логика, зависит только от db.
 */

function createChatStatsModule(deps) {
    const { db } = deps;

    function registerRoutes(app) {
        app.get('/api/chat/messages', (req, res) => {
            const { platform = 'vkplay', limit = 50 } = req.query;

            db.all(`SELECT * FROM chat_messages
                    WHERE platform = ?
                    ORDER BY created_at DESC
                    LIMIT ?`, [platform, limit], (err, rows) => {
                if (err) {
                    console.error('Ошибка получения чата:', err);
                    return res.status(500).json({ error: 'Ошибка получения чата' });
                }
                res.json({ messages: rows });
            });
        });

        // Статистика активности в чате
        app.get('/api/chat/stats', (req, res) => {
            const { platform = 'all', period = 'all' } = req.query;

            const whereParts = [
                'username IS NOT NULL',
                'username != ""',
                "username != 'Gray_Body'" // исключаем технического/шумового пользователя
            ];
            const params = [];

            if (platform && platform !== 'all') {
                whereParts.push('platform = ?');
                params.push(platform);
            }

            if (period === 'week') {
                whereParts.push('created_at >= datetime("now", "-7 days")');
            } else if (period === 'month') {
                whereParts.push('created_at >= datetime("now", "-30 days")');
            }

            const where = whereParts.join(' AND ');

            // Для общей статистики агрегируем по username без разделения по платформам
            const sql = platform === 'all'
                ? `
                    SELECT
                        'all' AS platform,
                        username,
                        COUNT(*) AS messages_count,
                        MIN(created_at) AS first_message_at,
                        MAX(created_at) AS last_message_at
                    FROM chat_messages
                    WHERE ${where}
                    GROUP BY username
                    ORDER BY messages_count DESC, last_message_at DESC
                `
                : `
                    SELECT
                        platform,
                        username,
                        COUNT(*) AS messages_count,
                        MIN(created_at) AS first_message_at,
                        MAX(created_at) AS last_message_at
                    FROM chat_messages
                    WHERE ${where}
                    GROUP BY username
                    ORDER BY messages_count DESC, last_message_at DESC
                `;

            db.all(sql, params, (err, rows) => {
                if (err) {
                    console.error('Ошибка получения статистики чата:', err);
                    return res.status(500).json({ error: 'Ошибка получения статистики чата' });
                }
                res.json({ stats: rows });
            });
        });
    }

    return { registerRoutes };
}

module.exports = { createChatStatsModule };
