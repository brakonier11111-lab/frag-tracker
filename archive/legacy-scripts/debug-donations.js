const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

console.log('🔍 ДИАГНОСТИКА ПРОБЛЕМЫ С ДОНАТАМИ\n');

async function debugDonations() {
    // 1. Проверяем API DonationAlerts
    console.log('1. Проверка API DonationAlerts:');
    try {
        const response = await axios.get('http://localhost:3000/api/da-api-test');
        console.log(`   ✅ Статус: ${response.status}`);
        console.log(`   📊 Данные:`, JSON.stringify(response.data, null, 2));
        
        if (response.data.success) {
            console.log(`   ✅ API работает, получено донатов: ${response.data.donationsCount}`);
            if (response.data.donations && response.data.donations.length > 0) {
                console.log('   📋 Последние донаты:');
                response.data.donations.forEach((donation, index) => {
                    console.log(`      ${index + 1}. ${donation.username}: ${donation.amount} ${donation.currency}`);
                    console.log(`         Сообщение: ${donation.message || 'Нет'}`);
                    console.log(`         Дата: ${donation.created_at}`);
                    console.log(`         ID: ${donation.id}`);
                });
            } else {
                console.log('   ⚠️ Донатов в API не найдено');
            }
        } else {
            console.log(`   ❌ Ошибка API: ${response.data.error}`);
        }
    } catch (error) {
        console.log(`   ❌ Ошибка запроса: ${error.message}`);
    }
    
    // 2. Проверяем базу данных
    console.log('\n2. Проверка базы данных:');
    const db = new sqlite3.Database('./frag_tracker.db');
    
    db.get('SELECT da_access_token FROM app_state WHERE id = 1', (err, row) => {
        if (err) {
            console.log(`   ❌ Ошибка БД: ${err.message}`);
        } else if (row) {
            console.log(`   ✅ Токен DA в БД: ${row.da_access_token ? 'ЕСТЬ' : 'НЕТ'}`);
            if (row.da_access_token) {
                console.log(`   🔑 Токен: ${row.da_access_token.substring(0, 20)}...`);
            }
        } else {
            console.log('   ⚠️ Нет записей в БД');
        }
        
        // Проверяем донаты в БД
        db.all('SELECT * FROM donations ORDER BY created_at DESC LIMIT 10', (err, rows) => {
            if (err) {
                console.log(`   ❌ Ошибка получения донатов: ${err.message}`);
            } else {
                console.log(`   📊 Донатов в БД: ${rows.length}`);
                if (rows.length > 0) {
                    console.log('   📋 Последние донаты в БД:');
                    rows.forEach((donation, index) => {
                        console.log(`      ${index + 1}. ${donation.username}: ${donation.amount} ${donation.currency}`);
                        console.log(`         Сообщение: ${donation.message || 'Нет'}`);
                        console.log(`         Дата: ${donation.created_at}`);
                        console.log(`         ID: ${donation.id}`);
                        console.log(`         Фраги: ${donation.frags_earned || 0}`);
                    });
                } else {
                    console.log('   ⚠️ Донатов в БД нет');
                }
            }
            
            // 3. Проверяем логику опроса
            console.log('\n3. Проверка логики опроса:');
            checkPollingLogic();
            
            db.close();
        });
    });
}

function checkPollingLogic() {
    console.log('   🔍 Проверяем настройки опроса...');
    
    // Проверяем переменные окружения
    const clientId = process.env.DA_CLIENT_ID || '16225';
    const clientSecret = process.env.DA_CLIENT_SECRET || '0VJ2dMRax8cJrQqAYQJ7dLnFCMPKOFZdjCHkU4Lw';
    
    console.log(`   🔑 Client ID: ${clientId}`);
    console.log(`   🔐 Client Secret: ${clientSecret.substring(0, 10)}...`);
    
    // 4. Тестируем прямой запрос к API
    console.log('\n4. Прямой тест API DonationAlerts:');
    testDirectAPI();
}

async function testDirectAPI() {
    try {
        // Получаем токен из БД
        const db = new sqlite3.Database('./frag_tracker.db');
        db.get('SELECT da_access_token FROM app_state WHERE id = 1', async (err, row) => {
            if (err || !row || !row.da_access_token) {
                console.log('   ❌ Токен не найден в БД');
                db.close();
                return;
            }
            
            const accessToken = row.da_access_token;
            console.log(`   🔑 Используем токен: ${accessToken.substring(0, 20)}...`);
            
            try {
                const response = await axios.get('https://www.donationalerts.com/api/v1/alerts/donations', {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                });
                
                console.log(`   ✅ Прямой API запрос успешен: ${response.status}`);
                console.log(`   📊 Получено донатов: ${response.data.data?.length || 0}`);
                
                if (response.data.data && response.data.data.length > 0) {
                    console.log('   📋 Последние донаты из API:');
                    response.data.data.slice(0, 3).forEach((donation, index) => {
                        console.log(`      ${index + 1}. ${donation.username}: ${donation.amount} ${donation.currency}`);
                        console.log(`         Сообщение: ${donation.message || 'Нет'}`);
                        console.log(`         Дата: ${donation.created_at}`);
                        console.log(`         ID: ${donation.id}`);
                    });
                } else {
                    console.log('   ⚠️ Донатов в API не найдено');
                }
                
            } catch (apiError) {
                console.log(`   ❌ Ошибка прямого API запроса: ${apiError.message}`);
                if (apiError.response) {
                    console.log(`   📊 Статус: ${apiError.response.status}`);
                    console.log(`   📋 Ответ: ${JSON.stringify(apiError.response.data)}`);
                }
            }
            
            db.close();
            
            // 5. Рекомендации
            console.log('\n5. РЕКОМЕНДАЦИИ:');
            console.log('   📋 Возможные причины проблемы:');
            console.log('   1. Токен недействителен или истек');
            console.log('   2. Нет донатов в аккаунте DonationAlerts');
            console.log('   3. Проблемы с правами доступа приложения');
            console.log('   4. Ошибка в логике обработки донатов');
            console.log('   5. Проблемы с сохранением в БД');
            
            console.log('\n   🔧 Следующие шаги:');
            console.log('   1. Проверьте есть ли донаты в личном кабинете DonationAlerts');
            console.log('   2. Отправьте тестовый донат');
            console.log('   3. Перезапустите сервер');
            console.log('   4. Проверьте логи сервера');
            console.log('   5. Выполните OAuth авторизацию заново');
        });
        
    } catch (error) {
        console.log(`   ❌ Ошибка: ${error.message}`);
    }
}

// Запуск диагностики
debugDonations().catch(console.error);

