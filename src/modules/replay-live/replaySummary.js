'use strict';

const { normalizeShotHitCounts, hitAccuracyPct } = require('./combatStatsUtils');

function fmtNum(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString('ru-RU');
}

function pickAuthorRow(players, authorNickname) {
    const nick = (authorNickname || '').trim();
    if (!nick) return null;
    return (players || []).find((p) => p.nickname === nick)
        || (players || []).find((p) => (p.nickname || '').toLowerCase() === nick.toLowerCase())
        || null;
}

function sumField(players, field) {
    return (players || []).reduce((sum, p) => sum + (Number(p[field]) || 0), 0);
}

function pct(part, total) {
    if (!total || total <= 0) return null;
    return Math.round((part / total) * 100);
}

function hpAtClock(hpPoints, clockSec) {
    const points = hpPoints || [];
    if (!points.length) return null;
    for (let i = 0; i < points.length; i += 1) {
        if (points[i][0] > clockSec) break;
        if (points[i][1] === 0) return 0;
    }
    let lo = 0;
    let hi = points.length - 1;
    let best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid][0] <= clockSec) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (best < 0) return null;
    return Math.max(0, Number(points[best][1]) || 0);
}

function entityHpAtClock(player, clockSec) {
    const spawn = Number(player.spawnMaxHp || player.maxHp) || 0;
    const hp = hpAtClock(player.hpPoints, clockSec);
    if (hp != null) return hp;
    if (spawn > 0) return spawn;
    return 0;
}

function buildTeamHpTimeline(playbackTimeline, authorTeam, durationSec) {
    const timelinePlayers = (playbackTimeline && playbackTimeline.players) || [];
    if (!timelinePlayers.length || !authorTeam) return null;

    const allies = timelinePlayers.filter((p) => p.team === authorTeam);
    const enemies = timelinePlayers.filter((p) => p.team !== authorTeam && (p.team === 1 || p.team === 2));
    if (!allies.length && !enemies.length) return null;

    const dur = Number(durationSec)
        || Number(playbackTimeline.durationSec)
        || Number(playbackTimeline.replayDataDurationSec)
        || 0;

    const times = new Set([0]);
    if (dur > 0) times.add(dur);
    timelinePlayers.forEach((p) => {
        (p.hpPoints || []).forEach((pt) => {
            if (pt && pt[0] != null) times.add(Number(pt[0]));
        });
    });

    let sorted = [...times].sort((a, b) => a - b);
    if (dur > 0) sorted = sorted.filter((t) => t <= dur + 1);

    const MAX = 36;
    if (sorted.length > MAX) {
        const sampled = [];
        for (let i = 0; i < MAX; i += 1) {
            sampled.push(sorted[Math.round((i / (MAX - 1)) * (sorted.length - 1))]);
        }
        sorted = sampled;
    }

    const sumTeamHp = (roster, t) => roster.reduce((sum, p) => sum + entityHpAtClock(p, t), 0);
    const alliesMaxHp = sumTeamHp(allies, 0);
    const enemiesMaxHp = sumTeamHp(enemies, 0);

    const points = sorted.map((t) => ({
        t: Math.round(t * 10) / 10,
        allies: sumTeamHp(allies, t),
        enemies: sumTeamHp(enemies, t)
    }));

    return {
        durationSec: dur || (points.length ? points[points.length - 1].t : 0),
        alliesMaxHp,
        enemiesMaxHp,
        points
    };
}

