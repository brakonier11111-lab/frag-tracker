#!/usr/bin/env node
'use strict';
/*
 * Патч производительности для «Стримерской» (frag-tracker).
 * Запуск: положите файл в папку приложения (где лежит server.js) и выполните
 *     node apply-perf-fix.js
 * Перед изменением каждого файла создаётся копия <файл>.bak-perf.
 * Если ваш файл отличается от ожидаемого, правка пропускается и файл не трогается.
 * Повторный запуск безопасен: уже применённые правки распознаются.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const PATCHES = {
 "electron/main.js": [
  [
   "const fs = require('fs');\nconst http = require('http');\nconst { spawn, execSync } = require('child_process');\n\nconst PORT = Number(process.env.PORT) || 3000;\nconst SERVER_URL = `http://127.0.0.1:${PORT}/`;",
   "const fs = require('fs');\nconst http = require('http');\nconst { spawn, execSync } = require('child_process');\nconst os = require('os');\n\n// Приложение работает рядом с игрой — не конкурируем с ней за процессор.\ntry {\n    os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);\n} catch (_) { /* noop */ }\n\nconst PORT = Number(process.env.PORT) || 3000;\nconst SERVER_URL = `http://127.0.0.1:${PORT}/`;"
  ],
  [
   "    // перехвата редирект всё равно подменял бы главное окно.\n    mainWindow.webContents.on('will-redirect', interceptExternalNav);\n\n    mainWindow.on('close', (event) => {\n        if (!isQuitting) {\n            event.preventDefault();",
   "    // перехвата редирект всё равно подменял бы главное окно.\n    mainWindow.webContents.on('will-redirect', interceptExternalNav);\n\n    // Пока фокус в игре, окно панели остаётся видимым (второй монитор, свёрнутая\n    // игра в окне) и продолжает рисовать CSS-анимации на той же видеокарте.\n    // Ставим все анимации на паузу, пока окно не в фокусе.\n    let pausedCssKey = null;\n    const pauseAnimations = async () => {\n        if (!mainWindow || pausedCssKey) return;\n        try {\n            pausedCssKey = await mainWindow.webContents.insertCSS(\n                '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }'\n            );\n        } catch (_) { pausedCssKey = null; }\n    };\n    const resumeAnimations = async () => {\n        if (!mainWindow || !pausedCssKey) return;\n        const key = pausedCssKey;\n        pausedCssKey = null;\n        try { await mainWindow.webContents.removeInsertedCSS(key); } catch (_) { /* noop */ }\n    };\n    mainWindow.on('blur', pauseAnimations);\n    mainWindow.on('focus', resumeAnimations);\n    mainWindow.webContents.on('did-navigate', () => {\n        // insertCSS живёт до перехода на другую страницу\n        pausedCssKey = null;\n        if (!mainWindow.isFocused()) pauseAnimations();\n    });\n\n    mainWindow.on('close', (event) => {\n        if (!isQuitting) {\n            event.preventDefault();"
  ]
 ],
 "public/donation-management.html": [
  [
   "    body.theme-neon.theme-2026 {\n        background: #0e0e12 !important;\n    }\n    /* живой фон */\n    body.theme-neon.theme-2026::before {\n        content: '';\n        position: fixed; inset: 0; z-index: 0; pointer-events: none;\n        background:\n            radial-gradient(45% 35% at 88% 6%, rgba(255,90,120,.14), transparent 60%),\n            radial-gradient(40% 35% at 6% 96%, rgba(110,90,255,.12), transparent 60%);\n        animation: ddmDrift 24s ease-in-out infinite alternate;\n    }\n    @keyframes ddmDrift { 0%{transform:translate3d(0,0,0)} 100%{transform:translate3d(2%,2%,0) scale(1.06)} }\n    body.theme-neon.theme-2026 > *:not(script) { position: relative; z-index: 1; }\n\n    /* HERO-шапка */",
   "    body.theme-neon.theme-2026 {\n        background: #0e0e12 !important;\n    }\n    /* фон */\n    body.theme-neon.theme-2026::before {\n        content: '';\n        position: fixed; inset: 0; z-index: 0; pointer-events: none;\n        background:\n            radial-gradient(45% 35% at 88% 6%, rgba(255,90,120,.14), transparent 60%),\n            radial-gradient(40% 35% at 6% 96%, rgba(110,90,255,.12), transparent 60%);\n        /* статичный: анимация фона на весь экран грузила видеокарту во время игры */\n    }\n    body.theme-neon.theme-2026 > *:not(script) { position: relative; z-index: 1; }\n\n    /* HERO-шапка */"
  ]
 ],
 "public/index.html": [
  [
   "                radial-gradient(40% 35% at 85% 12%, rgba(255, 90, 120, 0.16), transparent 60%),\n                radial-gradient(38% 32% at 10% 90%, rgba(110, 90, 255, 0.14), transparent 60%),\n                radial-gradient(30% 30% at 55% 45%, rgba(40, 210, 180, 0.07), transparent 60%);\n            animation: meshDrift 22s ease-in-out infinite alternate;\n            filter: saturate(1.1);\n        }\n        @keyframes meshDrift {\n            0%   { transform: translate3d(0, 0, 0) scale(1); }\n            50%  { transform: translate3d(2.5%, -2%, 0) scale(1.08); }\n            100% { transform: translate3d(-2%, 2.5%, 0) scale(1.04); }\n        }\n        .bg-fx .grain {\n            position: absolute;\n            inset: 0;",
   "                radial-gradient(40% 35% at 85% 12%, rgba(255, 90, 120, 0.16), transparent 60%),\n                radial-gradient(38% 32% at 10% 90%, rgba(110, 90, 255, 0.14), transparent 60%),\n                radial-gradient(30% 30% at 55% 45%, rgba(40, 210, 180, 0.07), transparent 60%);\n            /* Фон статичный: бесконечная анимация под backdrop-filter стеклянных\n               панелей заставляла видеокарту перерисовывать размытие каждый кадр\n               и отнимала FPS у игры. */\n            filter: saturate(1.1);\n        }\n        .bg-fx .grain {\n            position: absolute;\n            inset: 0;"
  ]
 ],
 "public/widget-battle.html": [
  [
   "    cv.width = window.innerWidth; cv.height = window.innerHeight;\n    ctx = cv.getContext('2d');\n    window.addEventListener('resize', () => { cv.width = window.innerWidth; cv.height = window.innerHeight; });\n    (function loop() {\n        ctx.clearRect(0, 0, cv.width, cv.height);\n        parts.forEach(p => {\n            p.x += p.vx; p.y += p.vy; p.vy += p.g || 0.15; p.life -= p.decay;\n            ctx.globalAlpha = Math.max(0, p.life);\n            ctx.fillStyle = p.color;\n            ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();\n        });\n        parts = parts.filter(p => p.life > 0 && p.y < cv.height + 40);\n        requestAnimationFrame(loop);\n    })();\n}\n\nfunction burst(color, count) {",
   "    cv.width = window.innerWidth; cv.height = window.innerHeight;\n    ctx = cv.getContext('2d');\n    window.addEventListener('resize', () => { cv.width = window.innerWidth; cv.height = window.innerHeight; });\n}\n\n// Цикл крутится только пока летят частицы: пустой canvas, который очищали каждый\n// кадр, заставлял OBS перерисовывать источник постоянно и грузил видеокарту.\nlet fxRaf = 0;\nfunction fxLoop() {\n    ctx.clearRect(0, 0, cv.width, cv.height);\n    parts.forEach(p => {\n        p.x += p.vx; p.y += p.vy; p.vy += p.g || 0.15; p.life -= p.decay;\n        ctx.globalAlpha = Math.max(0, p.life);\n        ctx.fillStyle = p.color;\n        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();\n    });\n    parts = parts.filter(p => p.life > 0 && p.y < cv.height + 40);\n    fxRaf = parts.length ? requestAnimationFrame(fxLoop) : 0;\n    if (!fxRaf) ctx.clearRect(0, 0, cv.width, cv.height);\n}\n\nfunction burst(color, count) {"
  ],
  [
   "            g: 0.18, color, r: 2 + Math.random() * 3, life: 1, decay: 0.012 + Math.random() * 0.012\n        });\n    }\n}\n\nfunction flash() {",
   "            g: 0.18, color, r: 2 + Math.random() * 3, life: 1, decay: 0.012 + Math.random() * 0.012\n        });\n    }\n    if (!fxRaf && parts.length) fxRaf = requestAnimationFrame(fxLoop);\n}\n\nfunction flash() {"
  ]
 ],
 "public/widget-mode2.html": [
  [
   "\n        let timerInterval = null; // legacy\n        let rafId = null;\n        let baselineStartMs = null;\n        let baselineStartSeconds = 0;\n        let streamStartTime = null;",
   "\n        let timerInterval = null; // legacy\n        let rafId = null;\n        // Таймер показывает только секунды: перерисовка каждый кадр (rAF) лишь\n        // грузила OBS и видеокарту во время игры. 4 тика в секунду достаточно.\n        const TIMER_TICK_MS = 250;\n        let baselineStartMs = null;\n        let baselineStartSeconds = 0;\n        let streamStartTime = null;"
  ],
  [
   "\n        function startAnimationLoop() {\n            if (rafId) return;\n            rafId = requestAnimationFrame(animationTick);\n        }\n\n        function stopAnimationLoop() {\n            if (rafId) {\n                cancelAnimationFrame(rafId);\n                rafId = null;\n            }\n            if (timerInterval) {",
   "\n        function startAnimationLoop() {\n            if (rafId) return;\n            rafId = setTimeout(animationTick, 0);\n        }\n\n        function stopAnimationLoop() {\n            if (rafId) {\n                clearTimeout(rafId);\n                rafId = null;\n            }\n            if (timerInterval) {"
  ],
  [
   "            const nowMs = Date.now();\n            if (currentState.timer_paused || baselineStartMs == null) {\n                renderMainTimerOnly();\n                rafId = requestAnimationFrame(animationTick);\n                return;\n            }\n            const factor = getEffectiveFactor(nowMs);",
   "            const nowMs = Date.now();\n            if (currentState.timer_paused || baselineStartMs == null) {\n                renderMainTimerOnly();\n                rafId = setTimeout(animationTick, TIMER_TICK_MS);\n                return;\n            }\n            const factor = getEffectiveFactor(nowMs);"
  ],
  [
   "                renderMainTimerOnly();\n                return;\n            }\n            rafId = requestAnimationFrame(animationTick);\n        }\n\n        function updateServerTimer() {",
   "                renderMainTimerOnly();\n                return;\n            }\n            rafId = setTimeout(animationTick, TIMER_TICK_MS);\n        }\n\n        function updateServerTimer() {"
  ]
 ],
 "public/widget-tanks-blitz-challenge.html": [
  [
   "    if(big){ const c=document.getElementById('card'); c.classList.add('shake'); setTimeout(()=>c.classList.remove('shake'),520);} }\n\nlet ctx,parts=[],cv;\nfunction initFx(){ cv=document.getElementById('fx'); const rz=()=>{cv.width=innerWidth;cv.height=innerHeight;}; rz(); addEventListener('resize',rz); ctx=cv.getContext('2d');\n    (function loop(){ ctx.clearRect(0,0,cv.width,cv.height); parts.forEach(p=>{p.x+=p.vx;p.y+=p.vy;p.vy+=p.g||0;p.life-=p.decay;\n        ctx.globalAlpha=Math.max(0,p.life);ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,7);ctx.fill();});\n        parts=parts.filter(p=>p.life>0&&p.y<cv.height+40); requestAnimationFrame(loop); })(); }\n</script>\n</body>\n</html>",
   "    if(big){ const c=document.getElementById('card'); c.classList.add('shake'); setTimeout(()=>c.classList.remove('shake'),520);} }\n\nlet ctx,parts=[],cv;\n// Частицы сюда никто не добавляет, а пустой canvas очищался каждый кадр —\n// OBS перерисовывал источник постоянно. Цикл запускается только при наличии частиц.\nlet fxRaf=0;\nfunction fxLoop(){ ctx.clearRect(0,0,cv.width,cv.height); parts.forEach(p=>{p.x+=p.vx;p.y+=p.vy;p.vy+=p.g||0;p.life-=p.decay;\n        ctx.globalAlpha=Math.max(0,p.life);ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,7);ctx.fill();});\n        parts=parts.filter(p=>p.life>0&&p.y<cv.height+40); fxRaf=parts.length?requestAnimationFrame(fxLoop):0; }\nfunction startFx(){ if(!fxRaf&&ctx&&parts.length) fxRaf=requestAnimationFrame(fxLoop); }\nfunction initFx(){ cv=document.getElementById('fx'); const rz=()=>{cv.width=innerWidth;cv.height=innerHeight;}; rz(); addEventListener('resize',rz); ctx=cv.getContext('2d'); startFx(); }\n</script>\n</body>\n</html>"
  ]
 ],
 "server.js": [
  [
   "const fs = require('fs');\nconst os = require('os');\n\nconst express = require('express');\nconst axios = require('axios');\n// Системный HTTP_PROXY/HTTPS_PROXY (используется для доступа к заблокированным",
   "const fs = require('fs');\nconst os = require('os');\n\n// Сервер работает рядом с игрой: пониженный приоритет, чтобы планировщик Windows\n// всегда отдавал процессор игре первой (дочерние процессы его наследуют).\ntry {\n    os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);\n} catch (_) { /* noop */ }\n\nconst express = require('express');\nconst axios = require('axios');\n// Системный HTTP_PROXY/HTTPS_PROXY (используется для доступа к заблокированным"
  ]
 ],
 "src/modules/replay-live/index.js": [
  [
   "    sanitizeGameCacheReplaysDir();\n    let timer = null;\n    let watcher = null;\n    let lastFinishedPath = '';\n    let playbackSession = {\n        path: '',",
   "    sanitizeGameCacheReplaysDir();\n    let timer = null;\n    let watcher = null;\n    // Ленивый запуск: модуль следит за файлами игры только пока виджет/страница\n    // реально опрашивают /api/replay-live. Без зрителей — ноль нагрузки на ПК.\n    const IDLE_STOP_MS = 60000;\n    let lastDemandAt = 0;\n    let idleTimer = null;\n    let watchPollTimer = null;\n    let lastFinishedPath = '';\n    let playbackSession = {\n        path: '',"
  ],
  [
   "                try {\n                    dirWatchers.push(fs.watch(dir, { persistent: false }, () => {\n                        if (isExtraDir) scheduleExtraDirReplayPoll();\n                        else poll();\n                    }));\n                } catch (_) { /* noop */ }\n            }\n            const gameCacheDir = replayCacheDir(resolveGameCacheReplaysDir());\n            if (fs.existsSync(gameCacheDir)) {\n                dirWatchers.push(fs.watch(gameCacheDir, { persistent: false }, () => poll()));\n            }\n            if (dirWatchers.length) {\n                watcher = {",
   "                try {\n                    dirWatchers.push(fs.watch(dir, { persistent: false }, () => {\n                        if (isExtraDir) scheduleExtraDirReplayPoll();\n                        else schedulePollFromWatch();\n                    }));\n                } catch (_) { /* noop */ }\n            }\n            const gameCacheDir = replayCacheDir(resolveGameCacheReplaysDir());\n            if (fs.existsSync(gameCacheDir)) {\n                dirWatchers.push(fs.watch(gameCacheDir, { persistent: false }, () => schedulePollFromWatch()));\n            }\n            if (dirWatchers.length) {\n                watcher = {"
  ],
  [
   "        } catch (err) {\n            console.warn('[replay-live] fs.watch failed:', err.message);\n        }\n        console.log('[replay-live] watcher started:', {\n            game: config.gameInstallDir || detectGameInstallDir() || '(unknown)',\n            gameCache: replayCacheDir(resolveGameCacheReplaysDir()),",
   "        } catch (err) {\n            console.warn('[replay-live] fs.watch failed:', err.message);\n        }\n        lastDemandAt = Math.max(lastDemandAt, Date.now());\n        idleTimer = setInterval(() => {\n            if (Date.now() - lastDemandAt > IDLE_STOP_MS) {\n                stopWatcher();\n                console.log('[replay-live] watcher stopped: виджет не открыт');\n            }\n        }, 15000);\n        console.log('[replay-live] watcher started:', {\n            game: config.gameInstallDir || detectGameInstallDir() || '(unknown)',\n            gameCache: replayCacheDir(resolveGameCacheReplaysDir()),"
  ],
  [
   "        });\n    }\n\n    function stopWatcher() {\n        if (timer) clearInterval(timer);\n        timer = null;\n        if (watcher) {\n            try { watcher.close(); } catch (_) { /* noop */ }\n            watcher = null;",
   "        });\n    }\n\n    // Игра пишет в кеш реплеев много раз в секунду — без склейки событий каждое\n    // срабатывание fs.watch перечитывало и разбирало файл боя целиком.\n    function schedulePollFromWatch() {\n        if (watchPollTimer || !timer) return;\n        watchPollTimer = setTimeout(() => {\n            watchPollTimer = null;\n            if (timer) poll();\n        }, 500);\n    }\n\n    function touchDemand() {\n        lastDemandAt = Date.now();\n        if (!timer) startWatcher();\n    }\n\n    function stopWatcher() {\n        if (timer) clearInterval(timer);\n        timer = null;\n        if (idleTimer) clearInterval(idleTimer);\n        idleTimer = null;\n        if (watchPollTimer) clearTimeout(watchPollTimer);\n        watchPollTimer = null;\n        if (watcher) {\n            try { watcher.close(); } catch (_) { /* noop */ }\n            watcher = null;"
  ],
  [
   "\n    const { registerRoutes, registerPages } = createReplayLiveRoutes({\n        appRoot: deps.appRoot,\n        getState,\n        getConfig: () => config,\n        saveConfig,",
   "\n    const { registerRoutes, registerPages } = createReplayLiveRoutes({\n        appRoot: deps.appRoot,\n        touchDemand,\n        getState,\n        getConfig: () => config,\n        saveConfig,"
  ],
  [
   "    });\n\n    function init() {\n        startWatcher();\n    }\n\n    return {",
   "    });\n\n    function init() {\n        // Не стартуем сразу: слежение включится при первом запросе виджета.\n        console.log('[replay-live] ждёт открытия виджета (ленивый запуск)');\n    }\n\n    return {"
  ]
 ],
 "src/modules/replay-live/routes.js": [
  [
   "\nfunction createReplayLiveRoutes(api) {\n    function registerRoutes(app) {\n        app.get('/api/replay-live', (req, res) => {\n            res.json({ success: true, data: api.getState() });\n        });",
   "\nfunction createReplayLiveRoutes(api) {\n    function registerRoutes(app) {\n        app.use('/api/replay-live', (req, res, next) => {\n            api.touchDemand();\n            next();\n        });\n\n        app.get('/api/replay-live', (req, res) => {\n            res.json({ success: true, data: api.getState() });\n        });"
  ]
 ],
 "src/modules/yandex-music/index.js": [
  [
   "const { readYandexMusicNowPlaying, readYandexMusicArt, DEFAULT_APP_IDS } = require('./windowsMedia');\n\nconst MODULE_VERSION = 'yandex-music-v2-art';\nconst DEFAULT_POLL_MS = 1500;\n\nfunction createYandexMusicModule(deps) {\n    let timer = null;\n    let polling = false;\n    let artPolling = false;\n    let config = {",
   "const { readYandexMusicNowPlaying, readYandexMusicArt, DEFAULT_APP_IDS } = require('./windowsMedia');\n\nconst MODULE_VERSION = 'yandex-music-v2-art';\nconst DEFAULT_POLL_MS = 3000;\n// Каждый опрос запускает powershell.exe — тяжёлый процесс. Поэтому опрашиваем\n// только пока виджет/страница реально запрашивают /api/yandex-music.\nconst IDLE_STOP_MS = 60000;\n\nfunction createYandexMusicModule(deps) {\n    let timer = null;\n    let idleTimer = null;\n    let lastDemandAt = 0;\n    let polling = false;\n    let artPolling = false;\n    let config = {"
  ],
  [
   "        if (!config.enabled) return;\n        pollOnce();\n        timer = setInterval(pollOnce, Math.max(800, Number(config.pollIntervalMs) || DEFAULT_POLL_MS));\n    }\n\n    function stopPolling() {\n        if (timer) clearInterval(timer);\n        timer = null;\n    }\n\n    function getState() {",
   "        if (!config.enabled) return;\n        pollOnce();\n        timer = setInterval(pollOnce, Math.max(800, Number(config.pollIntervalMs) || DEFAULT_POLL_MS));\n        lastDemandAt = Math.max(lastDemandAt, Date.now());\n        idleTimer = setInterval(() => {\n            if (Date.now() - lastDemandAt > IDLE_STOP_MS) {\n                stopPolling();\n                console.log('[yandex-music] опрос остановлен: виджет не открыт');\n            }\n        }, 15000);\n    }\n\n    function stopPolling() {\n        if (timer) clearInterval(timer);\n        timer = null;\n        if (idleTimer) clearInterval(idleTimer);\n        idleTimer = null;\n    }\n\n    function touchDemand() {\n        lastDemandAt = Date.now();\n        if (!timer && config.enabled && process.platform === 'win32') startPolling();\n    }\n\n    function getState() {"
  ],
  [
   "    }\n\n    function registerRoutes(app) {\n        app.get('/api/yandex-music/now-playing', (req, res) => {\n            res.json({ success: true, data: getState() });\n        });",
   "    }\n\n    function registerRoutes(app) {\n        app.use('/api/yandex-music', (req, res, next) => {\n            touchDemand();\n            next();\n        });\n\n        app.get('/api/yandex-music/now-playing', (req, res) => {\n            res.json({ success: true, data: getState() });\n        });"
  ],
  [
   "            state.error = 'Только Windows (System Media API)';\n            return;\n        }\n        startPolling();\n        console.log('[yandex-music] page: /yandex-music · widget: /widget-yandex-music');\n    }\n",
   "            state.error = 'Только Windows (System Media API)';\n            return;\n        }\n        // Опрос стартует при первом запросе виджета (ленивый запуск)\n        console.log('[yandex-music] page: /yandex-music · widget: /widget-yandex-music');\n    }\n"
  ]
 ]
};
const GROUPS = [["src/modules/replay-live/index.js", "src/modules/replay-live/routes.js"], ["electron/main.js"], ["public/donation-management.html"], ["public/index.html"], ["public/widget-battle.html"], ["public/widget-mode2.html"], ["public/widget-tanks-blitz-challenge.html"], ["server.js"], ["src/modules/yandex-music/index.js"]];

