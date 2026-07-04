'use strict';
const path = require('path');
const fs = require('fs');

const APP_ROOT = process.env.FRAG_APP_ROOT || path.join(__dirname, '..', '..');

// Пользовательские данные (БД, config.env, логи) по умолчанию живут ВНЕ кода:
// %LOCALAPPDATA%\FragTracker на Windows, ~/.local/share/frag-tracker иначе.
// Electron и тесты задают FRAG_USER_DATA явно и это переопределяют.
function defaultUserData() {
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        return path.join(process.env.LOCALAPPDATA, 'FragTracker');
    }
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) return path.join(home, '.local', 'share', 'frag-tracker');
    return APP_ROOT;
}

const USER_DATA = process.env.FRAG_USER_DATA || defaultUserData();

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
                    // WAL/SHM обязаны переехать вместе с БД: в -wal могут лежать
                    // ещё не слитые в основной файл транзакции.
                    for (const suffix of ['-wal', '-shm']) {
                        const legacySide = legacyDb + suffix;
                        if (fs.existsSync(legacySide)) {
                            fs.copyFileSync(legacySide, userDb + suffix);
                        }
                    }
                    console.log('📦 База данных скопирована в:', userDb);
                    console.log('   Старая копия осталась в', legacyDb, '— после проверки её можно удалить.');
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
