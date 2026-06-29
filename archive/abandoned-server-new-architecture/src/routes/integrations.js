const express = require('express');
const router = express.Router();
const axios = require('axios');
const cheerio = require('cheerio');

module.exports = function(database) {
    /**
     * Сохранить токен виджета DonationAlerts
     */
    router.post('/da-widget-token', async (req, res) => {
        try {
            const { token } = req.body;
            
            if (!token) {
                return res.status(400).json({ success: false, error: 'Токен не предоставлен' });
            }
            
            // Очищаем токен от возможного URL
            let cleanToken = token.trim();
            if (cleanToken.includes('token=')) {
                cleanToken = cleanToken.split('token=')[1].split('&')[0].split(' ')[0];
            }
            
            // Сохраняем токен в БД
            await database.run(`
                UPDATE app_state SET da_widget_token = ? WHERE id = 1
            `, [cleanToken]);
            
            // Тестируем токен
            let testResult = null;
            try {
                const widgetUrl = `https://www.donationalerts.com/widget/lastdonations?alert_type=1,20,27,28,29,30,31,32&limit=10&token=${cleanToken}`;
                const response = await axios.get(widgetUrl, {
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                
                const $ = cheerio.load(response.data);
                const donations = [];
                
                $('.donation-item, .donation, .last-donation').each((i, elem) => {
                    const $el = $(elem);
                    const username = $el.find('.username, .name, .donor-name').text().trim() || 
                                   $el.find('strong').first().text().trim();
                    const amountText = $el.find('.amount, .sum, .money').text().trim() || 
                                     $el.find('.price').text().trim();
                    const amount = parseFloat(amountText.replace(/[^\d.]/g, '')) || 0;
                    const message = $el.find('.message, .comment, .text').text().trim() || '';
                    
                    if (username && amount > 0) {
                        donations.push({
                            username,
                            amount,
                            message,
                            currency: 'RUB'
                        });
                    }
                });
                
                testResult = {
                    donationsFound: donations.length,
                    donations: donations.slice(0, 5)
                };
            } catch (testError) {
                console.error('Ошибка тестирования токена виджета:', testError.message);
                // Не возвращаем ошибку, просто токен сохранен
            }
            
            res.json({ 
                success: true, 
                testResult,
                message: 'Токен виджета сохранен'
            });
        } catch (error) {
            console.error('Ошибка сохранения токена виджета:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    /**
     * Принудительная проверка донатов через виджет DonationAlerts
     */
    router.post('/force-check-widget-da', async (req, res) => {
        try {
            // Получаем токен виджета из БД
            const state = await database.get('SELECT da_widget_token FROM app_state WHERE id = 1');
            
            if (!state || !state.da_widget_token) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Токен виджета не настроен' 
                });
            }
            
            const widgetUrl = `https://www.donationalerts.com/widget/lastdonations?alert_type=1,20,27,28,29,30,31,32&limit=10&token=${state.da_widget_token}`;
            
            const response = await axios.get(widgetUrl, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            const $ = cheerio.load(response.data);
            const donations = [];
            
            $('.donation-item, .donation, .last-donation').each((i, elem) => {
                const $el = $(elem);
                const username = $el.find('.username, .name, .donor-name').text().trim() || 
                               $el.find('strong').first().text().trim();
                const amountText = $el.find('.amount, .sum, .money').text().trim() || 
                                 $el.find('.price').text().trim();
                const amount = parseFloat(amountText.replace(/[^\d.]/g, '')) || 0;
                const message = $el.find('.message, .comment, .text').text().trim() || '';
                
                if (username && amount > 0) {
                    donations.push({
                        id: `widget_${Date.now()}_${i}`,
                        username,
                        amount,
                        message,
                        currency: 'RUB'
                    });
                }
            });
            
            res.json({ 
                success: true,
                donationsFound: donations.length,
                donations: donations.slice(0, 10)
            });
        } catch (error) {
            console.error('Ошибка проверки виджета DonationAlerts:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    return router;
};

