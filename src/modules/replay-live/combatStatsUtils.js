'use strict';

/** Попадания не могут превышать выстрелы — иначе поля перепутаны в источнике. */
function normalizeShotHitCounts(shotsFired, hits) {
    let shots = Number(shotsFired) || 0;
    let h = Number(hits) || 0;
    if (shots > 0 && h > shots) {
        return { shotsFired: h, hits: shots };
    }
    return { shotsFired: shots, hits: h };
}

/** Точность = попадания / выстрелы × 100 */
function hitAccuracyPct(shotsFired, hits) {
    const norm = normalizeShotHitCounts(shotsFired, hits);
    if (norm.shotsFired <= 0) return null;
    return Math.round((Math.min(norm.hits, norm.shotsFired) / norm.shotsFired) * 100);
}

function mergeReplayCombatCounters(row, replayStats) {
    if (!replayStats) return row;

    const brNorm = normalizeShotHitCounts(row.shotsFired, row.hits);
    const rpShots = Number(replayStats.shotsFired) || 0;
    const rpHits = Number(replayStats.hits) || 0;
    const brValid = brNorm.shotsFired > 0 && brNorm.hits <= brNorm.shotsFired;

    let hits = 0;
    let shotsFired = 0;

    if (brValid) {
        shotsFired = brNorm.shotsFired;
        hits = brNorm.hits;
    } else {
        hits = rpHits || brNorm.hits || 0;
        shotsFired = rpShots || brNorm.shotsFired || 0;
    }

    const norm = normalizeShotHitCounts(shotsFired, hits);
    return Object.assign({}, row, {
        shotsFired: norm.shotsFired,
        hits: norm.hits,
        penetrations: Number(row.penetrations) || Number(replayStats.penetrations) || 0,
        tanksDamaged: row.tanksDamaged || replayStats.tanksDamaged
    });
}

module.exports = {
    normalizeShotHitCounts,
    hitAccuracyPct,
    mergeReplayCombatCounters
};
