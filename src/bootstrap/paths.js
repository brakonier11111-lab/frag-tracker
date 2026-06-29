'use strict';
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
