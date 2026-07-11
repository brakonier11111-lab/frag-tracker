'use strict';

const fs = require('fs');
const path = require('path');

/**
 * API истории и статистики чата (chat_messages). Вынесено из server.js —
 * чисто DB-логика, зависит только от db.
 */

const DEFAULT_IGNORED_USERS = ['ChatBot', 'Nightbot', 'Gray_Body'];

function createChatStatsModule(deps) {
    const { db } = deps;

    // Игнор-лист ников для статистики чата (боты и технические аккаунты).
    // Сиды вставляются один раз; удалённые пользователем ники повторно не добавляем.
    db.run(`CREATE TABLE IF NOT EXISTS chat_ignored_users (
        username TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) return console.error('Ошибка создания chat_ignored_users:', err);
        db.run(`CREATE TABLE IF NOT EXISTS chat_stats_meta (key TEXT PRIMARY KEY, value TEXT)`, (mErr) => {
            if (mErr) return console.error('Ошибка создания chat_stats_meta:', mErr);
            db.get(`SELECT value FROM chat_stats_meta WHERE key = 'ignored_seeded'`, (sErr, row) => {
                if (sErr || row) return;
                DEFAULT_IGNORED_USERS.forEach((name) => {
                    db.run(`INSERT OR IGNORE INTO chat_ignored_users (username) VALUES (?)`, [name]);
                });
                db.run(`INSERT OR REPLACE INTO chat_stats_meta (key, value) VALUES ('ignored_seeded', '1')`);
            });
        });
    });

    function registerRoutes(app) {
        // CRUD игнор-листа статистики чата
        app.get('/api/chat/ignored-users', (req, res) => {
            db.all(`SELECT username, created_at FROM chat_ignored_users ORDER BY username COLLATE NOCASE`, (err, rows) => {
                if (err) return res.status(500).json({ error: 'Ошибка чтения игнор-листа' });
                res.json({ users: rows || [] });
            });
        });

        app.post('/api/chat/ignored-users', (req, res) => {
            const username = String(req.body && req.body.username || '').trim();
            if (!username) return res.status(400).json({ error: 'Укажите ник' });
            db.run(`INSERT OR IGNORE INTO chat_ignored_users (username) VALUES (?)`, [username], function(err) {
                if (err) return res.status(500).json({ error: 'Ошибка добавления в игнор-лист' });
                res.json({ success: true, added: this.changes > 0, username });
            });
        });

        app.delete('/api/chat/ignored-users/:username', (req, res) => {
            const username = String(req.params.username || '').trim();
            db.run(`DELETE FROM chat_ignored_users WHERE username = ? COLLATE NOCASE`, [username], function(err) {
                if (err) return res.status(500).json({ error: 'Ошибка удаления из игнор-листа' });
                res.json({ success: true, removed: this.changes > 0 });
            });
        });

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
                // игнор-лист (боты и технические аккаунты), управляется через /api/chat/ignored-users
                'LOWER(username) NOT IN (SELECT LOWER(username) FROM chat_ignored_users)'
            ];
            const params = [];

            if (platform && platform !== 'all') {
                whereParts.push('platform = ?');
                params.push(platform);
            }

            if (period === 'day') {
                whereParts.push('created_at >= datetime("now", "-1 day")');
            } else if (period === 'week') {
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

        // Полный сброс статистики чата: потоковый бэкап всех строк (NDJSON) на диск, затем
        // очистка таблицы. Стримим построчно вместо db.all + JSON.stringify — при миллионах
        // сообщений один большой массив/строка либо съедает всю память, либо падает с
        // "Invalid string length"; если бэкап не удался, сброс отменяется.
        app.post('/api/chat/stats/reset', (req, res) => {
            const dir = path.join(deps.userData, 'backups');
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            } catch (e) {
                console.error('❌ Не удалось подготовить папку бэкапа:', e.message);
                return res.status(500).json({ error: 'Не удалось подготовить папку для бэкапа' });
            }
            const file = path.join(dir, `chat_messages_backup_${Date.now()}.ndjson`);
            const stream = fs.createWriteStream(file, { encoding: 'utf8' });
            let streamErrored = false;
            stream.on('error', (e) => {
                streamErrored = true;
                console.error('❌ Ошибка записи бэкапа chat_messages:', e.message);
            });
            let count = 0;
            db.each('SELECT * FROM chat_messages', (rowErr, row) => {
                if (rowErr || streamErrored) return;
                count++;
                stream.write(JSON.stringify(row) + '\n');
            }, (err) => {
                stream.end(() => {
                    if (err) {
                        console.error('Ошибка чтения chat_messages перед сбросом:', err);
                        return res.status(500).json({ error: 'Ошибка сервера' });
                    }
                    if (streamErrored) {
                        return res.status(500).json({ error: 'Не удалось создать бэкап, сброс отменён' });
                    }
                    db.run('DELETE FROM chat_messages', (delErr) => {
                        if (delErr) {
                            console.error('Ошибка очистки chat_messages:', delErr);
                            return res.status(500).json({ error: 'Ошибка сброса статистики' });
                        }
                        console.log(`🧹 Статистика чата обнулена (${count} строк, бэкап: ${file})`);
                        res.json({ success: true, deleted: count });
                    });
                });
            });
        });
    }

    return { registerRoutes };
}

module.exports = { createChatStatsModule };
