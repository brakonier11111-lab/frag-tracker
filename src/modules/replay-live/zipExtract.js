'use strict';

const fs = require('fs');
const zlib = require('zlib');

const REPLAY_DATA_ZIP_ENTRIES = ['data.replay', 'data.wotreplay'];

function findCentralDirectoryOffset(buf) {
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
        if (buf.readUInt32LE(i) !== 0x06054b50) continue;
        return buf.readUInt32LE(i + 16);
    }
    return null;
}

function extractZipEntryFromCentral(zipPath, entryName) {
    const fd = fs.openSync(zipPath, 'r');
    try {
        const stat = fs.fstatSync(fd);
        const tailSize = Math.min(stat.size, 256 * 1024);
        const tail = Buffer.alloc(tailSize);
        fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);

        const cdOffset = findCentralDirectoryOffset(tail);
        if (cdOffset == null) return null;

        const cdBuf = Buffer.alloc(Math.min(stat.size - cdOffset, 512 * 1024));
        fs.readSync(fd, cdBuf, 0, cdBuf.length, cdOffset);

        let offset = 0;
        while (offset + 46 <= cdBuf.length) {
            if (cdBuf.readUInt32LE(offset) !== 0x02014b50) break;
            const compression = cdBuf.readUInt16LE(offset + 10);
            const compSize = cdBuf.readUInt32LE(offset + 20);
            const nameLen = cdBuf.readUInt16LE(offset + 28);
            const extraLen = cdBuf.readUInt16LE(offset + 30);
            const commentLen = cdBuf.readUInt16LE(offset + 32);
            const localOffset = cdBuf.readUInt32LE(offset + 42);
            const name = cdBuf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
            offset += 46 + nameLen + extraLen + commentLen;

            if (name !== entryName) continue;

            const local = Buffer.alloc(30);
            fs.readSync(fd, local, 0, 30, localOffset);
            if (local.readUInt32LE(0) !== 0x04034b50) return null;
            const localNameLen = local.readUInt16LE(26);
            const localExtraLen = local.readUInt16LE(28);
            const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
            const size = compSize;
            if (!size || size > 50 * 1024 * 1024) return null;

            const compressed = Buffer.alloc(size);
            fs.readSync(fd, compressed, 0, size, dataOffset);
            if (compression === 0) return compressed;
            if (compression === 8) return zlib.inflateRawSync(compressed);
            return null;
        }
        return null;
    } finally {
        fs.closeSync(fd);
    }
}

function extractDataReplayFromZipNative(zipPath) {
    try {
        for (const entryName of REPLAY_DATA_ZIP_ENTRIES) {
            const buf = extractZipEntryFromCentral(zipPath, entryName);
            if (buf && buf.length > 32) return buf;
        }
        return null;
    } catch (_) {
        return null;
    }
}

function detectReplayDataEntryInZip(zipPath) {
    try {
        for (const entryName of REPLAY_DATA_ZIP_ENTRIES) {
            const buf = extractZipEntryFromCentral(zipPath, entryName);
            if (buf && buf.length > 32) return entryName;
        }
    } catch (_) { /* noop */ }
    return null;
}

module.exports = {
    extractDataReplayFromZipNative,
    extractZipEntryFromCentral,
    detectReplayDataEntryInZip,
    REPLAY_DATA_ZIP_ENTRIES
};
