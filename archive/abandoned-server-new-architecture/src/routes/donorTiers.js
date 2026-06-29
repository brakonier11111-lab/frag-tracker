const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

module.exports = function(database) {
    // Конфигурация multer для загрузки иконок
    const storage = multer.diskStorage({
        destination: function (req, file, cb) {
            const uploadDir = path.join(__dirname, '../../public/uploads/tiers');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            cb(null, uploadDir);
        },
        filename: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '_' + Math.round(Math.random() * 1E9);
            cb(null, `tier_${req.params.tier}_${uniqueSuffix}${path.extname(file.originalname)}`);
        }
    });

    const upload = multer({ 
        storage: storage,
        limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
        fileFilter: (req, file, cb) => {
            const allowedTypes = /jpeg|jpg|png|gif|webp/;
            const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
            const mimetype = allowedTypes.test(file.mimetype);
            
            if (mimetype && extname) {
                return cb(null, true);
            } else {
                cb(new Error('Только изображения разрешены!'));
            }
        }
    });

    /**
     * Получить все достижения
     */
    router.get('/', async (req, res) => {
        try {
            const tiers = await database.all('SELECT * FROM donor_tiers ORDER BY tier ASC');
            
            res.json({ 
                success: true, 
                tiers: tiers.map(tier => ({
                    ...tier,
                    max_amount: tier.max_amount === null || tier.max_amount === 999999999 ? null : tier.max_amount
                }))
            });
        } catch (error) {
            console.error('Ошибка получения достижений:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    /**
     * Получить достижение по номеру
     */
    router.get('/:tier', async (req, res) => {
        try {
            const tier = await database.get('SELECT * FROM donor_tiers WHERE tier = ?', [req.params.tier]);
            
            if (!tier) {
                return res.status(404).json({ success: false, error: 'Достижение не найдено' });
            }
            
            res.json({ 
                success: true, 
                tier: {
                    ...tier,
                    max_amount: tier.max_amount === null || tier.max_amount === 999999999 ? null : tier.max_amount
                }
            });
        } catch (error) {
            console.error('Ошибка получения достижения:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    /**
     * Обновить достижение
     */
    router.post('/:tier', async (req, res) => {
        try {
            const { title, min_amount, max_amount, color, icon_path } = req.body;
            
            if (!title || min_amount === undefined) {
                return res.status(400).json({ success: false, error: 'Название и минимальная сумма обязательны' });
            }
            
            const maxAmountValue = max_amount === null || max_amount === '' || max_amount === undefined ? 999999999 : max_amount;
            
            await database.run(`
                UPDATE donor_tiers 
                SET title = ?, min_amount = ?, max_amount = ?, color = ?, icon_path = ?, updated_at = CURRENT_TIMESTAMP
                WHERE tier = ?
            `, [title, min_amount, maxAmountValue, color || '#ffffff', icon_path || null, req.params.tier]);
            
            res.json({ success: true });
        } catch (error) {
            console.error('Ошибка обновления достижения:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    /**
     * Загрузить иконку для достижения
     */
    router.post('/:tier/icon', upload.single('icon'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ success: false, error: 'Файл не загружен' });
            }
            
            const iconPath = `/uploads/tiers/${req.file.filename}`;
            
            await database.run(`
                UPDATE donor_tiers 
                SET icon_path = ?, updated_at = CURRENT_TIMESTAMP
                WHERE tier = ?
            `, [iconPath, req.params.tier]);
            
            res.json({ success: true, icon_path: iconPath });
        } catch (error) {
            console.error('Ошибка загрузки иконки:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    return router;
};

