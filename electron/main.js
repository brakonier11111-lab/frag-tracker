const {
    app,
    BrowserWindow,
    Tray,
    Menu,
    nativeImage,
    shell,
    dialog
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execSync } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const SERVER_URL = `http://127.0.0.1:${PORT}/`;
const TRAY_ICON =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAI0lEQVR42mNkQAKMFMzIACwYwMDAwIgFkxGLYTIKAFmZAw+0N1O1AAAAAElFTkSuQmCC';

let mainWindow = null;
let tray = null;
let serverProcess = null;
let isQuitting = false;

function getAppRoot() {
    return path.join(__dirname, '..');
}

function getUserDataDir() {
    return app.getPath('userData');
}

function ensureUserConfig() {
    const userData = getUserDataDir();
    const appRoot = getAppRoot();
    fs.mkdirSync(userData, { recursive: true });

    const userConfig = path.join(userData, 'config.env');
    if (fs.existsSync(userConfig)) return userConfig;

    const sources = [
        path.join(appRoot, 'config.env'),
        path.join(appRoot, '.env'),
        path.join(appRoot, 'config.env.example')
    ];
    for (const src of sources) {
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, userConfig);
            return userConfig;
        }
    }
    return null;
}

function buildServerEnv() {
    ensureUserConfig();
    return {
        ...process.env,
        PORT: String(PORT),
        FRAG_APP_ROOT: getAppRoot(),
        FRAG_USER_DATA: getUserDataDir(),
        DONATION_POLLING: process.env.DONATION_POLLING || '1'
    };
}

function getServerCommand() {
    const serverPath = path.join(getAppRoot(), 'server.js');
    return {
        command: process.execPath,
        args: [serverPath],
        extraEnv: { ELECTRON_RUN_AS_NODE: '1' }
    };
}

function logStartup(message) {
    try {
        const logDir = app.isReady()
            ? getUserDataDir()
            : path.join(require('os').tmpdir(), 'frag-tracker');
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, 'startup.log');
        const line = `[${new Date().toISOString()}] ${message}\n`;
        fs.appendFileSync(logPath, line, 'utf8');
    } catch (_) { /* noop */ }
}

function findListeningPid(port) {
    if (process.platform === 'win32') {
        try {
            const out = execSync(`netstat -ano | findstr ":${port}.*LISTENING"`, { encoding: 'utf8' });
            for (const line of out.split('\n')) {
                if (!line.includes('LISTENING')) continue;
                const parts = line.trim().split(/\s+/);
                const pid = Number(parts[parts.length - 1]);
                if (pid > 0) return pid;
            }
        } catch (_) { /* noop */ }
        return null;
    }
    try {
        const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' });
        const pid = Number(String(out).trim().split('\n')[0]);
        return pid > 0 ? pid : null;
    } catch (_) {
        return null;
    }
}

function killPidTree(pid) {
    return new Promise((resolve) => {
        if (!pid) {
            resolve();
            return;
        }
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true })
                .on('exit', () => resolve());
            return;
        }
        try { process.kill(pid, 'SIGKILL'); } catch (_) { /* noop */ }
        resolve();
    });
}

async function releasePort(port) {
    const pid = findListeningPid(port);
    if (!pid) return;
    process.stdout.write(`[electron] освобождаем порт ${port} (PID ${pid})\n`);
    await killPidTree(pid);
    await new Promise((resolve) => setTimeout(resolve, 600));
}

function spawnServerProcess() {
    return new Promise((resolve, reject) => {
        const { command, args, extraEnv } = getServerCommand();
        serverProcess = spawn(command, args, {
            cwd: getAppRoot(),
            env: { ...buildServerEnv(), ...extraEnv },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        let settled = false;
        let sawAddrInUse = false;

        const fail = (err) => {
            if (settled) return;
            settled = true;
            serverProcess = null;
            logStartup(`server start failed: ${err.message}`);
            reject(err);
        };

        const onReady = () => {
            if (settled) return;
            settled = true;
            waitForServer().then(resolve).catch(fail);
        };

        serverProcess.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            process.stdout.write(`[server] ${text}`);
            if (text.includes('FRAG_SERVER_READY')) onReady();
        });

        serverProcess.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            process.stderr.write(`[server] ${text}`);
            if (text.includes('EADDRINUSE')) sawAddrInUse = true;
        });

        serverProcess.on('error', (err) => fail(err));

        serverProcess.on('exit', (code) => {
            serverProcess = null;
            if (!settled) {
                fail(new Error(
                    sawAddrInUse
                        ? `Порт ${PORT} занят. Закройте другой экземпляр Frag Tracker.`
                        : `Сервер остановился (код ${code}).`
                ));
                return;
            }
            if (!isQuitting && code !== 0 && code !== null) {
                dialog.showErrorBox(
                    'Frag Tracker',
                    `Сервер остановился (код ${code}). Перезапустите приложение.`
                );
            }
        });

        setTimeout(onReady, 15000);
    });
}

