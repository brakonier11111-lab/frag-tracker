/**
 * Создаёт модульную структура src/ и обновляет server.js (удаляет перенесённые блоки).
 * Запуск: node scripts/refactor-architecture.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverPath = path.join(ROOT, 'server.js');
let server = fs.readFileSync(serverPath, 'utf8');
const lines = server.split(/\r?\n/);

function removeLines(start, end) {
    // 1-based inclusive
    return lines.slice(0, start - 1).concat(lines.slice(end));
}

function write(rel, content) {
    const full = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    console.log('  +', rel);
}

// --- core ---
write('src/bootstrap/paths.js', `'use strict';
const path = require('path');
const fs = require('fs');

const APP_ROOT = process.env.FRAG_APP_ROOT || path.join(__dirname, '..', '..');
const USER_DATA = process.env.FRAG_USER_DATA || APP_ROOT;

function loadEnv() {
    const envCandidates = [
        path.join(USER_DATA, 'config.env'),
        path.join(USER_DATA, '.env'),
        path.join(APP_ROOT, 'config.env'),
        path.join(APP_ROOT, '.env')
    ];
    for (const envPath of envCandidates) {
        if (fs.existsSync(envPath)) {
            require('dotenv').config({ path: envPath });
            return envPath;
        }
    }
    const fallback = path.join(APP_ROOT, 'config.env');
    require('dotenv').config({ path: fallback });
    return fallback;
}

function resolveDbPath() {
    const userDb = path.join(USER_DATA, 'frag_tracker.db');
    if (USER_DATA !== APP_ROOT) {
        if (!fs.existsSync(userDb)) {
            const legacyDb = path.join(APP_ROOT, 'frag_tracker.db');
            if (fs.existsSync(legacyDb)) {
                try {
                    fs.mkdirSync(USER_DATA, { recursive: true });
                    fs.copyFileSync(legacyDb, userDb);
                    console.log('📦 База данных скопирована в:', userDb);
                } catch (e) {
                    console.warn('⚠️ Не удалось скопировать БД:', e.message);
                }
            }
        }
        return userDb;
    }
    return path.join(APP_ROOT, 'frag_tracker.db');
}

module.exports = { APP_ROOT, USER_DATA, loadEnv, resolveDbPath };
`);

write('src/core/utils.js', `'use strict';

function safeJsonParse(str, fallback) {
    try {
        const v = JSON.parse(str);
        return v == null ? fallback : v;
    } catch {
        return fallback;
    }
}

function clampNum(value, min, max) {
    let v = Number(value);
    if (!isFinite(v)) v = min;
    if (min != null && v < min) v = min;
    if (max != null && v > max) v = max;
    return v;
}

function round2(v) {
    return Math.round((Number(v) || 0) * 100) / 100;
}

module.exports = { safeJsonParse, clampNum, round2 };
`);

// --- blitz: wrap extracted code ---
const blitzCore = fs.readFileSync(path.join(ROOT, 'src/_extracted/blitz-core.js'), 'utf8');
const blitzRoutes = fs.readFileSync(path.join(ROOT, 'src/_extracted/blitz-routes.js'), 'utf8');

write('src/modules/blitz-challenge/constants.js', `'use strict';

const BLITZ_DEFAULT_HEADERS = {
    winrate: 'УДЕРЖАТЬ % ПОБЕД ЗА СТРИМ',
    damage: 'УДЕРЖАТЬ СРЕДНИЙ УРОН ЗА СТРИМ',
    medals: 'ВЗЯТЬ МЕДАЛИ ЗА СТРИМ'
};

module.exports = { BLITZ_DEFAULT_HEADERS };
`);

write('src/modules/blitz-challenge/schema.js', `'use strict';

const { BLITZ_DEFAULT_HEADERS } = require('./constants');
const { safeJsonParse } = require('../../core/utils');

/** Миграции таблиц blitz_challenge — вызывается из db.serialize в server.js */
function initBlitzChallengeSchema(db) {
    db.run(\`CREATE TABLE IF NOT EXISTS blitz_challenge (
        id INTEGER PRIMARY KEY DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        session_balance REAL NOT NULL DEFAULT 0,
        wr_enabled INTEGER NOT NULL DEFAULT 1,
        wr_start REAL NOT NULL DEFAULT 60,
        wr_current REAL NOT NULL DEFAULT 60,
        wr_cap REAL NOT NULL DEFAULT 85,
        wr_per_amount REAL NOT NULL DEFAULT 100,
        wr_step REAL NOT NULL DEFAULT 1,
        dmg_enabled INTEGER NOT NULL DEFAULT 1,
        dmg_start REAL NOT NULL DEFAULT 2000,
        dmg_current REAL NOT NULL DEFAULT 2000,
        dmg_cap REAL NOT NULL DEFAULT 5000,
        dmg_per_amount REAL NOT NULL DEFAULT 100,
        dmg_step REAL NOT NULL DEFAULT 100,
        medals_enabled INTEGER NOT NULL DEFAULT 1,
        medals_required REAL NOT NULL DEFAULT 1,
        medals_start REAL NOT NULL DEFAULT 1,
        medals_cap REAL NOT NULL DEFAULT 12,
        medals_per_amount REAL NOT NULL DEFAULT 200,
        medals_step REAL NOT NULL DEFAULT 1,
        medals_types TEXT NOT NULL DEFAULT '[]',
        medals_baseline TEXT NOT NULL DEFAULT '{}',
        medals_earned INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )\`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы blitz_challenge:', err);
        } else {
            const defaultMedals = JSON.stringify([
                { code: 'markOfMastery', label: 'Мастер', icon: '🎖️' },
                { code: 'medalRadleyWalters', label: 'Калибр', icon: '🔥' },
                { code: 'medalKnispel', label: 'Стальной дождь', icon: '⚡' },
                { code: 'titleSniper', label: 'Снайпер', icon: '🎯' },
                { code: 'medalKay', label: 'Бог войны', icon: '👑' }
            ]);
            db.run('INSERT OR IGNORE INTO blitz_challenge (id, medals_types) VALUES (1, ?)', [defaultMedals], (e) => {
                if (e && !e.message.includes('UNIQUE')) console.error('❌ Ошибка инициализации blitz_challenge:', e);
                else console.log('✅ Таблица blitz_challenge готова');
            });
        }
    });

    db.run("ALTER TABLE blitz_challenge ADD COLUMN medals_list TEXT NOT NULL DEFAULT '[]'", (err) => {
        if (err && !String(err.message).includes('duplicate column')) return;
        db.get('SELECT medals_list FROM blitz_challenge WHERE id = 1', (e, row) => {
            if (e || !row) return;
            const cur = (row.medals_list || '').trim();
            if (cur && cur !== '[]') return;
            const seed = JSON.stringify([
                { id: 'm1', label: 'Калибр', icon: '🔥', image: '', required: 1, earned: 0 }
            ]);
            db.run('UPDATE blitz_challenge SET medals_list = ? WHERE id = 1', [seed]);
        });
    });
    db.run("ALTER TABLE blitz_challenge ADD COLUMN active_type TEXT NOT NULL DEFAULT 'winrate'", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN header_text TEXT NOT NULL DEFAULT ''", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN consequence_text TEXT NOT NULL DEFAULT ''", () => {});
    db.run("ALTER TABLE blitz_challenge ADD COLUMN header_texts TEXT NOT NULL DEFAULT ''", (err) => {
        if (err && !String(err.message).includes('duplicate column')) return;
        db.get('SELECT active_type, header_text, header_texts FROM blitz_challenge WHERE id = 1', (e, row) => {
            if (e || !row) return;
            const cur = (row.header_texts || '').trim();
            if (cur && cur !== '{}' && cur !== '[]') return;
            const legacy = (row.header_text || '').trim();
            const seed = {
                winrate: legacy || BLITZ_DEFAULT_HEADERS.winrate,
                damage: BLITZ_DEFAULT_HEADERS.damage,
                medals: BLITZ_DEFAULT_HEADERS.medals
            };
            db.run('UPDATE blitz_challenge SET header_texts = ?, header_text = ? WHERE id = 1', [JSON.stringify(seed), '']);
        });
    });
    db.run(\`CREATE TABLE IF NOT EXISTS blitz_challenge_presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )\`, (err) => {
        if (err) console.error('❌ Ошибка создания таблицы blitz_challenge_presets:', err);
    });
}

module.exports = { initBlitzChallengeSchema };
`);

// Build blitz index by transforming extracted code
const blitzServiceBody = blitzCore
    .replace(/^function safeJsonParse[\s\S]*?^function round2[\s\S]*?\n\}/m, '')
    .replace(/^const BLITZ_DEFAULT_HEADERS = [\s\S]*?};\n\n/m, "const { BLITZ_DEFAULT_HEADERS } = require('./constants');\nconst { safeJsonParse, clampNum, round2 } = require('../../core/utils');\n\n")
    .replace(/\bdb\./g, 'deps.db.')
    .replace(/\bbroadcastToClients\b/g, 'deps.broadcastToClients')
    .replace(/\bgetAppState\b/g, 'deps.getAppState')
    .replace(/\bgetLestaCountersFromState\b/g, 'deps.getLestaCountersFromState')
    .replace(/\bcomputeLestaPeriodDelta\b/g, 'deps.computeLestaPeriodDelta')
    .replace(/\bfetchLestaHistoryWindow\b/g, 'deps.fetchLestaHistoryWindow')
    .replace(/\bcomputeLestaPeriodStatsFromRows\b/g, 'deps.computeLestaPeriodStatsFromRows');

