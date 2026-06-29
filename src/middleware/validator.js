const { body, param, query, validationResult } = require('express-validator');
const { ValidationError } = require('../utils/AppError');

/**
 * Middleware для проверки результатов валидации
 */
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new ValidationError('Validation failed', errors.array());
    }
    next();
};

/**
 * Правила валидации для различных эндпоинтов
 */
const validationRules = {
    // Валидация доната
    donation: [
        body('username').trim().notEmpty().withMessage('Username is required'),
        body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
        body('message').optional().trim().isLength({ max: 500 }).withMessage('Message too long')
    ],
    
    // Валидация состояния приложения
    updateState: [
        body('current_mode').optional().isIn(['mode1', 'mode2', 'mode3']).withMessage('Invalid mode'),
        body('frag_cost').optional().isInt({ min: 1 }).withMessage('Frag cost must be positive'),
        body('frags_needed').optional().isInt({ min: 1 }).withMessage('Frags needed must be positive'),
        body('timer_seconds').optional().isInt({ min: 0 }).withMessage('Timer seconds must be non-negative')
    ],
    
    // Валидация управления таймером
    timerControl: [
        body('action').isIn(['start', 'pause', 'resume', 'stop', 'add', 'subtract']).withMessage('Invalid action'),
        body('seconds').optional().isInt({ min: 0 }).withMessage('Seconds must be non-negative')
    ],
    
    // Валидация управления единицами
    manageUnits: [
        body('action').isIn(['add', 'subtract', 'set']).withMessage('Invalid action'),
        body('amount').isInt({ min: 0 }).withMessage('Amount must be non-negative'),
        body('mode').optional().isIn(['mode1', 'mode2', 'mode3']).withMessage('Invalid mode')
    ],
    
    // Валидация цели сбора
    donationGoal: [
        body('title').optional().trim().notEmpty().withMessage('Title cannot be empty'),
        body('description').optional().trim(),
        body('targetAmount').optional().isFloat({ min: 0 }).withMessage('Target amount must be positive'),
        body('currentAmount').optional().isFloat({ min: 0 }).withMessage('Current amount must be non-negative'),
        body('endDate').optional().isISO8601().withMessage('Invalid date format')
    ],
    
    // Валидация конфигурации DonatePay
    donatePayConfig: [
        body('apiKey').optional().trim().notEmpty().withMessage('API key cannot be empty'),
        body('webhookSecret').optional().trim(),
        body('widgetUrl').optional().trim().isURL().withMessage('Invalid URL')
    ],
    
    // Валидация конфигурации Lesta
    lestaConfig: [
        body('applicationId').trim().notEmpty().withMessage('Application ID is required')
    ],
    
    // Валидация статистики фрагов
    fragStats: [
        query('period').optional().isIn(['1d', '7d', '30d', 'all']).withMessage('Invalid period')
    ],
    
    // Валидация редактирования статистики вручную
    editStats: [
        body('battleTime').isISO8601().withMessage('Invalid date format'),
        body('frags').isInt({ min: 0 }).withMessage('Frags must be non-negative')
    ],
    
    // Валидация инициализации стартовых значений
    initializeStats: [
        body('startingFrags').isInt({ min: 0 }).withMessage('Starting frags must be non-negative'),
        body('startingBattles').isInt({ min: 0 }).withMessage('Starting battles must be non-negative')
    ],
    
    // Валидация наград (новая функция)
    createReward: [
        body('name').trim().notEmpty().withMessage('Reward name is required'),
        body('triggerType').isIn(['donation_amount', 'donation_goal', 'frag_count', 'timer_expired']).withMessage('Invalid trigger type'),
        body('triggerValue').isFloat({ min: 0 }).withMessage('Trigger value must be non-negative'),
        body('actionType').isIn(['alert', 'webhook', 'command', 'sound']).withMessage('Invalid action type'),
        body('actionData').notEmpty().withMessage('Action data is required'),
        body('enabled').optional().isBoolean().withMessage('Enabled must be boolean')
    ],
    
    // Валидация виджета (новая функция)
    saveWidget: [
        body('name').trim().notEmpty().withMessage('Widget name is required'),
        body('type').isIn(['mode1', 'mode2', 'mode3', 'donation_goal', 'custom']).withMessage('Invalid widget type'),
        body('config').isObject().withMessage('Config must be an object'),
        body('config.width').optional().isInt({ min: 1 }).withMessage('Width must be positive'),
        body('config.height').optional().isInt({ min: 1 }).withMessage('Height must be positive')
    ]
};

module.exports = {
    validate,
    validationRules
};







