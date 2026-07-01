'use strict';

/**
 * API «достижения донатеров» (уровни по суммарному времени доната).
 * Вынесено из server.js — независимый CRUD над donor_achievements /
 * donor_achievement_tiers, зависит только от db, fs, path и normalizeUsername.
 */

const fs = require('fs');
const path = require('path');

function createDonorAchievementsModule(deps) {
    const { db, appRoot, normalizeUsername } = deps;

    function registerRoutes(app) {
        app.get('/api/donor-achievements', (req, res) => {
            // Используем GROUP BY для предотвращения дублирования
            db.all(`SELECT da.id, da.normalized_username, da.username, da.total_time_seconds, da.total_time_minutes,
                           da.current_tier_id, da.last_donation_id, da.last_donation_time, da.created_at, da.updated_at,
                           dat.name as tier_name, dat.icon as tier_icon, dat.color as tier_color, dat.custom_icon_url as tier_custom_icon_url
                    FROM donor_achievements da
                    LEFT JOIN donor_achievement_tiers dat ON da.current_tier_id = dat.id
                    GROUP BY da.normalized_username
                    ORDER BY da.total_time_minutes DESC`, (err, achievements) => {
                if (err) {
                    console.error('❌ Ошибка получения достижений:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }
                res.json({ success: true, achievements: achievements || [] });
            });
        });

        app.get('/api/donor-achievements/:username', (req, res) => {
            const normalizedUsername = normalizeUsername(req.params.username);
            if (!normalizedUsername) {
                return res.status(400).json({ success: false, error: 'Invalid username' });
            }

            db.get(`SELECT da.*, dat.name as tier_name, dat.icon as tier_icon, dat.color as tier_color, dat.description as tier_description
                    FROM donor_achievements da
                    LEFT JOIN donor_achievement_tiers dat ON da.current_tier_id = dat.id
                    WHERE da.normalized_username = ?`, [normalizedUsername], (err, achievement) => {
                if (err) {
                    console.error('❌ Ошибка получения достижения:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }
                if (!achievement) {
                    return res.status(404).json({ success: false, error: 'Achievement not found' });
                }
                res.json({ success: true, achievement });
            });
        });

        app.get('/api/donor-achievement-tiers', (req, res) => {
            // Используем DISTINCT и GROUP BY для гарантированного удаления дубликатов
            db.all(`
                SELECT DISTINCT
                    id, name, min_minutes, max_minutes, icon, custom_icon_url,
                    color, description, sort_order, created_at, updated_at
                FROM donor_achievement_tiers
                WHERE id IN (
                    SELECT MIN(id)
                    FROM donor_achievement_tiers
                    GROUP BY sort_order
                )
                ORDER BY sort_order ASC
            `, (err, tiers) => {
                if (err) {
                    console.error('❌ Ошибка получения уровней:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }

                // Дополнительная фильтрация на случай если все еще есть дубликаты
                const uniqueTiers = [];
                const seenIds = new Set();
                const seenSortOrders = new Set();

                (tiers || []).forEach(tier => {
                    // Проверяем и по id, и по sort_order
                    if (tier.id && !seenIds.has(tier.id) && tier.sort_order !== null && !seenSortOrders.has(tier.sort_order)) {
                        seenIds.add(tier.id);
                        seenSortOrders.add(tier.sort_order);
                        uniqueTiers.push(tier);
                    }
                });

                console.log(`📊 Загружено уровней: ${tiers?.length || 0}, уникальных: ${uniqueTiers.length}`);

                res.json({ success: true, tiers: uniqueTiers });
            });
        });

        app.put('/api/donor-achievement-tiers/:id', (req, res) => {
            const tierId = parseInt(req.params.id);
            const { name, min_minutes, max_minutes, icon, color, description } = req.body;

            const updates = {};
            if (name !== undefined) updates.name = name;
            if (min_minutes !== undefined) updates.min_minutes = min_minutes;
            if (max_minutes !== undefined) updates.max_minutes = max_minutes === '' ? null : max_minutes;
            if (icon !== undefined) updates.icon = icon;
            if (color !== undefined) updates.color = color;
            if (description !== undefined) updates.description = description;

            const fields = Object.keys(updates);
            if (fields.length === 0) {
                return res.status(400).json({ success: false, error: 'No fields to update' });
            }

            const setClause = fields.map(f => `${f} = ?`).join(', ');
            const values = fields.map(f => updates[f]);
            values.push(tierId);

            db.run(`UPDATE donor_achievement_tiers SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                values, function(err) {
                    if (err) {
                        console.error('❌ Ошибка обновления уровня:', err);
                        return res.status(500).json({ success: false, error: err.message });
                    }
                    res.json({ success: true, message: 'Tier updated successfully' });
                });
        });

        // API для загрузки значка достижения
        app.post('/api/donor-achievement-tiers/:id/upload-icon', (req, res) => {
            const tierId = parseInt(req.params.id);
            if (!tierId) {
                return res.status(400).json({ success: false, error: 'Invalid tier ID' });
            }

            // Проверяем наличие изображения в base64
            const { imageData } = req.body;
            if (!imageData || !imageData.startsWith('data:image/')) {
                return res.status(400).json({ success: false, error: 'Invalid image data' });
            }

            // Создаем директорию для значков если её нет
            const iconsDir = path.join(appRoot, 'public', 'uploads', 'achievement-icons');
            if (!fs.existsSync(iconsDir)) {
                fs.mkdirSync(iconsDir, { recursive: true });
            }

            // Извлекаем данные изображения
            const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
            if (!matches) {
                return res.status(400).json({ success: false, error: 'Invalid image format' });
            }

            const imageType = matches[1];
            const imageBuffer = Buffer.from(matches[2], 'base64');

            // Сохраняем файл
            const filename = `tier_${tierId}_${Date.now()}.${imageType}`;
            const filepath = path.join(iconsDir, filename);

            fs.writeFile(filepath, imageBuffer, (err) => {
                if (err) {
                    console.error('❌ Ошибка сохранения значка:', err);
                    return res.status(500).json({ success: false, error: 'Failed to save icon' });
                }

                // Обновляем URL в базе данных
                const iconUrl = `/uploads/achievement-icons/${filename}`;
                db.run(`UPDATE donor_achievement_tiers SET custom_icon_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [iconUrl, tierId], (updateErr) => {
                        if (updateErr) {
                            console.error('❌ Ошибка обновления URL значка:', updateErr);
                            // Удаляем файл если не удалось обновить БД
                            try { fs.unlinkSync(filepath); } catch(e) {}
                            return res.status(500).json({ success: false, error: 'Failed to update database' });
                        }
                        res.json({ success: true, iconUrl: iconUrl });
                    });
            });
        });

        // API для удаления значка достижения
        app.delete('/api/donor-achievement-tiers/:id/icon', (req, res) => {
            const tierId = parseInt(req.params.id);
            if (!tierId) {
                return res.status(400).json({ success: false, error: 'Invalid tier ID' });
            }

            // Получаем текущий URL значка
            db.get('SELECT custom_icon_url FROM donor_achievement_tiers WHERE id = ?', [tierId], (err, tier) => {
                if (err) {
                    console.error('❌ Ошибка получения значка:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }

                if (!tier || !tier.custom_icon_url) {
                    return res.status(404).json({ success: false, error: 'Icon not found' });
                }

                // Удаляем файл
                const filepath = path.join(appRoot, 'public', tier.custom_icon_url);
                if (fs.existsSync(filepath)) {
                    try {
                        fs.unlinkSync(filepath);
                    } catch (unlinkErr) {
                        console.error('❌ Ошибка удаления файла:', unlinkErr);
                    }
                }

                // Обновляем БД
                db.run('UPDATE donor_achievement_tiers SET custom_icon_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [tierId], (updateErr) => {
                        if (updateErr) {
                            console.error('❌ Ошибка удаления значка из БД:', updateErr);
                            return res.status(500).json({ success: false, error: 'Failed to update database' });
                        }
                        res.json({ success: true, message: 'Icon deleted successfully' });
                    });
            });
        });
    }

    return { registerRoutes };
}

module.exports = { createDonorAchievementsModule };