function buildTeamSummary(players, teamId, label) {
    const roster = (players || []).filter((p) => p.team === teamId);
    if (!roster.length) return null;

    const shotsFired = sumField(roster, 'shotsFired');
    const hits = sumField(roster, 'hits');
    const penetrations = sumField(roster, 'penetrations');
    const damageDealt = sumField(roster, 'damageDealt');
    const frags = sumField(roster, 'frags');
    const n = roster.length;

    return {
        label,
        team: teamId,
        players: n,
        totalDamage: damageDealt,
        totalFrags: frags,
        shotsFired,
        hits,
        penetrations,
        avgDamage: Math.round(damageDealt / n),
        avgHits: Math.round((hits / n) * 10) / 10,
        avgPenetrations: Math.round((penetrations / n) * 10) / 10,
        hitRatePct: hitAccuracyPct(shotsFired, hits),
        penRatePct: pct(penetrations, hits),
        avgDamagePerHit: hits > 0 ? Math.round(damageDealt / hits) : null
    };
}

function avgTeammateDamage(teamPlayers, authorNick) {
    const nick = (authorNick || '').trim();
    const mates = (teamPlayers || []).filter((p) => !nick || (p.nickname || '') !== nick);
    if (!mates.length) return null;
    const total = sumField(mates, 'damageDealt');
    if (total <= 0) return null;
    return total / mates.length;
}

function rankInList(list, authorNick, field) {
    const sorted = [...list].sort((a, b) => (Number(b[field]) || 0) - (Number(a[field]) || 0));
    const idx = sorted.findIndex((p) => p.nickname === authorNick);
    return idx >= 0 ? idx + 1 : sorted.length;
}

function buildHeroProfile(authorRow, stats, teamSummary, teamPlayers) {
    const profile = [];
    const hits = Number(stats.hits) || 0;
    const shots = Number(stats.shotsFired) || 0;
    const pens = Number(stats.penetrations) || 0;
    const authorNick = authorRow.nickname || '';

    if (shots > 0) {
        const acc = hitAccuracyPct(shots, hits);
        profile.push({
            label: 'Точность',
            value: acc != null ? `${acc}%` : '—',
            sub: teamSummary && teamSummary.hitRatePct != null
                ? `среднее по команде ${teamSummary.hitRatePct}%`
                : ''
        });
    }
    if (hits > 0) {
        profile.push({
            label: 'Пробитие',
            value: `${pct(pens, hits)}%`,
            sub: teamSummary && teamSummary.penRatePct != null
                ? `среднее по команде ${teamSummary.penRatePct}%`
                : ''
        });
    }
    if (hits > 0) {
        profile.push({
            label: 'Урон за попадание',
            value: fmtNum(Math.round(stats.damageDealt / hits)),
            sub: teamSummary && teamSummary.avgDamagePerHit
                ? `среднее ${fmtNum(teamSummary.avgDamagePerHit)}`
                : ''
        });
    }

    if (shots > 0) profile.push({ label: 'Выстрелов', value: fmtNum(shots) });
    if (hits > 0) profile.push({ label: 'Попаданий', value: fmtNum(hits) });
    if (pens > 0) profile.push({ label: 'Пробитий', value: fmtNum(pens) });

    const tanksDamaged = Number(authorRow.tanksDamaged) || 0;
    if (tanksDamaged > 0) {
        profile.push({ label: 'Танков повреждено', value: String(tanksDamaged) });
    }

    if (teamSummary && teamSummary.avgDamage > 0) {
        const mateAvg = avgTeammateDamage(teamPlayers, authorNick) || teamSummary.avgDamage;
        if (mateAvg > 0) {
            const vs = Math.round((stats.damageDealt / mateAvg - 1) * 100);
            profile.push({
                label: 'Урон vs команда',
                value: `${vs >= 0 ? '+' : ''}${vs}%`,
                sub: 'к среднему по союзникам (без вас)'
            });
        }
    }

    if (teamPlayers.length > 1) {
        const rankHits = rankInList(teamPlayers, authorNick, 'hits');
        const rankPens = rankInList(teamPlayers, authorNick, 'penetrations');
        if (hits > 0) {
            profile.push({
                label: 'Попадания в команде',
                value: `#${rankHits}`,
                sub: `из ${teamPlayers.length}`
            });
        }
        if (pens > 0) {
            profile.push({
                label: 'Пробития в команде',
                value: `#${rankPens}`,
                sub: `из ${teamPlayers.length}`
            });
        }
    }

    profile.push({ label: 'Место по урону', value: `#${stats.rankTeam} в команде · #${stats.rankBattle} в бою` });

    return profile;
}

