const axios = require('axios');

console.log('🔍 Тестирование API диагностики статистики фрагов\n');

async function testAPI() {
    try {
        console.log('📡 Отправка запроса к API...');
        const response = await axios.get('http://localhost:3000/api/frag-stats/diagnose');
        
        console.log('✅ API работает!');
        console.log('📊 Ответ сервера:');
        console.log(JSON.stringify(response.data, null, 2));
        
    } catch (error) {
        console.error('❌ Ошибка API:');
        if (error.response) {
            console.error('   Статус:', error.response.status);
            console.error('   Данные:', error.response.data);
        } else if (error.request) {
            console.error('   Сервер не отвечает');
        } else {
            console.error('   Ошибка:', error.message);
        }
    }
}

testAPI();

