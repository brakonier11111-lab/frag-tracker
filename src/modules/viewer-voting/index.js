'use strict';

const fs = require('fs');
const path = require('path');

const POLL_INTERVAL_MS = 3000;
const ALLOWED_PLATFORMS = ['vkplay', 'twitch', 'youtube'];

/**
 * Голосования зрителей по ключевым словам в чате. Опрос новых chat_messages
 * (та же таблица, что и chat-stats/чат-интеграции) вместо хука в каждую
 * интеграцию — не трогает vkplay/twitch/youtube-integration, курсор
 * (last_chat_message_id) свой на каждый опрос, поэтому несколько голосований
 * могут идти параллельно с разными наборами ключевых слов.
 */
function createViewerVotingModule(deps) {
    const { db, appRoot, broadcastToClients } = deps;

    function dbRun(sql, params) {
        return new Promise((resolve, reject) => {
            db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
        });
    }
    function dbGet(sql, params) {
        return new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
        });
    }
    function dbAll(sql, params) {
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
        });
    }

    // Ключевое слово ищется как ОТДЕЛЬНЫЙ токен сообщения, не как голая
    // подстрока — иначе "1" матчился бы внутри "12" или "танк1". \b в JS не
    // годится: \w не включает кириллицу, поэтому токенизация вручную по
    // Unicode-классам букв/цифр.
    function tokenize(message) {
        return String(message || '')
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter(Boolean);
    }

    async function loadPollWithOptions(pollId) {
        const poll = await dbGet(`SELECT * FROM voting_polls WHERE id = ?`, [pollId]);
        if (!poll) return null;
        const options = await dbAll(`SELECT * FROM voting_options WHERE poll_id = ? ORDER BY sort_order ASC, id ASC`, [pollId]);
        return pollToState(poll, options);
    }

    function pollToState(poll, options) {
        const totalVotes = options.reduce((sum, o) => sum + (o.votes_count || 0), 0);
        const maxVotes = Math.max(0, ...options.map((o) => o.votes_count || 0));
        return {
            id: poll.id,
            title: poll.title,
            status: poll.status,
            platforms: (poll.platforms || '').split(',').filter(Boolean),
            createdAt: poll.created_at,
            activatedAt: poll.activated_at,
            closedAt: poll.closed_at,
            totalVotes,
            // Порядок — стабильный (sort_order из запроса), НЕ по количеству голосов:
            // общая шкала на виджете держит сегменты на фиксированных местах и просто
            // меняет их ширину, а не переставляет местами при каждом новом голосе.
            options: options.map((o) => ({
                id: o.id,
                label: o.label,
                keyword: o.keyword,
                imageUrl: o.image_url,
                votes: o.votes_count || 0,
                pct: totalVotes > 0 ? Math.round((o.votes_count / totalVotes) * 1000) / 10 : 0,
                isLeader: totalVotes > 0 && (o.votes_count || 0) === maxVotes
            }))
        };
    }

    async function broadcastPoll(pollId) {
        const state = await loadPollWithOptions(pollId);
        if (state) broadcastToClients({ type: 'VOTING_UPDATE', poll: state });
    }

    // Обрабатывает один активный опрос: новые сообщения чата с id > курсора,
    // первое совпавшее по порядку sort_order ключевое слово в сообщении — голос.
    // UNIQUE(poll_id, platform, user_id) в voting_votes — источник истины для
    // "уже проголосовал", гонки между несколькими тиками исключены на уровне БД.
    async function pollOnce(pollRow) {
        const options = await dbAll(`SELECT * FROM voting_options WHERE poll_id = ? ORDER BY sort_order ASC, id ASC`, [pollRow.id]);
        if (!options.length) return;

        const platforms = (pollRow.platforms || '').split(',').filter(Boolean);
        if (!platforms.length) return;
        const placeholders = platforms.map(() => '?').join(',');

        const messages = await dbAll(
            `SELECT id, platform, user_id, username, message FROM chat_messages
             WHERE id > ? AND platform IN (${placeholders}) AND user_id IS NOT NULL
             ORDER BY id ASC LIMIT 500`,
            [pollRow.last_chat_message_id, ...platforms]
        );
        if (!messages.length) return;

        let maxId = pollRow.last_chat_message_id;
        let changed = false;

        for (const msg of messages) {
            maxId = Math.max(maxId, msg.id);
            const tokens = tokenize(msg.message);
            if (!tokens.length) continue;

            const matched = options.find((o) => tokens.includes(String(o.keyword || '').toLowerCase().trim()));
            if (!matched) continue;

            try {
                const result = await dbRun(
                    `INSERT OR IGNORE INTO voting_votes (poll_id, option_id, platform, user_id, username) VALUES (?, ?, ?, ?, ?)`,
                    [pollRow.id, matched.id, msg.platform, String(msg.user_id), msg.username || '']
                );
                if (result.changes > 0) {
                    await dbRun(`UPDATE voting_options SET votes_count = votes_count + 1 WHERE id = ?`, [matched.id]);
                    changed = true;
                }
            } catch (e) {
                console.warn('⚠️ viewer-voting: ошибка записи голоса:', e.message);
            }
        }

        await dbRun(`UPDATE voting_polls SET last_chat_message_id = ? WHERE id = ?`, [maxId, pollRow.id]);
        if (changed) await broadcastPoll(pollRow.id);
    }

    let pollTimer = null;
    async function tick() {
        const activePolls = await dbAll(`SELECT * FROM voting_polls WHERE status = 'active'`);
        for (const poll of activePolls) {
            try { await pollOnce(poll); } catch (e) { console.warn('⚠️ viewer-voting tick:', e.message); }
        }
    }
    function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(() => { tick().catch(() => {}); }, POLL_INTERVAL_MS);
    }

    function registerRoutes(app) {
        app.get('/api/voting/polls', async (req, res) => {
            try {
                const rows = await dbAll(`SELECT id FROM voting_polls ORDER BY created_at DESC`);
                const polls = [];
                for (const r of rows) polls.push(await loadPollWithOptions(r.id));
                res.json({ success: true, polls });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.get('/api/voting/polls/:id', async (req, res) => {
            try {
                const poll = await loadPollWithOptions(req.params.id);
                if (!poll) return res.status(404).json({ success: false, error: 'Опрос не найден' });
                res.json({ success: true, poll });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.post('/api/voting/polls', async (req, res) => {
            try {
                const { title, options, platforms } = req.body || {};
                const opts = Array.isArray(options) ? options : [];
                if (!opts.length) return res.status(400).json({ success: false, error: 'Нужен хотя бы один вариант' });

                const cleanOpts = opts.map((o) => ({
                    label: String(o.label || '').trim().slice(0, 200),
                    keyword: String(o.keyword || '').trim().toLowerCase().slice(0, 100),
                    imageUrl: String(o.imageUrl || '').trim().slice(0, 500)
                }));
                if (cleanOpts.some((o) => !o.label || !o.keyword)) {
                    return res.status(400).json({ success: false, error: 'У каждого варианта должны быть название и ключевое слово' });
                }
                // Ключевое слово матчится токенайзером как ЦЕЛОЕ слово в сообщении чата
                // (см. tokenize/pollOnce) — с пробелом внутри оно никогда ни с чем не
                // совпадёт, голос за такой вариант физически невозможен.
                if (cleanOpts.some((o) => /\s/.test(o.keyword))) {
                    return res.status(400).json({ success: false, error: 'Ключевое слово должно быть одним словом, без пробелов' });
                }
                const seenKeywords = new Set();
                for (const o of cleanOpts) {
                    if (seenKeywords.has(o.keyword)) {
                        return res.status(400).json({ success: false, error: `Ключевое слово "${o.keyword}" повторяется` });
                    }
                    seenKeywords.add(o.keyword);
                }

                const platformList = Array.isArray(platforms) && platforms.length
                    ? platforms.filter((p) => ALLOWED_PLATFORMS.includes(p))
                    : ALLOWED_PLATFORMS.slice();

                // Курсор старта — текущий максимальный id чата, чтобы новый опрос не
                // засчитывал историческую переписку до его создания.
                const lastMsg = await dbGet(`SELECT MAX(id) AS maxId FROM chat_messages`);
                const startCursor = (lastMsg && lastMsg.maxId) || 0;

                const result = await dbRun(
                    `INSERT INTO voting_polls (title, status, platforms, last_chat_message_id) VALUES (?, 'draft', ?, ?)`,
                    [String(title || '').trim().slice(0, 200) || 'Голосование', platformList.join(','), startCursor]
                );
                const pollId = result.lastID;
                for (let i = 0; i < cleanOpts.length; i++) {
                    const o = cleanOpts[i];
                    await dbRun(
                        `INSERT INTO voting_options (poll_id, label, keyword, image_url, sort_order) VALUES (?, ?, ?, ?, ?)`,
                        [pollId, o.label, o.keyword, o.imageUrl, i]
                    );
                }
                const poll = await loadPollWithOptions(pollId);
                res.json({ success: true, poll });
            } catch (e) {
                console.error('❌ viewer-voting create:', e.message);
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.post('/api/voting/polls/:id/activate', async (req, res) => {
            try {
                const row = await dbGet(`SELECT * FROM voting_polls WHERE id = ?`, [req.params.id]);
                if (!row) return res.status(404).json({ success: false, error: 'Опрос не найден' });
                await dbRun(`UPDATE voting_polls SET status = 'active', activated_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);
                await broadcastPoll(row.id);
                res.json({ success: true, poll: await loadPollWithOptions(row.id) });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.post('/api/voting/polls/:id/close', async (req, res) => {
            try {
                const row = await dbGet(`SELECT * FROM voting_polls WHERE id = ?`, [req.params.id]);
                if (!row) return res.status(404).json({ success: false, error: 'Опрос не найден' });
                await dbRun(`UPDATE voting_polls SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);
                const poll = await loadPollWithOptions(row.id);
                broadcastToClients({ type: 'VOTING_CLOSED', poll });
                res.json({ success: true, poll });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.post('/api/voting/polls/:id/reset', async (req, res) => {
            try {
                const row = await dbGet(`SELECT * FROM voting_polls WHERE id = ?`, [req.params.id]);
                if (!row) return res.status(404).json({ success: false, error: 'Опрос не найден' });
                await dbRun(`DELETE FROM voting_votes WHERE poll_id = ?`, [row.id]);
                await dbRun(`UPDATE voting_options SET votes_count = 0 WHERE poll_id = ?`, [row.id]);
                const lastMsg = await dbGet(`SELECT MAX(id) AS maxId FROM chat_messages`);
                await dbRun(`UPDATE voting_polls SET last_chat_message_id = ? WHERE id = ?`, [(lastMsg && lastMsg.maxId) || 0, row.id]);
                const poll = await loadPollWithOptions(row.id);
                await broadcastPoll(row.id);
                res.json({ success: true, poll });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.delete('/api/voting/polls/:id', async (req, res) => {
            try {
                await dbRun(`DELETE FROM voting_votes WHERE poll_id = ?`, [req.params.id]);
                await dbRun(`DELETE FROM voting_options WHERE poll_id = ?`, [req.params.id]);
                await dbRun(`DELETE FROM voting_polls WHERE id = ?`, [req.params.id]);
                broadcastToClients({ type: 'VOTING_DELETED', pollId: Number(req.params.id) });
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        // Загрузка картинки варианта (base64) -> URL, как /api/blitz-challenge/upload-medal-icon
        app.post('/api/voting/upload-image', (req, res) => {
            const { imageData } = req.body || {};
            if (!imageData || !String(imageData).startsWith('data:image/')) {
                return res.status(400).json({ success: false, error: 'Некорректное изображение' });
            }
            const matches = String(imageData).match(/^data:image\/([\w+]+);base64,(.+)$/);
            if (!matches) return res.status(400).json({ success: false, error: 'Неверный формат' });
            const ext = matches[1] === 'svg+xml' ? 'svg' : matches[1];
            const buffer = Buffer.from(matches[2], 'base64');
            const dir = path.join(appRoot, 'public', 'uploads', 'voting');
            try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
            const filename = `option_${Date.now()}_${Math.floor(Math.random() * 1e4)}.${ext}`;
            fs.writeFile(path.join(dir, filename), buffer, (err) => {
                if (err) return res.status(500).json({ success: false, error: 'Не удалось сохранить файл' });
                res.json({ success: true, url: `/uploads/voting/${filename}` });
            });
        });
    }

    function registerPages(app) {
        app.get('/voting-admin', (req, res) => {
            res.sendFile(path.join(appRoot, 'public', 'voting-admin.html'));
        });
        app.get('/widget-voting.html', (req, res) => {
            res.sendFile(path.join(appRoot, 'public', 'widget-voting.html'));
        });
    }

    startPolling();

    return { registerRoutes, registerPages };
}

module.exports = { createViewerVotingModule };