const blitzRoutesBody = blitzRoutes
    .replace(/^\/\/ ---- API.*\n/m, '')
    .replace(/\bapp\./g, 'app.')
    .replace(/\bgetBlitzChallengeRow\b/g, 'getBlitzChallengeRow')
    .replace(/\bnormalizeBlitzRow\b/g, 'normalizeBlitzRow')
    .replace(/\bresolveBlitzHeaderTexts\b/g, 'resolveBlitzHeaderTexts')
    .replace(/\bBLITZ_DEFAULT_HEADERS\b/g, 'BLITZ_DEFAULT_HEADERS')
    .replace(/\bclampNum\b/g, 'clampNum')
    .replace(/\bsafeJsonParse\b/g, 'safeJsonParse')
    .replace(/\bupdateBlitzChallenge\b/g, 'updateBlitzChallenge')
    .replace(/\bfetchBlitzBattleProgress\b/g, 'fetchBlitzBattleProgress')
    .replace(/\bbroadcastToClients\b/g, 'deps.broadcastToClients')
    .replace(/\bgetAppState\b/g, 'deps.getAppState')
    .replace(/\bupdateAppState\b/g, 'deps.updateAppState')
    .replace(/\bdb\./g, 'deps.db.')
    .replace(/path\.join\(__dirname,/g, 'path.join(deps.appRoot,');

write('src/modules/blitz-challenge/index.js', `'use strict';

const path = require('path');
const fs = require('fs');
const { BLITZ_DEFAULT_HEADERS } = require('./constants');
const { safeJsonParse, clampNum, round2 } = require('../../core/utils');
const { initBlitzChallengeSchema } = require('./schema');

function createBlitzChallengeModule(deps) {
${blitzServiceBody.split('\n').map(l => '    ' + l).join('\n')}

    function registerRoutes(app) {
${blitzRoutesBody.split('\n').map(l => '        ' + l).join('\n')}
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
`);

// roulette module
const rouletteRaw = fs.readFileSync(path.join(ROOT, 'src/_extracted/roulette.js'), 'utf8');
const rouletteBody = rouletteRaw
    .replace(/^\/\/ =+[\s\S]*?\n\n/m, '')
    .replace(/\bdb\./g, 'db.');

write('src/modules/roulette/index.js', `'use strict';

const express = require('express');

function registerRouletteRoutes(app, db) {
${rouletteBody.split('\n').map(l => '    ' + l).join('\n')}
}

module.exports = { registerRouletteRoutes };
`);

// razblog module
const razblogRaw = fs.readFileSync(path.join(ROOT, 'src/_extracted/razblog.js'), 'utf8');
const razblogBody = razblogRaw
    .replace(/^\/\/ ---[\s\S]*?\n\n/m, '')
    .replace(/\bRAZBLOG_ENABLED\b/g, 'config.razblogEnabled')
    .replace(/\bcreateRazblogirovkaGoldService\b/g, 'config.createRazblogirovkaGoldService')
    .replace(/\bdb\b/g, 'deps.db')
    .replace(/\bgetAppState\b/g, 'deps.getAppState')
    .replace(/\bupdateAppState\b/g, 'deps.updateAppState')
    .replace(/\bgetLestaPlayerStats\b/g, 'deps.getLestaPlayerStats')
    .replace(/\bbroadcastToClients\b/g, 'deps.broadcastToClients');

write('src/modules/razblog/index.js', `'use strict';

function createRazblogModule(deps, config) {
    let razblogirovkaGoldService = null;

${razblogBody.split('\n').map(l => '    ' + l).join('\n')}

    function registerPages(app) {
        app.get('/razblogirovka', (req, res) => {
            if (!config.razblogEnabled) {
                return res.status(410).send('РазБЛОГировка 2026 отключена. Уберите RAZBLOG_ENABLED=0 и перезапустите сервер.');
            }
            res.sendFile(require('path').join(config.archiveDir, 'public', 'razblogirovka.html'));
        });
    }

    function registerRoutes(app) {
        // routes already use app.get/post above — move them into registerRoutes by wrapping
    }

    return {
        initRazblogirovkaGoldService,
        getService: () => razblogirovkaGoldService,
        registerPages
    };
}

module.exports = { createRazblogModule };
`);

// Fix razblog - the routes need to be in registerRoutes function. Let me rewrite razblog module properly
write('src/modules/razblog/index.js', fs.readFileSync(path.join(ROOT, 'src/_extracted/razblog.js'), 'utf8')
    .replace(/^\/\/ ---[^\n]*\n/, '')
    .replace(/^let razblogirovkaGoldService/m, 'function createRazblogModule(deps, config) {\n    let razblogirovkaGoldService')
    .replace(/\bRAZBLOG_ENABLED\b/g, 'config.razblogEnabled')
    .replace(/\bcreateRazblogirovkaGoldService\b/g, 'config.createRazblogirovkaGoldService')
    .replace(/\bdb,/g, 'deps.db,')
    .replace(/\bdb\./g, 'deps.db.')
    .replace(/\bgetAppState,/g, 'deps.getAppState,')
    .replace(/\bupdateAppState,/g, 'deps.updateAppState,')
    .replace(/\bgetLestaPlayerStats,/g, 'deps.getLestaPlayerStats,')
    .replace(/\bbroadcastToClients/g, 'deps.broadcastToClients')
    .replace(/(\napp\.)/g, '\n    function registerRoutes(app) {\n    app.')
    + `\n    }\n\n    function registerPages(app) {
        app.get('/razblogirovka', (req, res) => {
            if (!config.razblogEnabled) {
                return res.status(410).send('РазБЛОГировка 2026 отключена. Уберите RAZBLOG_ENABLED=0 и перезапустите сервер.');
            }
            res.sendFile(require('path').join(config.archiveDir, 'public', 'razblogirovka.html'));
        });
    }\n\n    return { initRazblogirovkaGoldService, getService: () => razblogirovkaGoldService, registerRoutes, registerPages };\n}\n\nmodule.exports = { createRazblogModule };\n`);

// registerModules
write('src/registerModules.js', `'use strict';

const { createBlitzChallengeModule } = require('./modules/blitz-challenge');
const { registerRouletteRoutes } = require('./modules/roulette');
const { createRazblogModule } = require('./modules/razblog');

/**
 * Подключает вынесенные модули к Express-приложению.
 * @returns {{ blitz, razblog }}
 */
function registerModules(app, deps, config) {
    const blitz = createBlitzChallengeModule(deps);
    blitz.registerPages(app);
    blitz.registerRoutes(app);

    registerRouletteRoutes(app, deps.db);

    const razblog = createRazblogModule(deps, config);
    razblog.registerPages(app);
    razblog.registerRoutes(app);

    return { blitz, razblog };
}

module.exports = { registerModules };
`);

// Archive test pages script
write('scripts/archive-test-pages.js', `'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const ARCHIVE = path.join(ROOT, '_archive');

const KEEP = new Set([
    'index.html', 'admin.html', 'analytics.html', 'menu.html',
    'mode1-frag-tracker.html', 'mode2-timer.html', 'tank-queue.html',
    'donation-management.html', 'donation-goal.html', 'donations-dashboard.html',
    'donation-driven-widget.html', 'frag-stats.html', 'chat-stats.html',
    'lesta-stats.html', 'stream-integrations.html', 'stream-stats-widgets.html',
    'tanks-blitz-challenge.html', 'donor-achievements.html', 'schedule.html',
    'tournament.html', 'alert-replay.html', 'alert-mode1.html', 'alert-mode2.html', 'alert-mode3.html',
    'widget-mode1.html', 'widget-mode2.html', 'widget-mode3.html',
    'widget-donation-goal.html', 'widget-donation-driven.html', 'widget-donation-driven-damage.html',
    'widget-tanks-blitz-challenge.html', 'widget-tank-queue.html', 'widget-tank-queue-obs.html',
    'widget-donors-top.html', 'widget-donors-top-unified.html', 'widget-donors-top-daily.html',
    'widget-stream-online.html', 'widget-stream-likes.html', 'widget-stream-likes-tank.html',
    'widget-stream-duration.html', 'widget-stream-duration-borderless.html',
    'widget-schedule.html', 'widget-roulette.html', 'widget-roulette-text.html',
    'widget-last-donation.html', 'widget-tournament-scores.html', 'widget-tournament-bracket.html',
    'widget-donation-bar.html', 'rewards-manager.html', 'vkplay-rewards.html',
    'oauth-vkplay-implicit.html', 'components', 'styles', 'uploads', 'widget-assets', '_archive'
]);

const TEST_PATTERNS = [
    /^test-/i, /^debug-/i, /^check-/i, /^fix-/i, /^adjust-/i, /^remove-/i,
    /^force-/i, /^database-init/, /^setup-widget/, /^donor-tiers/,
    /^donation-bar-(enhanced|obs|themes|customizable)/,
    /^widget-timer-\d+/, /^widget-temperature/, /^widget-mode2-copy/,
    /^widget-mode2-borderless/, /^widget-slowdown/, /^widget-modes-/,
    /^widget-marathon/, /^widget-donors-top-experiment/,
    /^index-new/, /^index-modern/, /^dashboard-new/,
    /^donations-analytics/, /^lesta-test/, /^lesta-api-test/, /^donatepay-test/,
    /^donation-alerts-test/, /^websocket-test/, /^test-analytics/
];

function shouldArchive(name) {
    if (KEEP.has(name)) return false;
    return TEST_PATTERNS.some(p => p.test(name));
}

if (!fs.existsSync(ARCHIVE)) fs.mkdirSync(ARCHIVE, { recursive: true });

let moved = 0;
for (const name of fs.readdirSync(ROOT)) {
    if (name === '_archive' || name === 'components' || name === 'styles' || name === 'uploads' || name === 'widget-assets') continue;
    const full = path.join(ROOT, name);
    if (!fs.statSync(full).isFile()) continue;
    if (!shouldArchive(name)) continue;
    fs.renameSync(full, path.join(ARCHIVE, name));
    console.log('archived', name);
    moved++;
}
console.log('Done. Moved', moved, 'files to public/_archive/');
`);

write('src/README.md', `# Архитектура Frag Tracker

\`\`\`
src/
  bootstrap/paths.js     — пути, .env, расположение БД
  core/utils.js          — safeJsonParse, clampNum, round2
  modules/
    blitz-challenge/     — Tanks Blitz Challenge (API + сервис)
    roulette/            — API рулетки
    razblog/             — РазБЛОГировка (копилка золота)
  registerModules.js     — регистрация модулей в Express
\`\`\`

## Дальнейший рефакторинг

Планируется вынести в отдельные модули:
- \`donations/\` — DonationAlerts, DonatePay, polling
- \`lesta/\` — Lesta API, сессии, frag-stats
- \`widgets/\` — donation-driven, donation-goal
- \`pages/\` — маршруты HTML-страниц
- \`core/app-state.js\` — getAppState / updateAppState
- \`core/websocket.js\` — broadcastToClients

\`server.js\` остаётся точкой входа до полного переноса.
`);

console.log('\nPatching server.js...');

// Remove sections from server.js (bottom-up to preserve line numbers)
let L = lines.slice();
const removals = [
    [13551, 13620], // razblog routes (before blitz removal - check line numbers)
    [12805, 13303], // blitz
    [6792, 6974],   // roulette
    [604, 694],     // blitz schema
];
removals.sort((a, b) => b[0] - a[0]);
for (const [start, end] of removals) {
    L = L.slice(0, start - 1).concat(L.slice(end));
    console.log(`  removed lines ${start}-${end}`);
}

let patched = L.join('\n');

// Replace bootstrap at top
patched = patched.replace(
    /const path = require\('path'\);\r?\nconst fs = require\('fs'\);\r?\n\r?\nconst APP_ROOT[\s\S]*?return path\.join\(APP_ROOT, 'frag_tracker\.db'\);\r?\n\}/,
    `const { APP_ROOT, USER_DATA, loadEnv, resolveDbPath } = require('./src/bootstrap/paths');\nloadEnv();`
);

