const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');

// Подключение к базе данных
const dbPath = path.join(__dirname, 'frag_tracker.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Диагностика DonationAlerts');

// Конфигурация DonationAlerts
const DA_CONFIG = {
    clientId: process.env.DA_CLIENT_ID || '16225',
    clientSecret: process.env.DA_CLIENT_SECRET || '0VJ2dMRax8cJrQqAYQJ7dLnFCMPKOFZdjCHkU4Lw',
    redirectUri: process.env.DA_REDIRECT_URI || 'http://localhost:3000/auth/callback',
    accessToken: null,
    apiUrl: 'https://www.donationalerts.com/api/v1'
};

async function diagnoseDonationAlerts() {
    console.log('\n📊 Конфигурация DonationAlerts:');
    console.log(`   Client ID: ${DA_CONFIG.clientId}`);
    console.log(`   Client Secret: ${DA_CONFIG.clientSecret ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ'}`);
    console.log(`   Redirect URI: ${DA_CONFIG.redirectUri}`);
    console.log(`   API URL: ${DA_CONFIG.apiUrl}`);

    // Проверяем токен в базе данных
    console.log('\n🔍 Проверка токена в базе данных...');
    
    db.get('SELECT da_access_token FROM app_state WHERE id = 1', (err, row) => {
        if (err) {
            console.error('❌ Ошибка получения токена из БД:', err);
            return;
        }

        if (row && row.da_access_token) {
            DA_CONFIG.accessToken = row.da_access_token;
            console.log('✅ Токен найден в БД');
            console.log(`   Токен: ${DA_CONFIG.accessToken.substring(0, 20)}...`);
            
            // Тестируем API с токеном
            testDonationAlertsAPI();
        } else {
            console.log('❌ Токен не найден в БД');
            console.log('💡 Необходима авторизация через OAuth');
            testOAuthFlow();
        }
    });
}

async function testDonationAlertsAPI() {
    console.log('\n🧪 Тестирование API DonationAlerts...');
    
    try {
        // Тест 1: Получение профиля пользователя
        console.log('1. Тестирование получения профиля пользователя...');
        const profileResponse = await axios.get(`${DA_CONFIG.apiUrl}/user/oauth`, {
            headers: {
                'Authorization': `Bearer ${DA_CONFIG.accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
        
        console.log('✅ Профиль пользователя получен:');
        console.log(`   ID: ${profileResponse.data.data.id}`);
        console.log(`   Никнейм: ${profileResponse.data.data.username}`);
        console.log(`   Email: ${profileResponse.data.data.email}`);
        
        // Тест 2: Получение донатов
        console.log('\n2. Тестирование получения донатов...');
        const donationsResponse = await axios.get(`${DA_CONFIG.apiUrl}/alerts/donations`, {
            headers: {
                'Authorization': `Bearer ${DA_CONFIG.accessToken}`,
                'Content-Type': 'application/json'
            },
            params: {
                page: 1,
                per_page: 10
            },
            timeout: 10000
        });
        
        console.log('✅ Донаты получены:');
        console.log(`   Количество: ${donationsResponse.data.data?.length || 0}`);
        
        if (donationsResponse.data.data && donationsResponse.data.data.length > 0) {
            console.log('   Последние донаты:');
            donationsResponse.data.data.slice(0, 3).forEach((donation, index) => {
                console.log(`   ${index + 1}. ${donation.username}: ${donation.amount} ${donation.currency} - "${donation.message}"`);
                console.log(`      Время: ${donation.created_at}`);
            });
        } else {
            console.log('   Донатов не найдено');
        }
        
        // Тест 3: Проверка пагинации
        console.log('\n3. Проверка пагинации...');
        console.log(`   Текущая страница: ${donationsResponse.data.meta?.current_page || 'неизвестно'}`);
        console.log(`   Всего страниц: ${donationsResponse.data.meta?.last_page || 'неизвестно'}`);
        console.log(`   Всего донатов: ${donationsResponse.data.meta?.total || 'неизвестно'}`);
        
        // Тест 4: Проверка виджета
        console.log('\n4. Тестирование виджета...');
        const widgetUrl = `https://www.donationalerts.com/widget/lastdonations?alert_type=1,20,27,28,29,30,31,32&limit=10&token=${DA_CONFIG.accessToken}`;
        console.log(`   URL виджета: ${widgetUrl}`);
        
        try {
            const widgetResponse = await axios.get(widgetUrl, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            console.log('✅ Виджет работает');
            console.log(`   Статус: ${widgetResponse.status}`);
            console.log(`   Размер ответа: ${widgetResponse.data.length} символов`);
        } catch (widgetError) {
            console.log('❌ Ошибка виджета:', widgetError.message);
        }
        
    } catch (error) {
        console.error('❌ Ошибка API DonationAlerts:', error.response?.status, error.response?.data || error.message);
        
        if (error.response?.status === 401) {
            console.log('🔑 Токен устарел или недействителен');
            console.log('💡 Необходима повторная авторизация');
        }
    }
}

function testOAuthFlow() {
    console.log('\n🔗 Тестирование OAuth потока...');
    
    const authUrl = `https://www.donationalerts.com/oauth/authorize?client_id=${DA_CONFIG.clientId}&redirect_uri=${encodeURIComponent(DA_CONFIG.redirectUri)}&response_type=code&scope=oauth-donation-index`;
    
    console.log('📋 Информация для авторизации:');
    console.log(`   Client ID: ${DA_CONFIG.clientId}`);
    console.log(`   Redirect URI: ${DA_CONFIG.redirectUri}`);
    console.log(`   Scope: oauth-donation-index`);
    console.log(`   URL авторизации: ${authUrl}`);
    
    console.log('\n💡 Для авторизации:');
    console.log('1. Откройте URL авторизации в браузере');
    console.log('2. Войдите в DonationAlerts');
    console.log('3. Разрешите доступ приложению');
    console.log('4. Скопируйте код из URL после перенаправления');
    console.log('5. Используйте код для получения токена');
}

// Проверяем переменные окружения
console.log('\n🔍 Проверка переменных окружения...');
console.log(`   DA_CLIENT_ID: ${process.env.DA_CLIENT_ID || 'НЕ УСТАНОВЛЕНА'}`);
console.log(`   DA_CLIENT_SECRET: ${process.env.DA_CLIENT_SECRET ? 'УСТАНОВЛЕНА' : 'НЕ УСТАНОВЛЕНА'}`);
console.log(`   DA_REDIRECT_URI: ${process.env.DA_REDIRECT_URI || 'НЕ УСТАНОВЛЕНА'}`);

// Запускаем диагностику
diagnoseDonationAlerts().then(() => {
    console.log('\n✅ Диагностика завершена');
    db.close();
}).catch(error => {
    console.error('❌ Ошибка диагностики:', error);
    db.close();
});