'use strict';

/**
 * Кэш и доступ к app_state (единственная строка id=1) — вынос из server.js
 * с семантикой 1:1. Кэш в памяти убирает очередь на SQLite при опросе
 * виджетов; таймер тикает ПРЯМО в кэше (см. updateTimer в server.js),
 * поэтому getCachedState() возвращает живой мутабельный объект.
 *
 * deps:
 *   db      — соединение на запись
 *   dbRead  — read-only соединение
 *   onRowLoaded(row) — необязательный хук: server.js обновляет из него
 *                      lastSeenDonationId при загрузке строки из БД
 */
function createAppState(deps) {
    const db = deps.db;
    const dbRead = deps.dbRead;
    const onRowLoaded = typeof deps.onRowLoaded === 'function' ? deps.onRowLoaded : null;

    let memoryAppState = null;
    let memoryAppStateLoaded = false;

    function mergeIntoMemoryAppState(fields, values, atomicTimerIncrement) {
        if (!memoryAppState) memoryAppState = { id: 1 };
        if (atomicTimerIncrement) {
            memoryAppState.timer_seconds = Math.max(
                0,
                (Number(memoryAppState.timer_seconds) || 0) + atomicTimerIncrement
            );
        }
        fields.forEach((key, idx) => {
            memoryAppState[key] = values[idx];
        });
    }

    function preloadAppStateCache(callback) {
        dbRead.get('SELECT * FROM app_state WHERE id = 1', (err, row) => {
            if (!err && row) {
                memoryAppState = row;
                memoryAppStateLoaded = true;
                if (onRowLoaded) onRowLoaded(row);
            }
            if (callback) callback(err, row);
        });
    }

    function getAppState(callback) {
        if (memoryAppStateLoaded && memoryAppState) {
            callback(memoryAppState);
            return;
        }
        dbRead.get('SELECT * FROM app_state WHERE id = 1', (err, row) => {
            if (err) {
                console.error('❌ Ошибка получения состояния:', err);
                callback(null);
            } else {
                if (row) {
                    memoryAppState = row;
                    memoryAppStateLoaded = true;
                }
                callback(row);
                if (row && onRowLoaded) onRowLoaded(row);
            }
        });
    }

    function updateAppState(newState, callback, allowManualTimeUpdate = false) {
        // ВАЖНО: timer_manual_time_added обновляется ТОЛЬКО через /api/timer-control с isManual: true
        // ВАЖНО: для timer_seconds используется атомарный SQL-инкремент (спец-флаг
        // _timer_seconds_increment) — предотвращает гонку с параллельным тиком таймера
        const timerSecondsIncrement = newState._timer_seconds_increment;
        const useAtomicTimerUpdate = timerSecondsIncrement !== undefined && timerSecondsIncrement > 0;

        const fields = Object.keys(newState).filter(key => {
            if (key === 'id') return false;
            if (key === 'created_at' || key === 'updated_at') return false;
            if (key === '_forceFullUpdate') return false;
            if (key === '_timer_seconds_increment') return false;
            if (key === 'timer_manual_time_added' && !allowManualTimeUpdate) {
                console.log(`⚠️ Игнорируем обновление timer_manual_time_added (разрешено только через /api/timer-control)`);
                return false;
            }
            if (key === 'timer_seconds' && useAtomicTimerUpdate) {
                return false;
            }
            return true;
        });

        // Защита от случайной передачи всего state — иначе SQLite блокируется на секунды
        if (fields.length > 35 && !newState._forceFullUpdate) {
            const err = new Error(`updateAppState: слишком много полей (${fields.length}), вероятно передан весь state`);
            console.error('❌', err.message);
            if (callback) callback(err);
            return;
        }

        const values = fields.map(key => {
            const value = newState[key];
            if (typeof value === 'object' && value !== null) {
                return JSON.stringify(value);
            }
            return value;
        });

        let setClause;
        if (useAtomicTimerUpdate) {
            const otherSetClause = fields.map(key => `${key} = ?`).join(', ');
            setClause = `timer_seconds = timer_seconds + ${timerSecondsIncrement}${fields.length > 0 ? ', ' + otherSetClause : ''}`;
            console.log(`⏰ АТОМАРНОЕ обновление timer_seconds: +${timerSecondsIncrement} сек`);
        } else {
            setClause = fields.map(key => `${key} = ?`).join(', ');
        }

        if (process.env.DEBUG_STATE === '1') {
            console.log('🔄 Обновление состояния в БД:', fields);
        }

        db.run(`UPDATE app_state SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
            values, function(err) {
                if (err) {
                    console.error('❌ Ошибка обновления состояния:', err);
                    console.error('   SQL:', `UPDATE app_state SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`);
                    console.error('   Values:', values);
                    if (callback) callback(err);
                } else {
                    mergeIntoMemoryAppState(fields, values, useAtomicTimerUpdate ? timerSecondsIncrement : 0);
                    memoryAppStateLoaded = true;
                    if (process.env.DEBUG_STATE === '1') {
                        console.log('✅ Состояние успешно обновлено в БД');
                    }
                    if (callback) callback(null);
                }
            });
    }

    /** Живой объект кэша (таймер мутирует его напрямую) либо null, если кэш не загружен */
    function getCachedState() {
        return (memoryAppStateLoaded && memoryAppState) ? memoryAppState : null;
    }

    return { preloadAppStateCache, getAppState, updateAppState, getCachedState };
}

module.exports = { createAppState };
