const sqlite3 = require('sqlite3').verbose();

console.log('🔍 Диагностика статистики фрагов\n');

const db = new sqlite3.Database('./frag_tracker.db');

// Получаем все записи за сегодня
const today = new Date().toISOString().split('T')[0];
console.log(`📅 Анализ данных за ${today}\n`);

db.all(`
    SELECT * FROM frag_stats 
    WHERE date(battle_time) = ? 
    ORDER BY battle_time DESC
`, [today], (err, rows) => {
    if (err) {
        console.error('❌ Ошибка получения данных:', err);
        db.close();
        return;
    }
    
    console.log(`📊 Найдено записей за сегодня: ${rows.length}\n`);
    
    if (rows.length === 0) {
        console.log('✅ Нет данных за сегодня');
        db.close();
        return;
    }
    
    // Анализируем каждую запись
    console.log('📋 Детальный анализ записей:');
    rows.forEach((row, index) => {
        const battleTime = new Date(row.battle_time);
        console.log(`   ${index + 1}. ID: ${row.id}`);
        console.log(`      Время: ${battleTime.toLocaleString()}`);
        console.log(`      Фраги: ${row.frags}`);
        console.log(`      Тип: ${row.frags > 0 ? 'Бой с фрагами' : 'Бой без фрагов'}`);
        console.log('');
    });
    
    // Подсчитываем статистику
    const totalBattles = rows.length;
    const totalFrags = rows.reduce((sum, row) => sum + row.frags, 0);
    const battlesWithFrags = rows.filter(row => row.frags > 0).length;
    const battlesWithoutFrags = rows.filter(row => row.frags === 0).length;
    
    console.log('📊 Итоговая статистика:');
    console.log(`   Всего боев: ${totalBattles}`);
    console.log(`   Всего фрагов: ${totalFrags}`);
    console.log(`   Боев с фрагами: ${battlesWithFrags}`);
    console.log(`   Боев без фрагов: ${battlesWithoutFrags}`);
    console.log(`   Среднее фрагов за бой: ${totalBattles > 0 ? (totalFrags / totalBattles).toFixed(2) : '0.00'}`);
    
    // Проверяем на дубликаты по времени
    console.log('\n🔍 Проверка на дубликаты:');
    const timeGroups = {};
    rows.forEach(row => {
        const timeKey = new Date(row.battle_time).toLocaleTimeString('ru-RU', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        if (!timeGroups[timeKey]) {
            timeGroups[timeKey] = [];
        }
        timeGroups[timeKey].push(row);
    });
    
    let duplicatesFound = false;
    Object.keys(timeGroups).forEach(timeKey => {
        if (timeGroups[timeKey].length > 1) {
            duplicatesFound = true;
            console.log(`   ⚠️ Дубликаты в ${timeKey}:`);
            timeGroups[timeKey].forEach((battle, index) => {
                console.log(`      ${index + 1}. ID: ${battle.id}, Фраги: ${battle.frags}`);
            });
        }
    });
    
    if (!duplicatesFound) {
        console.log('   ✅ Дубликатов не найдено');
    }
    
    // Рекомендации
    console.log('\n💡 Рекомендации:');
    if (battlesWithoutFrags > 0) {
        console.log(`   • Найдено ${battlesWithoutFrags} боев без фрагов`);
        console.log('   • Возможно, это дубликаты от синхронизации Lesta API');
        console.log('   • Используйте кнопку "УДАЛИТЬ ОДИН БОЙ БЕЗ ФРАГОВ" в админ-панели');
    }
    
    if (totalBattles > 1 && totalFrags === 0) {
        console.log('   • Все бои без фрагов - возможно проблема с записью фрагов');
    }
    
    if (totalBattles === 1 && totalFrags > 0) {
        console.log('   • Корректная статистика: 1 бой с фрагами');
    }
    
    db.close();
});

