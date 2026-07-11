'use strict';

const path = require('path');
const axios = require('axios');

// Очки: урон 1:1, фраг 500, выживание в бою 300
// (ассист-урон убран — Lesta API для Tanks Blitz его не отдаёт ни на уровне
// танка, ни на уровне аккаунта, проверено напрямую)
const POINTS_PER_DAMAGE = 1;
const POINTS_PER_FRAG = 500;
const POINTS_PER_SURVIVED = 300;
const POLL_INTERVAL_MS = 20000;
const BATTLE_TANK_FIELDS = 'tank_id,all';
const FEED_LIMIT = 50;

function createBattleTrackerModule(deps) {
    const { db, getAppState, lestaConfig, broadcastToClients, appRoot } = deps;

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

    function getMyAccountId() {
        return new Promise((resolve, reject) => {
            getAppState((state) => {
                const id = state?.lesta_account_id || lestaConfig.accountId;
                if (!id) return reject(new Error('Мой аккаунт Lesta не привязан (нужна авторизация на /lesta-stats)'));
                resolve(String(id));
            });
        });
    }

    function getMyNickname() {
        return new Promise((resolve) => {
            getAppState((state) => resolve(state?.lesta_nickname || lestaConfig.nickname || 'Стример'));
        });
    }

    // Лёгкая версия fetchAccountTanksForAccount (src/core/lesta-history.js) без
    // обогащения названиями танков — тут нужны только цифры для очков, не имена.
    // access_token моего OAuth не имеет смысла и не нужен для чужого публичного
    // account_id — передаём его только когда запрашиваем СВОЮ статистику (isSelf).
    async function requestTankStats(accountId, withToken) {
        const params = {
            application_id: lestaConfig.applicationId,
            account_id: accountId,
            fields: BATTLE_TANK_FIELDS
        };
        if (withToken && lestaConfig.accessToken) params.access_token = lestaConfig.accessToken;

        return axios.get(`${lestaConfig.apiUrl}/tanks/stats/`, {
            params,
            timeout: 30000,
            validateStatus: (status) => status < 500
        });
    }

    async function fetchRawTankTotals(accountId, isSelf) {
        let response = await requestTankStats(accountId, isSelf);

        // Просроченный/невалидный токен не должен блокировать баттл — статистика
        // по умолчанию публичная, повторяем запрос без токена вместо жёсткого отказа.
        if (isSelf && response.data?.status === 'error' && response.data.error?.code === 407) {
            response = await requestTankStats(accountId, false);
        }

        if (response.data?.status === 'error') {
            throw new Error(response.data.error?.message || 'Lesta API error');
        }

        const raw = response.data?.data?.[String(accountId)];
        const map = {};
        if (Array.isArray(raw)) {
            raw.forEach((item) => {
                const stats = item.all || {};
                if (item.tank_id == null) return;
                map[String(item.tank_id)] = {
                    battles: Number(stats.battles) || 0,
                    frags: Number(stats.frags) || 0,
                    damage_dealt: Number(stats.damage_dealt) || 0,
                    survived_battles: Number(stats.survived_battles) || 0
                };
            });
        }
        return map;
    }

    // Суммирует дельту (baseline -> current) по всем танкам аккаунта и считает очки.
    // Math.max(0, ...) на каждом танке — игнорирует одиночные откаты/сбои API, не
    // валит всю сессию из-за одного танка.
    function computeTotals(baselineMap, currentMap) {
        let battles = 0, frags = 0, damage = 0, survived = 0;
        const ids = new Set([...Object.keys(currentMap || {}), ...Object.keys(baselineMap || {})]);
        ids.forEach((id) => {
            const cur = currentMap[id] || {};
            const base = baselineMap[id] || {};
            const b = Math.max(0, (cur.battles || 0) - (base.battles || 0));
            if (b <= 0) return;
            battles += b;
            frags += Math.max(0, (cur.frags || 0) - (base.frags || 0));
            damage += Math.max(0, (cur.damage_dealt || 0) - (base.damage_dealt || 0));
            survived += Math.max(0, (cur.survived_battles || 0) - (base.survived_battles || 0));
        });
        const score = damage * POINTS_PER_DAMAGE + frags * POINTS_PER_FRAG + survived * POINTS_PER_SURVIVED;
        return {
            battles, frags, damage, survived,
            avgDamage: battles > 0 ? Math.round(damage / battles) : 0,
            avgFrags: battles > 0 ? Number((frags / battles).toFixed(2)) : 0,
            survivalRate: battles > 0 ? Number(((survived / battles) * 100).toFixed(1)) : 0,
            score: Math.round(score)
        };
    }

    function safeParse(json, fallback) {
        try {
            const parsed = JSON.parse(json || '');
            return parsed && typeof parsed === 'object' ? parsed : fallback;
        } catch {
            return fallback;
        }
    }

    function rowToState(row) {
        if (!row) return { active: false };
        const myTotals = safeParse(row.my_totals_json, {});
        const opponentTotals = safeParse(row.opponent_totals_json, {});
        const totalScore = (row.my_score || 0) + (row.opponent_score || 0);
        let myPct = 50;
        if (totalScore > 0) {
            myPct = Math.min(92, Math.max(8, (row.my_score / totalScore) * 100));
        }
        return {
            id: row.id,
            active: row.status === 'active',
            status: row.status,
            myNickname: row.my_nickname,
            opponentNickname: row.opponent_nickname,
            opponentAccountId: row.opponent_account_id,
            price: row.price,
            startedAt: row.started_at,
            endedAt: row.ended_at,
            winner: row.winner,
            myTotals,
            opponentTotals,
            myScore: row.my_score || 0,
            opponentScore: row.opponent_score || 0,
            myPct,
            opponentPct: 100 - myPct,
            lastEventSide: row.last_event_side || null,
            lastEventAt: row.last_event_at || null
        };
    }

    let pollTimer = null;

    async function pollTick() {
        const row = await dbGet(`SELECT * FROM battle_sessions WHERE status = 'active' LIMIT 1`);
        if (!row) return;

        try {
            const myAccountId = await getMyAccountId();
            const [myMap, oppMap] = await Promise.all([
                fetchRawTankTotals(myAccountId, true),
                fetchRawTankTotals(row.opponent_account_id)
            ]);
            const myBaseline = safeParse(row.my_baseline_json, {});
            const oppBaseline = safeParse(row.opponent_baseline_json, {});
            const myTotals = computeTotals(myBaseline, myMap);
            const oppTotals = computeTotals(oppBaseline, oppMap);

            const prevMyTotals = safeParse(row.my_totals_json, {});
            const prevOppTotals = safeParse(row.opponent_totals_json, {});

            let eventSide = null;
            if ((myTotals.battles || 0) > (prevMyTotals.battles || 0)) eventSide = 'me';
            else if ((oppTotals.battles || 0) > (prevOppTotals.battles || 0)) eventSide = 'opponent';

            const updates = {
                my_totals_json: JSON.stringify(myTotals),
                opponent_totals_json: JSON.stringify(oppTotals),
                my_score: myTotals.score,
                opponent_score: oppTotals.score
            };
            if (eventSide) {
                updates.last_event_side = eventSide;
                updates.last_event_at = new Date().toISOString();
            }
            const setSql = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
            await dbRun(`UPDATE battle_sessions SET ${setSql} WHERE id = ?`, [...Object.values(updates), row.id]);

            const updatedRow = await dbGet(`SELECT * FROM battle_sessions WHERE id = ?`, [row.id]);
            broadcastToClients({ type: 'BATTLE_UPDATE', battle: rowToState(updatedRow), justPlayed: eventSide });
        } catch (e) {
            console.warn('⚠️ Battle-tracker: ошибка опроса Lesta API:', e.message);
        }
    }

    function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(() => { pollTick().catch(() => {}); }, POLL_INTERVAL_MS);
    }

    function registerRoutes(app) {
        app.post('/api/battle/start', async (req, res) => {
            try {
                const { opponentNickname, opponentAccountId, price } = req.body || {};
                if (!opponentNickname || !opponentAccountId) {
                    return res.status(400).json({ success: false, error: 'Не указан никнейм или account_id зрителя' });
                }

                const existing = await dbGet(`SELECT id FROM battle_sessions WHERE status = 'active' LIMIT 1`);
                if (existing) {
                    return res.status(409).json({ success: false, error: 'Баттл уже идёт — сначала завершите или отмените текущий' });
                }

                const myAccountId = await getMyAccountId();
                const myNickname = await getMyNickname();

                const [myBaseline, opponentBaseline] = await Promise.all([
                    fetchRawTankTotals(myAccountId, true),
                    fetchRawTankTotals(String(opponentAccountId))
                ]);

                const result = await dbRun(
                    `INSERT INTO battle_sessions
                        (status, my_nickname, opponent_nickname, opponent_account_id, price,
                         my_baseline_json, opponent_baseline_json, my_totals_json, opponent_totals_json)
                     VALUES ('active', ?, ?, ?, ?, ?, ?, '{}', '{}')`,
                    [myNickname, opponentNickname, String(opponentAccountId), price || '',
                        JSON.stringify(myBaseline), JSON.stringify(opponentBaseline)]
                );

                const row = await dbGet(`SELECT * FROM battle_sessions WHERE id = ?`, [result.lastID]);
                const state = rowToState(row);
                broadcastToClients({ type: 'BATTLE_UPDATE', battle: state, justPlayed: null });
                res.json({ success: true, battle: state });
            } catch (e) {
                console.error('❌ Battle-tracker /start:', e.message);
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.get('/api/battle/state', async (req, res) => {
            try {
                const row = await dbGet(`SELECT * FROM battle_sessions WHERE status = 'active' LIMIT 1`);
                res.json({ success: true, battle: rowToState(row) });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.post('/api/battle/end', async (req, res) => {
            try {
                const { winner } = req.body || {};
                if (winner !== 'me' && winner !== 'opponent') {
                    return res.status(400).json({ success: false, error: 'winner должен быть "me" или "opponent"' });
                }
                const row = await dbGet(`SELECT * FROM battle_sessions WHERE status = 'active' LIMIT 1`);
                if (!row) return res.status(404).json({ success: false, error: 'Нет активного баттла' });

                await dbRun(
                    `UPDATE battle_sessions SET status = 'finished', winner = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [winner, row.id]
                );
                const updatedRow = await dbGet(`SELECT * FROM battle_sessions WHERE id = ?`, [row.id]);
                const state = rowToState(updatedRow);
                broadcastToClients({ type: 'BATTLE_ENDED', battle: state });
                res.json({ success: true, battle: state });
            } catch (e) {
                console.error('❌ Battle-tracker /end:', e.message);
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.post('/api/battle/cancel', async (req, res) => {
            try {
                const row = await dbGet(`SELECT * FROM battle_sessions WHERE status = 'active' LIMIT 1`);
                if (!row) return res.status(404).json({ success: false, error: 'Нет активного баттла' });

                await dbRun(
                    `UPDATE battle_sessions SET status = 'cancelled', ended_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [row.id]
                );
                broadcastToClients({ type: 'BATTLE_UPDATE', battle: { active: false }, justPlayed: null });
                res.json({ success: true });
            } catch (e) {
                console.error('❌ Battle-tracker /cancel:', e.message);
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.get('/api/battle/feed', async (req, res) => {
            try {
                const rows = await dbAll(
                    `SELECT * FROM battle_sessions WHERE status = 'finished' ORDER BY ended_at DESC LIMIT ?`,
                    [FEED_LIMIT]
                );
                res.json({ success: true, feed: rows.map(rowToState) });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.post('/api/battle/feed/clear', async (req, res) => {
            try {
                const result = await dbRun(`DELETE FROM battle_sessions WHERE status = 'finished'`);
                res.json({ success: true, removed: result.changes || 0 });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });
    }

    function registerPages(app) {
        app.get('/battle-admin', (req, res) => {
            res.sendFile(path.join(appRoot, 'public', 'battle-admin.html'));
        });
    }

    startPolling();

    return { registerRoutes, registerPages };
}

module.exports = { createBattleTrackerModule };
