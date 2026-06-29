(function (root) {
  'use strict';

  const UI_VERSION = 'v96';

  function hitAccuracyPct(shotsFired, hits) {
    let shots = Number(shotsFired) || 0;
    let h = Number(hits) || 0;
    if (shots > 0 && h > shots) {
      const tmp = shots;
      shots = h;
      h = tmp;
    }
    if (shots <= 0) return null;
    return Math.round((Math.min(h, shots) / shots) * 100);
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function fmtNum(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString('ru-RU');
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function pct(part, total) {
    if (!total || total <= 0) return null;
    return Math.round((part / total) * 100);
  }

  function outcomeLabel(outcome, rankBattle) {
    if (outcome === 'mvp' || rankBattle === 1) return { text: 'MVP', mvp: true };
    if (outcome === 'team-carry') return { text: 'Carry', mvp: false };
    if (rankBattle > 0 && rankBattle <= 3) return { text: 'Top-' + rankBattle, mvp: false };
    return { text: '#' + (rankBattle || '?'), mvp: false };
  }

  function deltaClass(delta) {
    if (delta == null || !Number.isFinite(delta)) return 'neutral';
    if (delta >= 5) return 'up';
    if (delta <= -5) return 'down';
    return 'neutral';
  }

  function deltaText(delta, suffix) {
    if (delta == null || !Number.isFinite(delta)) return '≈ как команда';
    const sign = delta >= 0 ? '+' : '';
    return sign + delta + '% ' + (suffix || 'к команде');
  }

  function renderCombatFlow(stats) {
    const shots = Number(stats.shotsFired) || 0;
    const hits = Number(stats.hits) || 0;
    const pens = Number(stats.penetrations) || 0;
    if (!shots && !hits && !pens) return '';

    const acc = shots > 0 ? hitAccuracyPct(shots, hits) : null;
    const pen = hits > 0 ? pct(pens, hits) : null;

    const step = (val, lbl) =>
      `<div class="rs-flow-step"><span class="rs-flow-val">${esc(fmtNum(val))}</span><span class="rs-flow-lbl">${esc(lbl)}</span></div>`;
    const arrow = (pctVal) =>
      `<div class="rs-flow-arrow"><span>▸</span>${pctVal != null ? `<span class="rs-flow-pct">${pctVal}%</span>` : ''}</div>`;

    return `<div class="rs-combat-flow">
      ${step(shots, 'выстрелов')}
      ${arrow(acc)}
      ${step(hits, 'попаданий')}
      ${arrow(pen)}
      ${step(pens, 'пробитий')}
    </div>`;
  }

  function renderMetrics(stats, allies) {
    const shots = Number(stats.shotsFired) || 0;
    const hits = Number(stats.hits) || 0;
    const pens = Number(stats.penetrations) || 0;

    const items = [];
    if (shots > 0) {
      const acc = hitAccuracyPct(shots, hits);
      const delta = acc != null && allies && allies.hitRatePct != null ? acc - allies.hitRatePct : null;
      items.push({ val: acc + '%', lbl: 'Точность', delta, suffix: 'к команде' });
    }
    if (hits > 0) {
      const pen = pct(pens, hits);
      const delta = pen != null && allies && allies.penRatePct != null ? pen - allies.penRatePct : null;
      items.push({ val: pen + '%', lbl: 'Пробитие', delta, suffix: 'к команде' });
    }

    if (!items.length) return '';
    return `<div class="rs-metrics rs-metrics-duo">${items.map((m) =>
      `<div class="rs-metric">
        <span class="rs-metric-val">${esc(m.val)}</span>
        <span class="rs-metric-lbl">${esc(m.lbl)}</span>
        <span class="rs-metric-delta ${deltaClass(m.delta)}">${esc(deltaText(m.delta, m.suffix))}</span>
      </div>`
    ).join('')}</div>`;
  }

  function renderRanks(stats) {
    const chips = [];
    if (stats.rankTeam) {
      chips.push(`Урон в команде: <strong>#${stats.rankTeam}</strong>`);
    }
    if (stats.rankBattle) {
      chips.push(`В бою: <strong>#${stats.rankBattle}</strong>`);
    }
    if (!chips.length) return '';
    return `<div class="rs-ranks">${chips.map((c) => `<div class="rs-rank-chip">${c}</div>`).join('')}</div>`;
  }

  function renderTeamCompare(allies, enemies) {
    if (!allies || !enemies) return '';
    const diff = (allies.totalDamage || 0) - (enemies.totalDamage || 0);
    if (!diff) {
      return '<div class="rs-team-compare">Команды нанесли одинаковый урон</div>';
    }
    const pctDiff = enemies.totalDamage > 0
      ? Math.round(Math.abs(diff) / enemies.totalDamage * 100)
      : 100;
    if (diff > 0) {
      return `<div class="rs-team-compare win-allies">Союзники нанесли на ${pctDiff}% больше урона</div>`;
    }
    return `<div class="rs-team-compare win-enemies">Противники нанесли на ${pctDiff}% больше урона</div>`;
  }

  function renderTeamCard(team, sideClass) {
    if (!team) return '';
    return `<div class="rs-team ${sideClass}">
      <div class="rs-team-head">
        <span class="rs-team-name">${esc(team.label)}</span>
      </div>
      <div class="rs-team-damage">${esc(fmtNum(team.totalDamage))}</div>
      <div class="rs-team-damage-lbl">суммарный урон · ${esc(fmtNum(team.totalFrags))} фрагов</div>
    </div>`;
  }

  function renderCompareBar(label, alliesVal, enemiesVal, alliesCls, enemiesCls) {
    const a = Number(alliesVal) || 0;
    const e = Number(enemiesVal) || 0;
    const max = Math.max(a, e, 1);
    const aW = Math.max(6, Math.round(a / max * 100));
    const eW = Math.max(6, Math.round(e / max * 100));
    return `<div class="rs-ig-compare-row">
      <div class="rs-ig-compare-lbl">${esc(label)}</div>
      <div class="rs-ig-compare-bars">
        <div class="rs-ig-bar-row allies">
          <span class="rs-ig-bar-tag">Союзники</span>
          <div class="rs-ig-bar"><div class="rs-ig-bar-fill ${alliesCls}" style="width:${aW}%"></div></div>
          <span class="rs-ig-bar-num">${esc(fmtNum(a))}</span>
        </div>
        <div class="rs-ig-bar-row enemies">
          <span class="rs-ig-bar-tag">Противники</span>
          <div class="rs-ig-bar"><div class="rs-ig-bar-fill ${enemiesCls}" style="width:${eW}%"></div></div>
          <span class="rs-ig-bar-num">${esc(fmtNum(e))}</span>
        </div>
      </div>
    </div>`;
  }

  function renderHpChart(hpChart, carousel) {
    if (!hpChart || !hpChart.points || !hpChart.points.length) {
      return '<div class="rs-hp-empty">Нет данных HP по ходу боя</div>';
    }

    const W = 220;
    const H = carousel ? 72 : 100;
    const pad = carousel
      ? { l: 2, r: 2, t: 8, b: 14 }
      : { l: 2, r: 2, t: 12, b: 18 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const pts = hpChart.points;
    const dur = hpChart.durationSec || pts[pts.length - 1].t || 1;
    const maxY = Math.max(
      hpChart.alliesMaxHp || 0,
      hpChart.enemiesMaxHp || 0,
      ...pts.map((p) => Math.max(p.allies, p.enemies)),
      1
    );

    const x = (t) => pad.l + (t / dur) * iw;
    const y = (v) => pad.t + (1 - v / maxY) * ih;

    function linePath(key) {
      return pts.map((p, i) =>
        `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`
      ).join(' ');
    }

    function areaPath(key) {
      let d = linePath(key);
      d += ` L${x(pts[pts.length - 1].t).toFixed(1)},${y(0).toFixed(1)}`;
      d += ` L${x(pts[0].t).toFixed(1)},${y(0).toFixed(1)} Z`;
      return d;
    }

    const startAllies = pts[0].allies;
    const startEnemies = pts[0].enemies;
    const endAllies = pts[pts.length - 1].allies;
    const endEnemies = pts[pts.length - 1].enemies;

    if (carousel) {
      return `<div class="rs-hp-chart rs-hp-chart-carousel">
        <div class="rs-hp-chart-head">
          <span class="rs-hp-leg allies"><i></i>Союзники</span>
          <span class="rs-hp-leg enemies"><i></i>Противники</span>
        </div>
        <svg viewBox="0 0 ${W} ${H}" class="rs-hp-svg" preserveAspectRatio="none" aria-hidden="true">
          <path class="rs-hp-area allies" d="${areaPath('allies')}"/>
          <path class="rs-hp-area enemies" d="${areaPath('enemies')}"/>
          <path class="rs-hp-line allies" d="${linePath('allies')}"/>
          <path class="rs-hp-line enemies" d="${linePath('enemies')}"/>
        </svg>
        <div class="rs-hp-axis">
          <span>${esc(fmtTime(0))}</span>
          <span>${esc(fmtTime(dur))}</span>
        </div>
        <div class="rs-hp-inline">
          <span class="allies">${esc(fmtNum(startAllies))} → ${esc(fmtNum(endAllies))}</span>
          <span class="enemies">${esc(fmtNum(startEnemies))} → ${esc(fmtNum(endEnemies))}</span>
        </div>
      </div>`;
    }

    return `<div class="rs-hp-chart">
      <div class="rs-hp-chart-head">
        <span class="rs-hp-leg allies"><i></i>HP союзников</span>
        <span class="rs-hp-leg enemies"><i></i>HP противников</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="rs-hp-svg" preserveAspectRatio="none" aria-hidden="true">
        <path class="rs-hp-area allies" d="${areaPath('allies')}"/>
        <path class="rs-hp-area enemies" d="${areaPath('enemies')}"/>
        <path class="rs-hp-line allies" d="${linePath('allies')}"/>
        <path class="rs-hp-line enemies" d="${linePath('enemies')}"/>
      </svg>
      <div class="rs-hp-axis">
        <span>${esc(fmtTime(0))}</span>
        <span>${esc(fmtTime(dur))}</span>
      </div>
      <div class="rs-hp-summary">
        <div class="rs-hp-sum allies">
          <span class="k">Старт</span><span class="v">${esc(fmtNum(startAllies))}</span>
          <span class="k">Финиш</span><span class="v">${esc(fmtNum(endAllies))}</span>
        </div>
        <div class="rs-hp-sum enemies">
          <span class="k">Старт</span><span class="v">${esc(fmtNum(startEnemies))}</span>
          <span class="k">Финиш</span><span class="v">${esc(fmtNum(endEnemies))}</span>
        </div>
      </div>
    </div>`;
  }

  function renderCarouselCompareCell(label, alliesVal, enemiesVal) {
    const a = Number(alliesVal) || 0;
    const e = Number(enemiesVal) || 0;
    const max = Math.max(a, e, 1);
    const aW = Math.max(8, Math.round(a / max * 100));
    const eW = Math.max(8, Math.round(e / max * 100));
    return `<div class="rs-cmp-cell">
      <div class="rs-cmp-lbl">${esc(label)}</div>
      <div class="rs-cmp-row allies">
        <div class="rs-cmp-bar"><div class="rs-cmp-fill fill-allies" style="width:${aW}%"></div></div>
        <span class="rs-cmp-num">${esc(fmtNum(a))}</span>
      </div>
      <div class="rs-cmp-row enemies">
        <div class="rs-cmp-bar"><div class="rs-cmp-fill fill-enemies" style="width:${eW}%"></div></div>
        <span class="rs-cmp-num">${esc(fmtNum(e))}</span>
      </div>
    </div>`;
  }

  function renderCarouselBattle(allies, enemies, hpChart) {
    const compareGrid = (allies && enemies)
      ? `<div class="rs-cmp-grid">
          ${renderCarouselCompareCell('Урон', allies.totalDamage, enemies.totalDamage)}
          ${renderCarouselCompareCell('Выстрелы', allies.shotsFired, enemies.shotsFired)}
          ${renderCarouselCompareCell('Попадания', allies.hits, enemies.hits)}
          ${renderCarouselCompareCell('Пробития', allies.penetrations, enemies.penetrations)}
        </div>`
      : '';

    return `<div class="rs-carousel-battle">
      ${renderHpChart(hpChart, true)}
      ${compareGrid}
    </div>`;
  }

  function renderInfographic(allies, enemies, hpChart, compact) {
    const compareBlock = (allies && enemies)
      ? `<div class="rs-ig-compare">
          ${renderCompareBar('Урон', allies.totalDamage, enemies.totalDamage, 'fill-allies', 'fill-enemies')}
          ${renderCompareBar('Выстрелы', allies.shotsFired, enemies.shotsFired, 'fill-allies', 'fill-enemies')}
          ${renderCompareBar('Попадания', allies.hits, enemies.hits, 'fill-allies', 'fill-enemies')}
          ${renderCompareBar('Пробития', allies.penetrations, enemies.penetrations, 'fill-allies', 'fill-enemies')}
        </div>`
      : '';

    const cls = compact ? ' rs-infographic-compact' : '';
    return `<div class="rs-infographic${cls}">
      ${renderHpChart(hpChart)}
      ${compareBlock}
    </div>`;
  }

  function buildSummaryContext(summary) {
    const hero = summary.hero || {};
    const stats = summary.stats || {};
    const teams = summary.teamSummary || {};
    const facts = summary.facts || [];
    const allies = teams.allies;
    const enemies = teams.enemies;
    const rank = outcomeLabel(summary.outcome, stats.rankBattle);
    const mapPart = hero.mapName ? `<em>${esc(hero.mapName)}</em>` : '';
    const tankPart = hero.tankName ? esc(hero.tankName) : '—';
    const shareTeam = stats.teamShare || 0;
    const shareBattle = stats.battleShare || 0;
    const factsHtml = facts.length
      ? facts.map((f) => `<span class="rs-fact-chip"><span class="ico">${esc(f.icon || '•')}</span>${esc(f.text)}</span>`).join('')
      : '<span class="rs-fact-chip"><span class="ico">📊</span>Бой завершён</span>';

    return {
      hero,
      stats,
      allies,
      enemies,
      rank,
      outcome: summary.outcome,
      mapPart,
      tankPart,
      shareTeam,
      shareBattle,
      factsHtml,
      hpChart: summary.hpChart
    };
  }

  function blitzSubhead(title) {
    return `<div class="rs-blitz-subhead">${esc(title)}</div>`;
  }

  function blitzRow(label, value, opts) {
    opts = opts || {};
    const gold = opts.gold ? ' rs-blitz-val-gold' : '';
    const blue = opts.blue ? ' rs-blitz-val-blue' : '';
    const red = opts.red ? ' rs-blitz-val-red' : '';
    const icon = opts.icon ? `<span class="rs-blitz-row-ico">${opts.icon}</span>` : '';
    return `<div class="rs-blitz-row">
      <span class="rs-blitz-row-lbl">${icon}${esc(label)}</span>
      <span class="rs-blitz-row-val${gold}${blue}${red}">${value}</span>
    </div>`;
  }

  function blitzSectionTitle(title) {
    return `<div class="rs-blitz-head">${esc(title)}</div>`;
  }

  function blitzHeroBanner(ctx) {
    const nick = esc((ctx && ctx.hero && ctx.hero.nickname) || '—');
    const nickCls = ' rs-blitz-banner-nick';
    if (ctx && ctx.rank && (ctx.rank.mvp || ctx.stats.rankBattle === 1)) {
      return `<div class="rs-blitz-banner mvp${nickCls}">${nick}</div>`;
    }
    if (ctx && ctx.outcome === 'team-carry') {
      return `<div class="rs-blitz-banner carry${nickCls}">${nick}</div>`;
    }
    return `<div class="rs-blitz-banner${nickCls}">${nick}</div>`;
  }

  function blitzTeamsBanner() {
    return '<div class="rs-blitz-banner">Результаты команд</div>';
  }

  function blitzOutcomeBanner(allies, enemies, ctx) {
    if (ctx && ctx.rank && (ctx.rank.mvp || ctx.stats.rankBattle === 1)) {
      return '<div class="rs-blitz-banner mvp">MVP</div>';
    }
    if (ctx && ctx.outcome === 'team-carry') {
      return '<div class="rs-blitz-banner carry">Carry</div>';
    }
    if (!allies || !enemies) return '';
    const diff = (allies.totalDamage || 0) - (enemies.totalDamage || 0);
    if (!diff) return '<div class="rs-blitz-banner even">Равный бой</div>';
    const pctDiff = enemies.totalDamage > 0
      ? Math.round(Math.abs(diff) / enemies.totalDamage * 100) : 100;
    if (diff > 0) {
      return `<div class="rs-blitz-banner win-allies">Союзники +${pctDiff}% урона</div>`;
    }
    return `<div class="rs-blitz-banner win-enemies">Противники +${pctDiff}% урона</div>`;
  }

  function renderBlitzAuthorRow(ctx) {
    const initial = esc(String(ctx.hero.nickname || '?').charAt(0).toUpperCase());
    const mvpCls = ctx.rank && ctx.rank.mvp ? ' is-mvp' : '';
    const shots = Number(ctx.stats.shotsFired) || 0;
    const hits = Number(ctx.stats.hits) || 0;
    const acc = shots > 0 ? hitAccuracyPct(shots, hits) : null;
    return `<div class="rs-blitz-author${mvpCls}">
      <div class="rs-blitz-hex">${initial}</div>
      <div class="rs-blitz-author-main">
        <div class="rs-blitz-tank">${ctx.tankPart}</div>
      </div>
      <div class="rs-blitz-author-stats">
        <div class="rs-blitz-pill dmg" title="Урон">
          <span class="rs-blitz-pill-col">
            <span class="v">${esc(fmtNum(ctx.stats.damageDealt))}</span>
            <span class="lbl">урон</span>
          </span>
        </div>
        <div class="rs-blitz-pill frags" title="Фраги">
          <span class="rs-blitz-pill-col">
            <span class="v">${esc(ctx.stats.frags != null ? ctx.stats.frags : '—')}</span>
            <span class="lbl">фрагов</span>
          </span>
        </div>
        ${acc != null ? `<div class="rs-blitz-pill acc" title="Точность (попадания / выстрелы)">
          <span class="rs-blitz-pill-col">
            <span class="v">${esc(acc + '%')}</span>
            <span class="lbl">точность</span>
          </span>
        </div>` : ''}
      </div>
    </div>`;
  }

  function renderBlitzCombatPills(stats) {
    const shots = Number(stats.shotsFired) || 0;
    const hits = Number(stats.hits) || 0;
    const pens = Number(stats.penetrations) || 0;
    if (!shots && !hits && !pens) return '';
    return `<div class="rs-blitz-pills-row">
      <div class="rs-blitz-pill"><span class="lbl">выстр.</span><span class="v">${esc(fmtNum(shots))}</span></div>
      <div class="rs-blitz-pill highlight"><span class="lbl">попад.</span><span class="v">${esc(fmtNum(hits))}</span></div>
      <div class="rs-blitz-pill"><span class="lbl">пробит.</span><span class="v">${esc(fmtNum(pens))}</span></div>
    </div>`;
  }

  function renderBlitzCompareSection(allies, enemies) {
    if (!allies || !enemies) return '';
    return `${blitzSubhead('Сравнение')}
      <div class="rs-blitz-section">
        <div class="rs-blitz-pair-head"><span></span><span class="allies">Союзн.</span><span class="enemies">Враги</span></div>
        ${renderBlitzPairRow('Урон', allies.totalDamage, enemies.totalDamage)}
        ${renderBlitzPairRow('Выстрелы', allies.shotsFired, enemies.shotsFired)}
        ${renderBlitzPairRow('Попадания', allies.hits, enemies.hits)}
        ${renderBlitzPairRow('Пробития', allies.penetrations, enemies.penetrations)}
      </div>`;
  }

  function renderBlitzScoreboard(allies, enemies) {
    if (!allies || !enemies) return '';
    return `<div class="rs-blitz-scoreboard rs-blitz-scoreboard-full">
      ${renderBlitzTeamCol(allies, 'allies')}
      <div class="rs-blitz-score-mid" aria-hidden="true"></div>
      ${renderBlitzTeamCol(enemies, 'enemies')}
    </div>`;
  }

  function renderBlitzShareBars(ctx) {
    return `<div class="rs-bf-shares">
      <div class="rs-bf-share">
        <div class="rs-bf-share-head">
          <span class="rs-bf-share-lbl">Доля команды</span>
          <span class="rs-bf-share-val">${esc(ctx.shareTeam)}%</span>
        </div>
        <div class="rs-bf-bar"><div class="rs-bf-bar-fill allies" style="width:${Math.min(100, ctx.shareTeam)}%"></div></div>
        <div class="rs-bf-share-note">${esc(ctx.stats.teamShareLabel || `Нанёс ${ctx.shareTeam}% урона своей команды`)}</div>
      </div>
      <div class="rs-bf-share">
        <div class="rs-bf-share-head">
          <span class="rs-bf-share-lbl">Доля в бою</span>
          <span class="rs-bf-share-val gold">${esc(ctx.shareBattle)}%</span>
        </div>
        <div class="rs-bf-bar"><div class="rs-bf-bar-fill battle" style="width:${Math.min(100, ctx.shareBattle)}%"></div></div>
        <div class="rs-bf-share-note">${esc(ctx.stats.battleShareLabel || `Нанёс ${ctx.shareBattle}% всего урона в бою`)}</div>
      </div>
    </div>`;
  }

  function renderBlitzFactsBlock(facts) {
    const factList = facts || [];
    if (!factList.length) return '';
    return `${blitzSubhead('Достижения')}<div class="rs-blitz-facts">${factList.map((f) =>
      `<div class="rs-blitz-fact"><span class="ico">${esc(f.icon || '•')}</span><span>${esc(f.text)}</span></div>`
    ).join('')}</div>`;
  }

  function renderBlitzHpPanel(hpChart, layout) {
    const full = layout === 'full';
    if (!hpChart || !hpChart.points || !hpChart.points.length) {
      return `${blitzSubhead('Здоровье команд')}
        <div class="rs-blitz-empty">Нет данных HP по ходу боя</div>`;
    }

    const W = full ? 420 : 220;
    const H = full ? 96 : 80;
    const pad = { l: 2, r: 2, t: 8, b: 14 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const pts = hpChart.points;
    const dur = hpChart.durationSec || pts[pts.length - 1].t || 1;
    const maxY = Math.max(
      hpChart.alliesMaxHp || 0, hpChart.enemiesMaxHp || 0,
      ...pts.map((p) => Math.max(p.allies, p.enemies)), 1
    );
    const x = (t) => pad.l + (t / dur) * iw;
    const y = (v) => pad.t + (1 - v / maxY) * ih;
    const linePath = (key) => pts.map((p, i) =>
      `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`
    ).join(' ');
    const areaPath = (key) => {
      let d = linePath(key);
      d += ` L${x(pts[pts.length - 1].t).toFixed(1)},${y(0).toFixed(1)}`;
      d += ` L${x(pts[0].t).toFixed(1)},${y(0).toFixed(1)} Z`;
      return d;
    };

    const sa = pts[0].allies;
    const se = pts[0].enemies;
    const ea = pts[pts.length - 1].allies;
    const ee = pts[pts.length - 1].enemies;
    const lostA = sa - ea;
    const lostE = se - ee;

    const hpCls = full ? 'rs-hp-chart rs-hp-chart-full' : 'rs-hp-chart rs-hp-chart-carousel';

    const statsBlock = full
      ? `<div class="rs-blitz-hp-stats">
          <div class="rs-blitz-hp-stat-col allies">
            ${blitzRow('Старт', esc(fmtNum(sa)), { blue: true })}
            ${blitzRow('Финиш', esc(fmtNum(ea)), { blue: true })}
            ${blitzRow('Потеряно', esc(fmtNum(lostA)), { blue: true })}
          </div>
          <div class="rs-blitz-hp-stat-col enemies">
            ${blitzRow('Старт', esc(fmtNum(se)), { red: true })}
            ${blitzRow('Финиш', esc(fmtNum(ee)), { red: true })}
            ${blitzRow('Потеряно', esc(fmtNum(lostE)), { red: true })}
          </div>
        </div>`
      : `<div class="rs-blitz-section">
        ${blitzRow('Союзники · старт', esc(fmtNum(sa)), { blue: true })}
        ${blitzRow('Потеряно HP', esc(fmtNum(lostA)), { blue: true })}
      </div>
      <div class="rs-blitz-sep"></div>
      <div class="rs-blitz-section">
        ${blitzRow('Противники · старт', esc(fmtNum(se)), { red: true })}
        ${blitzRow('Потеряно HP', esc(fmtNum(lostE)), { red: true })}
      </div>`;

    return `${blitzSubhead('Здоровье команд')}
      <div class="rs-blitz-hp-wrap${full ? ' rs-blitz-hp-wrap-full' : ''}">
        <div class="${hpCls}">
          <div class="rs-hp-chart-head">
            <span class="rs-hp-leg allies"><i></i>Союзники</span>
            <span class="rs-hp-leg enemies"><i></i>Противники</span>
          </div>
          <svg viewBox="0 0 ${W} ${H}" class="rs-hp-svg" preserveAspectRatio="none" aria-hidden="true">
            <path class="rs-hp-area allies" d="${areaPath('allies')}"/>
            <path class="rs-hp-area enemies" d="${areaPath('enemies')}"/>
            <path class="rs-hp-line allies" d="${linePath('allies')}"/>
            <path class="rs-hp-line enemies" d="${linePath('enemies')}"/>
          </svg>
          <div class="rs-hp-axis">
            <span>${esc(fmtTime(0))}</span>
            <span>${esc(fmtTime(dur))}</span>
          </div>
        </div>
      </div>
      ${statsBlock}`;
  }

  function renderBlitzHero(ctx) {
    return `<div class="rs-blitz-slide">
      ${blitzHeroBanner(ctx)}
      ${renderBlitzAuthorRow(ctx)}
      ${blitzSubhead('Вклад в бой')}
      <div class="rs-blitz-section">
        ${blitzRow('Доля урона команды', esc(ctx.shareTeam + '%'), { gold: ctx.shareTeam >= 30 })}
        ${blitzRow('Доля урона в бою', esc(ctx.shareBattle + '%'))}
      </div>
      <div class="rs-blitz-sep"></div>
      <div class="rs-blitz-section rs-blitz-section-muted">
        ${blitzRow('Урон в команде', ctx.stats.rankTeam ? esc('#' + ctx.stats.rankTeam) : '—', { gold: ctx.stats.rankTeam === 1 })}
        ${blitzRow('Место среди 14', ctx.stats.rankBattle ? esc('#' + ctx.stats.rankBattle) : '—', { gold: ctx.stats.rankBattle <= 3 })}
      </div>
    </div>`;
  }

  function renderBlitzPlayer(ctx, facts) {
    const stats = ctx.stats;
    const acc = stats.shotsFired > 0 ? hitAccuracyPct(stats.shotsFired, stats.hits) : null;
    const pen = stats.hits > 0 ? pct(stats.penetrations, stats.hits) : null;

    const factList = facts || [];
    const factsHtml = factList.length
      ? `${blitzSubhead('Достижения')}<div class="rs-blitz-facts">${factList.map((f) =>
        `<div class="rs-blitz-fact"><span class="ico">${esc(f.icon || '•')}</span><span>${esc(f.text)}</span></div>`
      ).join('')}</div>`
      : '';

    return `<div class="rs-blitz-slide">
      ${blitzHeroBanner(ctx)}
      ${renderBlitzAuthorRow(ctx)}
      ${blitzSubhead('Боевая статистика')}
      ${renderBlitzCombatPills(stats)}
      <div class="rs-blitz-section">
        ${acc != null ? blitzRow('Точность', esc(acc + '%'), { gold: acc >= 80 }) : ''}
        ${pen != null ? blitzRow('Пробитие', esc(pen + '%'), { gold: pen >= 80 }) : ''}
        ${stats.rankTeam ? blitzRow('Урон в команде', esc('#' + stats.rankTeam), { gold: stats.rankTeam === 1 }) : ''}
      </div>
      ${factsHtml}
    </div>`;
  }

  function renderBlitzTeamCol(team, side) {
    if (!team) return '';
    return `<div class="rs-blitz-score-col ${side}">
      <div class="rs-blitz-score-title">${esc(team.label)}</div>
      <div class="rs-blitz-score-dmg-wrap">
        <span class="rs-blitz-score-dmg-lbl">нанесли урона</span>
        <div class="rs-blitz-score-dmg">${esc(fmtNum(team.totalDamage))}</div>
      </div>
      <div class="rs-blitz-score-meta">
        <span><b>${esc(fmtNum(team.totalFrags))}</b> фрагов</span>
        <span><b>${esc(fmtNum(team.hits))}</b> попад.</span>
      </div>
    </div>`;
  }

  function renderBlitzTeams(allies, enemies, ctx) {
    if (!allies || !enemies) return '';
    return `<div class="rs-blitz-slide">
      ${blitzTeamsBanner(allies, enemies)}
      <div class="rs-blitz-scoreboard">
        ${renderBlitzTeamCol(allies, 'allies')}
        <div class="rs-blitz-score-mid" aria-hidden="true"></div>
        ${renderBlitzTeamCol(enemies, 'enemies')}
      </div>
      ${blitzSubhead('Сравнение')}
      <div class="rs-blitz-section">
        <div class="rs-blitz-pair-head"><span></span><span class="allies">Союзн.</span><span class="enemies">Враги</span></div>
        ${renderBlitzPairRow('Урон', allies.totalDamage, enemies.totalDamage)}
        ${renderBlitzPairRow('Выстрелы', allies.shotsFired, enemies.shotsFired)}
        ${renderBlitzPairRow('Попадания', allies.hits, enemies.hits)}
        ${renderBlitzPairRow('Пробития', allies.penetrations, enemies.penetrations)}
      </div>
    </div>`;
  }

  function renderBlitzPairRow(label, alliesVal, enemiesVal) {
    const a = Number(alliesVal) || 0;
    const e = Number(enemiesVal) || 0;
    const aWin = a >= e ? ' win' : '';
    const eWin = e > a ? ' win' : '';
    return `<div class="rs-blitz-pair">
      <span class="rs-blitz-pair-lbl">${esc(label)}</span>
      <span class="rs-blitz-pair-val allies${aWin}">${esc(fmtNum(a))}</span>
      <span class="rs-blitz-pair-val enemies${eWin}">${esc(fmtNum(e))}</span>
    </div>`;
  }

  function renderBlitzBattle(allies, enemies, hpChart) {
    const compare = (allies && enemies)
      ? `${blitzSubhead('Сводка боя')}
        <div class="rs-blitz-section">
          <div class="rs-blitz-pair-head"><span></span><span class="allies">Союзн.</span><span class="enemies">Враги</span></div>
          ${renderBlitzPairRow('Урон', allies.totalDamage, enemies.totalDamage)}
          ${renderBlitzPairRow('Выстрелы', allies.shotsFired, enemies.shotsFired)}
          ${renderBlitzPairRow('Попадания', allies.hits, enemies.hits)}
          ${renderBlitzPairRow('Пробития', allies.penetrations, enemies.penetrations)}
        </div>`
      : '';

    return `<div class="rs-blitz-slide">
      ${renderBlitzHpPanel(hpChart)}
      ${compare}
    </div>`;
  }

  function renderHeroBlock(ctx) {
    return `<header class="rs-hero">
        <div class="rs-hero-main">
          <span class="rs-badge">Итоги боя</span>
          <div class="rs-name">${esc(ctx.hero.nickname || '—')}</div>
          <div class="rs-meta">${ctx.tankPart}${ctx.mapPart ? ' · ' + ctx.mapPart : ''}</div>
        </div>
        <div class="rs-hero-kpi">
          <div class="rs-kpi rs-kpi-damage">
            <span class="rs-kpi-val">${esc(fmtNum(ctx.stats.damageDealt))}</span>
            <span class="rs-kpi-label">урон</span>
          </div>
          <div class="rs-kpi">
            <span class="rs-kpi-val">${esc(ctx.stats.frags != null ? ctx.stats.frags : '—')}</span>
            <span class="rs-kpi-label">фраги</span>
          </div>
          <div class="rs-kpi rs-kpi-rank${ctx.rank.mvp ? ' mvp' : ''}">
            <span class="rs-kpi-val">${esc(ctx.rank.text)}</span>
            <span class="rs-kpi-label">место</span>
          </div>
        </div>
      </header>
      <div class="rs-impact rs-impact-carousel">
        <div class="rs-share">
          <div class="rs-bar"><div class="rs-bar-fill team" style="width:${Math.min(100, ctx.shareTeam)}%"></div></div>
          <div class="rs-share-note">${esc(ctx.stats.teamShareLabel || `Нанёс ${ctx.shareTeam}% урона своей команды`)}</div>
        </div>
        <div class="rs-share">
          <div class="rs-bar"><div class="rs-bar-fill battle" style="width:${Math.min(100, ctx.shareBattle)}%"></div></div>
          <div class="rs-share-note">${esc(ctx.stats.battleShareLabel || `Нанёс ${ctx.shareBattle}% всего урона в бою`)}</div>
        </div>
      </div>`;
  }

  function renderSummaryHtml(summary) {
    if (!summary || !summary.visible) return '';

    const ctx = buildSummaryContext(summary);
    const stats = ctx.stats;
    const facts = summary.facts || [];
    const acc = stats.shotsFired > 0 ? hitAccuracyPct(stats.shotsFired, stats.hits) : null;
    const pen = stats.hits > 0 ? pct(stats.penetrations, stats.hits) : null;

    const playerCol = `<section class="rs-bf-col">
      ${blitzSubhead('Твоя игра')}
      ${renderBlitzCombatPills(stats)}
      <div class="rs-blitz-section">
        ${acc != null ? blitzRow('Точность', esc(acc + '%'), { gold: acc >= 80 }) : ''}
        ${pen != null ? blitzRow('Пробитие', esc(pen + '%'), { gold: pen >= 80 }) : ''}
        ${stats.rankTeam ? blitzRow('Урон в команде', esc('#' + stats.rankTeam), { gold: stats.rankTeam === 1 }) : ''}
      </div>
      ${renderBlitzFactsBlock(facts)}
    </section>`;

    const teamsCol = `<section class="rs-bf-col">
      ${blitzSubhead('Команды')}
      ${renderBlitzScoreboard(ctx.allies, ctx.enemies)}
      ${renderBlitzCompareSection(ctx.allies, ctx.enemies)}
    </section>`;

    const battleCol = `<section class="rs-bf-col">
      ${renderBlitzHpPanel(ctx.hpChart, 'full')}
    </section>`;

    return `<div class="rs-panel rs-blitz-full">
      <div class="rs-ui-version">UI ${UI_VERSION}</div>
      ${blitzOutcomeBanner(ctx.allies, ctx.enemies, ctx)}
      ${renderBlitzAuthorRow(ctx)}
      ${renderBlitzShareBars(ctx)}
      <div class="rs-bf-grid">${playerCol}${teamsCol}${battleCol}</div>
    </div>`;
  }

  function getCarouselSlides(summary) {
    if (!summary || !summary.visible) return [];

    const ctx = buildSummaryContext(summary);
    const facts = summary.facts || [];

    return [
      { id: 'hero', label: 'Итоги', body: renderBlitzHero(ctx) },
      { id: 'player', label: 'Твоя игра', body: renderBlitzPlayer(ctx, facts) },
      { id: 'teams', label: 'Команды', body: renderBlitzTeams(ctx.allies, ctx.enemies, ctx) },
      { id: 'battle', label: 'Сводка', body: renderBlitzBattle(ctx.allies, ctx.enemies, ctx.hpChart) }
    ];
  }

  function renderCarouselSlideCard(slide, options) {
    options = options || {};
    const editable = options.editable !== false;
    let body = slide.body;
    if (editable) {
      body = body.replace(
        'class="rs-blitz-slide"',
        'class="rs-blitz-slide rs-card-editable" contenteditable="true" spellcheck="false"'
      );
    }

    return `<article class="rs-card-sheet-item" data-slide-id="${esc(slide.id)}">
      <div class="rs-blitz-theme rs-blitz-standalone-card">${body}</div>
    </article>`;
  }

  function renderSummaryCarouselCardsHtml(summary, options) {
    if (!summary || !summary.visible) return '';

    options = options || {};
    const slides = getCarouselSlides(summary);
    if (!slides.length) return '';

    const cards = slides.map((slide) => renderCarouselSlideCard(slide, options)).join('');

    return `<div class="rs-card-sheet" data-cards-count="${slides.length}">${cards}</div>`;
  }

  function renderCarouselPanelHtml(slides, options) {
    if (!slides.length) return '';

    options = options || {};
    const intervalMs = Math.max(2000, Number(options.intervalMs) || 10000);
    const showVersion = options.showVersion !== false;

    const dots = slides.map((slide, idx) =>
      `<div class="rs-carousel-dot${idx === 0 ? ' active' : ''}" data-idx="${idx}" title="${esc(slide.label)}"></div>`
    ).join('');

    const tabsHtml = slides.map((slide, idx) =>
      `<span class="rs-blitz-tab${idx === 0 ? ' active' : ''}" data-tab-idx="${idx}">${esc(slide.label)}</span>`
    ).join('');

    const slideHtml = slides.map((slide, idx) =>
      `<div class="rs-carousel-slide${idx === 0 ? ' active' : ''}" data-slide="${esc(slide.id)}" data-idx="${idx}" data-label="${esc(slide.label)}">
        ${slide.body}
      </div>`
    ).join('');

    const versionHtml = showVersion
      ? `<div class="rs-ui-version">UI ${UI_VERSION} · blitz · dual</div>`
      : '';

    return `<div class="rs-panel rs-panel-carousel rs-blitz-theme" data-interval="${intervalMs}">
      <div class="rs-carousel-card">
        ${versionHtml}
        <div class="rs-blitz-tabs">${tabsHtml}</div>
        <div class="rs-carousel-viewport">${slideHtml}</div>
        <div class="rs-carousel-footer">
          <div class="rs-carousel-dots rs-carousel-dots-vertical">${dots}</div>
          <span class="rs-carousel-counter"><span data-carousel-current>1</span> / ${slides.length}</span>
        </div>
      </div>
    </div>`;
  }

  function renderSummaryCarouselHtml(summary, options) {
    if (!summary || !summary.visible) return '';

    options = options || {};
    const slides = getCarouselSlides(summary);
    if (!slides.length) return '';

    const playerSlides = slides.filter(function (slide) {
      return slide.id === 'hero' || slide.id === 'player';
    });
    const teamsSlides = slides.filter(function (slide) {
      return slide.id === 'teams' || slide.id === 'battle';
    });

    return `<div class="rs-dual-carousel">
      <div class="rs-carousel-block rs-carousel-block-player">
      ${renderCarouselPanelHtml(playerSlides, Object.assign({}, options, { showVersion: true }))}
      </div>
      <div class="rs-carousel-block rs-carousel-block-teams">
      ${renderCarouselPanelHtml(teamsSlides, Object.assign({}, options, { showVersion: false }))}
      </div>
    </div>`;
  }

  function lockCarouselViewport(panel) {
    const viewport = panel.querySelector('.rs-carousel-viewport');
    const slideEls = Array.from(panel.querySelectorAll('.rs-carousel-slide'));
    if (!viewport || !slideEls.length) return 0;

    let maxH = 0;
    slideEls.forEach(function (slide) {
      slideEls.forEach(function (other) {
        other.classList.remove('active');
        other.style.position = 'absolute';
        other.style.left = '0';
        other.style.right = '0';
        other.style.top = '0';
        other.style.height = 'auto';
      });
      slide.classList.add('active');
      slide.style.position = 'relative';
      slide.style.height = 'auto';
      maxH = Math.max(maxH, slide.scrollHeight, slide.offsetHeight);
    });

    maxH = Math.max(Math.ceil(maxH), 200);
    viewport.style.height = maxH + 'px';
    viewport.style.minHeight = maxH + 'px';

    slideEls.forEach(function (slide, i) {
      slide.style.position = 'absolute';
      slide.style.left = '0';
      slide.style.right = '0';
      slide.style.top = '0';
      slide.style.height = 'auto';
      slide.classList.toggle('active', i === 0);
    });

    return maxH;
  }

  function initCarousel(root, options) {
    if (!root) return { stop: function () {} };

    options = options || {};
    const panel = root.querySelector('.rs-panel-carousel') || root;
    const intervalMs = Math.max(2000, Number(options.intervalMs)
      || Number(panel.getAttribute('data-interval'))
      || 10000);
    panel.style.setProperty('--rs-carousel-ms', intervalMs + 'ms');

    const slides = panel.querySelectorAll('.rs-carousel-slide');
    const dots = panel.querySelectorAll('.rs-carousel-dot');
    const tabs = panel.querySelectorAll('.rs-blitz-tab');
    const labelEl = panel.querySelector('[data-carousel-label]');
    const currentEl = panel.querySelector('[data-carousel-current]');
    if (!slides.length) return { stop: function () {} };

    lockCarouselViewport(panel);

    let idx = 0;
    let timer = null;
    let dotAnimTimer = null;

    function restartDotAnim() {
      dots.forEach((dot, i) => {
        dot.classList.remove('active', 'animating');
        if (i === idx) {
          dot.classList.add('active');
          void dot.offsetWidth;
          dot.classList.add('animating');
        }
      });
      clearTimeout(dotAnimTimer);
      dotAnimTimer = setTimeout(function () {
        const dot = dots[idx];
        if (dot) dot.classList.remove('animating');
      }, intervalMs);
    }

    function show(nextIdx) {
      idx = (nextIdx + slides.length) % slides.length;
      slides.forEach(function (slide, i) {
        slide.classList.toggle('active', i === idx);
      });
      if (labelEl && slides[idx]) {
        labelEl.textContent = slides[idx].getAttribute('data-label') || '';
      }
      tabs.forEach(function (tab, i) {
        tab.classList.toggle('active', i === idx);
      });
      if (currentEl) currentEl.textContent = String(idx + 1);
      restartDotAnim();
    }

    function next() {
      show(idx + 1);
    }

    function start() {
      clearInterval(timer);
      timer = setInterval(next, intervalMs);
    }

    show(0);
    start();

    return {
      stop: function () {
        clearInterval(timer);
        clearTimeout(dotAnimTimer);
        timer = null;
      },
      goTo: show
    };
  }

  function initCarousels(root, options) {
    if (!root) return { stop: function () {} };

    const panels = root.matches && root.matches('.rs-panel-carousel')
      ? [root]
      : Array.from(root.querySelectorAll('.rs-panel-carousel'));
    if (!panels.length) return initCarousel(root, options);

    const controllers = panels.map(function (panel) {
      return initCarousel(panel, options);
    });

    return {
      stop: function () {
        controllers.forEach(function (ctl) { ctl.stop(); });
      },
      controllers: controllers
    };
  }

  function demoSummary() {
    return {
      visible: true,
      replayKey: 'demo',
      replayFile: 'demo_replay.tbreplay',
      hero: { nickname: 'Xasya', tankName: 'Bat.-Chatillon 25 t', mapName: 'Италия' },
      outcome: 'team-carry',
      stats: {
        damageDealt: 4640,
        frags: 3,
        shotsFired: 14,
        hits: 12,
        penetrations: 9,
        rankBattle: 2,
        rankTeam: 1,
        teamShare: 38,
        battleShare: 17,
        teamShareLabel: 'Нанёс 38% урона своей команды',
        battleShareLabel: 'Нанёс 17% всего урона в бою'
      },
      teamSummary: {
        allies: {
          label: 'Союзники', team: 1, players: 7,
          totalDamage: 12223, totalFrags: 5, shotsFired: 47, hits: 33, penetrations: 29,
          avgDamage: 1746, hitRatePct: 70, penRatePct: 88, avgDamagePerHit: 370
        },
        enemies: {
          label: 'Противники', team: 2, players: 7,
          totalDamage: 15690, totalFrags: 4, shotsFired: 40, hits: 35, penetrations: 34,
          avgDamage: 2241, hitRatePct: 88, penRatePct: 97, avgDamagePerHit: 448
        }
      },
      hpChart: {
        durationSec: 172,
        alliesMaxHp: 14681,
        enemiesMaxHp: 14418,
        points: [
          { t: 0, allies: 14681, enemies: 14418 },
          { t: 30, allies: 13200, enemies: 13800 },
          { t: 60, allies: 11800, enemies: 12100 },
          { t: 90, allies: 10500, enemies: 10900 },
          { t: 120, allies: 9200, enemies: 9800 },
          { t: 150, allies: 8100, enemies: 8700 },
          { t: 172, allies: 7600, enemies: 8200 }
        ]
      },
      facts: [
        { icon: '⭐', text: 'Лучший урон в своей команде' },
        { icon: '🔥', text: 'Нанёс 38% урона команды — главный carry' },
        { icon: '🎯', text: '86% точность — почти не промахивался' },
        { icon: '🏅', text: 'Top-2 по урону среди 14 танков' }
      ]
    };
  }

  root.ReplaySummaryUI = {
    UI_VERSION,
    fmtNum,
    esc,
    outcomeLabel,
    getCarouselSlides,
    renderCarouselSlideCard,
    renderSummaryHtml,
    renderCarouselPanelHtml,
    renderSummaryCarouselHtml,
    renderSummaryCarouselCardsHtml,
    initCarousel,
    initCarousels,
    demoSummary
  };

  function bindViewportFit(options) {
    options = options || {};
    if (!options.wrap && typeof options.getWrap !== 'function') {
      return { update: function () {}, stop: function () {} };
    }

    const renderScale = Math.max(1, Math.min(3, Number(
      options.renderScale != null ? options.renderScale : options.manualScale
    ) || 2));
    const designW = Number(options.designWidth) || Number(options.fallbackWidth) || 0;
    const designH = Number(options.designHeight) || Number(options.fallbackHeight) || 0;
    const maxScaleOpt = options.maxScale;
    const maxScale = maxScaleOpt != null
      ? Math.max(0.1, Number(maxScaleOpt) || renderScale)
      : renderScale;
    const pollMs = Number(options.pollMs) || 400;

    function resolveWrap() {
      if (typeof options.getWrap === 'function') return options.getWrap();
      return options.wrap;
    }

    function resolveContent(wrap) {
      if (typeof options.getContent === 'function') return options.getContent(wrap);
      if (options.content) return options.content;
      return wrap.firstElementChild || wrap;
    }

    function readHostSize(host) {
      if (host && host !== document.body && host !== document.documentElement) {
        const rect = host.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return { width: rect.width, height: rect.height };
        }
        if (host.clientWidth > 0 && host.clientHeight > 0) {
          return { width: host.clientWidth, height: host.clientHeight };
        }
      }
      return { width: window.innerWidth, height: window.innerHeight };
    }

    let rafId = 0;
    let pollTimer = null;
    let lastHostW = 0;
    let lastHostH = 0;
    let lastContentW = 0;
    let lastContentH = 0;
    let lastScale = 0;
    let observedContent = null;

    function trackContent(content) {
      if (!ro || !content || content === observedContent) return;
      if (observedContent) {
        try { ro.unobserve(observedContent); } catch (_) { /* ignore */ }
      }
      ro.observe(content);
      observedContent = content;
    }

    function resetMeasureCache() {
      lastHostW = 0;
      lastHostH = 0;
      lastContentW = 0;
      lastContentH = 0;
      lastScale = 0;
    }

    function measureContent(content, wrap) {
      const fallbackW = Number(options.fallbackWidth) || 480;
      const fallbackH = Number(options.fallbackHeight) || 0;
      const layoutW = Math.max(content.offsetWidth || 0, content.scrollWidth || 0);
      const layoutH = Math.max(
        content.offsetHeight || 0,
        content.scrollHeight || 0,
        wrap.scrollHeight || 0
      );
      return {
        w: Math.max(layoutW, designW, fallbackW),
        h: Math.max(layoutH, designH, fallbackH) || 400
      };
    }

    function update(force) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(function () {
        rafId = 0;
        const wrap = resolveWrap();
        if (!wrap) return;

        const content = resolveContent(wrap);
        if (!content) return;
        if (content.classList && content.classList.contains('hidden')) return;
        trackContent(content);

        const measured = measureContent(content, wrap);
        const w = measured.w;
        const h = measured.h;

        const padOpt = Number(options.padding);
        const padding = Number.isFinite(padOpt) ? padOpt : 12;
        const host = options.fitHost || document.body;
        const hostSize = readHostSize(host);
        const availW = Math.max(1, hostSize.width - padding * 2);
        const availH = Math.max(1, hostSize.height - padding * 2);
        const minScale = Number(options.minScale) || 0.08;

        let totalScale;
        if (options.fitPriority === 'width') {
          totalScale = Math.max(minScale, Math.min(availW / w, maxScale));
        } else {
          totalScale = Math.max(
            minScale,
            Math.min(availW / w, availH / h, maxScale)
          );
        }

        const hostStable = hostSize.width === lastHostW && hostSize.height === lastHostH;
        const contentStable = Math.abs(w - lastContentW) < 2 && Math.abs(h - lastContentH) < 2;
        const scaleStable = Math.abs(totalScale - lastScale) < 0.002;
        if (!force && hostStable && contentStable && scaleStable && lastScale > 0) return;

        lastContentW = w;
        lastContentH = h;
        lastHostW = hostSize.width;
        lastHostH = hostSize.height;
        lastScale = totalScale;

        const origin = options.transformOrigin
          || (options.anchorTop ? 'top center' : 'center center');
        wrap.style.transformOrigin = origin;
        wrap.style.transform = 'scale(' + totalScale + ')';

        if (typeof options.onScale === 'function') {
          options.onScale(totalScale, { width: w, height: h, renderScale: renderScale });
        }
      });
    }

    function pollHost() {
      const host = options.fitHost || document.body;
      const hostSize = readHostSize(host);
      if (hostSize.width !== lastHostW || hostSize.height !== lastHostH) update();
    }

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    const observeHost = options.fitHost || document.body;
    if (ro && observeHost) ro.observe(observeHost);
    window.addEventListener('resize', update);
    if (pollMs > 0) pollTimer = setInterval(pollHost, pollMs);

    return {
      update: function (force) { update(force); },
      resetMeasureCache: resetMeasureCache,
      scheduleUpdates: function () {
        resetMeasureCache();
        update(true);
        requestAnimationFrame(function () {
          update(true);
          requestAnimationFrame(function () { update(true); });
        });
        setTimeout(function () { update(true); }, 60);
        setTimeout(function () { update(true); }, 220);
      },
      stop: function () {
        if (rafId) cancelAnimationFrame(rafId);
        if (pollTimer) clearInterval(pollTimer);
        if (ro) ro.disconnect();
        window.removeEventListener('resize', update);
      },
      getRenderScale: function () { return renderScale; }
    };
  }

  root.ReplaySummaryUI.bindViewportFit = bindViewportFit;
})(typeof window !== 'undefined' ? window : globalThis);
