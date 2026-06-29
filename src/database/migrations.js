const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Система миграций для базы данных
 */
class MigrationManager {
    constructor(db) {
        this.db = db;
        this.migrationsDir = path.join(__dirname, 'migrations');
    }
    
    /**
     * Инициализация таблицы миграций
     */
    async initialize() {
        await this.db.run(`
            CREATE TABLE IF NOT EXISTS migrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        logger.database('Migrations table initialized');
    }
    
    /**
     * Получение выполненных миграций
     */
    async getExecutedMigrations() {
        const rows = await this.db.all('SELECT name FROM migrations ORDER BY id');
        return rows.map(row => row.name);
    }
    
    /**
     * Получение списка файлов миграций
     */
    getMigrationFiles() {
        if (!fs.existsSync(this.migrationsDir)) {
            fs.mkdirSync(this.migrationsDir, { recursive: true });
            return [];
        }
        
        return fs.readdirSync(this.migrationsDir)
            .filter(file => file.endsWith('.js'))
            .sort();
    }
    
    /**
     * Выполнение миграции
     */
    async executeMigration(filename) {
        const migrationPath = path.join(this.migrationsDir, filename);
        const migration = require(migrationPath);
        
        logger.database(`Executing migration: ${filename}`);
        
        try {
            await this.db.transaction(async (db) => {
                // Выполняем миграцию
                await migration.up(db);
                
                // Записываем в таблицу миграций
                await db.run('INSERT INTO migrations (name) VALUES (?)', [filename]);
            });
            
            logger.database(`Migration completed: ${filename}`);
        } catch (error) {
            logger.error(`Migration failed: ${filename}`, { error: error.message });
            throw error;
        }
    }
    
    /**
     * Откат миграции
     */
    async rollbackMigration(filename) {
        const migrationPath = path.join(this.migrationsDir, filename);
        const migration = require(migrationPath);
        
        if (!migration.down) {
            throw new Error(`Migration ${filename} does not have a down() method`);
        }
        
        logger.database(`Rolling back migration: ${filename}`);
        
        try {
            await this.db.transaction(async (db) => {
                // Откатываем миграцию
                await migration.down(db);
                
                // Удаляем из таблицы миграций
                await db.run('DELETE FROM migrations WHERE name = ?', [filename]);
            });
            
            logger.database(`Rollback completed: ${filename}`);
        } catch (error) {
            logger.error(`Rollback failed: ${filename}`, { error: error.message });
            throw error;
        }
    }
    
    /**
     * Выполнение всех pending миграций
     */
    async migrate() {
        await this.initialize();
        
        const executedMigrations = await this.getExecutedMigrations();
        const migrationFiles = this.getMigrationFiles();
        
        const pendingMigrations = migrationFiles.filter(
            file => !executedMigrations.includes(file)
        );
        
        if (pendingMigrations.length === 0) {
            logger.database('No pending migrations');
            return;
        }
        
        logger.database(`Found ${pendingMigrations.length} pending migrations`);
        
        for (const migration of pendingMigrations) {
            await this.executeMigration(migration);
        }
        
        logger.database('All migrations completed');
    }
    
    /**
     * Откат последней миграции
     */
    async rollbackLast() {
        await this.initialize();
        
        const executedMigrations = await this.getExecutedMigrations();
        
        if (executedMigrations.length === 0) {
            logger.database('No migrations to rollback');
            return;
        }
        
        const lastMigration = executedMigrations[executedMigrations.length - 1];
        await this.rollbackMigration(lastMigration);
    }
    
    /**
     * Создание нового файла миграции
     */
    createMigration(name) {
        const timestamp = Date.now();
        const filename = `${timestamp}_${name}.js`;
        const filepath = path.join(this.migrationsDir, filename);
        
        const template = `/**
 * Migration: ${name}
 * Created: ${new Date().toISOString()}
 */

module.exports = {
    /**
     * Применение миграции
     */
    async up(db) {
        // TODO: Implement migration
        // Example:
        // await db.run(\`
        //     CREATE TABLE example (
        //         id INTEGER PRIMARY KEY AUTOINCREMENT,
        //         name TEXT NOT NULL
        //     )
        // \`);
    },
    
    /**
     * Откат миграции
     */
    async down(db) {
        // TODO: Implement rollback
        // Example:
        // await db.run('DROP TABLE IF EXISTS example');
    }
};
`;
        
        fs.writeFileSync(filepath, template);
        logger.database(`Migration created: ${filename}`);
        
        return filename;
    }
}

module.exports = MigrationManager;







