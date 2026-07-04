'use strict';
/**
 * Хранилище донатов и достижений донатеров: нормализация ников, запись доната
 * с контекстом режимов таймера, выборка истории, апдейт достижений.
 * Вынесено из server.js 1:1. Deps: db (sqlite), getAppState.
 */

function createDonationsStore({ db, getAppState }) {
    function updateDonorAchievement(username, timeEarnedSeconds, donationId) {
        if (!username || !timeEarnedSeconds || timeEarnedSeconds <= 0) {
            return;
        }
    
        const normalizedUsername = normalizeUsername(username);
        if (!normalizedUsername) {
            return;
        }
    
        // Получаем или создаем запись донатера
        // ВАЖНО: Используем транзакцию для предотвращения гонок условий
        db.serialize(() => {
            db.get('SELECT * FROM donor_achievements WHERE normalized_username = ?', [normalizedUsername], (err, achievement) => {
                if (err) {
                    console.error('❌ Ошибка получения достижения донатера:', err);
                    return;
                }
            
                const timeEarnedMinutes = Math.floor(timeEarnedSeconds / 60);
                const now = new Date().toISOString();
            
                if (!achievement) {
                // Создаем новую запись
                const totalSeconds = timeEarnedSeconds;
                const totalMinutes = timeEarnedMinutes;
            
                    // Определяем текущий уровень
                    // Ищем уровень, который соответствует времени донатера
                    db.get(`SELECT * FROM donor_achievement_tiers 
                        WHERE min_minutes <= ? AND (max_minutes IS NULL OR max_minutes >= ?)
                        ORDER BY sort_order DESC LIMIT 1`, 
                        [totalMinutes, totalMinutes], 
                        (err, tier) => {
                            if (err) {
                                console.error('❌ Ошибка получения уровня достижения:', err);
                                return;
                            }
                        
                            // Если уровень не найден (например, меньше 5 минут), не присваиваем уровень
                            // Используем INSERT OR IGNORE с последующей проверкой
                            db.run(`INSERT OR IGNORE INTO donor_achievements 
                                (normalized_username, username, total_time_seconds, total_time_minutes, 
                                 current_tier_id, last_donation_id, last_donation_time)
                                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                                [normalizedUsername, username, totalSeconds, totalMinutes, 
                                 tier ? tier.id : null, donationId, now],
                            function(insertErr) {
                                if (insertErr) {
                                    console.error('❌ Ошибка создания достижения донатера:', insertErr);
                                    return;
                                }
                            
                                // Если запись не была вставлена (уже существует), обновляем
                                if (this.changes === 0) {
                                    console.log(`⚠️ Достижение уже существует для ${username}, обновляем...`);
                                    db.get('SELECT * FROM donor_achievements WHERE normalized_username = ?', [normalizedUsername], (getErr, existing) => {
                                        if (getErr || !existing) {
                                            console.error('❌ Ошибка получения существующего достижения:', getErr);
                                            return;
                                        }
                                        const newTotalSeconds = (existing.total_time_seconds || 0) + timeEarnedSeconds;
                                        const newTotalMinutes = Math.floor(newTotalSeconds / 60);
                                        db.get(`SELECT * FROM donor_achievement_tiers 
                                            WHERE min_minutes <= ? AND (max_minutes IS NULL OR max_minutes >= ?)
                                            ORDER BY sort_order DESC LIMIT 1`, 
                                            [newTotalMinutes, newTotalMinutes], 
                                            (tierErr, newTier) => {
                                                if (tierErr) {
                                                    console.error('❌ Ошибка получения уровня:', tierErr);
                                                    return;
                                                }
                                                db.run(`UPDATE donor_achievements 
                                                    SET total_time_seconds = ?, total_time_minutes = ?,
                                                        current_tier_id = COALESCE(?, current_tier_id),
                                                        last_donation_id = ?, last_donation_time = ?,
                                                        username = ?, updated_at = CURRENT_TIMESTAMP
                                                    WHERE normalized_username = ?`,
                                                    [newTotalSeconds, newTotalMinutes, newTier ? newTier.id : null, donationId, now, username, normalizedUsername],
                                                    (updateErr) => {
                                                        if (updateErr) {
                                                            console.error('❌ Ошибка обновления достижения:', updateErr);
                                                        } else {
                                                            console.log(`✅ Обновлено достижение для ${username}: +${timeEarnedMinutes} мин (всего: ${newTotalMinutes} мин)`);
                                                        }
                                                    }
                                                );
                                            }
                                        );
                                    });
                                } else {
                                    console.log(`✅ Создано достижение для ${username}: +${timeEarnedMinutes} мин (всего: ${totalMinutes} мин)`);
                                }
                            }
                        );
                    }
                );
                } else {
                    // Обновляем существующую запись
                    const newTotalSeconds = (achievement.total_time_seconds || 0) + timeEarnedSeconds;
                    const newTotalMinutes = Math.floor(newTotalSeconds / 60);
                
                    // Определяем новый уровень
                    db.get(`SELECT * FROM donor_achievement_tiers 
                        WHERE min_minutes <= ? AND (max_minutes IS NULL OR max_minutes >= ?)
                        ORDER BY sort_order DESC LIMIT 1`, 
                        [newTotalMinutes, newTotalMinutes], 
                        (err, tier) => {
                            if (err) {
                                console.error('❌ Ошибка получения уровня достижения:', err);
                                return;
                            }
                        
                            // Если уровень не найден, оставляем текущий или null
                            // НЕ используем дефолтное значение "Новичок"
                            const newTierId = tier ? tier.id : (achievement.current_tier_id || null);
                            const tierChanged = newTierId !== achievement.current_tier_id;
                        
                            db.run(`UPDATE donor_achievements 
                                SET total_time_seconds = ?, total_time_minutes = ?, 
                                    current_tier_id = ?, last_donation_id = ?, last_donation_time = ?,
                                    username = ?, updated_at = CURRENT_TIMESTAMP
                                WHERE normalized_username = ?`,
                                [newTotalSeconds, newTotalMinutes, newTierId, donationId, now, username, normalizedUsername],
                                (err) => {
                                    if (err) {
                                        console.error('❌ Ошибка обновления достижения донатера:', err);
                                    } else {
                                        console.log(`✅ Обновлено достижение для ${username}: +${timeEarnedMinutes} мин (всего: ${newTotalMinutes} мин)`);
                                        if (tierChanged) {
                                            console.log(`🎉 ${username} получил новый уровень достижения!`);
                                        }
                                    }
                                }
                            );
                        }
                    );
                }
            });
        });
    }

    function normalizeUsername(username) {
        if (!username || typeof username !== 'string') {
            return '';
        }
    
        // Приводим к нижнему регистру
        let normalized = username.toLowerCase().trim();
    
        // Убираем лишние пробелы
        normalized = normalized.replace(/\s+/g, ' ');
    
        // Заменяем различные разделители на единообразные
        normalized = normalized.replace(/[_\-\s]+/g, '_');
    
        // Убираем специальные символы, оставляем только буквы, цифры и подчеркивания
        normalized = normalized.replace(/[^a-zа-я0-9_]/g, '');
    
        // Убираем множественные подчеркивания
        normalized = normalized.replace(/_+/g, '_');
    
        // Убираем подчеркивания в начале и конце
        normalized = normalized.replace(/^_+|_+$/g, '');
    
        // Если результат пустой, возвращаем оригинальный ник
        if (!normalized) {
            return username.toLowerCase().trim();
        }
    
        return normalized;
    }

    // Функция для поиска похожих ников в базе данных
    function findSimilarUsernames(normalizedUsername, callback) {
        if (!normalizedUsername) {
            callback([]);
            return;
        }
    
        // Ищем ники, которые отличаются только регистром, пробелами или разделителями
        const searchPattern = normalizedUsername.replace(/_/g, '[_\-\s]*');
    
        db.all(`
            SELECT DISTINCT username, normalized_username 
            FROM donations 
            WHERE normalized_username LIKE ? 
            OR username LIKE ?
            ORDER BY username
        `, [`%${normalizedUsername}%`, `%${searchPattern}%`], (err, rows) => {
            if (err) {
                console.error('❌ Ошибка поиска похожих ников:', err);
                callback([]);
            } else {
                callback(rows || []);
            }
        });
    }

    function saveDonation(donation, callback) {
        // Получаем текущее состояние для сохранения информации о режимах таймера
        getAppState((state) => {
            if (!state) {
                console.error('❌ Не удалось получить состояние для сохранения доната');
                if (callback) callback(new Error('State not found'));
                return;
            }
        
            // Нормализуем ник для группировки похожих ников
            const normalizedUsername = normalizeUsername(donation.username);
        
            // Логируем нормализацию для отладки
            console.log(`🔤 Нормализация имени: "${donation.username}" -> "${normalizedUsername}"`);
        
            db.run(`INSERT OR REPLACE INTO donations (
                id, username, amount, message, currency, is_realtime, 
                frags_earned, time_earned, custom_units_earned,
                timer_mode, timer_seconds, 
                discount_active, discount_percentage,
                slowdown_active, slowdown_factor,
                temperature_active, temperature_amount, temperature_target,
                temperature_overheated, temperature_reward_minutes,
                normalized_username
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    donation.id, donation.username, donation.amount, donation.message, 
                    donation.currency || 'RUB', donation.isRealtime ? 1 : 0, 
                    donation.fragsEarned || 0, donation.timeEarned || 0, donation.customUnitsEarned || 0,
                    // Информация о режимах таймера
                    state.current_mode || 'mode1',
                    state.timer_seconds || 0,
                    state.timer_discount_active || 0,
                    state.timer_discount || 0,
                    state.timer_slowdown_active || 0,
                    state.timer_slowdown_factor || 1.0,
                    state.temperature_mode_active || 0,
                    state.temperature_current_amount || 0,
                    state.temperature_target_amount || 0,
                    state.temperature_overheated || 0,
                    state.temperature_peak_reward_minutes || 0,
                    // Нормализованный ник
                    normalizedUsername
                ],
                function(err) {
                    if (err) {
                        console.error('❌ Ошибка сохранения доната:', err);
                        console.error('   Донат ID:', donation.id);
                        console.error('   Донат username:', donation.username);
                        console.error('   Донат amount:', donation.amount);
                    } else {
                        console.log(`✅ Донат сохранен в БД: ID=${donation.id}, username=${donation.username}, normalized=${normalizedUsername}, amount=${donation.amount}₽, time_earned=${donation.timeEarned || 0} сек`);
                    }
                    if (callback) callback(err);
                }
            );
        });
    }

    function getDonations(limit = 50, offset = 0, callback) {
        // Сортируем по created_at DESC, а затем по id DESC для гарантии правильного порядка
        // Это важно, если несколько донатов имеют одинаковую дату
        db.all(`SELECT * FROM donations ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?`, [limit, offset], (err, rows) => {
            if (err) {
                if (err.message && err.message.includes('no such table')) {
                    return callback(null, []);
                }
                return callback(err);
            }
        
            // Логируем последний донат только при необходимости (убрано для уменьшения логов)
            // if (rows && rows.length > 0 && limit === 1) {
            //     const lastDonation = rows[0];
            //     console.log(`📋 Последний донат (api/donations?limit=1): ${lastDonation.username} - ${lastDonation.amount}₽, дата: ${lastDonation.created_at}`);
            // }
        
            callback(null, rows);
        });
    }

    return {
        updateDonorAchievement,
        normalizeUsername,
        findSimilarUsernames,
        saveDonation,
        getDonations
    };
}

module.exports = { createDonationsStore };
