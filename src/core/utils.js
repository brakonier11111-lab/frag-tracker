'use strict';

function safeJsonParse(str, fallback) {
    try {
        const v = JSON.parse(str);
        return v == null ? fallback : v;
    } catch {
        return fallback;
    }
}

function clampNum(value, min, max) {
    let v = Number(value);
    if (!isFinite(v)) v = min;
    if (min != null && v < min) v = min;
    if (max != null && v > max) v = max;
    return v;
}

function round2(v) {
    return Math.round((Number(v) || 0) * 100) / 100;
}

module.exports = { safeJsonParse, clampNum, round2 };
