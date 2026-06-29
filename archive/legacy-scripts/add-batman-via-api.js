const http = require('http');

const donations = [
    {
        username: 'Бетмен',
        amount: 45000,
        time_earned: Math.round(45000 / 35 * 60), // 77143 секунд
        message: 'Донат по цене 35р за минуту'
    },
    {
        username: 'Бетмен',
        amount: 75000,
        time_earned: Math.round(75000 / 50 * 60), // 90000 секунд
        message: 'Донат по цене 50р за минуту'
    }
];

function addDonation(donation) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(donation);
        
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: '/api/manual-donation',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = http.request(options, (res) => {
            let responseData = '';
            
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            
            res.on('end', () => {
                try {
                    const result = JSON.parse(responseData);
                    if (result.success) {
                        console.log(`✅ Донат добавлен: ${donation.username} - ${donation.amount}₽, ${donation.time_earned} сек`);
                        resolve(result);
                    } else {
                        console.error(`❌ Ошибка: ${result.error}`);
                        reject(new Error(result.error));
                    }
                } catch (e) {
                    console.error('❌ Ошибка парсинга ответа:', e);
                    reject(e);
                }
            });
        });

        req.on('error', (e) => {
            console.error(`❌ Ошибка запроса: ${e.message}`);
            reject(e);
        });

        req.write(data);
        req.end();
    });
}

async function addAllDonations() {
    console.log('📝 Добавление донатов для Бетмен через API...\n');
    
    for (let i = 0; i < donations.length; i++) {
        try {
            await addDonation(donations[i]);
            // Небольшая задержка между запросами
            if (i < donations.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (error) {
            console.error(`Ошибка при добавлении доната ${i + 1}:`, error.message);
        }
    }
    
    console.log('\n✅ Готово! Проверьте виджет топ донатеров.');
}

// Проверяем, запущен ли сервер
const testReq = http.request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/state',
    method: 'GET',
    timeout: 2000
}, () => {
    addAllDonations();
});

testReq.on('error', (e) => {
    console.error('❌ Сервер не запущен на localhost:3000');
    console.error('   Запустите сервер и попробуйте снова.');
    process.exit(1);
});

testReq.on('timeout', () => {
    console.error('❌ Таймаут подключения к серверу');
    process.exit(1);
});

testReq.end();










