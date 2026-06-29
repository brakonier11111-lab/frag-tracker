const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const { DatabaseError } = require('../utils/AppError');

class Database {
    constructor() {
        this.db = null;
        this.isConnected = false;
    }
    
    /**
     * Подключение к базе данных
     */
    connect() {
        return new Promise((resolve, reject) => {
            const dbPath = path.join(__dirname, '../../', config.database.path);
            
            this.db = new sqlite3.Database(dbPath, (err) => {
                if (err) {
                    logger.error('Failed to connect to database', { error: err.message });
                    reject(new DatabaseError('Failed to connect to database', err));
                } else {
                    this.isConnected = true;
                    logger.database('Connected to SQLite database', { path: dbPath });
                    
                    // Включаем foreign keys
                    this.db.run('PRAGMA foreign_keys = ON');
                    
                    resolve(this.db);
                }
            });
        });
    }
    
    /**
     * Закрытие соединения
     */
    close() {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                resolve();
                return;
            }
            
            this.db.close((err) => {
                if (err) {
                    logger.error('Error closing database', { error: err.message });
                    reject(err);
                } else {
                    this.isConnected = false;
                    logger.database('Database connection closed');
                    resolve();
                }
            });
        });
    }
    
    /**
     * Выполнение запроса (Promise wrapper)
     */
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) {
                    logger.error('Database run error', { sql, error: err.message });
                    reject(new DatabaseError('Query execution failed', err));
                } else {
                    resolve({ lastID: this.lastID, changes: this.changes });
                }
            });
        });
    }
    
    /**
     * Получение одной строки
     */
    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    logger.error('Database get error', { sql, error: err.message });
                    reject(new DatabaseError('Query execution failed', err));
                } else {
                    resolve(row);
                }
            });
        });
    }
    
    /**
     * Получение всех строк
     */
    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    logger.error('Database all error', { sql, error: err.message });
                    reject(new DatabaseError('Query execution failed', err));
                } else {
                    resolve(rows || []);
                }
            });
        });
    }
    
    /**
     * Транзакция
     */
    async transaction(callback) {
        try {
            await this.run('BEGIN TRANSACTION');
            const result = await callback(this);
            await this.run('COMMIT');
            return result;
        } catch (error) {
            await this.run('ROLLBACK');
            throw error;
        }
    }
    
    /**
     * Выполнение серии запросов
     */
    serialize(callback) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                try {
                    callback();
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        });
    }
}

// Singleton instance
const database = new Database();

module.exports = database;







