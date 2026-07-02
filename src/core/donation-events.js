'use strict';

/**
 * Шина события «донат»: побочные потребители processDonation подписываются
 * вместо жёстко вшитого веера вызовов. emit синхронный, порядок вызова =
 * порядок подписки (тот же, что был у прямых вызовов), каждый подписчик
 * изолирован try/catch — падение одного не задевает остальных и ядро.
 *
 * Событие: { donation, state, fragUnitsEarned, timeEarned, customUnitsEarned }
 */
function createDonationBus() {
    const listeners = [];

    function subscribe(name, fn) {
        listeners.push({ name, fn });
    }

    function emit(event) {
        for (const { name, fn } of listeners) {
            try {
                fn(event);
            } catch (e) {
                console.warn(`⚠️ Подписчик доната «${name}» упал:`, e);
            }
        }
    }

    return { subscribe, emit };
}

module.exports = { createDonationBus };
