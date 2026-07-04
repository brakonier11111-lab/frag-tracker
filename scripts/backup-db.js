'use strict';
/**
 * Резервная копия SQLite-базы — единственной копии данных по донатам и
 * статистике стримов. Скрипт безопасно копирует основной файл плюс -wal/-shm
 * (если есть незакоммиченные в БД данные в WAL) в backups/ рядом с БД
 * с таймстампом, и подчищает старые копии, оставляя последние N.
 *
 * Путь к БД берётся из src/bootstrap/paths (FRAG_USER_DATA).
 * Запуск: node scripts/backup-db.js
 */

const fs = require('fs');
const path = require('path');
const { resolveDbPath } = require('../src/bootstrap/paths');

const DB_PATH = resolveDbPath();
const DB_DIR = path.dirname(DB_PATH);
const DB_NAME = path.basename(DB_PATH);
const BACKUPS_DIR = path.join(DB_DIR, 'backups');
const KEEP_LAST = Number(process.env.BACKUP_KEEP_LAST || 14);

function timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function backupOne(srcName) {
    const srcPath = path.join(DB_DIR, srcName);
    if (!fs.existsSync(srcPath)) return null;
    const ts = timestamp();
    const dstName = `${srcName}.${ts}.bak`;
    const dstPath = path.join(BACKUPS_DIR, dstName);
    fs.copyFileSync(srcPath, dstPath);
    return dstPath;
}

function cleanupOldBackups() {
    const files = fs.readdirSync(BACKUPS_DIR)
        .filter((f) => f.startsWith(DB_NAME))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

    const toDelete = files.slice(KEEP_LAST);
    for (const f of toDelete) {
        fs.unlinkSync(path.join(BACKUPS_DIR, f.name));
        console.log('🗑️  Удалена старая резервная копия:', f.name);
    }
}

function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`❌ ${DB_NAME} не найден в ${DB_DIR}`);
        process.exit(1);
    }

    fs.mkdirSync(BACKUPS_DIR, { recursive: true });

    const mainBackup = backupOne(DB_NAME);
    const walBackup = backupOne(`${DB_NAME}-wal`);
    const shmBackup = backupOne(`${DB_NAME}-shm`);

    console.log('✅ Резервная копия создана:', mainBackup);
    if (walBackup) console.log('   + WAL:', walBackup);
    if (shmBackup) console.log('   + SHM:', shmBackup);

    cleanupOldBackups();
}

main();
