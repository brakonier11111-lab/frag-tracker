const logger = require('../utils/logger');
const { AppError } = require('../utils/AppError');

/**
 * Централизованный обработчик ошибок
 */
function errorHandler(err, req, res, next) {
    // Логируем ошибку
    if (err.isOperational) {
        logger.warn(`Operational error: ${err.message}`, {
            errorCode: err.errorCode,
            statusCode: err.statusCode,
            path: req.path,
            method: req.method
        });
    } else {
        logger.error(`Unexpected error: ${err.message}`, {
            stack: err.stack,
            path: req.path,
            method: req.method
        });
    }
    
    // Если это наша кастомная ошибка
    if (err instanceof AppError) {
        return res.status(err.statusCode).json(err.toJSON());
    }
    
    // Ошибки валидации express-validator
    if (err.name === 'ValidationError' && err.array) {
        return res.status(400).json({
            success: false,
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Validation failed',
                details: err.array()
            }
        });
    }
    
    // Ошибки базы данных SQLite
    if (err.code && err.code.startsWith('SQLITE_')) {
        return res.status(500).json({
            success: false,
            error: {
                code: 'DATABASE_ERROR',
                message: 'Database operation failed',
                details: process.env.NODE_ENV === 'development' ? err.message : null
            }
        });
    }
    
    // Ошибки Axios (внешние API)
    if (err.isAxiosError) {
        const statusCode = err.response?.status || 503;
        return res.status(statusCode).json({
            success: false,
            error: {
                code: 'EXTERNAL_API_ERROR',
                message: 'External API request failed',
                details: process.env.NODE_ENV === 'development' ? err.response?.data : null
            }
        });
    }
    
    // Неизвестная ошибка
    res.status(500).json({
        success: false,
        error: {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error',
            details: process.env.NODE_ENV === 'development' ? err.message : null
        }
    });
}

/**
 * Обработчик для 404
 */
function notFoundHandler(req, res) {
    res.status(404).json({
        success: false,
        error: {
            code: 'NOT_FOUND',
            message: `Route ${req.method} ${req.path} not found`
        }
    });
}

/**
 * Async wrapper для обработки ошибок в async route handlers
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = {
    errorHandler,
    notFoundHandler,
    asyncHandler
};







