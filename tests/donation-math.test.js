'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { computeFragAward, computeTimerAward, computeCustomAward } = require('../src/core/donation-math');

test('фраги: 250₽ при 100₽/фраг — 2 фрага, остаток 50', () => {
    const r = computeFragAward({ frag_cost: 100, frag_amount: 1, current_balance: 0 }, 250);
    assert.strictEqual(r.unitsEarned, 2);
    assert.strictEqual(r.remainingBalance, 50);
});

test('фраги: баланс копится между донатами', () => {
    const r = computeFragAward({ frag_cost: 100, frag_amount: 1, current_balance: 70 }, 40);
    assert.strictEqual(r.unitsEarned, 1);
    assert.strictEqual(r.remainingBalance, 10);
});

test('фраги: frag_amount>1 удешевляет единицу (100₽ за 4 фрага)', () => {
    const r = computeFragAward({ frag_cost: 100, frag_amount: 4, current_balance: 0 }, 60);
    assert.strictEqual(r.unitsEarned, 2); // 25₽/фраг
    assert.strictEqual(r.remainingBalance, 10);
});

test('таймер: 60₽/мин без скидки — 1 сек/₽', () => {
    const r = computeTimerAward({ cost_per_minute: 60 }, 250, 1000);
    assert.strictEqual(r.timeEarned, 250);
    assert.strictEqual(r.actualCostPerMinute, 60);
    assert.strictEqual(r.discountExpired, false);
});

test('таймер: бессрочная скидка (until=0) применяется', () => {
    const r = computeTimerAward({ cost_per_minute: 60, timer_discount: 30, timer_discount_until_ts: 0 }, 50, 1000);
    assert.strictEqual(r.timeEarned, 100); // 30₽/мин → 2 сек/₽
    assert.strictEqual(r.discount, 30);
});

test('таймер: активная временнáя скидка применяется', () => {
    const r = computeTimerAward({ cost_per_minute: 60, timer_discount: 30, timer_discount_until_ts: 2000 }, 50, 1999);
    assert.strictEqual(r.timeEarned, 100);
});

test('таймер: истёкшая скидка не применяется и помечается', () => {
    const r = computeTimerAward({ cost_per_minute: 60, timer_discount: 30, timer_discount_until_ts: 2000 }, 60, 2000);
    assert.strictEqual(r.timeEarned, 60);
    assert.strictEqual(r.discount, 0);
    assert.strictEqual(r.discountExpired, true);
});

test('таймер: цена клэмпится снизу единицей (скидка больше цены)', () => {
    const r = computeTimerAward({ cost_per_minute: 50, timer_discount: 999, timer_discount_until_ts: 0 }, 10, 0);
    assert.strictEqual(r.actualCostPerMinute, 1);
    assert.strictEqual(r.timeEarned, 600); // 60 сек/₽
});

test('таймер: дефолт цены 50₽/мин, дробные секунды отбрасываются', () => {
    const r = computeTimerAward({}, 41, 0); // 1.2 сек/₽ → 49.2
    assert.strictEqual(r.timeEarned, 49);
});

test('кастом: 250₽ при 70₽/ед — 3 единицы, остаток 40', () => {
    const r = computeCustomAward({ custom_unit_cost: 70, custom_unit_amount: 1, custom_current_balance: 0 }, 250);
    assert.strictEqual(r.unitsEarned, 3);
    assert.strictEqual(r.remainingBalance, 40);
});

test('кастом: баланс копится', () => {
    const r = computeCustomAward({ custom_unit_cost: 100, custom_unit_amount: 1, custom_current_balance: 90 }, 20);
    assert.strictEqual(r.unitsEarned, 1);
    assert.strictEqual(r.remainingBalance, 10);
});
