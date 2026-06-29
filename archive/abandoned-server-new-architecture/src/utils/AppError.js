/**
 * Кастомный класс ошибок приложения
 */
class AppError extends Error {
    constructor(message, statusCode = 500, errorCode = 'INTERNAL_ERROR', details = null) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.details = details;
        this.isOperational = true; // Отличает ожидаемые ошибки от неожиданных
        
        Error.captureStackTrace(this, this.constructor);
    }
    
    toJSON() {
        return {
            success: false,
            error: {
                code: this.errorCode,
                message: this.message,
                details: this.details
            }
        };
    }
}

// Предопределенные ошибки
class ValidationError extends AppError {
    constructor(message, details = null) {
        super(message, 400, 'VALIDATION_ERROR', details);
        this.name = 'ValidationError';
    }
}

class NotFoundError extends AppError {
    constructor(resource = 'Resource') {
        super(`${resource} not found`, 404, 'NOT_FOUND');
        this.name = 'NotFoundError';
    }
}

class UnauthorizedError extends AppError {
    constructor(message = 'Unauthorized') {
        super(message, 401, 'UNAUTHORIZED');
        this.name = 'UnauthorizedError';
    }
}

class ForbiddenError extends AppError {
    constructor(message = 'Forbidden') {
        super(message, 403, 'FORBIDDEN');
        this.name = 'ForbiddenError';
    }
}

class ConflictError extends AppError {
    constructor(message = 'Resource already exists') {
        super(message, 409, 'CONFLICT');
        this.name = 'ConflictError';
    }
}

class ExternalServiceError extends AppError {
    constructor(service, originalError = null) {
        super(
            `External service error: ${service}`,
            503,
            'EXTERNAL_SERVICE_ERROR',
            originalError ? originalError.message : null
        );
        this.name = 'ExternalServiceError';
        this.service = service;
    }
}

class DatabaseError extends AppError {
    constructor(message, originalError = null) {
        super(
            message,
            500,
            'DATABASE_ERROR',
            originalError ? originalError.message : null
        );
        this.name = 'DatabaseError';
    }
}

module.exports = {
    AppError,
    ValidationError,
    NotFoundError,
    UnauthorizedError,
    ForbiddenError,
    ConflictError,
    ExternalServiceError,
    DatabaseError
};







