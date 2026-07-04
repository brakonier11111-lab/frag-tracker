'use strict';
/**
 * Чистая математика начислений от доната — вынесена 1:1 из processDonationCore
 * (server.js). Никаких БД/сайд-эффектов: state читается, результат возвращается.
 * Семантика закреплена регресс-тестами scripts/test-donation-pipeline.js и
 * юнитами tests/donation-math.test.js.
 */

/** Режим 1 (фраг-трекер): (баланс + сумма) / цена единицы, остаток в баланс. */
function computeFragAward(state, amount) {
    const fragCostPerUnit = state.frag_cost / state.frag_amount;
    const currentBalance = state.current_balance || 0;
    const totalAmount = currentBalance + amount;
    return {
        unitsEarned: Math.floor(totalAmount / fragCostPerUnit),
        remainingBalance: totalAmount % fragCostPerUnit
    };
}

/**
 * Режим 2 (таймер): секунды по цене минуты с учётом скидки.
 * Скидка действует при timer_discount>0 и (until==0 или now<until);
 * истёкшая скидка помечается discountExpired — вызывающий обнуляет поля.
 */
function computeTimerAward(state, amount, nowSec) {
    const baseCostPerMinute = state.cost_per_minute || 50;
    const discountUntil = state.timer_discount_until_ts || 0;
    let discount = 0;
    let discountExpired = false;
    if (state.timer_discount && state.timer_discount > 0) {
        if (discountUntil === 0 || nowSec < discountUntil) {
            discount = state.timer_discount;
        } else {
            discountExpired = true;
        }
    }
    const actualCostPerMinute = Math.max(1, baseCostPerMinute - discount);
    const secondsPerRuble = 60 / actualCostPerMinute;
    return {
        timeEarned: Math.floor(amount * secondsPerRuble),
        actualCostPerMinute,
        discount,
        discountExpired
    };
}

/** Режим 3 (кастомная цель): та же схема, что фраги, на custom_*-полях. */
function computeCustomAward(state, amount) {
    const customCostPerUnit = state.custom_unit_cost / state.custom_unit_amount;
    const customCurrentBalance = state.custom_current_balance || 0;
    const customTotalAmount = customCurrentBalance + amount;
    return {
        unitsEarned: Math.floor(customTotalAmount / customCostPerUnit),
        remainingBalance: customTotalAmount % customCostPerUnit
    };
}

module.exports = { computeFragAward, computeTimerAward, computeCustomAward };
