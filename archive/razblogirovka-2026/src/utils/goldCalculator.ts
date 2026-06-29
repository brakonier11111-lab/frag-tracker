/**
 * TypeScript-спецификация (рантайм: goldCalculator.js).
 * Победа и выживание — отдельные счётчики Lesta; при поражении выживание тоже учитывается.
 */

export interface BattleOutcome {
  won: boolean;
  survived: boolean;
}

/** 6 союзников + 7 врагов; блогер не получает золото */
const ALLIES = 6;
const ENEMIES = 7;

export function calculateGoldDistributed(battle: BattleOutcome): number {
  let gold = 250 * (ALLIES + ENEMIES); // участие
  gold += 500 * 2; // топ-дамагер в каждой команде
  gold += battle.won ? 250 * ALLIES : 250 * ENEMIES;
  gold += battle.survived ? 500 * ALLIES : 500 * ENEMIES;
  return gold;
}
