'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readMetaFromZip(zipPath) {
    try {
        // eslint-disable-next-line global-require
        const AdmZip = tryRequireAdmZip();
        if (AdmZip) {
            const zip = new AdmZip(zipPath);
            const entry = zip.getEntry('meta.json');
            if (!entry) return null;
            return JSON.parse(entry.getData().toString('utf8'));
        }
    } catch (_) { /* fall through */ }

    const fromManual = readMetaManual(zipPath);
    if (fromManual) return fromManual;

    try {
        const py = spawnSync('python', [
            '-c',
            'import zipfile,json,sys; print(zipfile.ZipFile(sys.argv[1]).read("meta.json").decode())',
            zipPath
        ], { encoding: 'utf8', timeout: 4000 }); // было 8000 — синхронный spawnSync блокирует event loop, держим короче
        if (py.status === 0 && py.stdout) {
            return JSON.parse(py.stdout.trim());
        }
    } catch (_) { /* noop */ }

    return null;
}

function tryRequireAdmZip() {
    try {
        return require('adm-zip');
    } catch (_) {
        return null;
    }
}

function readMetaManual(zipPath) {
    const fd = fs.openSync(zipPath, 'r');
    try {
        const head = Buffer.alloc(8192);
        fs.readSync(fd, head, 0, 8192, 0);
        const marker = Buffer.from('meta.json');
        const idx = head.indexOf(marker);
        if (idx < 0) return null;
        const jsonStart = head.indexOf('{', idx);
        if (jsonStart < 0) return null;
        const jsonEnd = head.indexOf('}', jsonStart);
        if (jsonEnd < 0) return null;
        return JSON.parse(head.subarray(jsonStart, jsonEnd + 1).toString('utf8'));
    } catch (_) {
        return null;
    } finally {
        fs.closeSync(fd);
    }
}

function parseBattleResultsWithPython(zipPath, pythonPath) {
    const script = path.join(__dirname, 'parse_battle_results.py');
    if (!fs.existsSync(script)) return null;
    const cmd = pythonPath || 'python';
    const run = spawnSync(cmd, [script, zipPath], { encoding: 'utf8', timeout: 4000 }); // было 8000 — синхронный spawnSync блокирует event loop
    if (run.status !== 0 || !run.stdout) return null;
    try {
        const parsed = JSON.parse(run.stdout.trim());
        return parsed.success ? parsed : null;
    } catch (_) {
        return null;
    }
}

function extractAuthorStats(protobufBuf) {
    if (!protobufBuf || !protobufBuf.length) return null;
    let best = null;
    for (let i = 0; i < protobufBuf.length - 2; i += 1) {
        if (protobufBuf.readUInt8(i) !== 0x40) continue;
        let offset = i + 1;
        let val = 0;
        let shift = 0;
        while (offset < protobufBuf.length) {
            const b = protobufBuf.readUInt8(offset);
            offset += 1;
            val |= (b & 0x7f) << shift;
            if ((b & 0x80) === 0) break;
            shift += 7;
        }
        if (val >= 100 && val <= 20000) {
            if (!best || val > best.damageDealt) best = { damageDealt: val };
        }
    }
    return best;
}

function parseFinishedReplay(zipPath, pythonPath) {
    const meta = readMetaFromZip(zipPath);
    const py = parseBattleResultsWithPython(zipPath, pythonPath);
    if (py && py.author) {
        return {
            meta,
            author: py.author,
            players: py.players || [],
            source: 'python'
        };
    }
    return {
        meta,
        author: extractAuthorStats(readBattleResultsBytes(zipPath)),
        source: 'heuristic'
    };
}

function readBattleResultsBytes(zipPath) {
    try {
        const AdmZip = tryRequireAdmZip();
        if (AdmZip) {
            const zip = new AdmZip(zipPath);
            const entry = zip.getEntry('battle_results.dat');
            if (!entry) return null;
            const raw = entry.getData();
            return unpickleSecondElement(raw);
        }
    } catch (_) { /* noop */ }
    return null;
}

function unpickleSecondElement(buf) {
    if (!buf || buf.length < 16 || buf.readUInt8(0) !== 0x80) return null;
    let offset = 2;
    if (buf.readUInt8(offset) === 0x8a) {
        offset += 9;
    }
    while (offset < buf.length) {
        const op = buf.readUInt8(offset);
        offset += 1;
        if (op === 0x42 || op === 0x43) {
            if (offset >= buf.length) return null;
            const len = buf.readUInt8(offset);
            offset += 1;
            if (offset + len <= buf.length) return buf.subarray(offset, offset + len);
        }
        if (op === 0x54) {
            if (offset + 4 > buf.length) return null;
            const len = buf.readUInt32LE(offset);
            offset += 4;
            if (offset + len <= buf.length) return buf.subarray(offset, offset + len);
        }
    }
    return null;
}

module.exports = {
    parseFinishedReplay,
    readMetaFromZip
};
