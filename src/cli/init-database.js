#!/usr/bin/env node

/**
 * Инициализация базы данных через систему миграций
 */

const database = require('../database');
const MigrationManager = require('../database/migrations');
const logger = require('../utils/logger');

async function main() {
    try {
        console.log('🗄️  Initializing database...');
        
        // Подключаемся к БД
        await database.connect();
        
        // Выполняем миграции
        const migrationManager = new MigrationManager(database);
        await migrationManager.migrate();
        
        console.log('✅ Database initialized successfully');
        
        await database.close();
        process.exit(0);
        
    } catch (error) {
        logger.error('Database initialization failed', { 
            error: error.message, 
            stack: error.stack 
        });
        console.error('❌ Database initialization failed:', error.message);
        process.exit(1);
    }
}

main();