async function startServer() {
    if (serverProcess) {
        await waitForServer();
        return;
    }

    await releasePort(PORT);
    try {
        await spawnServerProcess();
    } catch (err) {
        await releasePort(PORT);
        await spawnServerProcess();
    }
}

function waitForServer(maxAttempts = 80) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const tryOnce = () => {
            attempts += 1;
            const req = http.get(`http://127.0.0.1:${PORT}/healthz`, (res) => {
                res.resume();
                if (res.statusCode === 200) resolve();
                else if (attempts >= maxAttempts) reject(new Error('Сервер не отвечает'));
                else setTimeout(tryOnce, 400);
            });
            req.on('error', () => {
                if (attempts >= maxAttempts) reject(new Error('Сервер не запустился'));
                else setTimeout(tryOnce, 400);
            });
            req.setTimeout(2000, () => {
                req.destroy();
                if (attempts >= maxAttempts) reject(new Error('Таймаут ожидания сервера'));
                else setTimeout(tryOnce, 400);
            });
        };
        tryOnce();
    });
}

function stopServer() {
    return new Promise((resolve) => {
        if (!serverProcess) {
            resolve();
            return;
        }
        const proc = serverProcess;
        serverProcess = null;
        const finish = () => resolve();
        proc.once('exit', finish);

        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { windowsHide: true })
                .on('exit', finish);
        } else {
            proc.kill('SIGINT');
            setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch {}
                finish();
            }, 3000);
        }
    });
}

function createWindow() {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        return;
    }

    mainWindow = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 1024,
        minHeight: 680,
        title: 'Frag Tracker',
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    mainWindow.loadURL(SERVER_URL);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.focus();
    });

    // Навигация между страницами (window.location.href на /battle-admin,
    // /voting-admin и т.д.) иногда оставляет ОС-фокус на окне, но не передаёт
    // его внутреннему webContents — тогда клик по инпуту не показывает каретку
    // и клавиатурный ввод никуда не попадает. Дожимаем фокус после каждой загрузки.
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.focus();
    });

    mainWindow.webContents.on('did-fail-load', (_event, _code, desc) => {
        logStartup(`page load failed: ${desc}`);
        dialog.showErrorBox('Frag Tracker', `Не удалось загрузить панель:\n${desc}`);
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
            return { action: 'allow' };
        }
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // OAuth-кнопки (YouTube/VK Play/...) делают window.location.href на внешний
    // домен (не window.open, поэтому setWindowOpenHandler их не ловит) — без этой
    // защиты Electron заменяет содержимое ГЛАВНОГО окна страницей логина, и когда
    // пользователь закрывает то, что выглядит как окно авторизации, закрывается всё
    // приложение. Открываем такие переходы в системном браузере вместо этого;
    // OAuth callback всё равно бьёт напрямую в наш локальный сервер.
    const interceptExternalNav = (event, url) => {
        if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
            return;
        }
        event.preventDefault();
        shell.openExternal(url);
    };
    mainWindow.webContents.on('will-navigate', interceptExternalNav);
    // Наши /oauth/*/start роуты сначала грузятся с локального сервера (проходят
    // will-navigate), а уже ОН отвечает HTTP-редиректом на внешний OAuth-домен —
    // это отдельное событие will-redirect, не will-navigate, и без отдельного
    // перехвата редирект всё равно подменял бы главное окно.
    mainWindow.webContents.on('will-redirect', interceptExternalNav);

    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'tray-icon.png');
    const icon = fs.existsSync(iconPath)
        ? nativeImage.createFromPath(iconPath)
        : nativeImage.createFromDataURL(TRAY_ICON);

    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('Frag Tracker');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Открыть панель', click: () => createWindow() },
        { label: 'Папка данных', click: () => shell.openPath(getUserDataDir()) },
        { type: 'separator' },
        { label: 'Выход', click: () => { isQuitting = true; app.quit(); } }
    ]));
    tray.on('double-click', () => createWindow());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.whenReady().then(() => {
        dialog.showMessageBoxSync({
            type: 'info',
            title: 'Frag Tracker',
            message: 'Frag Tracker уже запущен.',
            detail: 'Проверьте иконку в трее (рядом с часами) или откройте панель оттуда.'
        });
        app.quit();
    });
} else {
    app.on('second-instance', () => createWindow());

    app.whenReady().then(async () => {
        try {
            logStartup('starting server');
            await startServer();
            logStartup('server ready');
            createTray();
            createWindow();
        } catch (err) {
            logStartup(`startup error: ${err.message}`);
            dialog.showErrorBox('Frag Tracker', `Не удалось запустить сервер:\n${err.message}`);
            app.quit();
        }
    });

    app.on('before-quit', () => { isQuitting = true; });

    app.on('will-quit', (event) => {
        if (!serverProcess) return;
        event.preventDefault();
        stopServer().then(() => app.exit(0));
    });

    app.on('activate', () => createWindow());
}
