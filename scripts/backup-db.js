'use strict';
/**
 * Резервная копия SQLite-базы. frag_tracker.db лежит в корне проекта рядом с
 * кодом и сейчас вообще никак не бэкапится — это единственная копия данных
 * по донатам/статистике стримов. Скрипт безопасно копирует основной файл
 * плюс -wal/-shm (если есть незакоммиченные в БД данные в WAL), в backups/
 * с таймстампом, и подчищает старые копии, оставляя последние N.
 *
 * Запуск: node scripts/backup-db.js
 */

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const DB_NAME = 'frag_tracker.db';
const BACKUPS_DIR = path.join(APP_ROOT, 'backups');
const KEEP_LAST = Number(process.env.BACKUP_KEEP_LAST || 14);

function timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function backupOne(srcName) {
    const srcPath = path.join(APP_ROOT, srcName);
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
    if (!fs.existsSync(path.join(APP_ROOT, DB_NAME))) {
        console.error(`❌ ${DB_NAME} не найден в ${APP_ROOT}`);
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
