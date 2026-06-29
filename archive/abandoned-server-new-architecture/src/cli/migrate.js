#!/usr/bin/env node

/**
 * CLI утилита для управления миграциями
 * 
 * Использование:
 *   node src/cli/migrate.js                    - выполнить все pending миграции
 *   node src/cli/migrate.js create <name>      - создать новую миграцию
 *   node src/cli/migrate.js rollback           - откатить последнюю миграцию
 */

const database = require('../database');
const MigrationManager = require('../database/migrations');
const logger = require('../utils/logger');

const command = process.argv[2];
const arg = process.argv[3];

async function main() {
    try {
        // Подключаемся к БД
        await database.connect();
        
        const migrationManager = new MigrationManager(database);
        
        switch (command) {
            case 'create':
                if (!arg) {
                    console.error('❌ Error: Migration name is required');
                    console.log('Usage: node src/cli/migrate.js create <migration_name>');
                    process.exit(1);
                }
                
                const filename = migrationManager.createMigration(arg);
                console.log(`✅ Migration created: ${filename}`);
                break;
                
            case 'rollback':
                await migrationManager.rollbackLast();
                console.log('✅ Last migration rolled back');
                break;
                
            case 'up':
            default:
                await migrationManager.migrate();
                console.log('✅ All migrations completed');
                break;
        }
        
        await database.close();
        process.exit(0);
        
    } catch (error) {
        logger.error('Migration failed', { error: error.message, stack: error.stack });
        console.error('❌ Migration failed:', error.message);
        process.exit(1);
    }
}

main();







