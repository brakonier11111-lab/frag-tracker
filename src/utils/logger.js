const winston = require('winston');
const path = require('path');
const config = require('../config');

// Кастомные форматы
const customFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
    let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    
    if (Object.keys(metadata).length > 0) {
        msg += ` ${JSON.stringify(metadata)}`;
    }
    
    return msg;
});

// Цветной формат для консоли
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    customFormat
);

// JSON формат для файлов
const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.json()
);

// Создание директории для логов
const logsDir = path.join(__dirname, '../../logs');
const fs = require('fs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Transports
const transports = [];

// Console transport
if (config.logging.consoleEnabled) {
    transports.push(
        new winston.transports.Console({
            format: consoleFormat
        })
    );
}

// File transports
if (config.logging.fileEnabled) {
    // Error logs
    transports.push(
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            format: fileFormat,
            maxsize: 5242880, // 5MB
            maxFiles: 5
        })
    );
    
    // Combined logs
    transports.push(
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            format: fileFormat,
            maxsize: 5242880, // 5MB
            maxFiles: 5
        })
    );
    
    // Donations logs (специальный лог для донатов)
    transports.push(
        new winston.transports.File({
            filename: path.join(logsDir, 'donations.log'),
            level: 'info',
            format: fileFormat,
            maxsize: 5242880, // 5MB
            maxFiles: 10
        })
    );
}

// Создание logger
const logger = winston.createLogger({
    level: config.logging.level,
    transports
});

// Хелперы для специфичных логов
logger.donation = (message, data = {}) => {
    logger.info(`💰 DONATION: ${message}`, { type: 'donation', ...data });
};

logger.integration = (message, data = {}) => {
    logger.info(`🔌 INTEGRATION: ${message}`, { type: 'integration', ...data });
};

logger.api = (message, data = {}) => {
    logger.info(`🌐 API: ${message}`, { type: 'api', ...data });
};

logger.websocket = (message, data = {}) => {
    logger.info(`🔌 WEBSOCKET: ${message}`, { type: 'websocket', ...data });
};

logger.database = (message, data = {}) => {
    logger.info(`💾 DATABASE: ${message}`, { type: 'database', ...data });
};

module.exports = logger;







