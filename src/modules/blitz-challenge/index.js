'use strict';

const path = require('path');
const fs = require('fs');
const { BLITZ_DEFAULT_HEADERS } = require('./constants');
const { safeJsonParse, clampNum, round2 } = require('../../core/utils');
const { initBlitzChallengeSchema } = require('./schema');

function createBlitzChallengeModule(deps) {
    // Последние донаты челленджа для фида + суммарный вклад по донатерам
    // (в памяти процесса, сбрасывается при рестарте/reset)
    const FEED_LIMIT = 30;
    let recentFeed = [];
    let donorTotals = {};

    function pushFeedItem(item) {
        recentFeed.unshift(item);
        if (recentFeed.length > FEED_LIMIT) recentFeed.length = FEED_LIMIT;
        const key = item.username || 'Аноним';
        const t = donorTotals[key] || (donorTotals[key] = { username: key, amount: 0, winrate: 0, damage: 0, medals: 0 });
        t.amount += Number(item.amount) || 0;
        const c = item.contribution || {};
        t.winrate += Number(c.winrate) || 0;
        t.damage += Number(c.damage) || 0;
        t.medals += Number(c.medals) || 0;
    }

    function computeTopDonors() {
        return Object.values(donorTotals)
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 5)
            .map(t => ({
                username: t.username,
                amount: round2(t.amount),
                winrate: round2(t.winrate),
                damage: Math.round(t.damage),
                medals: Math.round(t.medals)
            }));
    }

    function resolveBlitzHeaderTexts(row) {
        row = row || {};
        const active = row.active_type || 'winrate';
        const parsed = safeJsonParse(row.header_texts, {});
        const hasJson = parsed && typeof parsed === 'object' && (parsed.winrate || parsed.damage || parsed.medals);
        const texts = {
            winrate: BLITZ_DEFAULT_HEADERS.winrate,
            damage: BLITZ_DEFAULT_HEADERS.damage,
            medals: BLITZ_DEFAULT_HEADERS.medals
        };
        if (hasJson) {
            if (parsed.winrate) texts.winrate = String(parsed.winrate).trim();
            if (parsed.damage) texts.damage = String(parsed.damage).trim();
            if (parsed.medals) texts.medals = String(parsed.medals).trim();
        } else {
            const legacy = String(row.header_text || '').trim();
            // старый единый заголовок — только для winrate, остальные типы по умолчанию
            if (legacy) texts.winrate = legacy;
        }
        return texts;
    }
    
    function normalizeBlitzMedalList(row) {
        const raw = safeJsonParse(row && row.medals_list, []);
        const list = (Array.isArray(raw) ? raw : []).map((m, i) => ({
            id: m.id || ('m' + (i + 1)),
            label: m.label || 'Медаль',
            icon: m.icon || '🏅',
            image: m.image || '',
            required: Math.max(0, Math.round(Number(m.required) || 0)),
            requiredRaw: Number(m.required) || 0,
            earned: Math.max(0, Math.round(Number(m.earned) || 0))
        }));
        return list;
    }
    
    function normalizeBlitzRow(row) {
        row = row || {};
        const medalList = normalizeBlitzMedalList(row);
        const totalRequired = medalList.reduce((s, m) => s + m.required, 0);
        const totalEarned = medalList.reduce((s, m) => s + Math.min(m.earned, m.required || m.earned), 0);
        const activeType = row.active_type || 'winrate';
        const headerTexts = resolveBlitzHeaderTexts(row);
        return {
            id: 1,
            enabled: row.enabled ? 1 : 0,
            activeType,
            headerTexts,
            headerText: headerTexts[activeType] || BLITZ_DEFAULT_HEADERS[activeType] || '',
            consequenceText: row.consequence_text || '',
            sessionBalance: round2(row.session_balance || 0),
            winrate: {
                enabled: row.wr_enabled ? 1 : 0,
                start: Number(row.wr_start) || 0,
                current: round2(row.wr_current || row.wr_start || 0),
                cap: Number(row.wr_cap) || 0,
                perAmount: Number(row.wr_per_amount) || 100,
                step: Number(row.wr_step) || 0
            },
            damage: {
                enabled: row.dmg_enabled ? 1 : 0,
                start: Number(row.dmg_start) || 0,
                current: Math.round(Number(row.dmg_current) || Number(row.dmg_start) || 0),
                cap: Number(row.dmg_cap) || 0,
                perAmount: Number(row.dmg_per_amount) || 100,
                step: Number(row.dmg_step) || 0
            },
            medals: {
                enabled: row.medals_enabled ? 1 : 0,
                perAmount: Number(row.medals_per_amount) || 200,
                step: Number(row.medals_step) || 1,
                capPerMedal: Number(row.medals_cap) || 0,
                list: medalList,
                totalRequired,
                totalEarned
            },
            timers: {
                countdown: {
                    enabled: row.timer_countdown_enabled ? 1 : 0,
                    durationSec: Math.max(0, Math.round(Number(row.timer_countdown_seconds) || 0)),
                    startedAt: Number(row.timer_countdown_started_at) || 0
                },
                elapsed: {
                    enabled: row.timer_elapsed_enabled ? 1 : 0,
                    startedAt: Number(row.timer_elapsed_started_at) || 0
                }
            },
            serverNow: Math.floor(Date.now() / 1000),
            updatedAt: row.updated_at || null
        };
    }
    
    function getBlitzChallengeRow(callback) {
        deps.db.get('SELECT * FROM blitz_challenge WHERE id = 1', (err, row) => {
            callback(err, row);
        });
    }
    
    function broadcastBlitzChallengeUpdate(extra) {
        getBlitzChallengeRow((err, row) => {
            if (err || !row) return;
            const payload = normalizeBlitzRow(row);
            deps.broadcastToClients(Object.assign({ type: 'BLITZ_CHALLENGE_UPDATE', challenge: payload }, extra || {}));
        });
    }
    
    // Поднимаем сложность челленджа при каждом донате
    function updateBlitzChallenge(amount, donation) {
        const amt = parseFloat(amount);
        if (!amt || amt <= 0) return;
        getBlitzChallengeRow((err, row) => {
            if (err || !row || !row.enabled) return;
    
            const contribution = { winrate: 0, damage: 0, medals: 0 };
            const updates = [];
            const values = [];
    
            const newBalance = round2((Number(row.session_balance) || 0) + amt);
            updates.push('session_balance = ?'); values.push(newBalance);
    
            if (row.wr_enabled) {
                const per = Number(row.wr_per_amount) || 100;
                const step = Number(row.wr_step) || 0;
                if (per > 0 && step > 0) {
                    const inc = (amt / per) * step;
                    const cur = Number(row.wr_current) || Number(row.wr_start) || 0;
                    const cap = Number(row.wr_cap);
                    let next = cur + inc;
                    if (isFinite(cap) && cap > 0) next = Math.min(next, cap);
                    next = round2(next);
                    contribution.winrate = round2(next - cur);
                    updates.push('wr_current = ?'); values.push(next);
                }
            }
    
            if (row.dmg_enabled) {
                const per = Number(row.dmg_per_amount) || 100;
                const step = Number(row.dmg_step) || 0;
                if (per > 0 && step > 0) {
                    const inc = (amt / per) * step;
                    const cur = Number(row.dmg_current) || Number(row.dmg_start) || 0;
                    const cap = Number(row.dmg_cap);
                    let next = cur + inc;
                    if (isFinite(cap) && cap > 0) next = Math.min(next, cap);
                    next = Math.round(next);
                    contribution.damage = Math.round(next - cur);
                    updates.push('dmg_current = ?'); values.push(next);
                }
            }
    
            if (row.medals_enabled) {
                const per = Number(row.medals_per_amount) || 200;
                const step = Number(row.medals_step) || 1;
                const list = safeJsonParse(row.medals_list, []);
                if (per > 0 && step > 0 && Array.isArray(list) && list.length) {
                    const inc = (amt / per) * step;
                    const capPer = Number(row.medals_cap) || 0;
                    const totalBefore = list.reduce((s, m) => s + Math.round(Number(m.required) || 0), 0);
                    // повышаем планку у первой ещё не закрытой медали (иначе у последней)
                    let idx = list.findIndex(m => (Number(m.earned) || 0) < Math.round(Number(m.required) || 0));
                    if (idx < 0) idx = list.length - 1;
                    let req = (Number(list[idx].required) || 0) + inc;
                    if (capPer > 0) req = Math.min(req, capPer);
                    list[idx].required = round2(req);
                    const totalAfter = list.reduce((s, m) => s + Math.round(Number(m.required) || 0), 0);
                    contribution.medals = totalAfter - totalBefore;
                    updates.push('medals_list = ?'); values.push(JSON.stringify(list));
                }
            }
    
            updates.push('updated_at = CURRENT_TIMESTAMP');
            deps.db.run(`UPDATE blitz_challenge SET ${updates.join(', ')} WHERE id = 1`, values, (uErr) => {
                if (uErr) {
                    console.error('❌ Ошибка обновления blitz_challenge:', uErr);
                    return;
                }
                const feedItem = {
                    username: donation?.username || donation?.name || 'Аноним',
                    amount: amt,
                    contribution,
                    at: Math.floor(Date.now() / 1000)
                };
                pushFeedItem(feedItem);
                broadcastBlitzChallengeUpdate({ lastDonation: feedItem, topDonors: computeTopDonors() });
            });
        });
    }
    
    // Текущий прогресс боя из сессии Lesta + полученные медали
    function fetchBlitzBattleProgress(callback) {
        deps.getAppState((state) => {
            const current = deps.getLestaCountersFromState(state);
            const startedAt = Number(state && state.lesta_session_started_at) || 0;
            const result = { success: true, hasSession: false, sessionActive: startedAt > 0, sessionStartedAt: startedAt, battlesPlayed: 0, winRate: 0, avgDamage: 0, frags: 0 };
            if (!current) return callback(result);
    
            const hasManualSession = startedAt > 0;
            if (hasManualSession) {
                const baseline = {
                    battles: Number(state.lesta_session_baseline_battles) || 0,
                    wins: Number(state.lesta_session_baseline_wins) || 0,
                    losses: Number(state.lesta_session_baseline_losses) || 0,
                    frags: Number(state.lesta_session_baseline_frags) || 0,
                    damage_dealt: Number(state.lesta_session_baseline_damage) || 0,
                    xp: Number(state.lesta_session_baseline_xp) || 0
                };
                const session = deps.computeLestaPeriodDelta(baseline, current);
                return callback({
                    success: true,
                    hasSession: session.battlesPlayed > 0,
                    sessionActive: true,
                    sessionStartedAt: startedAt,
                    mode: 'manual',
                    battlesPlayed: session.battlesPlayed,
                    winRate: Number(session.winRate) || 0,
                    avgDamage: Number(session.avgDamage) || 0,
                    frags: session.frags || 0
                });
            }
    
            const reliableSince = Number(state.lesta_reliable_since) || 0;
            deps.fetchLestaHistoryWindow('1d', current.battles, reliableSince, (err, windowData) => {
                if (err || !windowData || !windowData.rows.length) return callback(result);
                const session = deps.computeLestaPeriodStatsFromRows(windowData.rows, current.battles);
                callback({
                    success: true,
                    hasSession: session.battlesPlayed > 0,
                    sessionActive: false,
                    sessionStartedAt: 0,
                    mode: 'today',
                    battlesPlayed: session.battlesPlayed,
                    winRate: Number(session.winRate) || 0,
                    avgDamage: Number(session.avgDamage) || 0,
                    frags: session.frags || 0
                });
            });
        });
    }

    function registerRoutes(app) {
        app.get('/api/blitz-challenge', (req, res) => {
            getBlitzChallengeRow((err, row) => {
                if (err) return res.status(500).json({ success: false, error: 'Ошибка сервера' });
                res.json({ success: true, challenge: normalizeBlitzRow(row) });
            });
        });
        
        app.put('/api/blitz-challenge', (req, res) => {
            const b = req.body || {};
            getBlitzChallengeRow((rowErr, existingRow) => {
                if (rowErr) return res.status(500).json({ success: false, error: 'Ошибка сервера' });
        
                const updates = [];
                const values = [];
                const setNum = (col, val, min, max) => {
                    if (val == null || val === '') return;
                    const n = clampNum(val, min, max);
                    if (isFinite(n)) { updates.push(`${col} = ?`); values.push(n); }
                };
                const setBool = (col, val) => {
                    if (val == null) return;
                    updates.push(`${col} = ?`); values.push(val ? 1 : 0);
                };
        
                setBool('enabled', b.enabled);
                const nextActiveType = (b.activeType != null && ['winrate', 'damage', 'medals'].includes(String(b.activeType)))
                    ? String(b.activeType)
                    : (existingRow.active_type || 'winrate');
                if (b.activeType != null && ['winrate', 'damage', 'medals'].includes(String(b.activeType))) {
                    updates.push('active_type = ?'); values.push(String(b.activeType));
                }
        
                if (b.headerTexts && typeof b.headerTexts === 'object') {
                    const ht = {
                        winrate: String(b.headerTexts.winrate != null ? b.headerTexts.winrate : BLITZ_DEFAULT_HEADERS.winrate).slice(0, 200),
                        damage: String(b.headerTexts.damage != null ? b.headerTexts.damage : BLITZ_DEFAULT_HEADERS.damage).slice(0, 200),
                        medals: String(b.headerTexts.medals != null ? b.headerTexts.medals : BLITZ_DEFAULT_HEADERS.medals).slice(0, 200)
                    };
                    updates.push('header_texts = ?'); values.push(JSON.stringify(ht));
                    updates.push('header_text = ?'); values.push('');
                } else if (b.headerText != null) {
                    const texts = resolveBlitzHeaderTexts(existingRow);
                    texts[nextActiveType] = String(b.headerText).slice(0, 200);
                    updates.push('header_texts = ?'); values.push(JSON.stringify(texts));
                    updates.push('header_text = ?'); values.push('');
                }
                if (b.consequenceText != null) { updates.push('consequence_text = ?'); values.push(String(b.consequenceText).slice(0, 400)); }
        
                if (b.winrate) {
                    const w = b.winrate;
                    setBool('wr_enabled', w.enabled);
                    setNum('wr_start', w.start, 0, 100);
                    setNum('wr_cap', w.cap, 0, 100);
                    setNum('wr_per_amount', w.perAmount, 1, null);
                    setNum('wr_step', w.step, 0, null);
                    if (w.start != null) { updates.push('wr_current = ?'); values.push(clampNum(w.start, 0, 100)); }
                }
                if (b.damage) {
                    const d = b.damage;
                    setBool('dmg_enabled', d.enabled);
                    setNum('dmg_start', d.start, 0, null);
                    setNum('dmg_cap', d.cap, 0, null);
                    setNum('dmg_per_amount', d.perAmount, 1, null);
                    setNum('dmg_step', d.step, 0, null);
                    if (d.start != null) { updates.push('dmg_current = ?'); values.push(clampNum(d.start, 0, null)); }
                }
                if (b.medals) {
                    const m = b.medals;
                    setBool('medals_enabled', m.enabled);
                    setNum('medals_cap', m.capPerMedal, 0, null);
                    setNum('medals_per_amount', m.perAmount, 1, null);
                    setNum('medals_step', m.step, 0, null);
                    if (Array.isArray(m.list)) {
                        const clean = m.list.map((x, i) => ({
                            id: x.id || ('m' + (i + 1)),
                            label: (x.label != null ? String(x.label) : 'Медаль').slice(0, 60),
                            icon: (x.icon || '🏅').toString().slice(0, 6),
                            image: (x.image || '').toString().slice(0, 500),
                            required: Math.max(0, clampNum(x.required, 0, null)),
                            earned: Math.max(0, clampNum(x.earned, 0, null))
                        }));
                        updates.push('medals_list = ?'); values.push(JSON.stringify(clean));
                    }
                }

                if (b.timers && typeof b.timers === 'object') {
                    const tc = b.timers.countdown, te = b.timers.elapsed;
                    if (tc && typeof tc === 'object') {
                        setBool('timer_countdown_enabled', tc.enabled);
                        setNum('timer_countdown_seconds', tc.durationSec, 0, 86400 * 7);
                    }
                    if (te && typeof te === 'object') {
                        setBool('timer_elapsed_enabled', te.enabled);
                    }
                }

                if (!updates.length) return res.status(400).json({ success: false, error: 'Нет полей для обновления' });
                updates.push('updated_at = CURRENT_TIMESTAMP');
        
                deps.db.run(`UPDATE blitz_challenge SET ${updates.join(', ')} WHERE id = 1`, values, (err) => {
                    if (err) return res.status(500).json({ success: false, error: 'Ошибка обновления' });
                    getBlitzChallengeRow((e, row) => {
                        const payload = normalizeBlitzRow(row);
                        deps.broadcastToClients({ type: 'BLITZ_CHALLENGE_UPDATE', challenge: payload });
                        res.json({ success: true, challenge: payload });
                    });
                });
            });
        });
        
        // Сброс прогресса (вернуть цели к стартовым), конфиг сохраняется
        app.post('/api/blitz-challenge/reset', (req, res) => {
            getBlitzChallengeRow((err, row) => {
                if (err || !row) return res.status(500).json({ success: false, error: 'Ошибка сервера' });
                // Обнуляем "взято" у медалей, сохраняя их список и требуемое количество
                const list = safeJsonParse(row.medals_list, []).map(m => Object.assign({}, m, { earned: 0 }));
                deps.db.run(`UPDATE blitz_challenge SET wr_current = wr_start, dmg_current = dmg_start, session_balance = 0, medals_list = ?, timer_countdown_started_at = 0, timer_elapsed_started_at = 0, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, [JSON.stringify(list)], (e) => {
                    if (e) return res.status(500).json({ success: false, error: 'Ошибка сброса' });
                    recentFeed = []; donorTotals = {};
                    getBlitzChallengeRow((e2, r2) => {
                        const payload = normalizeBlitzRow(r2);
                        deps.broadcastToClients({ type: 'BLITZ_CHALLENGE_UPDATE', challenge: payload, reset: true });
                        res.json({ success: true, challenge: payload });
                    });
                });
            });
        });
        
        // Ручное добавление "доната" (тест/оффлайн-донат)
        app.post('/api/blitz-challenge/add', (req, res) => {
            const amount = parseFloat(req.body?.amount);
            const username = req.body?.username ? String(req.body.username) : 'Стример';
            if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Некорректная сумма' });
            updateBlitzChallenge(amount, { username });
            setTimeout(() => {
                getBlitzChallengeRow((e, row) => res.json({ success: true, challenge: normalizeBlitzRow(row) }));
            }, 120);
        });
        
        // Прогресс текущего боя/сессии
        app.get('/api/blitz-challenge/progress', (req, res) => {
            fetchBlitzBattleProgress((data) => res.json(data));
        });

        // История донат-фида челленджа + топ донатеров (в памяти процесса)
        app.get('/api/blitz-challenge/feed', (req, res) => {
            res.json({ success: true, feed: recentFeed, top: computeTopDonors() });
        });

        // Управление таймерами: start запускает от текущего момента, reset останавливает и обнуляет
        app.post('/api/blitz-challenge/timer', (req, res) => {
            const timer = String(req.body?.timer || '');
            const action = String(req.body?.action || '');
            const cols = { countdown: 'timer_countdown_started_at', elapsed: 'timer_elapsed_started_at' };
            const targets = timer === 'both' ? ['countdown', 'elapsed'] : (cols[timer] ? [timer] : null);
            if (!targets) return res.status(400).json({ success: false, error: 'Неизвестный таймер' });
            if (action !== 'start' && action !== 'reset') return res.status(400).json({ success: false, error: 'Неизвестное действие' });
            const value = action === 'start' ? Math.floor(Date.now() / 1000) : 0;
            const updates = targets.map(t => `${cols[t]} = ?`);
            const values = targets.map(() => value);
            deps.db.run(`UPDATE blitz_challenge SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, values, (err) => {
                if (err) return res.status(500).json({ success: false, error: 'Ошибка обновления' });
                getBlitzChallengeRow((e, row) => {
                    const payload = normalizeBlitzRow(row);
                    deps.broadcastToClients({ type: 'BLITZ_CHALLENGE_UPDATE', challenge: payload });
                    res.json({ success: true, challenge: payload });
                });
            });
        });
        
        // Ручная отметка полученных медалей (по конкретной медали)
        app.post('/api/blitz-challenge/medal-earned', (req, res) => {
            const medalId = req.body?.id != null ? String(req.body.id) : null;
            const delta = parseInt(req.body?.delta, 10);
            const setTo = req.body?.set != null ? Math.max(0, parseInt(req.body.set, 10)) : null;
            if (!medalId) return res.status(400).json({ success: false, error: 'Не указан id медали' });
            getBlitzChallengeRow((err, row) => {
                if (err || !row) return res.status(500).json({ success: false, error: 'Ошибка сервера' });
                const list = safeJsonParse(row.medals_list, []);
                const m = list.find(x => String(x.id) === medalId);
                if (!m) return res.status(404).json({ success: false, error: 'Медаль не найдена' });
                let val = Number(m.earned) || 0;
                if (setTo != null) val = setTo; else if (!isNaN(delta)) val = Math.max(0, val + delta);
                m.earned = val;
                deps.db.run('UPDATE blitz_challenge SET medals_list = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [JSON.stringify(list)], (e) => {
                    if (e) return res.status(500).json({ success: false, error: 'Ошибка обновления' });
                    getBlitzChallengeRow((e2, r2) => {
                        const payload = normalizeBlitzRow(r2);
                        deps.broadcastToClients({ type: 'BLITZ_CHALLENGE_UPDATE', challenge: payload });
                        res.json({ success: true, challenge: payload });
                    });
                });
            });
        });
        
        // Загрузка PNG-иконки медали (base64) -> возвращает URL
        app.post('/api/blitz-challenge/upload-medal-icon', (req, res) => {
            const { imageData } = req.body || {};
            if (!imageData || !String(imageData).startsWith('data:image/')) {
                return res.status(400).json({ success: false, error: 'Некорректное изображение' });
            }
            const matches = String(imageData).match(/^data:image\/([\w+]+);base64,(.+)$/);
            if (!matches) return res.status(400).json({ success: false, error: 'Неверный формат' });
            const ext = matches[1] === 'svg+xml' ? 'svg' : matches[1];
            const buffer = Buffer.from(matches[2], 'base64');
            const dir = path.join(deps.appRoot, 'public', 'uploads', 'blitz-medals');
            try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
            const filename = `medal_${Date.now()}_${Math.floor(Math.random() * 1e4)}.${ext}`;
            fs.writeFile(path.join(dir, filename), buffer, (err) => {
                if (err) return res.status(500).json({ success: false, error: 'Не удалось сохранить файл' });
                res.json({ success: true, url: `/uploads/blitz-medals/${filename}` });
            });
        });
        
        // Управление сессией (для расчёта средних показателей челленджа) — обёртка над Lesta-сессией
        app.get('/api/blitz-challenge/session', (req, res) => {
            deps.getAppState((state) => {
                const startedAt = Number(state && state.lesta_session_started_at) || 0;
                res.json({ success: true, active: startedAt > 0, startedAt });
            });
        });
        // Логика сессии общая с /api/lesta-session/* — живёт в server.js, здесь только обёртка
        app.post('/api/blitz-challenge/session/start', (req, res) => {
            deps.startLestaSession((err, data) => {
                if (err) return res.status(err.status).json({ success: false, error: err.error });
                res.json({ success: true, startedAt: data.startedAt });
            });
        });
        app.post('/api/blitz-challenge/session/reset', (req, res) => {
            deps.resetLestaSession((err) => {
                if (err) return res.status(err.status).json({ success: false, error: err.error });
                res.json({ success: true });
            });
        });
        
        // Пресеты
        app.get('/api/blitz-challenge/presets', (req, res) => {
            deps.db.all('SELECT * FROM blitz_challenge_presets ORDER BY created_at DESC', (err, rows) => {
                if (err) return res.status(500).json({ success: false, error: 'Ошибка сервера' });
                res.json({ success: true, presets: (rows || []).map(r => ({ id: r.id, name: r.name, config: safeJsonParse(r.config_json, {}), createdAt: r.created_at })) });
            });
        });
        
        app.post('/api/blitz-challenge/presets', (req, res) => {
            const name = (req.body?.name || '').toString().trim() || 'Пресет';
            const config = req.body?.config;
            if (!config) return res.status(400).json({ success: false, error: 'Нет конфигурации' });
            deps.db.run('INSERT INTO blitz_challenge_presets (name, config_json) VALUES (?, ?)', [name, JSON.stringify(config)], function(err) {
                if (err) return res.status(500).json({ success: false, error: 'Ошибка сохранения' });
                res.json({ success: true, id: this.lastID });
            });
        });
        
        app.delete('/api/blitz-challenge/presets/:id', (req, res) => {
            deps.db.run('DELETE FROM blitz_challenge_presets WHERE id = ?', [req.params.id], (err) => {
                if (err) return res.status(500).json({ success: false, error: 'Ошибка удаления' });
                res.json({ success: true });
            });
        });
    }

    function registerPages(app) {
        app.get('/tanks-blitz-challenge', (req, res) => {
            res.sendFile(path.join(deps.appRoot, 'public', 'tanks-blitz-challenge.html'));
        });
    }

    return {
        initSchema: initBlitzChallengeSchema,
        registerRoutes,
        registerPages,
        updateBlitzChallenge,
        fetchBlitzBattleProgress,
        normalizeBlitzRow
    };
}

module.exports = { createBlitzChallengeModule };
