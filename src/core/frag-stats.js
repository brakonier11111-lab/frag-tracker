'use strict';
/**
 * Статистика боёв/фрагов (таблица frag_stats): запись боя (форс/с дедупом),
 * выборка за период, агрегация в почасовую/подневную статистику для
 * /api/frag-stats. Вынесено из server.js 1:1. Deps: db (sqlite).
 *
 * addFragBattle/addLestaBattle из оригинала не перенесены — подтверждённо
 * мёртвый код (0 вызовов в репозитории, ESLint no-unused-vars), addBattleForce
 * их заменяет везде, где реально пишутся бои.
 */

function createFragStats({ db }) {
    function addFragStats(battleTime, frags) {
        db.run(
            'INSERT INTO frag_stats (battle_time, frags) VALUES (?, ?)',
            [battleTime, frags],
            function (err) {
                if (err) {
                    console.error('❌ Ошибка сохранения статистики фрагов:', err);
                } else {
                    console.log('✅ Статистика фрагов сохранена:', { battleTime, frags });
                }
            }
        );
    }

    // Функция для принудительного добавления боя (без проверки дублирования)
    function addBattleForce(battleTime, frags = 0, source = 'lesta') {
        console.log('🔨 Принудительное добавление боя:', { battleTime, frags, source });

        db.run(
            'INSERT INTO frag_stats (battle_time, frags) VALUES (?, ?)',
            [battleTime, frags],
            function (err) {
                if (err) {
                    console.error('❌ Ошибка сохранения боя:', err);
                } else {
                    console.log('✅ Бой принудительно сохранен:', { battleTime, frags, source });
                }
            }
        );
    }

    // Функция для добавления уникального боя (предотвращает дублирование)
    function addUniqueBattle(battleTime, frags = 0, source = 'lesta') {
        // Проверяем, не был ли уже записан бой в последние 2 минуты
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

        db.get(
            'SELECT COUNT(*) as count FROM frag_stats WHERE battle_time >= ? AND battle_time <= ?',
            [twoMinutesAgo, battleTime],
            function (err, row) {
                if (err) {
                    console.error('❌ Ошибка проверки дублирования:', err);
                    return;
                }

                // Если в последние 2 минуты уже есть записи, не добавляем новую
                if (row.count > 0) {
                    console.log('⚠️ Бой уже записан в последние 2 минуты, пропускаем дублирование');
                    return;
                }

                // Добавляем бой
                db.run(
                    'INSERT INTO frag_stats (battle_time, frags) VALUES (?, ?)',
                    [battleTime, frags],
                    function (err) {
                        if (err) {
                            console.error('❌ Ошибка сохранения уникального боя:', err);
                        } else {
                            console.log('✅ Уникальный бой сохранен:', { battleTime, frags, source });
                        }
                    }
                );
            }
        );
    }

    function getFragStats(period, callback) {
        let query = 'SELECT * FROM frag_stats ORDER BY battle_time DESC';
        let params = [];

        if (period === 'day') {
            query = 'SELECT * FROM frag_stats WHERE battle_time >= datetime("now", "-1 day") ORDER BY battle_time DESC';
        } else if (period === 'week') {
            query = 'SELECT * FROM frag_stats WHERE battle_time >= datetime("now", "-7 days") ORDER BY battle_time DESC';
        } else if (period === 'month') {
            query = 'SELECT * FROM frag_stats WHERE battle_time >= datetime("now", "-30 days") ORDER BY battle_time DESC';
        }

        db.all(query, params, callback);
    }

    return { addFragStats, addBattleForce, addUniqueBattle, getFragStats };
}

// Функция для обработки реальных данных статистики фрагов (чистая, без db)
function processFragStatsData(rows, period) {
    const data = {
        totalFrags: 0,
        totalBattles: 0, // Общее количество боев
        battlesWithFrags: 0,  // Бои с фрагами
        battlesWithoutFrags: 0, // Бои без фрагов
        bestHour: '—',
        avgFragsPerBattle: '0.00',
        hourlyStats: [],
        dailyStats: [],
        battleStats: []
    };

    // Инициализируем массивы для часов и дней
    const hourlyData = new Array(24).fill(0);
    const dailyData = {};

    // Обрабатываем каждую запись
    rows.forEach(row => {
        const battleTime = new Date(row.battle_time);
        const hour = battleTime.getHours();
        const date = battleTime.toISOString().split('T')[0];

        // Обновляем общую статистику
        data.totalFrags += row.frags;
        data.totalBattles++; // Общее количество боев

        // Подсчитываем бои с фрагами и без фрагов
        if (row.frags > 0) {
            data.battlesWithFrags++;
        } else {
            data.battlesWithoutFrags++;
        }

        // Обновляем данные по часам
        hourlyData[hour] += row.frags;

        // Обновляем данные по дням
        if (!dailyData[date]) {
            dailyData[date] = 0;
        }
        dailyData[date] += row.frags;

        // Добавляем в статистику по боям
        data.battleStats.push({
            frags: row.frags,
            time: battleTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
            hasFrags: row.frags > 0
        });
    });

    // Формируем данные по часам
    for (let hour = 0; hour < 24; hour++) {
        data.hourlyStats.push({ hour, frags: hourlyData[hour] });
    }

    // Находим лучший час
    const bestHourData = data.hourlyStats.reduce((max, current) =>
        current.frags > max.frags ? current : max
    );
    if (bestHourData.frags > 0) {
        data.bestHour = `${bestHourData.hour}:00 (${bestHourData.frags} фрагов)`;
        data.bestHourData = bestHourData; // Сохраняем данные для дальнейшего использования
    }

    // Формируем данные по дням
    Object.keys(dailyData).sort().forEach(date => {
        data.dailyStats.push({ date, frags: dailyData[date] });
    });

    // Вычисляем среднее количество фрагов за бой
    if (data.totalBattles > 0) {
        data.avgFragsPerBattle = (data.totalFrags / data.totalBattles).toFixed(2);
    }

    return data;
}

module.exports = { createFragStats, processFragStatsData };
