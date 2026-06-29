require('dotenv').config({ path: './config.env' });

const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// Config and utils
const config = require('./src/config');
const logger = require('./src/utils/logger');
const database = require('./src/database');
const MigrationManager = require('./src/database/migrations');

// Middleware
const { errorHandler, notFoundHandler } = require('./src/middleware/errorHandler');

// Models
const AppStateModel = require('./src/models/AppState');
const DonationModel = require('./src/models/Donation');
const RewardModel = require('./src/models/Reward');
const AlertQueueModel = require('./src/models/AlertQueue');
const WidgetConfigModel = require('./src/models/WidgetConfig');

// Services
const DonationService = require('./src/services/DonationService');
const RewardService = require('./src/services/RewardService');
const AlertQueueService = require('./src/services/AlertQueueService');
const WidgetService = require('./src/services/WidgetService');

// Controllers
const DonationController = require('./src/controllers/DonationController');
const RewardController = require('./src/controllers/RewardController');
const AlertController = require('./src/controllers/AlertController');
const WidgetController = require('./src/controllers/WidgetController');

// Routes
const { donationsRoutes, rewardsRoutes, alertsRoutes, widgetsRoutes, donorTiersRoutes, donorsRoutes, integrationsRoutes } = require('./src/routes');

// Analytics (старый модуль)
const Analytics = require('./analytics');

const app = express();
const server = http.createServer(app);
const port = config.port;

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false, // Отключаем для OBS виджетов
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors());

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: config.security.rateLimitWindowMs,
    max: config.security.rateLimitMax,
    message: {
        success: false,
        error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests, please try again later'
        }
    }
});

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use(express.static('public'));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Request logging
app.use((req, res, next) => {
    logger.api(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.headers['user-agent']
    });
    next();
});

// Глобальные переменные
let models = {};
let services = {};
let controllers = {};

/**
 * Инициализация приложения
 */
async function initialize() {
    try {
        logger.info('🚀 Starting Frag Tracker Server v3.0...');
        
        // Подключение к БД
        logger.info('📦 Connecting to database...');
        await database.connect();
        
        // Выполнение миграций
        logger.info('🔄 Running migrations...');
        const migrationManager = new MigrationManager(database);
        await migrationManager.migrate();
        
        // Инициализация аналитики (старый модуль)
        const analytics = new Analytics(database.db);
        
        // Инициализация моделей
        logger.info('🏗️  Initializing models...');
        models = {
            appState: new AppStateModel(database),
            donation: new DonationModel(database),
            reward: new RewardModel(database),
            alertQueue: new AlertQueueModel(database),
            widgetConfig: new WidgetConfigModel(database)
        };
        
        // Инициализация сервисов
        logger.info('⚙️  Initializing services...');
        services = {
            donation: new DonationService(
                models.donation,
                models.appState,
                models.reward,
                models.alertQueue,
                analytics
            ),
            reward: new RewardService(models.reward),
            alertQueue: new AlertQueueService(models.alertQueue, models.donation),
            widget: new WidgetService(models.widgetConfig)
        };
        
        // Инициализация контроллеров
        logger.info('🎮 Initializing controllers...');
        controllers = {
            donation: new DonationController(services.donation, models.donation),
            reward: new RewardController(services.reward),
            alert: new AlertController(services.alertQueue),
            widget: new WidgetController(services.widget)
        };
        
        // Регистрация маршрутов
        logger.info('🛣️  Registering routes...');
        setupRoutes();
        
        // Обработчики ошибок (должны быть последними)
        app.use(notFoundHandler);
        app.use(errorHandler);
        
        logger.info('✅ Application initialized successfully');
        
    } catch (error) {
        logger.error('Failed to initialize application', { 
            error: error.message, 
            stack: error.stack 
        });
        process.exit(1);
    }
}

/**
 * Настройка маршрутов
 */
function setupRoutes() {
    // Health check
    app.get('/healthz', (req, res) => {
        res.json({
            success: true,
            status: 'ok',
            timestamp: Date.now(),
            version: '3.0.0',
            services: {
                database: database.isConnected
            }
        });
    });
    
    // API routes с rate limiting
    app.use('/api/donations', apiLimiter, donationsRoutes(controllers.donation));
    app.use('/api/rewards', apiLimiter, rewardsRoutes(controllers.reward));
    app.use('/api/alerts', apiLimiter, alertsRoutes(controllers.alert));
    app.use('/api/widgets', apiLimiter, widgetsRoutes(controllers.widget));
    app.use('/api/donor-tiers', apiLimiter, donorTiersRoutes(database));
    app.use('/api/donors', apiLimiter, donorsRoutes(database));
    app.use('/api', apiLimiter, integrationsRoutes(database));
    
    // Страницы (из public/)
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
    
    app.get('/admin', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });
    
    app.get('/dashboard', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'dashboard-new.html'));
    });
    
    app.get('/rewards', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'rewards-manager.html'));
    });
    
    app.get('/widget-builder', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'widget-builder.html'));
    });
    
    app.get('/alert-replay', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'alert-replay.html'));
    });
    
    logger.info('Routes registered successfully');
}

/**
 * Graceful shutdown
 */
async function shutdown() {
    logger.info('🛑 Shutting down gracefully...');
    
    try {
        // Останавливаем обработку очереди алертов
        if (services.alertQueue) {
            services.alertQueue.stopProcessing();
        }
        
        // Закрываем соединение с БД
        await database.close();
        
        logger.info('✅ Shutdown complete');
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', { error: error.message });
        process.exit(1);
    }
}

// Обработка сигналов завершения
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Обработка необработанных ошибок
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason, promise });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
    shutdown();
});

/**
 * Запуск сервера
 */
async function start() {
    await initialize();
    
    server.listen(port, () => {
        logger.info(`
🎯 ====================================
✅ Frag Tracker Server v3.0 Started
✅ URL: http://localhost:${port}
✅ Environment: ${config.env}
📺 Dashboard: http://localhost:${port}/dashboard
🎁 Rewards Manager: http://localhost:${port}/rewards
🎨 Widget Builder: http://localhost:${port}/widget-builder
🎬 Alert Replay: http://localhost:${port}/alert-replay
👨‍💼 Admin: http://localhost:${port}/admin
🎯 ====================================
        `);
    });
}

// Запускаем сервер
start().catch(error => {
    logger.error('Failed to start server', { error: error.message, stack: error.stack });
    process.exit(1);
});

// Экспортируем для тестов
module.exports = { app, server, models, services, controllers };







