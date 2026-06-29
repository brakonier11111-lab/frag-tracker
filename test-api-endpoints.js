const http = require('http');

console.log('🧪 Тестирование API эндпоинтов');

function testEndpoint(path, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let responseData = '';

            res.on('data', (chunk) => {
                responseData += chunk;
            });

            res.on('end', () => {
                try {
                    const jsonData = JSON.parse(responseData);
                    resolve({
                        status: res.statusCode,
                        data: jsonData
                    });
                } catch (error) {
                    resolve({
                        status: res.statusCode,
                        error: 'Invalid JSON',
                        response: responseData.substring(0, 200)
                    });
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        if (data) {
            req.write(JSON.stringify(data));
        }

        req.end();
    });
}

async function runTests() {
    console.log('\n📊 Тестирование эндпоинтов...\n');

    try {
        // Тест 1: Получение текущей статистики
        console.log('1. Тестирование GET /api/get-current-stats');
        const result1 = await testEndpoint('/api/get-current-stats');
        console.log('   Статус:', result1.status);
        if (result1.data) {
            console.log('   Данные:', JSON.stringify(result1.data, null, 2));
        } else {
            console.log('   Ошибка:', result1.error);
            console.log('   Ответ:', result1.response);
        }

        // Тест 2: Диагностика статистики фрагов
        console.log('\n2. Тестирование GET /api/frag-stats/diagnose');
        const result2 = await testEndpoint('/api/frag-stats/diagnose');
        console.log('   Статус:', result2.status);
        if (result2.data) {
            console.log('   Данные:', JSON.stringify(result2.data, null, 2));
        } else {
            console.log('   Ошибка:', result2.error);
            console.log('   Ответ:', result2.response);
        }

        // Тест 3: Тест логики боев и фрагов
        console.log('\n3. Тестирование GET /api/battle-frag-logic-test');
        const result3 = await testEndpoint('/api/battle-frag-logic-test');
        console.log('   Статус:', result3.status);
        if (result3.data) {
            console.log('   Данные:', JSON.stringify(result3.data, null, 2));
        } else {
            console.log('   Ошибка:', result3.error);
            console.log('   Ответ:', result3.response);
        }

        // Тест 4: Редактирование статистики
        console.log('\n4. Тестирование POST /api/edit-stats-manually');
        const result4 = await testEndpoint('/api/edit-stats-manually', 'POST', {
            totalBattles: 20,
            totalFrags: 40,
            battlesWithoutFrags: 5
        });
        console.log('   Статус:', result4.status);
        if (result4.data) {
            console.log('   Данные:', JSON.stringify(result4.data, null, 2));
        } else {
            console.log('   Ошибка:', result4.error);
            console.log('   Ответ:', result4.response);
        }

    } catch (error) {
        console.error('❌ Ошибка тестирования:', error.message);
    }
}

runTests();

