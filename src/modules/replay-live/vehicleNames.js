'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const LESTA_APP_ID = process.env.LESTA_APPLICATION_ID || 'da7874d5a895ff241d8b55e271c03ff3';
const API_URL = 'https://papi.tanksblitz.ru/wotb/encyclopedia/vehicles/';

const memoryCache = new Map();
const hpCache = new Map();
let diskCachePath = '';
let diskCacheLoaded = false;
let prefetchPromise = null;

function humanizeInternalName(internal) {
    if (!internal) return '';
    const trimmed = String(internal).trim();
    const withUnderscore = trimmed.match(/^[A-Za-z]{2,3}\d{1,3}_(.+)$/);
    if (withUnderscore) {
        return withUnderscore[1].replace(/_/g, ' ');
    }
    return trimmed;
}

function loadDiskCache(cacheDir) {
    if (diskCacheLoaded) return;
    diskCacheLoaded = true;
    diskCachePath = path.join(cacheDir || '', 'vehicle-names-cache.json');
    try {
        if (!fs.existsSync(diskCachePath)) return;
        const data = JSON.parse(fs.readFileSync(diskCachePath, 'utf8'));
        Object.entries(data).forEach(([id, row]) => {
            const vehicleId = Number(id);
            if (!row) return;
            if (typeof row === 'string') {
                memoryCache.set(vehicleId, row);
                return;
            }
            if (row.name) memoryCache.set(vehicleId, String(row.name));
            if (Number(row.hp) > 0) hpCache.set(vehicleId, Number(row.hp));
        });
    } catch (_) { /* noop */ }
}

function saveDiskCache() {
    if (!diskCachePath) return;
    try {
        const data = {};
        const ids = new Set([...memoryCache.keys(), ...hpCache.keys()]);
        ids.forEach((id) => {
            data[String(id)] = {
                name: memoryCache.get(id) || '',
                hp: hpCache.get(id) || 0
            };
        });
        fs.mkdirSync(path.dirname(diskCachePath), { recursive: true });
        fs.writeFileSync(diskCachePath, JSON.stringify(data), 'utf8');
    } catch (_) { /* noop */ }
}

function getVehicleName(vehicleId) {
    if (!vehicleId) return '';
    return memoryCache.get(vehicleId) || '';
}

function getVehicleMaxHp(vehicleId) {
    if (!vehicleId) return 0;
    return hpCache.get(vehicleId) || 0;
}

async function prefetchVehicleNames(vehicleIds, cacheDir) {
    loadDiskCache(cacheDir);
    const missing = [...new Set((vehicleIds || []).filter((id) => (
        id > 0 && (!memoryCache.has(id) || !hpCache.has(id))
    )))];
    if (!missing.length) return;

    for (let offset = 0; offset < missing.length; offset += 20) {
        const chunk = missing.slice(offset, offset + 20);
        try {
            const response = await axios.get(API_URL, {
                params: {
                    application_id: LESTA_APP_ID,
                    fields: 'tank_id,name,default_profile.hp',
                    language: 'ru',
                    tank_id: chunk.join(',')
                },
                timeout: 12000
            });
            if (response.data && response.data.status === 'ok' && response.data.data) {
                chunk.forEach((id) => {
                    const row = response.data.data[String(id)];
                    if (row && row.name) memoryCache.set(id, row.name);
                    if (row && row.default_profile && Number(row.default_profile.hp) > 0) {
                        hpCache.set(id, Number(row.default_profile.hp));
                    }
                });
            }
        } catch (_) { /* noop */ }
    }

    saveDiskCache();
}

// ВНИМАНИЕ: имя оставлено как было ради совместимости с местом вызова в index.js,
// но функция БОЛЬШЕ НЕ БЛОКИРУЮЩАЯ. Раньше тут был синхронный execSync('curl ...')
// с таймаутом 12с — он морозил ВЕСЬ event loop Node на время сетевого запроса к
// Lesta API. При тормозящем API (а он периодически отдаёт ECONNRESET/timeout) это
// были полные 12с фриза, на которые зависали все вкладки приложения. Теперь HP
// читается из дискового кэша синхронно (быстро), а недостающие значения
// дотягиваются асинхронно через prefetch (axios, не блокирует поток). На горячем
// пути (раз в секунду при просмотре реплея) HP нового танка появится через
// цикл-другой вместо заморозки всего сервера.
function ensureVehicleHpBlocking(vehicleIds, cacheDir) {
    loadDiskCache(cacheDir);
    const hasMissing = (vehicleIds || []).some((id) => id > 0 && !hpCache.has(id));
    if (hasMissing) schedulePrefetch(vehicleIds, cacheDir);
}

function schedulePrefetch(vehicleIds, cacheDir) {
    loadDiskCache(cacheDir);
    const missing = (vehicleIds || []).some((id) => (
        id > 0 && (!memoryCache.has(id) || !hpCache.has(id))
    ));
    if (!missing) return;
    if (!prefetchPromise) {
        prefetchPromise = prefetchVehicleNames(vehicleIds, cacheDir).finally(() => {
            prefetchPromise = null;
        });
    }
}

function resolveTankName(player, options) {
    options = options || {};
    const nick = player.nickname || '';
    const authorNick = options.authorNickname || '';
    const authorVehicleInternal = options.authorVehicleInternal || '';

    if (authorVehicleInternal && nick && nick === authorNick) {
        return humanizeInternalName(authorVehicleInternal);
    }

    const vehicleCodesByNick = options.vehicleCodesByNick;
    const code = vehicleCodesByNick instanceof Map
        ? (vehicleCodesByNick.get(nick) || vehicleCodesByNick.get(nick.toLowerCase()))
        : null;
    if (code) {
        const humanized = humanizeInternalName(code);
        if (humanized) return humanized;
    }

    if (player.vehicleId) {
        const fromApi = getVehicleName(player.vehicleId);
        if (fromApi) return fromApi;
    }

    return '';
}

function enrichPlayersWithTankNames(players, options) {
    options = options || {};
    loadDiskCache(options.cacheDir);

    const vehicleIds = (players || []).map((player) => player.vehicleId).filter(Boolean);
    schedulePrefetch(vehicleIds, options.cacheDir);

    return (players || []).map((player) => Object.assign({}, player, {
        tankName: resolveTankName(player, options) || player.tankName || ''
    }));
}

module.exports = {
    humanizeInternalName,
    getVehicleName,
    getVehicleMaxHp,
    prefetchVehicleNames,
    ensureVehicleHpBlocking,
    resolveTankName,
    enrichPlayersWithTankNames
};
