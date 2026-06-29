/**
 * Расчёт золота, разданного другим игрокам в бою 7×7 (РазБЛОГировка).
 * Блогер золото не получает — только 13 остальных (6 союзников + 7 противников).
 *
 * Исход боя и выживание берём из дельты статистики аккаунта Lesta
 * (battles / wins / survived_battles), без детализации отдельного боя.
 *
 * Правила восстановления исходов:
 * — победа и выживание — отдельные счётчики Lesta (wins / survived_battles);
 * — при поражении тоже смотрим, выжил блогер или уничтожен.
 *
 * @typedef {Object} BattleOutcome
 * @property {boolean} won — победила команда блогера
 * @property {boolean} survived — блогер не был уничтожен
 */

/** Состав: 6 союзников + 7 врагов (блогер не считается) */
const ALLIES_COUNT = 6;
const ENEMIES_COUNT = 7;
const OTHER_PLAYERS_COUNT = ALLIES_COUNT + ENEMIES_COUNT;

/** Участие в бою с блогером: +250 каждому из 13 */
const PARTICIPATION_GOLD = 250;

/** Победа команды блогера → +250 каждому из 6 союзников */
const WIN_BONUS_ALLY = 250;

/** Поражение блогера → +250 каждому из 7 врагов (их команда победила) */
const WIN_BONUS_ENEMY = 250;

/** Топ-дамагер в каждой команде: +500 × 2 (всегда, по одному на команду) */
const TOP_DAMAGER_BONUS = 500;
const TOP_DAMAGERS_COUNT = 2;

/** Блогер выжил → +500 каждому из 6 союзников */
const SURVIVE_BONUS_ALLY = 500;

/** Блогер уничтожен → +500 каждому из 7 врагов */
const DESTROY_BONUS_ENEMY = 500;

/**
 * @param {BattleOutcome} battle
 * @returns {number}
 */
function calculateGoldDistributed(battle) {
    if (!battle || typeof battle.won !== 'boolean' || typeof battle.survived !== 'boolean') {
        return 0;
    }

    // 250 × 13 — все, кто попал в бой с блогером
    let gold = PARTICIPATION_GOLD * OTHER_PLAYERS_COUNT;

    // Топ по урону в каждой команде (упрощение: всегда 2 игрока)
    gold += TOP_DAMAGER_BONUS * TOP_DAMAGERS_COUNT;

    // Бонус победившей стороны (не блогеру)
    if (battle.won) {
        gold += WIN_BONUS_ALLY * ALLIES_COUNT;
    } else {
        gold += WIN_BONUS_ENEMY * ENEMIES_COUNT;
    }

    // Выживание / уничтожение блогера
    if (battle.survived) {
        gold += SURVIVE_BONUS_ALLY * ALLIES_COUNT;
    } else {
        gold += DESTROY_BONUS_ENEMY * ENEMIES_COUNT;
    }

    return gold;
}

/**
 * @param {BattleOutcome} battle
 * @returns {{ total: number, breakdown: Record<string, number> }}
 */
function calculateGoldBreakdown(battle) {
    const breakdown = {
        participation: PARTICIPATION_GOLD * OTHER_PLAYERS_COUNT,
        topDamager: TOP_DAMAGER_BONUS * TOP_DAMAGERS_COUNT,
        victory: battle.won
            ? WIN_BONUS_ALLY * ALLIES_COUNT
            : WIN_BONUS_ENEMY * ENEMIES_COUNT,
        survival: battle.survived
            ? SURVIVE_BONUS_ALLY * ALLIES_COUNT
            : DESTROY_BONUS_ENEMY * ENEMIES_COUNT
    };
    return {
        total: breakdown.participation + breakdown.topDamager + breakdown.victory + breakdown.survival,
        breakdown
    };
}

/**
 * По дельте счётчиков аккаунта восстанавливаем исходы новых боёв.
 * Победы и выживания назначаются по порядку из дельт wins / survived_battles.
 *
 * @param {number} battlesDiff — новых боёв
 * @param {number} winsDiff — прирост побед блогера
 * @param {number} survivedDiff — прирост боёв, где блогер выжил
 * @returns {BattleOutcome[]}
 */
function inferBattleOutcomesFromAccountDelta(battlesDiff, winsDiff, survivedDiff) {
    const n = Math.max(0, battlesDiff);
    let winsLeft = Math.max(0, Math.min(winsDiff, n));
    let survLeft = Math.max(0, Math.min(survivedDiff, n));
    const battles = [];
    for (let i = 0; i < n; i++) {
        const won = winsLeft > 0;
        const survived = survLeft > 0;
        if (won) winsLeft--;
        if (survived) survLeft--;
        battles.push({ won, survived });
    }
    return battles;
}

module.exports = {
    calculateGoldDistributed,
    calculateGoldBreakdown,
    inferBattleOutcomesFromAccountDelta,
    GOLD_CONSTANTS: {
        ALLIES_COUNT,
        ENEMIES_COUNT,
        PARTICIPATION_GOLD,
        TOP_DAMAGER_BONUS,
        TOP_DAMAGERS_COUNT
    }
};
