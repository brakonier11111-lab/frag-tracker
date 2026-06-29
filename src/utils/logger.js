'use strict';
/**
 * Минимальный логгер без внешних зависимостей: дублирует вывод в консоль
 * (как и раньше — console.log/warn/error) и дописывает строки в logs/*.log,
 * чтобы после краша/инцидента можно было посмотреть, что происходило,
 * а не только то, что осталось в окне терминала.
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.FRAG_LOG_DIR || path.join(__dirname, '..', '..', 'logs');
try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
    // не критично — просто не будет файлового лога
}

function formatArgs(args) {
    return args
        .map((a) => {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return a.stack || a.message;
            try {
                return JSON.stringify(a);
            } catch (e) {
                return String(a);
            }
        })
        .join(' ');
}

function writeLine(file, level, args) {
    const line = `[${new Date().toISOString()}] [${level}] ${formatArgs(args)}\n`;
    fs.appendFile(path.join(LOG_DIR, file), line, () => {});
}

function info(...args) {
    console.log(...args);
    writeLine('combined.log', 'INFO', args);
}

function warn(...args) {
    console.warn(...args);
    writeLine('combined.log', 'WARN', args);
}

function error(...args) {
    console.error(...args);
    writeLine('combined.log', 'ERROR', args);
    writeLine('error.log', 'ERROR', args);
}

module.exports = { info, warn, error };
