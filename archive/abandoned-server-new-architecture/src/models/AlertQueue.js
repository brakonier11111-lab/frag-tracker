const { DatabaseError } = require('../utils/AppError');
const logger = require('../utils/logger');

class AlertQueueModel {
    constructor(db) {
        this.db = db;
    }
    
    /**
     * Добавить алерт в очередь
     */
    async enqueue(alertData) {
        try {
            const {
                donation_id,
                mode,
                alert_data,
                play_at = null,
                priority = 0
            } = alertData;
            
            const alertDataJson = typeof alert_data === 'string' 
                ? alert_data 
                : JSON.stringify(alert_data);
            
            const result = await this.db.run(
                `INSERT INTO alert_queue (donation_id, mode, alert_data, play_at, priority)
                 VALUES (?, ?, ?, ?, ?)`,
                [donation_id, mode, alertDataJson, play_at, priority]
            );
            
            logger.info('Alert added to queue', { 
                id: result.lastID, 
                donation_id, 
                mode 
            });
            
            return result.lastID;
        } catch (error) {
            logger.error('Error enqueueing alert', { error: error.message, alertData });
            throw new DatabaseError('Failed to enqueue alert', error);
        }
    }
    
    /**
     * Получить следующий алерт для воспроизведения
     */
    async getNext() {
        const alert = await this.db.get(`
            SELECT * FROM alert_queue 
            WHERE status = 'pending' 
              AND (play_at IS NULL OR play_at <= datetime('now'))
            ORDER BY priority DESC, created_at ASC 
            LIMIT 1
        `);
        
        if (alert && alert.alert_data) {
            try {
                alert.alert_data = JSON.parse(alert.alert_data);
            } catch (e) {
                // ignore
            }
        }
        
        return alert;
    }
    
    /**
     * Получить все pending алерты
     */
    async getPending(limit = 50) {
        const alerts = await this.db.all(`
            SELECT * FROM alert_queue 
            WHERE status = 'pending'
            ORDER BY priority DESC, created_at ASC
            LIMIT ?
        `, [limit]);
        
        return alerts.map(alert => {
            if (alert.alert_data) {
                try {
                    alert.alert_data = JSON.parse(alert.alert_data);
                } catch (e) {
                    // ignore
                }
            }
            return alert;
        });
    }
    
    /**
     * Обновить статус алерта
     */
    async updateStatus(id, status, errorMessage = null) {
        const validStatuses = ['pending', 'playing', 'completed', 'failed', 'skipped'];
        
        if (!validStatuses.includes(status)) {
            throw new ValidationError('Invalid alert status');
        }
        
        const updates = {
            status,
            updated_at: new Date().toISOString()
        };
        
        if (status === 'completed' || status === 'failed') {
            updates.played_at = new Date().toISOString();
        }
        
        if (errorMessage) {
            updates.error_message = errorMessage;
        }
        
        const fields = Object.keys(updates);
        const values = Object.values(updates);
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        
        await this.db.run(
            `UPDATE alert_queue SET ${setClause} WHERE id = ?`,
            [...values, id]
        );
        
        logger.info('Alert status updated', { id, status });
    }
    
    /**
     * Отметить алерт как воспроизведенный
     */
    async markAsPlayed(id) {
        await this.updateStatus(id, 'completed');
    }
    
    /**
     * Отметить алерт как failed
     */
    async markAsFailed(id, errorMessage) {
        await this.updateStatus(id, 'failed', errorMessage);
    }
    
    /**
     * Получить алерты по donation_id
     */
    async getByDonationId(donationId) {
        const alerts = await this.db.all(
            'SELECT * FROM alert_queue WHERE donation_id = ? ORDER BY created_at DESC',
            [donationId]
        );
        
        return alerts.map(alert => {
            if (alert.alert_data) {
                try {
                    alert.alert_data = JSON.parse(alert.alert_data);
                } catch (e) {
                    // ignore
                }
            }
            return alert;
        });
    }
    
    /**
     * Удалить старые completed/failed алерты
     */
    async cleanupOld(daysOld = 7) {
        const result = await this.db.run(`
            DELETE FROM alert_queue 
            WHERE status IN ('completed', 'failed', 'skipped')
              AND created_at < datetime('now', '-${daysOld} days')
        `);
        
        logger.info('Old alerts cleaned up', { deleted: result.changes });
        
        return result.changes;
    }
    
    /**
     * Записать в историю воспроизведения
     */
    async recordPlayback(donationId, mode, source = 'auto', durationMs = null) {
        await this.db.run(
            `INSERT INTO alert_playback_history (donation_id, mode, source, duration_ms)
             VALUES (?, ?, ?, ?)`,
            [donationId, mode, source, durationMs]
        );
        
        logger.info('Alert playback recorded', { donationId, mode, source });
    }
    
    /**
     * Получить историю воспроизведения
     */
    async getPlaybackHistory(donationId = null, limit = 50) {
        let sql = 'SELECT * FROM alert_playback_history';
        const params = [];
        
        if (donationId) {
            sql += ' WHERE donation_id = ?';
            params.push(donationId);
        }
        
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);
        
        return await this.db.all(sql, params);
    }
}

module.exports = AlertQueueModel;







