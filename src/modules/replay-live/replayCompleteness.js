'use strict';

const { readMetaFromZip } = require('./battleResults');

const REPLAY_END_SLACK_SEC = 12;

function isReplayRecordingComplete(playbackPath, replayDurationSec) {
    if (!playbackPath || !Number.isFinite(replayDurationSec) || replayDurationSec <= 0) {
        return false;
    }
    if (!playbackPath.toLowerCase().endsWith('.tbreplay')) {
        return false;
    }

    const meta = readMetaFromZip(playbackPath);
    const metaDuration = meta && Number(meta.battleDuration) > 0
        ? Number(meta.battleDuration)
        : 0;
    if (!metaDuration) return false;

    return replayDurationSec >= metaDuration - REPLAY_END_SLACK_SEC;
}

function shouldUseBattleResultsStats(options) {
    options = options || {};
    if (!options.atEnd) return false;
    if (!options.combatStatsByEntity || !options.combatStatsByEntity.size) return false;
    if (!isReplayRecordingComplete(options.playbackPath, options.replayDurationSec)) {
        return false;
    }
    return true;
}

module.exports = {
    isReplayRecordingComplete,
    shouldUseBattleResultsStats,
    REPLAY_END_SLACK_SEC
};
