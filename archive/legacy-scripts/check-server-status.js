const axios = require('axios');

async function checkServerStatus() {
    try {
        console.log('🔍 Проверка статуса сервера...');
        
        const response = await axios.get('http://localhost:3000/api/status', {
            timeout: 5000
        });
        
        console.log('✅ Сервер работает');
        console.log('📊 Статус системы:');
        console.log(JSON.stringify(response.data, null, 2));
        
        // Проверяем DonationAlerts
        if (response.data.donationAlerts) {
            console.log('\n🔍 Статус DonationAlerts:');
            console.log(`   Токен: ${response.data.donationAlerts.hasToken ? 'ЕСТЬ' : 'НЕТ'}`);
            console.log(`   Client ID: ${response.data.donationAlerts.clientId}`);
            console.log(`   Client Secret: ${response.data.donationAlerts.hasClientSecret ? 'ЕСТЬ' : 'НЕТ'}`);
        }
        
        // Проверяем опрос
        if (response.data.polling) {
            console.log('\n🔄 Статус опроса:');
            console.log(`   В процессе: ${response.data.polling.isPollingInProgress ? 'ДА' : 'НЕТ'}`);
            console.log(`   Интервал: ${response.data.polling.pollDelayMs}мс`);
            console.log(`   Активен: ${response.data.polling.hasPollingInterval ? 'ДА' : 'НЕТ'}`);
        }
        
    } catch (error) {
        console.error('❌ Ошибка подключения к серверу:', error.message);
        console.log('💡 Убедитесь, что сервер запущен на порту 3000');
    }
}

checkServerStatus();