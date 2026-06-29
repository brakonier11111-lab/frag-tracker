const axios = require('axios');

async function testDonationAlerts() {
    console.log('🔍 Тестирование DonationAlerts...\n');
    
    // Тест виджета
    console.log('1. Тест виджета последних донатов:');
    try {
        const widgetUrl = 'https://www.donationalerts.com/widget/lastdonations?alert_type=1,20,27,28,29,30,31,32&limit=10&token=F19xSligynHj8fnX6MQ3';
        const response = await axios.get(widgetUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        console.log(`   ✅ Статус: ${response.status}`);
        console.log(`   📏 Размер ответа: ${response.data.length} символов`);
        
        // Проверяем содержимое
        if (response.data.includes('connection to the server has been lost')) {
            console.log('   ❌ Проблема: Виджет показывает "connection lost"');
        } else if (response.data.includes('You don\'t have any alerts yet')) {
            console.log('   ⚠️ Предупреждение: Нет алертов (это нормально для нового аккаунта)');
        } else {
            console.log('   ✅ Виджет работает корректно');
        }
        
    } catch (error) {
        console.log(`   ❌ Ошибка виджета: ${error.message}`);
    }
    
    console.log('\n2. Тест API DonationAlerts:');
    
    // Проверяем переменные окружения
    const clientId = process.env.DA_CLIENT_ID || '16225';
    const clientSecret = process.env.DA_CLIENT_SECRET || '0VJ2dMRax8cJrQqAYQJ7dLnFCMPKOFZdjCHkU4Lw';
    
    console.log(`   🔑 Client ID: ${clientId}`);
    console.log(`   🔐 Client Secret: ${clientSecret.substring(0, 10)}...`);
    
    // Тест OAuth авторизации
    console.log('\n3. Тест OAuth авторизации:');
    try {
        const authUrl = `https://www.donationalerts.com/oauth/authorize?client_id=${clientId}&redirect_uri=http://localhost:3000/auth/callback&response_type=code&scope=oauth-donation-index`;
        console.log(`   🔗 URL авторизации: ${authUrl}`);
        console.log('   ✅ URL сформирован корректно');
    } catch (error) {
        console.log(`   ❌ Ошибка формирования URL: ${error.message}`);
    }
    
    console.log('\n4. Рекомендации:');
    console.log('   📋 Для исправления проблем:');
    console.log('   1. Убедитесь, что токен виджета F19xSligynHj8fnX6MQ3 активен');
    console.log('   2. Проверьте, что приложение с ID 16225 настроено корректно');
    console.log('   3. Убедитесь, что Redirect URI: http://localhost:3000/auth/callback');
    console.log('   4. Выполните OAuth авторизацию через /auth/donationalerts');
    console.log('   5. Проверьте логи сервера на наличие ошибок API');
}

testDonationAlerts().catch(console.error);