function buildInterestingFacts(options) {
    const facts = [];
    const authorNick = options.authorNickname || '';
    const players = options.players || [];
    const stats = options.stats || {};
    const heroProfile = options.heroProfile || [];
    const teamSummary = options.teamSummary || null;

    if (stats.rankBattle === 1) {
        facts.push({ icon: '👑', text: 'Абсолютный MVP боя по урону' });
    } else if (stats.rankTeam === 1) {
        facts.push({ icon: '⭐', text: 'Лучший урон в своей команде' });
    }

    if (stats.teamShare >= 35) {
        facts.push({ icon: '🔥', text: `Нанёс ${stats.teamShare}% урона своей команды — главный carry` });
    } else if (stats.teamShare >= 22) {
        facts.push({ icon: '💪', text: `Нанёс ${stats.teamShare}% урона команды — сильный вклад` });
    }

    if (stats.battleShare >= 16) {
        facts.push({ icon: '🌪️', text: `Нанёс ${stats.battleShare}% всего урона в бою` });
    }

    if (stats.frags >= 4) {
        facts.push({ icon: '💀', text: `${stats.frags} фрагов — настоящая резня` });
    } else if (stats.frags === 3) {
        facts.push({ icon: '🎯', text: 'Три фрага — отличная игра' });
    } else if (stats.frags === 0 && stats.damageDealt >= 2500) {
        facts.push({ icon: '🛡️', text: 'Без фрагов, но урон говорит сам за себя' });
    }

    if (stats.hits > 0 && stats.penetrations >= 6) {
        const penPct = pct(stats.penetrations, stats.hits);
        if (penPct >= 70) {
            facts.push({ icon: '🎳', text: `${penPct}% пробитий — снайперская работа` });
        }
    }

    if (stats.shotsFired > 0 && stats.hits > 0) {
        const acc = hitAccuracyPct(stats.shotsFired, stats.hits);
        if (acc >= 85) {
            facts.push({ icon: '🎯', text: `${acc}% точность — почти не промахивался` });
        }
    }

    const vsTeam = heroProfile.find((row) => row.label === 'Урон vs команда');
    if (vsTeam && vsTeam.value) {
        const vsNum = parseInt(String(vsTeam.value).replace(/[^\d-]/g, ''), 10);
        if (Number.isFinite(vsNum) && vsNum >= 25 && vsNum <= 400) {
            facts.push({
                icon: '📈',
                text: `Урон на ${Math.abs(vsNum)}% выше среднего союзника`
            });
        }
    }

    const top = players[0];
    if (top && top.nickname !== authorNick && stats.damageDealt >= (top.damageDealt || 0) * 0.85) {
        facts.push({
            icon: '⚔️',
            text: `Почти догнал ${top.nickname} (${fmtNum(top.damageDealt)} урона)`
        });
    }

    if (stats.rankBattle > 0 && stats.rankBattle <= 3 && stats.rankBattle !== 1) {
        facts.push({ icon: '🏅', text: `Топ-${stats.rankBattle} по урону среди 14 танков` });
    }

    if (teamSummary && teamSummary.hitRatePct != null && stats.shotsFired > 0) {
        const authorAcc = hitAccuracyPct(stats.shotsFired, stats.hits);
        if (authorAcc != null && authorAcc >= teamSummary.hitRatePct + 12) {
            facts.push({ icon: '🔭', text: 'Точность выше среднего по команде' });
        }
    }

    if (!facts.length && stats.damageDealt > 0) {
        facts.push({ icon: '📊', text: 'Бой завершён — смотрим цифры героя' });
    }

    const seen = new Set();
    return facts.filter((row) => {
        const key = row.text;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 6);
}

function buildReplayEndSummary(options) {
    options = options || {};
    const authorNickname = options.authorNickname || options.meta?.playerName || '';
    const players = [...(options.players || [])].sort((a, b) => (b.damageDealt || 0) - (a.damageDealt || 0));
    const authorRow = pickAuthorRow(players, authorNickname) || options.authorRow || {};
    const authorTeam = authorRow.team || 0;

    const teamPlayers = players.filter((p) => (
        authorTeam && p.team === authorTeam
    ) || p.nickname === authorRow.nickname);

    const enemyTeam = authorTeam === 1 ? 2 : (authorTeam === 2 ? 1 : 0);

    const authorDmg = Number(authorRow.damageDealt) || Number(options.authorStats?.damageDealt) || 0;
    const teamDmg = sumField(teamPlayers, 'damageDealt');
    const battleDmg = sumField(players, 'damageDealt');

    const rankBattle = players.findIndex((p) => p.nickname === authorRow.nickname) + 1;
    const rankTeam = [...teamPlayers]
        .sort((a, b) => (b.damageDealt || 0) - (a.damageDealt || 0))
        .findIndex((p) => p.nickname === authorRow.nickname) + 1;

    const teamShare = pct(authorDmg, teamDmg) || 0;
    const battleShare = pct(authorDmg, battleDmg) || 0;

    const meta = options.meta || {};
    const shotHit = normalizeShotHitCounts(authorRow.shotsFired, authorRow.hits);
    const stats = {
        damageDealt: authorDmg,
        frags: authorRow.frags != null ? authorRow.frags : (options.authorStats?.frags ?? null),
        baseXp: authorRow.baseXp != null ? authorRow.baseXp : (options.authorStats?.baseXp ?? null),
        shotsFired: shotHit.shotsFired,
        hits: shotHit.hits,
        penetrations: Number(authorRow.penetrations) || 0,
        rankBattle: rankBattle || players.length,
        rankTeam: rankTeam || teamPlayers.length,
        teamShare,
        battleShare,
        teamShareLabel: teamShare ? `Нанёс ${teamShare}% урона своей команды` : '',
        battleShareLabel: battleShare ? `Нанёс ${battleShare}% всего урона в бою` : ''
    };

    const allies = authorTeam ? buildTeamSummary(players, authorTeam, 'Союзники') : null;
    const enemies = enemyTeam ? buildTeamSummary(players, enemyTeam, 'Противники') : null;
    const heroProfile = buildHeroProfile(authorRow, stats, allies, teamPlayers);

    const facts = buildInterestingFacts({
        authorNickname,
        authorRow,
        players,
        stats,
        heroProfile,
        teamSummary: allies
    });

    const mapName = meta.mapName || options.mapName || '';
    const tankName = authorRow.tankName || meta.playerVehicleName || options.tankName || '';
    const hpChart = buildTeamHpTimeline(
        options.playbackTimeline,
        authorTeam,
        options.durationSec
            || (options.playbackTimeline && options.playbackTimeline.durationSec)
            || 0
    );

    return {
        visible: true,
        shownAt: new Date().toISOString(),
        replayKey: options.replayKey || '',
        replayFile: options.replayFile || '',
        hero: {
            nickname: authorRow.nickname || authorNickname,
            tankName,
            mapName
        },
        stats,
        heroProfile,
        teamSummary: {
            allies,
            enemies
        },
        hpChart,
        facts,
        topPlayers: players.slice(0, 5).map((p) => ({
            nickname: p.nickname || '?',
            damageDealt: p.damageDealt || 0,
            team: p.team || 0,
            tankName: p.tankName || ''
        })),
        outcome: stats.rankBattle === 1 ? 'mvp' : (stats.rankTeam === 1 ? 'team-carry' : 'solid')
    };
}

module.exports = {
    buildReplayEndSummary,
    fmtNum
};