// Add module requires after express app creation (after port line)
if (!patched.includes("registerModules")) {
    patched = patched.replace(
        /const port = process\.env\.PORT \|\| 3000;/,
        `const port = process.env.PORT || 3000;\nconst { registerModules } = require('./src/registerModules');\nconst { initBlitzChallengeSchema } = require('./src/modules/blitz-challenge/schema');\nlet blitzModule = null;\nlet razblogModuleRef = null;`
    );
}

// Replace blitz schema block with init call
patched = patched.replace(
    /    \/\/ ===== Tanks Blitz Challenge[\s\S]*?    \}\)\;\r?\n\r?\n    db\.run\(`ALTER TABLE donation_driven_widgets ADD COLUMN goal_text/,
    `    initBlitzChallengeSchema(db);\n\n    db.run(\`ALTER TABLE donation_driven_widgets ADD COLUMN goal_text`
);

// Insert module registration before server.listen
const listenMarker = '// Запуск сервера\nserver.listen';
if (!patched.includes('registerModules(app')) {
    patched = patched.replace(
        listenMarker,
        `// Модули (src/modules/*)
const moduleDeps = {
    db,
    appRoot: APP_ROOT,
    getAppState,
    updateAppState,
    broadcastToClients,
    getLestaCountersFromState,
    computeLestaPeriodDelta,
    fetchLestaHistoryWindow,
    computeLestaPeriodStatsFromRows,
    getLestaPlayerStats
};
const moduleConfig = {
    razblogEnabled: RAZBLOG_ENABLED,
    createRazblogirovkaGoldService,
    archiveDir: RAZBLOG_ARCHIVE_DIR
};
const modules = registerModules(app, moduleDeps, moduleConfig);
blitzModule = modules.blitz;
razblogModuleRef = modules.razblog;

function updateBlitzChallenge(amount, donation) {
    if (blitzModule) blitzModule.updateBlitzChallenge(amount, donation);
}

${listenMarker}`
    );
}

// Replace razblog init in listen callback
patched = patched.replace(
    /if \(RAZBLOG_ENABLED\) \{\s*\n\s*initRazblogirovkaGoldService\(\);/,
    'if (RAZBLOG_ENABLED) {\n        if (razblogModuleRef) razblogModuleRef.initRazblogirovkaGoldService();'
);

// Replace razblog sync in lesta polling if exists
patched = patched.replace(
    /if \(RAZBLOG_ENABLED && !err && razblogirovkaGoldService && state\.razblog_tracking_active\)/,
    'if (RAZBLOG_ENABLED && !err && razblogModuleRef && razblogModuleRef.getService() && state.razblog_tracking_active)'
);
patched = patched.replace(
    /razblogirovkaGoldService\.syncFromLestaStats/g,
    'razblogModuleRef.getService().syncFromLestaStats'
);

// Remove duplicate page routes moved to modules
patched = patched.replace(/\napp\.get\('\/tanks-blitz-challenge'[\s\S]*?tanks-blitz-challenge\.html'\)\);\n/, '\n');
patched = patched.replace(/\napp\.get\('\/razblogirovka'[\s\S]*?razblogirovka\.html'\)\);\n\}\);\n/, '\n');

// Remove local updateBlitzChallenge call wrapper if duplicate - the function is now wrapper

fs.writeFileSync(serverPath, patched, 'utf8');
console.log('\n✅ server.js patched');
console.log('Run: node scripts/archive-test-pages.js');
console.log('Then: npm start');