if (!fs.existsSync(path.join(ROOT, 'server.js'))) {
    console.error('Не нашёл server.js в папке: ' + ROOT);
    console.error('Запустите скрипт из папки приложения или укажите путь: node apply-perf-fix.js "E:\\Стримерская\\2.3"');
    process.exit(1);
}

function planFile(rel) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) return { rel, ok: false, reason: 'файл не найден' };
    const raw = fs.readFileSync(full, 'utf8');
    const crlf = raw.includes('\r\n');
    let text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
    let applied = 0, already = 0;
    for (const [oldStr, newStr] of PATCHES[rel]) {
        if (text.includes(newStr)) { already++; continue; }
        const idx = text.indexOf(oldStr);
        if (idx === -1 || text.indexOf(oldStr, idx + 1) !== -1) {
            return { rel, ok: false, reason: 'код отличается от ожидаемого (правка ' + (applied + already + 1) + ')' };
        }
        text = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
        applied++;
    }
    return { rel, ok: true, full, raw, text: crlf ? text.replace(/\n/g, '\r\n') : text, applied, already };
}

let changed = 0, skipped = 0;
for (const group of GROUPS) {
    const plans = group.map(planFile);
    const bad = plans.filter((p) => !p.ok);
    if (bad.length) {
        for (const p of plans) {
            console.log('ПРОПУЩЕН  ' + p.rel + (p.ok ? '  (связан с файлом, который не удалось изменить)' : '  — ' + p.reason));
        }
        skipped += plans.length;
        continue;
    }
    for (const p of plans) {
        if (!p.applied) { console.log('уже есть  ' + p.rel); continue; }
        const bak = p.full + '.bak-perf';
        if (!fs.existsSync(bak)) fs.writeFileSync(bak, p.raw, 'utf8');
        fs.writeFileSync(p.full, p.text, 'utf8');
        console.log('ИСПРАВЛЕН ' + p.rel);
        changed++;
    }
}
console.log('');
console.log('Готово: исправлено файлов ' + changed + ', пропущено ' + skipped + '.');
if (skipped) console.log('Пропущенные файлы пришлите Claude — подгоню правку под вашу версию.');
console.log('Перезапустите сервер/приложение. Откат: верните файлы из *.bak-perf.');
