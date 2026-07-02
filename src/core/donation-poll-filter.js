'use strict';

/**
 * Чистая функция классификации доната при опросе (DonationAlerts/DonatePay) —
 * выделена из цикла checkForNewDonations в server.js с семантикой 1:1, чтобы
 * решение «засчитать / пропустить» можно было протестировать без сети, БД
 * и поднятия сервера. Побочные эффекты (вызов processDonation, мутация
 * processedIds/lastSeenDonationId, немедленный повторный опрос DonatePay)
 * остаются в server.js — здесь только решение.
 *
 * Возвращает { action, donationId, isNumericId }, action — одно из:
 *   'skip_old_by_time'       — донат старше maxAgeMs по created_at
 *   'skip_already_processed' — id уже встречался (processedIds)
 *   'skip_old_by_id'         — числовой id <= lastSeenDonationId (DonationAlerts)
 *   'process'                — донат нужно обработать
 */
function classifyDonationForPolling(donation, { processedIds, lastSeenDonationId, nowMs, maxAgeMs }) {
    const donationId = donation.id.toString();

    let donationTime = null;
    if (donation.created_at) {
        if (typeof donation.created_at === 'string') {
            donationTime = new Date(donation.created_at).getTime();
        } else if (typeof donation.created_at === 'number') {
            donationTime = donation.created_at * 1000; // timestamp в секундах
        }
    } else if (donation.created_at_ts) {
        donationTime = donation.created_at_ts * 1000;
    }

    if (donationTime && (nowMs - donationTime) > maxAgeMs) {
        return { action: 'skip_old_by_time', donationId };
    }

    if (processedIds.has(donationId)) {
        return { action: 'skip_already_processed', donationId };
    }

    // Для донатов с числовыми ID (DonationAlerts) — пропускаем старые.
    // Для донатов с префиксом (DonatePay: dp_xxx) — обрабатываем все новые.
    const isNumericId = /^\d+$/.test(donationId);
    if (isNumericId && lastSeenDonationId && parseInt(donationId, 10) <= parseInt(lastSeenDonationId, 10)) {
        return { action: 'skip_old_by_id', donationId, isNumericId };
    }

    return { action: 'process', donationId, isNumericId };
}

module.exports = { classifyDonationForPolling };
