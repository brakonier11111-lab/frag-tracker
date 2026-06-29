const axios = require('axios');

console.log('🔍 ПРОВЕРКА СТАТУСА СЕРВЕРА И ИНТЕГРАЦИЙ\n');

async function checkStatus() {
    try {
        // Проверяем доступность сервера
        console.log('1. Проверка сервера:');
        const serverResponse = await axios.get('http://localhost:3000/api/status', { timeout: 5000 });
        console.log(`   ✅ Сервер работает (статус: ${serverResponse.status})`);
        console.log(`   📅 Время работы: ${Math.floor(serverResponse.data.uptime)} секунд`);
        
        // Проверяем статус DonationAlerts
        console.log('\n2. Проверка DonationAlerts:');
        try {
            const daResponse = await axios.get('http://localhost:3000/api/da-status', { timeout: 5000 });
            console.log(`   🔑 Токен: ${daResponse.data.hasToken ? 'ЕСТЬ' : 'НЕТ'}`);
            console.log(`   🆔 Client ID: ${daResponse.data.clientId || 'НЕ НАСТРОЕН'}`);
            console.log(`   🔐 Client Secret: ${daResponse.data.hasClientSecret ? 'ЕСТЬ' : 'НЕТ'}`);
            
            if (!daResponse.data.hasToken) {
                console.log('   ⚠️ Требуется OAuth авторизация');
                console.log('   🔗 Ссылка: http://localhost:3000/auth/donationalerts');
            }
        } catch (error) {
            console.log(`   ❌ Ошибка: ${error.message}`);
        }
        
        // Проверяем базу данных
        console.log('\n3. Проверка базы данных:');
        try {
            const dbResponse = await axios.get('http://localhost:3000/api/db-status', { timeout: 5000 });
            console.log(`   ✅ База данных подключена`);
            console.log(`   📊 Донатов в БД: ${dbResponse.data.donationsCount}`);
        } catch (error) {
            console.log(`   ❌ Ошибка: ${error.message}`);
        }
        
        // Проверяем API DonationAlerts
        console.log('\n4. Проверка API DonationAlerts:');
        try {
            const apiResponse = await axios.get('http://localhost:3000/api/da-api-test', { timeout: 10000 });
            if (apiResponse.data.success) {
                console.log(`   ✅ API работает`);
                console.log(`   📊 Получено донатов: ${apiResponse.data.donationsCount}`);
                
                if (apiResponse.data.donations && apiResponse.data.donations.length > 0) {
                    console.log('   📋 Последние донаты:');
                    apiResponse.data.donations.slice(0, 3).forEach((donation, index) => {
                        console.log(`      ${index + 1}. ${donation.username}: ${donation.amount} ${donation.currency}`);
                        console.log(`         Сообщение: ${donation.message || 'Нет'}`);
                        console.log(`         Дата: ${new Date(donation.created_at).toLocaleString()}`);
                    });
                } else {
                    console.log('   ⚠️ Донатов в API нет');
                }
            } else {
                console.log(`   ❌ Ошибка API: ${apiResponse.data.error}`);
            }
        } catch (error) {
            console.log(`   ❌ Ошибка запроса: ${error.message}`);
        }
        
        // Рекомендации
        console.log('\n5. РЕКОМЕНДАЦИИ:');
        console.log('   📋 Для настройки DonationAlerts:');
        console.log('   1. Откройте http://localhost:3000/admin');
        console.log('   2. Нажмите "🔑 НАСТРОИТЬ DA"');
        console.log('   3. Авторизуйтесь в DonationAlerts');
        console.log('   4. Разрешите доступ приложению');
        console.log('   5. Отправьте тестовый донат');
        console.log('   6. Проверьте статус в админ-панели');
        
        console.log('\n   🔗 Полезные ссылки:');
        console.log('   • Админ-панель: http://localhost:3000/admin');
        console.log('   • OAuth авторизация: http://localhost:3000/auth/donationalerts');
        console.log('   • Диагностика DA: http://localhost:3000/donation-alerts-test.html');
        
    } catch (error) {
        console.log(`❌ Ошибка подключения к серверу: ${error.message}`);
        console.log('\n💡 Возможные причины:');
        console.log('   • Сервер не запущен');
        console.log('   • Сервер запущен на другом порту');
        console.log('   • Проблемы с сетью');
        console.log('\n🔧 Решение:');
        console.log('   1. Запустите сервер: start_server.bat');
        console.log('   2. Проверьте, что порт 3000 свободен');
        console.log('   3. Проверьте настройки файрвола');
    }
}

checkStatus().catch(console.error);

