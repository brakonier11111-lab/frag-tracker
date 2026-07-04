const { APP_ROOT, USER_DATA, loadEnv, resolveDbPath } = require('./src/bootstrap/paths');
loadEnv();

const logger = require('./src/utils/logger');
const console = { log: logger.info, warn: logger.warn, error: logger.error };

// Страховка от молчаливой смерти сервера посреди стрима: необработанные ошибки
// из фоновых таймеров/WebSocket-ов логируем в logs/error.log, процесс не роняем.
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    console.error('💥 uncaughtException:', err && err.stack ? err.stack : err);
});

const path = require('path');
const fs = require('fs');

const express = require('express');
const axios = require('axios');
// Системный HTTP_PROXY/HTTPS_PROXY (используется для доступа к заблокированным
// сервисам вроде Twitch) ломает часть запросов axios криво собранным туннелем
// ("plain HTTP request was sent to HTTPS port") — задеты были Twitch, YouTube,
// VK Play и DonationAlerts. Отключаем автопрокси глобально для всех axios-
// вызовов в проекте (все require('axios')/axios.create() наследуют этот
// дефолт, т.к. этот require выполняется раньше любых модулей интеграций).
axios.defaults.proxy = false;
const WebSocket = require('ws');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const helmet = require('helmet');
const cors = require('cors');
const Analytics = require('./analytics');
const https = require('https');
const { Centrifuge } = require('centrifuge');
const cheerio = require('cheerio');
const querystring = require('querystring');
const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;
const { registerModules } = require('./src/registerModules');
const { classifyDonationForPolling } = require('./src/core/donation-poll-filter');
const { initBlitzChallengeSchema } = require('./src/modules/blitz-challenge/schema');
const { initBossOrdersSchema } = require('./src/modules/boss-orders/schema');
let blitzModule = null;
let razblogModuleRef = null;
let rouletteModuleRef = null;

/** РазБЛОГировка 2026 — включена по умолчанию (RAZBLOG_ENABLED=0 для отключения) */
const RAZBLOG_ENABLED = process.env.RAZBLOG_ENABLED !== '0';
const RAZBLOG_ARCHIVE_DIR = path.join(__dirname, 'archive', 'razblogirovka-2026');
let createRazblogirovkaGoldService = null;
if (RAZBLOG_ENABLED) {
    createRazblogirovkaGoldService = require(path.join(RAZBLOG_ARCHIVE_DIR, 'src', 'services', 'razblogirovkaGoldService')).createRazblogirovkaGoldService;
}

// Конфигурация DonationAlerts
const DA_CONFIG = {
    clientId: process.env.DA_CLIENT_ID || '',
    clientSecret: process.env.DA_CLIENT_SECRET || '',
    redirectUri: process.env.DA_REDIRECT_URI || `http://localhost:${port}/oauth/donationalerts/callback`,
    accessToken: null,
    apiUrl: 'https://www.donationalerts.com/api/v1'
};

// Конфигурация DonatePay
const DP_CONFIG = {
    apiKey: process.env.DP_API_KEY || '',
    apiUrl: 'https://donatepay.ru/api/v1', // Используем v1 API
    widgetApiUrl: 'https://widget.donatepay.ru/api/v1', // API для виджетов (как в RutonyChat)
    webhookSecret: process.env.DP_WEBHOOK_SECRET || '',
    centrifugoUrl: 'wss://centrifugo.donatepay.ru:443/connection/websocket',
    socketTokenUrl: 'https://donatepay.ru/api/v2/socket/token',
    userId: null, // Будет получен из API /user
    widgetUrl: null, // URL виджета алертов
    lastWidgetCheck: null, // Время последней проверки виджета
    lastTransactionId: null, // ID последней обработанной транзакции
    lastError: null, // Последняя ошибка API
    lastUserInfoRequest: null // Время последнего запроса информации о пользователе
};

// Конфигурация Lesta Games API
const LESTA_CONFIG = {
    applicationId: process.env.LESTA_APPLICATION_ID || 'da7874d5a895ff241d8b55e271c03ff3',
    apiUrl: 'https://papi.tanksblitz.ru/wotb', // Для получения данных
    openIdUrl: 'https://api.tanki.su/wot/auth/login/', // Для авторизации
    accessToken: null,
    accountId: null,
    nickname: null
};

// База данных
const dbPath = resolveDbPath();
const db = new sqlite3.Database(dbPath);
const dbRead = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = NORMAL');
    db.run('PRAGMA busy_timeout = 5000');
});
dbRead.serialize(() => {
    dbRead.run('PRAGMA busy_timeout = 5000');
});

// Кэш app_state и WebSocket-реестр вынесены в src/core (семантика 1:1).
// Таймер по-прежнему тикает прямо в кэше через appStateStore.getCachedState().
const { createAppState } = require('./src/core/app-state');
const { createWebSocketHub } = require('./src/core/websocket');
const appStateStore = createAppState({
    db,
    dbRead,
    onRowLoaded: (row) => {
        if (row && row.last_donation_id) {
            try { lastSeenDonationId = row.last_donation_id.toString(); } catch {}
        }
    }
});
const preloadAppStateCache = appStateStore.preloadAppStateCache;
const getAppState = appStateStore.getAppState;
const updateAppState = appStateStore.updateAppState;
const wsHub = createWebSocketHub();
const broadcastToClients = wsHub.broadcastToClients;
const { createDonationBus } = require('./src/core/donation-events');
const donationBus = createDonationBus(); // подписчики — после registerModules
let timerDbFlushTimeout = null;
const TIMER_DB_FLUSH_MS = 10000;

// Тихий режим опроса донатов (иначе console.log блокирует UI на секунды)
const DEBUG_POLL = process.env.DEBUG_POLL === '1';
function pollLog(...args) {
    if (DEBUG_POLL) console.log(...args);
}

// Очередь внешних API — Lesta, YouTube, РазБЛОГировка и др. по одному, без параллельных тяжёлых вызовов
let externalApiChain = Promise.resolve();
function withApiQueue(label, fn) {
    const run = externalApiChain.then(() => fn());
    externalApiChain = run.catch((err) => {
        if (process.env.DEBUG_API === '1') {
            console.warn(`API queue [${label}]:`, err?.message || err);
        }
    });
    return run;
}
function withLestaApiLock(fn) {
    return withApiQueue('lesta', fn);
}

// Schema info
let donationsHasNormalizedUsername = false;

function checkDonationsNormalizedColumn() {
    db.all("PRAGMA table_info(donations)", (err, columns) => {
        if (err) {
            console.error('❌ Ошибка проверки колонок donations:', err);
            return;
        }
        if (Array.isArray(columns)) {
            donationsHasNormalizedUsername = columns.some(col => col.name === 'normalized_username');
            console.log('✅ columns donations normalized_username:', donationsHasNormalizedUsername);
        }
    });
}

// Виджеты "цель сбора" и "полоска сбора" вынесены в src/modules/donation-widgets
const { createDonationWidgetsModule } = require('./src/modules/donation-widgets');
const donationWidgetsModule = createDonationWidgetsModule({
    db,
    broadcastToClients: (...args) => broadcastToClients(...args)
});
const {
    DONATION_WIDGET_SETTINGS_VERSION,
    normalizeDonationWidgetSettings,
    encodeDonationWidgetSettings,
    buildDonationGoalPayload,
    buildDonationBarPayload,
    broadcastDonationWidgetState,
    persistDonationGoalSnapshot
} = donationWidgetsModule;

// Инициализация таблиц для сбора донатов и интеграций
db.serialize(() => {
    // Создаем таблицу для сбора донатов
    db.run(`CREATE TABLE IF NOT EXISTS donation_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT 'Сбор на новый контент',
        description TEXT DEFAULT 'Поддержите создание качественного контента!',
        target_amount REAL NOT NULL DEFAULT 10000,
        current_amount REAL NOT NULL DEFAULT 0,
        total_donations INTEGER NOT NULL DEFAULT 0,
        avg_donation REAL NOT NULL DEFAULT 0,
        end_date DATETIME,
        last_donation_time DATETIME,
        settings TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Добавляем колонку settings если её нет (для существующих БД)
    db.run(`ALTER TABLE donation_goals ADD COLUMN settings TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            // Игнорируем ошибку если колонка уже существует
        }
    });

    // Создаем таблицу для истории донатов цели
    db.run(`CREATE TABLE IF NOT EXISTS goal_donations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        username TEXT,
        message TEXT,
        is_manual BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (goal_id) REFERENCES donation_goals (id)
    )`);

    // Создаем таблицу для полоски сбора донатов (упрощенный виджет)
    db.run(`CREATE TABLE IF NOT EXISTS donation_bars (
        id INTEGER PRIMARY KEY DEFAULT 1,
        title TEXT NOT NULL DEFAULT 'Сбор донатов',
        target_amount REAL NOT NULL DEFAULT 1000,
        current_amount REAL NOT NULL DEFAULT 0,
        settings TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`ALTER TABLE donation_bars ADD COLUMN settings TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn('⚠️ Ошибка добавления settings в donation_bars:', err.message);
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS donation_goal_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL DEFAULT 'manual',
        payload TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Создаем таблицу для связей награда-роль VK Play
    // Таблица для истории выдачи ролей
    db.run(`CREATE TABLE IF NOT EXISTS vkplay_role_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        user_nick TEXT,
        reward_id TEXT NOT NULL,
        reward_name TEXT NOT NULL,
        role_id TEXT NOT NULL,
        role_name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        channel_url TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы vkplay_role_history:', err);
        } else {
            console.log('✅ Таблица vkplay_role_history создана');
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS vkplay_reward_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reward_id TEXT NOT NULL,
        reward_name TEXT NOT NULL,
        role_id TEXT NOT NULL,
        role_name TEXT NOT NULL,
        channel_url TEXT NOT NULL,
        enabled BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(reward_id, channel_url)
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы vkplay_reward_roles:', err);
        } else {
            console.log('✅ Таблица vkplay_reward_roles создана');
        }
    });

    // Создаем таблицу для интеграций стримов
    db.run(`CREATE TABLE IF NOT EXISTS stream_integrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        expires_at INTEGER,
        channel_name TEXT,
        channel_url TEXT,
        live_title TEXT,
        viewers_count INTEGER DEFAULT 0,
        chat_enabled BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Создаем таблицу для чата
    db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        channel_url TEXT,
        user_id INTEGER,
        username TEXT,
        message TEXT,
        is_moderator BOOLEAN DEFAULT 0,
        is_owner BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // Нативный ID сообщения с площадки — для надёжной дедупликации вместо сравнения по тексту
    db.run(`ALTER TABLE chat_messages ADD COLUMN message_id TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления поля message_id:', err);
        }
    });
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_platform_msgid ON chat_messages(platform, message_id) WHERE message_id IS NOT NULL`, (err) => {
        if (err) console.error('❌ Ошибка создания индекса idx_chat_messages_platform_msgid:', err);
    });

    // Вставляем начальную цель сбора
    db.run(`INSERT OR IGNORE INTO donation_goals (id) VALUES (1)`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания начальной цели:', err);
        } else {
            console.log('✅ Таблицы для сбора донатов и интеграций инициализированы');
        }
    });

    // История донатов
    db.run(`CREATE TABLE IF NOT EXISTS donations (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        amount REAL NOT NULL,
        message TEXT,
        currency TEXT DEFAULT 'RUB',
        is_realtime BOOLEAN DEFAULT 0,
        frags_earned INTEGER DEFAULT 0,
        time_earned INTEGER DEFAULT 0,
        custom_units_earned INTEGER DEFAULT 0,
        normalized_username TEXT DEFAULT '',
        timer_mode TEXT DEFAULT 'normal',
        timer_seconds INTEGER DEFAULT 0,
        discount_active BOOLEAN DEFAULT 0,
        discount_percentage REAL DEFAULT 0,
        slowdown_active BOOLEAN DEFAULT 0,
        slowdown_factor REAL DEFAULT 1.0,
        temperature_active BOOLEAN DEFAULT 0,
        temperature_amount REAL DEFAULT 0,
        temperature_target REAL DEFAULT 0,
        temperature_overheated BOOLEAN DEFAULT 0,
        temperature_reward_minutes INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Таблица для уровней достижений донатеров
    db.run(`CREATE TABLE IF NOT EXISTS donor_achievement_tiers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        min_minutes INTEGER NOT NULL,
        max_minutes INTEGER,
        icon TEXT DEFAULT '🏆',
        custom_icon_url TEXT,
        color TEXT DEFAULT '#00f0ff',
        description TEXT,
        sort_order INTEGER DEFAULT 0 UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Добавляем поле custom_icon_url если его нет
    db.run(`ALTER TABLE donor_achievement_tiers ADD COLUMN custom_icon_url TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления поля custom_icon_url:', err);
        } else {
            console.log('✅ Поле custom_icon_url готово');
        }
    });
    
    // Проверяем и добавляем timer_discount если его нет
    db.run(`ALTER TABLE app_state ADD COLUMN timer_discount INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления поля timer_discount:', err);
        } else {
            console.log('✅ Поле timer_discount готово');
        }
    });

    // Виджет «параметр от донатов»: стартовое значение, за N₽ добавляется X единиц, лимит; единица — % или произвольная
    db.run(`CREATE TABLE IF NOT EXISTS donation_driven_widgets (
        id INTEGER PRIMARY KEY DEFAULT 1,
        name TEXT NOT NULL DEFAULT 'Цель по донатам',
        unit_label TEXT NOT NULL DEFAULT '%',
        start_value REAL NOT NULL DEFAULT 70,
        current_value REAL NOT NULL DEFAULT 70,
        cap_value REAL NOT NULL DEFAULT 100,
        per_amount REAL NOT NULL DEFAULT 100,
        add_value REAL NOT NULL DEFAULT 0.1,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы donation_driven_widgets:', err);
        } else {
            console.log('✅ Таблица donation_driven_widgets создана');
            db.run(`INSERT OR IGNORE INTO donation_driven_widgets (id) VALUES (1)`, (e) => {
                if (e && !e.message.includes('UNIQUE')) console.error('❌ Ошибка инициализации виджета:', e);
            });
        }
    });


    db.run(`ALTER TABLE donation_driven_widgets ADD COLUMN goal_text TEXT DEFAULT ''`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('❌ Ошибка добавления goal_text:', err);
        }
    });
    db.run(`ALTER TABLE donation_driven_widgets ADD COLUMN fallback_text TEXT DEFAULT ''`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('❌ Ошибка добавления fallback_text:', err);
        }
    });
    db.run(`ALTER TABLE donation_driven_widgets ADD COLUMN fallback_threshold REAL DEFAULT 50`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('❌ Ошибка добавления fallback_threshold:', err);
        }
    });
    db.run(`ALTER TABLE donation_driven_widgets ADD COLUMN widget_bg_opacity REAL DEFAULT 1`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('❌ Ошибка добавления widget_bg_opacity:', err);
        }
    });
    db.run(`ALTER TABLE donation_driven_widgets ADD COLUMN info_window_enabled INTEGER DEFAULT 1`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('❌ Ошибка добавления info_window_enabled:', err);
        }
    });
    db.run(`ALTER TABLE donation_driven_widgets ADD COLUMN info_window_title TEXT DEFAULT ''`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('❌ Ошибка добавления info_window_title:', err);
        }
    });
    db.run(`ALTER TABLE donation_driven_widgets ADD COLUMN timer_enabled INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('❌ Ошибка добавления timer_enabled:', err);
        }
    });
    db.run(`ALTER TABLE donation_driven_widgets ADD COLUMN timer_duration_seconds INTEGER DEFAULT 300`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('❌ Ошибка добавления timer_duration_seconds:', err);
        }
    });

    initBlitzChallengeSchema(db);
    initBossOrdersSchema(db);

    // Таблица для очереди танков
    db.run(`CREATE TABLE IF NOT EXISTS tank_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price INTEGER NOT NULL,
        conditions TEXT DEFAULT '',
        priority INTEGER DEFAULT 0,
        added_at INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы tank_queue:', err);
        } else {
            console.log('✅ Таблица tank_queue создана');
        }
    });

    // Таблица для настроек очереди танков
    db.run(`CREATE TABLE IF NOT EXISTS tank_queue_settings (
        id INTEGER PRIMARY KEY,
        current_tank_index INTEGER DEFAULT -1,
        order_price INTEGER DEFAULT 0,
        order_price_top1 INTEGER DEFAULT 0,
        price_info TEXT DEFAULT '',
        order_price_label TEXT DEFAULT 'Заказ танка',
        order_price_top1_label TEXT DEFAULT 'Заказ танка до топ 1',
        order_price_enabled INTEGER DEFAULT 1,
        order_price_top1_enabled INTEGER DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы tank_queue_settings:', err);
        } else {
            console.log('✅ Таблица tank_queue_settings создана');
            // Вставляем начальную запись
            db.run(`INSERT OR IGNORE INTO tank_queue_settings (id) VALUES (1)`, (err) => {
                if (err && !err.message.includes('UNIQUE constraint')) {
                    console.error('❌ Ошибка создания начальных настроек:', err);
                }
            });
            
            // Добавляем новые поля если их нет (миграция)
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN order_price_label TEXT DEFAULT 'Заказ танка'`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления order_price_label:', err);
                }
            });
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN order_price_top1_label TEXT DEFAULT 'Заказ танка до топ 1'`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления order_price_top1_label:', err);
                }
            });
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN order_price_enabled INTEGER DEFAULT 1`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления order_price_enabled:', err);
                }
            });
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN order_price_top1_enabled INTEGER DEFAULT 1`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления order_price_top1_enabled:', err);
                }
            });
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN streamer_photo TEXT`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления streamer_photo:', err);
                } else {
                    console.log('✅ Поле streamer_photo готово');
                }
            });
            
            // Добавляем поле для второго фото
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN second_photo TEXT`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления second_photo:', err);
                } else {
                    console.log('✅ Поле second_photo готово');
                }
            });
            
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN third_photo TEXT`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления third_photo:', err);
                } else {
                    console.log('✅ Поле third_photo готово');
                }
            });
            
            // Добавляем поля для приоритетных заказов
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN order_price_priority INTEGER DEFAULT 0`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления order_price_priority:', err);
                } else {
                    console.log('✅ Поле order_price_priority готово');
                }
            });
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN order_price_mega INTEGER DEFAULT 0`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления order_price_mega:', err);
                } else {
                    console.log('✅ Поле order_price_mega готово');
                }
            });
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN order_price_priority_label TEXT DEFAULT 'Приоритетный заказ'`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления order_price_priority_label:', err);
                } else {
                    console.log('✅ Поле order_price_priority_label готово');
                }
            });
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN order_price_mega_label TEXT DEFAULT 'Мегаприоритет'`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления order_price_mega_label:', err);
                } else {
                    console.log('✅ Поле order_price_mega_label готово');
                }
            });
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN order_price_priority_enabled INTEGER DEFAULT 1`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления order_price_priority_enabled:', err);
                } else {
                    console.log('✅ Поле order_price_priority_enabled готово');
                }
            });
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN order_price_mega_enabled INTEGER DEFAULT 1`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления order_price_mega_enabled:', err);
                } else {
                    console.log('✅ Поле order_price_mega_enabled готово');
                }
            });
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN top1_section_visible INTEGER DEFAULT 0`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления top1_section_visible:', err);
                } else {
                    console.log('✅ Поле top1_section_visible готово');
                }
            });
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN price_carousel TEXT`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления price_carousel:', err);
                } else {
                    console.log('✅ Поле price_carousel готово');
                }
            });
            db.run(`ALTER TABLE tank_queue_settings ADD COLUMN price_carousel_interval INTEGER DEFAULT 15`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления price_carousel_interval:', err);
                } else {
                    console.log('✅ Поле price_carousel_interval готово');
                }
            });
        }
    });

    // Таблица для достижений донатеров
    db.run(`CREATE TABLE IF NOT EXISTS donor_achievements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        normalized_username TEXT NOT NULL,
        username TEXT NOT NULL,
        total_time_seconds INTEGER DEFAULT 0,
        total_time_minutes INTEGER DEFAULT 0,
        current_tier_id INTEGER,
        last_donation_id TEXT,
        last_donation_time DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (current_tier_id) REFERENCES donor_achievement_tiers (id),
        UNIQUE(normalized_username)
    )`);

    // Индексы для быстрого поиска
    db.run(`CREATE INDEX IF NOT EXISTS idx_donor_achievements_username ON donor_achievements(normalized_username)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_donor_achievements_tier ON donor_achievements(current_tier_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_achievement_tiers_minutes ON donor_achievement_tiers(min_minutes)`);
    // Создаем UNIQUE индекс на sort_order для предотвращения дубликатов
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_achievement_tiers_sort_order ON donor_achievement_tiers(sort_order)`, (err) => {
        if (err && !err.message.includes('already exists')) {
            console.error('❌ Ошибка создания UNIQUE индекса на sort_order:', err);
        }
    });

    // Вставляем дефолтные уровни достижений (обновленные градации)
    const defaultTiers = [
        { name: 'Новичок', min_minutes: 5, max_minutes: 29, icon: '🌱', color: '#00ff47', description: '5-29 минут', sort_order: 1 },
        { name: 'Активный', min_minutes: 30, max_minutes: 59, icon: '⭐', color: '#00f0ff', description: '30-59 минут', sort_order: 2 },
        { name: 'Преданный', min_minutes: 60, max_minutes: 359, icon: '💎', color: '#b300ff', description: '1 час - 5 часов 59 минут', sort_order: 3 },
        { name: 'Верный', min_minutes: 360, max_minutes: 719, icon: '👑', color: '#ff7700', description: '6 часов - 11 часов 59 минут', sort_order: 4 },
        { name: 'Легенда', min_minutes: 720, max_minutes: 1439, icon: '🌟', color: '#ffff00', description: '12 часов - 23 часа 59 минут', sort_order: 5 },
        { name: 'Мастер', min_minutes: 1440, max_minutes: 4319, icon: '🔥', color: '#ff003c', description: '24 часа - 71 час 59 минут', sort_order: 6 },
        { name: 'Божество', min_minutes: 4320, max_minutes: null, icon: '⚡', color: '#ff00ff', description: '72 часа+', sort_order: 7 }
    ];

    defaultTiers.forEach(tier => {
        // Проверяем существование перед вставкой, чтобы избежать дубликатов
        db.get(`SELECT id FROM donor_achievement_tiers WHERE sort_order = ?`, [tier.sort_order], (checkErr, existing) => {
            if (checkErr) {
                console.error('❌ Ошибка проверки уровня:', checkErr);
                return;
            }
            
            if (!existing) {
                db.run(`INSERT INTO donor_achievement_tiers 
                    (name, min_minutes, max_minutes, icon, color, description, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [tier.name, tier.min_minutes, tier.max_minutes, tier.icon, tier.color, tier.description, tier.sort_order],
                    (err) => {
                        if (!err) console.log(`✅ Уровень достижения "${tier.name}" создан`);
                    }
                );
            } else {
                console.log(`⚠️ Уровень с sort_order=${tier.sort_order} уже существует, пропускаем`);
            }
        });
    });

    console.log('✅ Таблицы для достижений донатеров инициализированы');
});

checkDonationsNormalizedColumn();

// Инициализация аналитики
const analytics = new Analytics(db);

/** Опрос DonationAlerts/DonatePay — включён по умолчанию (DONATION_POLLING=0 для отключения) */
const DONATION_POLLING_ENABLED = process.env.DONATION_POLLING !== '0';
let pollingInterval = null;
let isPollingInProgress = false;
let nextPollTimeout = null;
let pollDelayMs = 5000;
const MIN_POLL_MS = 5000;
const MAX_POLL_MS = 30000;
let processedDonationIds = new Set();
let firstPollDone = false;
let lastSeenDonationId = null; // cached from DB

// Ensure DB has external stats columns (safe no-op if already exist)
db.serialize(() => {
    // Добавляем поля для DonatePay
    db.run(`ALTER TABLE app_state ADD COLUMN dp_api_key TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле dp_api_key');
    });
    
    // Добавляем поле для сохранения userId DonatePay
    db.run(`ALTER TABLE app_state ADD COLUMN dp_user_id TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле dp_user_id');
    });
    // Добавляем поле для сохранения времени последней ошибки 429
    db.run(`ALTER TABLE app_state ADD COLUMN dp_last_429_error_ts INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле dp_last_429_error_ts');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN dp_webhook_secret TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле dp_webhook_secret');
    });
    
    // Добавляем поле для скидки
    db.run(`ALTER TABLE app_state ADD COLUMN timer_discount INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления поля timer_discount:', err);
        } else {
            console.log('✅ Поле timer_discount готово');
        }
    });
    // Добавляем поле для времени окончания скидки
    db.run(`ALTER TABLE app_state ADD COLUMN timer_discount_until_ts INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления поля timer_discount_until_ts:', err);
        } else {
            console.log('✅ Поле timer_discount_until_ts готово');
        }
    });
    
    // Добавляем поля для управления виджетом
    db.run(`ALTER TABLE app_state ADD COLUMN widget_opacity REAL DEFAULT 0.9`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления поля widget_opacity:', err);
        } else {
            console.log('✅ Поле widget_opacity готово');
        }
    });
    
    db.run(`ALTER TABLE app_state ADD COLUMN widget_background_blur INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления поля widget_background_blur:', err);
        } else {
            console.log('✅ Поле widget_background_blur готово');
        }
    });
    
    db.run(`ALTER TABLE app_state ADD COLUMN dp_widget_url TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле dp_webhook_secret');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN dp_widget_url TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле dp_widget_url');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN dp_last_transaction_id TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле dp_last_transaction_id');
    });
    // Добавляем поля для Lesta Games
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_application_id TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_application_id');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_access_token TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_access_token');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_token_expires_at INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_token_expires_at');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_account_id TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_account_id');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_nickname TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_nickname');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_auto_sync INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_auto_sync');
    });
    // Добавляем поля для статистики Lesta Games
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_battles INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_battles');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_frags INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_frags');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_wins INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_wins');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_losses INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_losses');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_win_rate REAL`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_win_rate');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_frags_per_battle REAL`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_frags_per_battle');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_damage_dealt INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_damage_dealt');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_xp INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_xp');
    });
    // Добавляем дополнительные поля для детальной статистики
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_damage_received INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_damage_received');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_max_frags INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_max_frags');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_frags8p INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_frags8p');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_hits INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_hits');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_shots INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_shots');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_spotted INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_spotted');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_capture_points INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_capture_points');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_dropped_capture_points INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_dropped_capture_points');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_survived_battles INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_survived_battles');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_win_and_survived INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_win_and_survived');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_max_xp INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_max_xp');
    });
    // Поля для сессионного винрейта Lesta для виджета «параметр от донатов»
    db.run(`ALTER TABLE app_state ADD COLUMN dd_lesta_session_active INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле dd_lesta_session_active');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN dd_lesta_session_start_battles INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле dd_lesta_session_start_battles');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN dd_lesta_session_start_wins INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле dd_lesta_session_start_wins');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN dd_lesta_session_start_losses INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле dd_lesta_session_start_losses');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN dd_lesta_session_start_damage INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле dd_lesta_session_start_damage');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN dd_lesta_session_started_at INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле dd_lesta_session_started_at');
    });
    // РазБЛОГировка 2026 — копилка золота
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_tracking_active INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_tracking_active');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_baseline_battles INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_baseline_battles');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_baseline_wins INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_baseline_wins');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_baseline_survived INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_baseline_survived');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_last_sync_battles INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_last_sync_battles');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_last_sync_wins INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_last_sync_wins');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_last_sync_survived INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_last_sync_survived');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_last_sync_at INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_last_sync_at');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_event_start_iso TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_event_start_iso');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_baseline_damage_dealt INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_baseline_damage_dealt');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_widget_show_win_rate INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_widget_show_win_rate');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_widget_show_avg_damage INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_widget_show_avg_damage');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN razblog_last_sync_damage_dealt INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblog_last_sync_damage_dealt');
    });
    db.run(`ALTER TABLE razblogirovka_battles ADD COLUMN damage_dealt INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле razblogirovka_battles.damage_dealt');
    });
    db.run(`CREATE TABLE IF NOT EXISTS razblogirovka_battles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        battle_key TEXT NOT NULL UNIQUE,
        played_at INTEGER NOT NULL DEFAULT 0,
        gold_amount INTEGER NOT NULL DEFAULT 0,
        won INTEGER NOT NULL DEFAULT 0,
        survived INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Ошибка создания razblogirovka_battles:', err);
        else console.log('✅ Таблица razblogirovka_battles создана');
    });
    // Добавляем поля для отслеживания изменений
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_previous_frags INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_previous_frags');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_auto_deduct INTEGER DEFAULT 1`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_auto_deduct');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_sync_time INTEGER`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_sync_time');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_history_at INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_history_at');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_session_started_at INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_session_started_at');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_session_baseline_battles INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_session_baseline_battles');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_session_baseline_wins INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_session_baseline_wins');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_session_baseline_losses INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_session_baseline_losses');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_session_baseline_frags INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_session_baseline_frags');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_session_baseline_damage INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_session_baseline_damage');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_session_baseline_xp INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_session_baseline_xp');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_reliable_since INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_reliable_since');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN lesta_last_tank_snapshot_at INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле lesta_last_tank_snapshot_at');
    });

    const lestaHistoryDeltaColumns = [
        'ALTER TABLE lesta_stats_history ADD COLUMN battles_delta INTEGER DEFAULT 0',
        'ALTER TABLE lesta_stats_history ADD COLUMN wins_delta INTEGER DEFAULT 0',
        'ALTER TABLE lesta_stats_history ADD COLUMN losses_delta INTEGER DEFAULT 0',
        'ALTER TABLE lesta_stats_history ADD COLUMN frags_delta INTEGER DEFAULT 0',
        'ALTER TABLE lesta_stats_history ADD COLUMN damage_delta INTEGER DEFAULT 0',
        'ALTER TABLE lesta_stats_history ADD COLUMN xp_delta INTEGER DEFAULT 0',
        'ALTER TABLE lesta_stats_history ADD COLUMN account_id TEXT',
        'ALTER TABLE lesta_stats_history ADD COLUMN is_resync INTEGER DEFAULT 0'
    ];
    lestaHistoryDeltaColumns.forEach((sql) => {
        db.run(sql, (err) => {
            if (!err) console.log('✅ Миграция lesta_stats_history:', sql.split('ADD COLUMN ')[1]);
        });
    });
    // Поле для стартового значения таймера стрима (в секундах)
    db.run(`ALTER TABLE app_state ADD COLUMN stream_timer_initial_elapsed_sec INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле stream_timer_initial_elapsed_sec');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN stream_timer_last_update_ts INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле stream_timer_last_update_ts');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN stream_timer_started_ts INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле stream_timer_started_ts');
    });
    // Add Mode 2 slowdown fields if missing
    db.run(`ALTER TABLE app_state ADD COLUMN timer_slowdown_active BOOLEAN DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле timer_slowdown_active');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN timer_slowdown_factor REAL DEFAULT 1.0`, (err) => {
        if (!err) console.log('✅ Добавлено поле timer_slowdown_factor');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN timer_slowdown_until_ts INTEGER DEFAULT 0`, (err) => {
        if (!err) console.log('✅ Добавлено поле timer_slowdown_until_ts');
    });
    // Add slowdown random settings field
    db.run(`ALTER TABLE app_state ADD COLUMN slowdown_random_settings TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле slowdown_random_settings');
    });
    // Add schedule settings field (JSON: title + today's slots)
    db.run(`ALTER TABLE app_state ADD COLUMN schedule_settings TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле schedule_settings');
    });
    db.run(`ALTER TABLE app_state ADD COLUMN tournament_data TEXT`, (err) => {
        if (!err) console.log('✅ Добавлено поле tournament_data');
    });
    // Добавляем поле для отслеживания времени, добавленного вручную
    db.run(`ALTER TABLE app_state ADD COLUMN timer_manual_time_added INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления поля timer_manual_time_added:', err);
        } else {
            console.log('✅ Поле timer_manual_time_added готово');
        }
    });
    
    // Фиксируем значение времени, добавленного вручную: 3 дня 4ч 55м = 276900 секунд
    // ВАЖНО: Это значение устанавливается при каждом запуске сервера
    // Оно будет увеличиваться только при ручном добавлении времени через кнопку "ДОБАВИТЬ ВРЕМЯ"
    db.run(`UPDATE app_state SET timer_manual_time_added = 276900 WHERE id = 1`, (err) => {
        if (err) {
            console.error('❌ Ошибка установки значения timer_manual_time_added:', err);
        } else {
            db.get(`SELECT timer_manual_time_added FROM app_state WHERE id = 1`, [], (err, row) => {
                if (!err && row) {
                    const days = Math.floor((row.timer_manual_time_added || 0) / 86400);
                    const hours = Math.floor(((row.timer_manual_time_added || 0) % 86400) / 3600);
                    const minutes = Math.floor(((row.timer_manual_time_added || 0) % 3600) / 60);
                    console.log(`✅ Значение timer_manual_time_added зафиксировано: ${days} д ${hours} ч ${minutes} м (${row.timer_manual_time_added} сек)`);
                    console.log(`   ⚠️ Это значение будет увеличиваться только при ручном добавлении времени через кнопку "ДОБАВИТЬ ВРЕМЯ"`);
                }
            });
        }
    });
    
    // Устанавливаем автосинхронизацию и автосписание всегда включенными
    db.run(`UPDATE app_state SET lesta_auto_sync = 1, lesta_auto_deduct = 1 WHERE id = 1`, (err) => {
        if (!err) console.log('✅ Автосинхронизация и автосписание установлены как включенные');
    });
    
    // Создаем таблицу для истории изменений статистики Lesta Games
    db.run(`CREATE TABLE IF NOT EXISTS lesta_stats_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        battles INTEGER,
        frags INTEGER,
        wins INTEGER,
        losses INTEGER,
        damage_dealt INTEGER,
        xp INTEGER,
        win_rate REAL,
        frags_per_battle REAL,
        avg_damage INTEGER,
        avg_xp INTEGER,
        frags_difference INTEGER DEFAULT 0,
        auto_deducted INTEGER DEFAULT 0
    )`, (err) => {
        if (!err) console.log('✅ Создана таблица lesta_stats_history');
    });

    db.run(`CREATE TABLE IF NOT EXISTS lesta_tank_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        account_id TEXT,
        tanks_json TEXT NOT NULL
    )`, (err) => {
        if (!err) console.log('✅ Создана таблица lesta_tank_snapshots');
    });
});

// Миграция для добавления полей аналитики режимов таймера
console.log('🔄 Проверяем миграцию для аналитики режимов таймера...');
const migrationQueries = [
    "ALTER TABLE donations ADD COLUMN timer_mode TEXT DEFAULT 'normal'",
    "ALTER TABLE donations ADD COLUMN timer_seconds INTEGER DEFAULT 0",
    "ALTER TABLE donations ADD COLUMN discount_active BOOLEAN DEFAULT 0",
    "ALTER TABLE donations ADD COLUMN discount_percentage REAL DEFAULT 0",
    "ALTER TABLE donations ADD COLUMN slowdown_active BOOLEAN DEFAULT 0",
    "ALTER TABLE donations ADD COLUMN slowdown_factor REAL DEFAULT 1.0",
    "ALTER TABLE donations ADD COLUMN temperature_active BOOLEAN DEFAULT 0",
    "ALTER TABLE donations ADD COLUMN temperature_amount REAL DEFAULT 0",
    "ALTER TABLE donations ADD COLUMN temperature_target REAL DEFAULT 0",
    "ALTER TABLE donations ADD COLUMN temperature_overheated BOOLEAN DEFAULT 0",
    "ALTER TABLE donations ADD COLUMN temperature_reward_minutes INTEGER DEFAULT 0",
    "ALTER TABLE donations ADD COLUMN normalized_username TEXT DEFAULT ''",
    "ALTER TABLE app_state ADD COLUMN stream_timer_started_ts INTEGER DEFAULT 0"
];

migrationQueries.forEach((query, index) => {
    db.run(query, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error(`❌ Ошибка миграции ${index + 1}:`, err.message);
        } else if (!err) {
            console.log(`✅ Миграция ${index + 1} выполнена`);
        }
    });
});

checkDonationsNormalizedColumn();

// Создаем таблицы для аналитики режимов таймера
db.run(`CREATE TABLE IF NOT EXISTS temperature_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_start DATETIME DEFAULT CURRENT_TIMESTAMP,
    session_end DATETIME,
    target_amount REAL NOT NULL,
    total_donated REAL DEFAULT 0,
    max_temperature REAL DEFAULT 0,
    overheated BOOLEAN DEFAULT 0,
    reward_minutes INTEGER DEFAULT 0,
    cooling_rate REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => {
    if (!err) console.log('✅ Создана таблица temperature_sessions');
});

    // Создаем таблицу для рулетки
    db.run(`CREATE TABLE IF NOT EXISTS roulette_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        is_active INTEGER DEFAULT 0,
        target_amount REAL DEFAULT 1000,
        current_amount REAL DEFAULT 0,
        accumulated_roulettes INTEGER DEFAULT 0,
        last_reset_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        CHECK (id = 1)
    )`);

    // Добавляем недостающие поля если их нет
    db.run(`ALTER TABLE roulette_state ADD COLUMN target_amount REAL DEFAULT 1000`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления target_amount:', err);
        } else if (!err) {
            console.log('✅ Добавлено поле target_amount');
        }
    });
    
    db.run(`ALTER TABLE roulette_state ADD COLUMN current_amount REAL DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления current_amount:', err);
        } else if (!err) {
            console.log('✅ Добавлено поле current_amount');
        }
    });
    
    db.run(`ALTER TABLE roulette_state ADD COLUMN accumulated_roulettes INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления accumulated_roulettes:', err);
        } else if (!err) {
            console.log('✅ Добавлено поле accumulated_roulettes');
        }
    });
    
    db.run(`ALTER TABLE roulette_state ADD COLUMN is_active INTEGER DEFAULT 0`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления is_active:', err);
        } else if (!err) {
            console.log('✅ Добавлено поле is_active');
        }
    });
    
    db.run(`ALTER TABLE roulette_state ADD COLUMN last_reset_at DATETIME`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления last_reset_at:', err);
        } else if (!err) {
            console.log('✅ Добавлено поле last_reset_at');
        }
    });
    
    db.run(`ALTER TABLE roulette_state ADD COLUMN text TEXT DEFAULT '750 лайков со всех стримов- крутим'`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('❌ Ошибка добавления text:', err);
        } else if (!err) {
            console.log('✅ Добавлено поле text');
        }
    });

    // Инициализируем состояние рулетки (создаем запись если её нет)
    db.run(`INSERT OR IGNORE INTO roulette_state (id, is_active, target_amount, current_amount, accumulated_roulettes) 
            VALUES (1, 0, 1000, 0, 0)`, (err) => {
        if (err && !err.message.includes('UNIQUE constraint')) {
            console.error('❌ Ошибка инициализации рулетки:', err);
        } else {
            console.log('✅ Таблица рулетки инициализирована');
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS timer_time_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timer_seconds INTEGER NOT NULL,
    donation_count INTEGER DEFAULT 0,
    total_amount REAL DEFAULT 0,
    avg_amount REAL DEFAULT 0,
    mode TEXT DEFAULT 'normal',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => {
    if (!err) console.log('✅ Создана таблица timer_time_stats');
});

// Middleware
app.use(helmet({
    contentSecurityPolicy: false // OBS/локальные виджеты могут встраиваться
}));
app.use(cors());
app.use(express.json({
    limit: '50mb',
    // Сырое тело нужно вебхуку DonatePay для проверки HMAC-подписи
    verify: (req, res, buf) => {
        if (req.originalUrl && req.originalUrl.startsWith('/webhook/donatepay')) {
            req.rawBody = buf;
        }
    }
}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Загрузка гифок для виджета лайков (base64 в JSON, без multer)
const widgetAssetsDir = path.join(__dirname, 'public', 'widget-assets');
app.post('/api/widget-assets/upload-gifs', express.json({ limit: '15mb' }), (req, res) => {
    try {
        const staticData = req.body && req.body.staticBase64;
        const animatedData = req.body && req.body.animatedBase64;
        if (!staticData || !animatedData || typeof staticData !== 'string' || typeof animatedData !== 'string') {
            return res.status(400).json({ error: 'Загрузите оба файла: статичную и анимированную гиф (GIF)' });
        }
        const strip = (s) => (s || '').replace(/^data:image\/gif;base64,/, '');
        const staticBuf = Buffer.from(strip(staticData), 'base64');
        const animatedBuf = Buffer.from(strip(animatedData), 'base64');
        if (staticBuf.length > 10 * 1024 * 1024 || animatedBuf.length > 10 * 1024 * 1024) {
            return res.status(400).json({ error: 'Файл слишком большой (макс. 10 МБ)' });
        }
        if (!fs.existsSync(widgetAssetsDir)) fs.mkdirSync(widgetAssetsDir, { recursive: true });
        fs.writeFileSync(path.join(widgetAssetsDir, 'likes-static.gif'), staticBuf);
        fs.writeFileSync(path.join(widgetAssetsDir, 'likes-animated.gif'), animatedBuf);
        res.json({
            ok: true,
            staticUrl: '/widget-assets/likes-static.gif',
            animatedUrl: '/widget-assets/likes-animated.gif'
        });
    } catch (e) {
        console.warn('Ошибка загрузки гифок виджета:', e);
        res.status(500).json({ error: 'Ошибка загрузки: ' + (e.message || 'неизвестно') });
    }
});

// HTML-страницы/OBS-оверлеи вынесены в src/modules/pages.
// ВАЖНО: registerEarlyPages — ДО express.static (переопределяет Cache-Control).
const { createPagesModule } = require('./src/modules/pages');
const pagesModule = createPagesModule({
    appRoot: __dirname,
    razblogEnabled: RAZBLOG_ENABLED,
    razblogArchiveDir: RAZBLOG_ARCHIVE_DIR
});
pagesModule.registerEarlyPages(app);

// Компоненты (sidebar/header) и стили меняются во время разработки чаще, чем
// раз в час/сутки — агрессивный Cache-Control тут приводил к тому, что правки
// в sidebar.html/layout.css не были видны в уже открытых вкладках. max-age: 0
// (как у index.html) заставляет браузер каждый раз проверять ETag/Last-Modified,
// но не грузить файл заново, если он не менялся.
app.use('/components', express.static(path.join(__dirname, 'public', 'components'), { maxAge: 0 }));
app.use('/styles', express.static(path.join(__dirname, 'public', 'styles'), { maxAge: 0 }));
app.use(express.static('public'));
// Отдаём статически папку assets в корне проекта
if (!fs.existsSync(path.join(__dirname, 'assets'))) {
    try { fs.mkdirSync(path.join(__dirname, 'assets'), { recursive: true }); } catch {}
}
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Healthcheck
app.get('/healthz', (req, res) => res.json({ ok: true }));

// API для получения данных очереди танков (для OBS виджета)
app.get('/api/tank-queue', (req, res) => {
    const liteMode = req.query && String(req.query.lite || '') === '1';
    db.serialize(() => {
        // Получаем очередь танков
        db.all('SELECT * FROM tank_queue ORDER BY price DESC', (err, tanks) => {
            if (err) {
                console.error('❌ Ошибка получения очереди:', err);
                return res.status(500).json({ success: false, error: err.message });
            }

            // Получаем настройки
            db.get('SELECT * FROM tank_queue_settings WHERE id = 1', (err, settings) => {
                if (err) {
                    console.error('❌ Ошибка получения настроек:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }

                // Преобразуем данные из базы в нужный формат
                const formattedTanks = (tanks || []).map(tank => ({
                    name: tank.name || '',
                    price: tank.price || 0,
                    conditions: tank.conditions || '',
                    priority: tank.priority !== undefined ? tank.priority : 0,
                    addedAt: tank.added_at !== undefined ? tank.added_at : (tank.addedAt || Date.now())
                }));

                if (liteMode) {
                    return res.json({
                        success: true,
                        tanks: formattedTanks,
                        currentTankIndex: settings?.current_tank_index !== undefined ? settings.current_tank_index : -1,
                        orderPrice: settings?.order_price !== undefined ? settings.order_price : 0,
                        orderPriceTop1: settings?.order_price_top1 !== undefined ? settings.order_price_top1 : 0,
                        orderPricePriority: settings?.order_price_priority !== undefined ? settings.order_price_priority : 0,
                        orderPriceMega: settings?.order_price_mega !== undefined ? settings.order_price_mega : 0,
                        priceInfo: settings?.price_info || '',
                        orderPriceLabel: settings?.order_price_label || 'Заказ танка',
                        orderPriceTop1Label: settings?.order_price_top1_label || 'Заказ танка до топ 1',
                        orderPricePriorityLabel: settings?.order_price_priority_label || 'Приоритетный заказ',
                        orderPriceMegaLabel: settings?.order_price_mega_label || 'Мегаприоритет',
                        orderPriceEnabled: settings?.order_price_enabled !== undefined ? settings.order_price_enabled : 1,
                        orderPriceTop1Enabled: settings?.order_price_top1_enabled !== undefined ? settings.order_price_top1_enabled : 0,
                        orderPricePriorityEnabled: settings?.order_price_priority_enabled !== undefined ? settings.order_price_priority_enabled : 1,
                        orderPriceMegaEnabled: settings?.order_price_mega_enabled !== undefined ? settings.order_price_mega_enabled : 1,
                        top1SectionVisible: settings?.top1_section_visible !== undefined ? settings.top1_section_visible : 0,
                        priceCarousel: (() => {
                            try {
                                if (settings?.price_carousel && settings.price_carousel.trim() !== '') {
                                    return JSON.parse(settings.price_carousel);
                                }
                                return [];
                            } catch {
                                return [];
                            }
                        })(),
                        priceCarouselInterval: settings?.price_carousel_interval !== undefined ? settings.price_carousel_interval : 15
                    });
                }

                // Загружаем фото из файла если есть путь
                let photoData = null;
                const photoPath = settings?.streamer_photo || null;
                if (photoPath) {
                    try {
                        const filePath = path.join(__dirname, 'public', photoPath);
                        if (fs.existsSync(filePath)) {
                            const fileBuffer = fs.readFileSync(filePath);
                            const extension = path.extname(photoPath).slice(1) || 'jpg';
                            const mimeType = extension === 'png' ? 'image/png' : 'image/jpeg';
                            photoData = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
                            console.log('📸 Photo loaded from file:', photoPath, 'size:', photoData.length);
                        } else {
                            console.warn('⚠️ Photo file not found:', photoPath);
                        }
                    } catch (err) {
                        console.error('❌ Error loading photo from file:', err);
                    }
                }
                
                // Загружаем второе фото из файла если есть путь
                let secondPhotoData = null;
                const secondPhotoPath = settings?.second_photo || null;
                if (secondPhotoPath) {
                    try {
                        const filePath = path.join(__dirname, 'public', secondPhotoPath);
                        if (fs.existsSync(filePath)) {
                            const fileBuffer = fs.readFileSync(filePath);
                            const extension = path.extname(secondPhotoPath).slice(1) || 'jpg';
                            const mimeType = extension === 'png' ? 'image/png' : 'image/jpeg';
                            secondPhotoData = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
                            console.log('📸 Second photo loaded from file:', secondPhotoPath, 'size:', secondPhotoData.length);
                        } else {
                            console.warn('⚠️ Second photo file not found:', secondPhotoPath);
                        }
                    } catch (err) {
                        console.error('❌ Error loading second photo from file:', err);
                    }
                }
                
                // Загружаем третье фото из файла если есть путь
                let thirdPhotoData = null;
                const thirdPhotoPath = settings?.third_photo || null;
                console.log('📸 Loading third photo from DB, path:', thirdPhotoPath || 'null');
                if (thirdPhotoPath) {
                    try {
                        const filePath = path.join(__dirname, 'public', thirdPhotoPath);
                        if (fs.existsSync(filePath)) {
                            const fileBuffer = fs.readFileSync(filePath);
                            const extension = path.extname(thirdPhotoPath).slice(1) || 'jpg';
                            const mimeType = extension === 'png' ? 'image/png' : 'image/jpeg';
                            thirdPhotoData = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
                            console.log('📸 Third photo loaded from file:', thirdPhotoPath, 'size:', thirdPhotoData.length);
                        } else {
                            console.warn('⚠️ Third photo file not found:', thirdPhotoPath);
                        }
                    } catch (err) {
                        console.error('❌ Error loading third photo from file:', err);
                    }
                }
                
                console.log('📤 Sending response with photos:');
                console.log('  streamerPhoto:', photoData ? `exists (${photoData.length} chars)` : 'null');
                console.log('  secondPhoto:', secondPhotoData ? `exists (${secondPhotoData.length} chars)` : 'null');
                console.log('  thirdPhoto:', thirdPhotoData ? `exists (${thirdPhotoData.length} chars)` : 'null');
                
                res.json({
                    success: true,
                    tanks: formattedTanks,
                    currentTankIndex: settings?.current_tank_index !== undefined ? settings.current_tank_index : -1,
                    orderPrice: settings?.order_price !== undefined ? settings.order_price : 0,
                    orderPriceTop1: settings?.order_price_top1 !== undefined ? settings.order_price_top1 : 0,
                    orderPricePriority: settings?.order_price_priority !== undefined ? settings.order_price_priority : 0,
                    orderPriceMega: settings?.order_price_mega !== undefined ? settings.order_price_mega : 0,
                    priceInfo: settings?.price_info || '',
                    orderPriceLabel: settings?.order_price_label || 'Заказ танка',
                    orderPriceTop1Label: settings?.order_price_top1_label || 'Заказ танка до топ 1',
                    orderPricePriorityLabel: settings?.order_price_priority_label || 'Приоритетный заказ',
                    orderPriceMegaLabel: settings?.order_price_mega_label || 'Мегаприоритет',
                    orderPriceEnabled: settings?.order_price_enabled !== undefined ? settings.order_price_enabled : 1,
                    orderPriceTop1Enabled: settings?.order_price_top1_enabled !== undefined ? settings.order_price_top1_enabled : 0,
                    orderPricePriorityEnabled: settings?.order_price_priority_enabled !== undefined ? settings.order_price_priority_enabled : 1,
                    orderPriceMegaEnabled: settings?.order_price_mega_enabled !== undefined ? settings.order_price_mega_enabled : 1,
                    top1SectionVisible: settings?.top1_section_visible !== undefined ? settings.top1_section_visible : 0,
                    priceCarousel: (() => {
                        try {
                            if (settings?.price_carousel && settings.price_carousel.trim() !== '') {
                                const parsed = JSON.parse(settings.price_carousel);
                                console.log('📺 Карусель загружена с сервера:', parsed);
                                return parsed;
                            }
                            return [];
                        } catch (err) {
                            console.error('❌ Ошибка парсинга карусели:', err);
                            return [];
                        }
                    })(),
                    priceCarouselInterval: settings?.price_carousel_interval !== undefined ? settings.price_carousel_interval : 15,
                    streamerPhoto: photoData,
                    secondPhoto: secondPhotoData,
                    thirdPhoto: thirdPhotoData
                });
            });
        });
    });
});

// API для сохранения данных очереди танков
app.post('/api/tank-queue/save', express.json({ limit: '50mb' }), (req, res) => {
    const { tanks, currentTankIndex, orderPrice, orderPriceTop1, orderPricePriority, orderPriceMega, priceInfo, priceCarousel, priceCarouselInterval, orderPriceLabel, orderPriceTop1Label, orderPricePriorityLabel, orderPriceMegaLabel, orderPriceEnabled, orderPriceTop1Enabled, orderPricePriorityEnabled, orderPriceMegaEnabled, top1SectionVisible, streamerPhoto, secondPhoto, thirdPhoto } = req.body;
    
    console.log('💾 Saving tank queue data...');
    console.log('📸 Streamer photo:', streamerPhoto ? `exists (${streamerPhoto.length} chars)` : 'null');
    console.log('📸 Second photo:', secondPhoto ? `exists (${secondPhoto.length} chars)` : 'null');
    console.log('📸 Third photo:', thirdPhoto ? `exists (${thirdPhoto.length} chars)` : 'null');
    
    db.serialize(() => {
        // Сначала получаем текущие пути к фото для удаления старых файлов
        db.get('SELECT streamer_photo, second_photo, third_photo FROM tank_queue_settings WHERE id = 1', (err, oldSettings) => {
            if (err) {
                console.error('❌ Error getting old photo paths:', err);
                return res.status(500).json({ success: false, error: err.message });
            }
            
            let photoPath = null;
            let secondPhotoPath = null;
            
            // Обрабатываем фото:
            // - undefined: поле не прислали -> оставляем как есть
            // - ''/null: явное удаление
            // - data:image...: обновление
            if (streamerPhoto === undefined) {
                photoPath = oldSettings?.streamer_photo || null;
            } else if (streamerPhoto && streamerPhoto.trim() !== '') {
                try {
                    // Удаляем старый файл если он есть
                    if (oldSettings && oldSettings.streamer_photo) {
                        const oldFilePath = path.join(__dirname, 'public', oldSettings.streamer_photo);
                        if (fs.existsSync(oldFilePath)) {
                            try {
                                fs.unlinkSync(oldFilePath);
                                console.log('🗑️ Old photo file deleted:', oldSettings.streamer_photo);
                            } catch (err) {
                                console.error('❌ Error deleting old photo:', err);
                            }
                        }
                    }
                    
                    // Создаем папку для фото если её нет
                    const uploadsDir = path.join(__dirname, 'public', 'uploads');
                    if (!fs.existsSync(uploadsDir)) {
                        fs.mkdirSync(uploadsDir, { recursive: true });
                    }
                    
                    // Извлекаем base64 данные
                    const base64Data = streamerPhoto.replace(/^data:image\/\w+;base64,/, '');
                    const buffer = Buffer.from(base64Data, 'base64');
                    
                    // Определяем расширение файла
                    const matches = streamerPhoto.match(/^data:image\/(\w+);base64,/);
                    const extension = matches ? matches[1] : 'jpg';
                    
                    // Сохраняем файл
                    photoPath = `uploads/streamer-photo.${extension}`;
                    const filePath = path.join(__dirname, 'public', photoPath);
                    fs.writeFileSync(filePath, buffer);
                    
                    console.log('✅ Photo saved to file:', photoPath);
                } catch (err) {
                    console.error('❌ Error saving photo to file:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка сохранения фото: ' + err.message });
                }
            } else {
                // Если фото не передано, удаляем файл если он есть
                if (oldSettings && oldSettings.streamer_photo) {
                    const filePath = path.join(__dirname, 'public', oldSettings.streamer_photo);
                    if (fs.existsSync(filePath)) {
                        try {
                            fs.unlinkSync(filePath);
                            console.log('🗑️ Photo file deleted (no photo in request)');
                        } catch (err) {
                            console.error('❌ Error deleting photo file:', err);
                        }
                    }
                }
            }
            
            // Обрабатываем второе фото
            if (secondPhoto === undefined) {
                secondPhotoPath = oldSettings?.second_photo || null;
            } else if (secondPhoto && secondPhoto.trim() !== '') {
                try {
                    // Удаляем старый файл если он есть
                    if (oldSettings && oldSettings.second_photo) {
                        const oldFilePath = path.join(__dirname, 'public', oldSettings.second_photo);
                        if (fs.existsSync(oldFilePath)) {
                            try {
                                fs.unlinkSync(oldFilePath);
                                console.log('🗑️ Old second photo file deleted:', oldSettings.second_photo);
                            } catch (err) {
                                console.error('❌ Error deleting old second photo:', err);
                            }
                        }
                    }
                    
                    // Создаем папку для фото если её нет
                    const uploadsDir = path.join(__dirname, 'public', 'uploads');
                    if (!fs.existsSync(uploadsDir)) {
                        fs.mkdirSync(uploadsDir, { recursive: true });
                    }
                    
                    // Извлекаем base64 данные
                    const base64Data = secondPhoto.replace(/^data:image\/\w+;base64,/, '');
                    const buffer = Buffer.from(base64Data, 'base64');
                    
                    // Определяем расширение файла
                    const matches = secondPhoto.match(/^data:image\/(\w+);base64,/);
                    const extension = matches ? matches[1] : 'jpg';
                    
                    // Сохраняем файл
                    secondPhotoPath = `uploads/second-photo.${extension}`;
                    const filePath = path.join(__dirname, 'public', secondPhotoPath);
                    fs.writeFileSync(filePath, buffer);
                    
                    console.log('✅ Second photo saved to file:', secondPhotoPath);
                } catch (err) {
                    console.error('❌ Error saving second photo to file:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка сохранения второго фото: ' + err.message });
                }
            } else {
                // Если второе фото не передано, удаляем файл если он есть
                if (oldSettings && oldSettings.second_photo) {
                    const filePath = path.join(__dirname, 'public', oldSettings.second_photo);
                    if (fs.existsSync(filePath)) {
                        try {
                            fs.unlinkSync(filePath);
                            console.log('🗑️ Second photo file deleted (no photo in request)');
                        } catch (err) {
                            console.error('❌ Error deleting second photo file:', err);
                        }
                    }
                }
            }
            
            // Обрабатываем третье фото
            let thirdPhotoPath = null;
            if (thirdPhoto === undefined) {
                thirdPhotoPath = oldSettings?.third_photo || null;
            } else if (thirdPhoto && thirdPhoto.trim() !== '') {
                try {
                    // Удаляем старый файл если он есть
                    if (oldSettings && oldSettings.third_photo) {
                        const oldFilePath = path.join(__dirname, 'public', oldSettings.third_photo);
                        if (fs.existsSync(oldFilePath)) {
                            try {
                                fs.unlinkSync(oldFilePath);
                                console.log('🗑️ Old third photo file deleted:', oldSettings.third_photo);
                            } catch (err) {
                                console.error('❌ Error deleting old third photo:', err);
                            }
                        }
                    }
                    
                    // Создаем папку для фото если её нет
                    const uploadsDir = path.join(__dirname, 'public', 'uploads');
                    if (!fs.existsSync(uploadsDir)) {
                        fs.mkdirSync(uploadsDir, { recursive: true });
                    }
                    
                    // Извлекаем base64 данные
                    const base64Data = thirdPhoto.replace(/^data:image\/\w+;base64,/, '');
                    const buffer = Buffer.from(base64Data, 'base64');
                    
                    // Определяем расширение файла
                    const matches = thirdPhoto.match(/^data:image\/(\w+);base64,/);
                    const extension = matches ? matches[1] : 'jpg';
                    
                    // Сохраняем файл
                    thirdPhotoPath = `uploads/third-photo.${extension}`;
                    const filePath = path.join(__dirname, 'public', thirdPhotoPath);
                    fs.writeFileSync(filePath, buffer);
                    
                    console.log('✅ Third photo saved to file:', thirdPhotoPath);
                } catch (err) {
                    console.error('❌ Error saving third photo to file:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка сохранения третьего фото: ' + err.message });
                }
            } else {
                // Если третье фото не передано, удаляем файл если он есть
                if (oldSettings && oldSettings.third_photo) {
                    const filePath = path.join(__dirname, 'public', oldSettings.third_photo);
                    if (fs.existsSync(filePath)) {
                        try {
                            fs.unlinkSync(filePath);
                            console.log('🗑️ Third photo file deleted (no photo in request)');
                        } catch (err) {
                            console.error('❌ Error deleting third photo file:', err);
                        }
                    }
                }
            }
            
            // Продолжаем сохранение данных
            // Добавляем поля priority и added_at если их нет (миграция)
            db.run(`ALTER TABLE tank_queue ADD COLUMN priority INTEGER DEFAULT 0`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления priority:', err);
                }
            });
            db.run(`ALTER TABLE tank_queue ADD COLUMN added_at INTEGER DEFAULT 0`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    console.error('❌ Ошибка добавления added_at:', err);
                }
            });
            
            // Очищаем старую очередь
            db.run('DELETE FROM tank_queue', (err) => {
                if (err) {
                    console.error('❌ Ошибка очистки очереди:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }

                // Вставляем новую очередь
                const stmt = db.prepare('INSERT INTO tank_queue (name, price, conditions, priority, added_at) VALUES (?, ?, ?, ?, ?)');
                if (Array.isArray(tanks)) {
                    tanks.forEach(tank => {
                        stmt.run(tank.name, tank.price, tank.conditions || '', tank.priority || 0, tank.addedAt || Date.now());
                    });
                }
                stmt.finalize((err) => {
                    if (err) {
                        console.error('❌ Ошибка сохранения очереди:', err);
                        return res.status(500).json({ success: false, error: err.message });
                    }

                    // Обновляем настройки (сохраняем путь к файлу вместо base64)
                    db.run(
                        `UPDATE tank_queue_settings SET 
                            current_tank_index = ?,
                            order_price = ?,
                            order_price_top1 = ?,
                            order_price_priority = ?,
                            order_price_mega = ?,
                            price_info = ?,
                            order_price_label = ?,
                            order_price_top1_label = ?,
                            order_price_priority_label = ?,
                            order_price_mega_label = ?,
                            order_price_enabled = ?,
                            order_price_top1_enabled = ?,
                            order_price_priority_enabled = ?,
                            order_price_mega_enabled = ?,
                            top1_section_visible = ?,
                            price_carousel = ?,
                            price_carousel_interval = ?,
                            streamer_photo = ?,
                            second_photo = ?,
                            third_photo = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = 1`,
                        [
                            currentTankIndex || -1, 
                            orderPrice || 0, 
                            orderPriceTop1 || 0,
                            orderPricePriority || 0,
                            orderPriceMega || 0,
                            priceInfo || '',
                            orderPriceLabel || 'Заказ танка',
                            orderPriceTop1Label || 'Заказ танка до топ 1',
                            orderPricePriorityLabel || 'Приоритетный заказ',
                            orderPriceMegaLabel || 'Мегаприоритет',
                            orderPriceEnabled !== undefined ? (orderPriceEnabled ? 1 : 0) : 1,
                            orderPriceTop1Enabled !== undefined ? (orderPriceTop1Enabled ? 1 : 0) : 0,
                            orderPricePriorityEnabled !== undefined ? (orderPricePriorityEnabled ? 1 : 0) : 1,
                            orderPriceMegaEnabled !== undefined ? (orderPriceMegaEnabled ? 1 : 0) : 1,
                            top1SectionVisible !== undefined ? (top1SectionVisible ? 1 : 0) : 0,
                            priceCarousel ? JSON.stringify(priceCarousel) : null,
                            priceCarouselInterval !== undefined ? (parseInt(priceCarouselInterval) || 15) : 15,
                            photoPath || null,
                            secondPhotoPath || null,
                            thirdPhotoPath || null
                        ],
                        (err) => {
                            if (err) {
                                console.error('❌ Ошибка сохранения настроек:', err);
                                return res.status(500).json({ success: false, error: err.message });
                            }

                            console.log('✅ Настройки сохранены успешно, photo path:', photoPath || 'null', 'second photo path:', secondPhotoPath || 'null', 'third photo path:', thirdPhotoPath || 'null');
                            res.json({ success: true });
                        }
                    );
                });
            });
        });
    });
});

// getAppState / updateAppState вынесены в src/core/app-state.js
// (константы объявлены рядом с созданием appStateStore в начале файла)

// Функция нормализации ников донатеров для группировки похожих ников
// Функция обновления достижений донатера
function updateDonorAchievement(username, timeEarnedSeconds, donationId) {
    if (!username || !timeEarnedSeconds || timeEarnedSeconds <= 0) {
        return;
    }
    
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
        return;
    }
    
    // Получаем или создаем запись донатера
    // ВАЖНО: Используем транзакцию для предотвращения гонок условий
    db.serialize(() => {
        db.get('SELECT * FROM donor_achievements WHERE normalized_username = ?', [normalizedUsername], (err, achievement) => {
            if (err) {
                console.error('❌ Ошибка получения достижения донатера:', err);
                return;
            }
            
            const timeEarnedMinutes = Math.floor(timeEarnedSeconds / 60);
            const now = new Date().toISOString();
            
            if (!achievement) {
            // Создаем новую запись
            const totalSeconds = timeEarnedSeconds;
            const totalMinutes = timeEarnedMinutes;
            
                // Определяем текущий уровень
                // Ищем уровень, который соответствует времени донатера
                db.get(`SELECT * FROM donor_achievement_tiers 
                    WHERE min_minutes <= ? AND (max_minutes IS NULL OR max_minutes >= ?)
                    ORDER BY sort_order DESC LIMIT 1`, 
                    [totalMinutes, totalMinutes], 
                    (err, tier) => {
                        if (err) {
                            console.error('❌ Ошибка получения уровня достижения:', err);
                            return;
                        }
                        
                        // Если уровень не найден (например, меньше 5 минут), не присваиваем уровень
                        // Используем INSERT OR IGNORE с последующей проверкой
                        db.run(`INSERT OR IGNORE INTO donor_achievements 
                            (normalized_username, username, total_time_seconds, total_time_minutes, 
                             current_tier_id, last_donation_id, last_donation_time)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [normalizedUsername, username, totalSeconds, totalMinutes, 
                             tier ? tier.id : null, donationId, now],
                        function(insertErr) {
                            if (insertErr) {
                                console.error('❌ Ошибка создания достижения донатера:', insertErr);
                                return;
                            }
                            
                            // Если запись не была вставлена (уже существует), обновляем
                            if (this.changes === 0) {
                                console.log(`⚠️ Достижение уже существует для ${username}, обновляем...`);
                                db.get('SELECT * FROM donor_achievements WHERE normalized_username = ?', [normalizedUsername], (getErr, existing) => {
                                    if (getErr || !existing) {
                                        console.error('❌ Ошибка получения существующего достижения:', getErr);
                                        return;
                                    }
                                    const newTotalSeconds = (existing.total_time_seconds || 0) + timeEarnedSeconds;
                                    const newTotalMinutes = Math.floor(newTotalSeconds / 60);
                                    db.get(`SELECT * FROM donor_achievement_tiers 
                                        WHERE min_minutes <= ? AND (max_minutes IS NULL OR max_minutes >= ?)
                                        ORDER BY sort_order DESC LIMIT 1`, 
                                        [newTotalMinutes, newTotalMinutes], 
                                        (tierErr, newTier) => {
                                            if (tierErr) {
                                                console.error('❌ Ошибка получения уровня:', tierErr);
                                                return;
                                            }
                                            db.run(`UPDATE donor_achievements 
                                                SET total_time_seconds = ?, total_time_minutes = ?,
                                                    current_tier_id = COALESCE(?, current_tier_id),
                                                    last_donation_id = ?, last_donation_time = ?,
                                                    username = ?, updated_at = CURRENT_TIMESTAMP
                                                WHERE normalized_username = ?`,
                                                [newTotalSeconds, newTotalMinutes, newTier ? newTier.id : null, donationId, now, username, normalizedUsername],
                                                (updateErr) => {
                                                    if (updateErr) {
                                                        console.error('❌ Ошибка обновления достижения:', updateErr);
                                                    } else {
                                                        console.log(`✅ Обновлено достижение для ${username}: +${timeEarnedMinutes} мин (всего: ${newTotalMinutes} мин)`);
                                                    }
                                                }
                                            );
                                        }
                                    );
                                });
                            } else {
                                console.log(`✅ Создано достижение для ${username}: +${timeEarnedMinutes} мин (всего: ${totalMinutes} мин)`);
                            }
                        }
                    );
                }
            );
            } else {
                // Обновляем существующую запись
                const newTotalSeconds = (achievement.total_time_seconds || 0) + timeEarnedSeconds;
                const newTotalMinutes = Math.floor(newTotalSeconds / 60);
                
                // Определяем новый уровень
                db.get(`SELECT * FROM donor_achievement_tiers 
                    WHERE min_minutes <= ? AND (max_minutes IS NULL OR max_minutes >= ?)
                    ORDER BY sort_order DESC LIMIT 1`, 
                    [newTotalMinutes, newTotalMinutes], 
                    (err, tier) => {
                        if (err) {
                            console.error('❌ Ошибка получения уровня достижения:', err);
                            return;
                        }
                        
                        // Если уровень не найден, оставляем текущий или null
                        // НЕ используем дефолтное значение "Новичок"
                        const newTierId = tier ? tier.id : (achievement.current_tier_id || null);
                        const tierChanged = newTierId !== achievement.current_tier_id;
                        
                        db.run(`UPDATE donor_achievements 
                            SET total_time_seconds = ?, total_time_minutes = ?, 
                                current_tier_id = ?, last_donation_id = ?, last_donation_time = ?,
                                username = ?, updated_at = CURRENT_TIMESTAMP
                            WHERE normalized_username = ?`,
                            [newTotalSeconds, newTotalMinutes, newTierId, donationId, now, username, normalizedUsername],
                            (err) => {
                                if (err) {
                                    console.error('❌ Ошибка обновления достижения донатера:', err);
                                } else {
                                    console.log(`✅ Обновлено достижение для ${username}: +${timeEarnedMinutes} мин (всего: ${newTotalMinutes} мин)`);
                                    if (tierChanged) {
                                        console.log(`🎉 ${username} получил новый уровень достижения!`);
                                    }
                                }
                            }
                        );
                    }
                );
            }
        });
    });
}

function normalizeUsername(username) {
    if (!username || typeof username !== 'string') {
        return '';
    }
    
    // Приводим к нижнему регистру
    let normalized = username.toLowerCase().trim();
    
    // Убираем лишние пробелы
    normalized = normalized.replace(/\s+/g, ' ');
    
    // Заменяем различные разделители на единообразные
    normalized = normalized.replace(/[_\-\s]+/g, '_');
    
    // Убираем специальные символы, оставляем только буквы, цифры и подчеркивания
    normalized = normalized.replace(/[^a-zа-я0-9_]/g, '');
    
    // Убираем множественные подчеркивания
    normalized = normalized.replace(/_+/g, '_');
    
    // Убираем подчеркивания в начале и конце
    normalized = normalized.replace(/^_+|_+$/g, '');
    
    // Если результат пустой, возвращаем оригинальный ник
    if (!normalized) {
        return username.toLowerCase().trim();
    }
    
    return normalized;
}

// Функция для поиска похожих ников в базе данных
function findSimilarUsernames(normalizedUsername, callback) {
    if (!normalizedUsername) {
        callback([]);
        return;
    }
    
    // Ищем ники, которые отличаются только регистром, пробелами или разделителями
    const searchPattern = normalizedUsername.replace(/_/g, '[_\-\s]*');
    
    db.all(`
        SELECT DISTINCT username, normalized_username 
        FROM donations 
        WHERE normalized_username LIKE ? 
        OR username LIKE ?
        ORDER BY username
    `, [`%${normalizedUsername}%`, `%${searchPattern}%`], (err, rows) => {
        if (err) {
            console.error('❌ Ошибка поиска похожих ников:', err);
            callback([]);
        } else {
            callback(rows || []);
        }
    });
}

function saveDonation(donation, callback) {
    // Получаем текущее состояние для сохранения информации о режимах таймера
    getAppState((state) => {
        if (!state) {
            console.error('❌ Не удалось получить состояние для сохранения доната');
            if (callback) callback(new Error('State not found'));
            return;
        }
        
        // Нормализуем ник для группировки похожих ников
        const normalizedUsername = normalizeUsername(donation.username);
        
        // Логируем нормализацию для отладки
        console.log(`🔤 Нормализация имени: "${donation.username}" -> "${normalizedUsername}"`);
        
        db.run(`INSERT OR REPLACE INTO donations (
            id, username, amount, message, currency, is_realtime, 
            frags_earned, time_earned, custom_units_earned,
            timer_mode, timer_seconds, 
            discount_active, discount_percentage,
            slowdown_active, slowdown_factor,
            temperature_active, temperature_amount, temperature_target,
            temperature_overheated, temperature_reward_minutes,
            normalized_username
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                donation.id, donation.username, donation.amount, donation.message, 
                donation.currency || 'RUB', donation.isRealtime ? 1 : 0, 
                donation.fragsEarned || 0, donation.timeEarned || 0, donation.customUnitsEarned || 0,
                // Информация о режимах таймера
                state.current_mode || 'mode1',
                state.timer_seconds || 0,
                state.timer_discount_active || 0,
                state.timer_discount || 0,
                state.timer_slowdown_active || 0,
                state.timer_slowdown_factor || 1.0,
                state.temperature_mode_active || 0,
                state.temperature_current_amount || 0,
                state.temperature_target_amount || 0,
                state.temperature_overheated || 0,
                state.temperature_peak_reward_minutes || 0,
                // Нормализованный ник
                normalizedUsername
            ],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка сохранения доната:', err);
                    console.error('   Донат ID:', donation.id);
                    console.error('   Донат username:', donation.username);
                    console.error('   Донат amount:', donation.amount);
                } else {
                    console.log(`✅ Донат сохранен в БД: ID=${donation.id}, username=${donation.username}, normalized=${normalizedUsername}, amount=${donation.amount}₽, time_earned=${donation.timeEarned || 0} сек`);
                }
                if (callback) callback(err);
            }
        );
    });
}

function getDonations(limit = 50, offset = 0, callback) {
    // Сортируем по created_at DESC, а затем по id DESC для гарантии правильного порядка
    // Это важно, если несколько донатов имеют одинаковую дату
    db.all(`SELECT * FROM donations ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?`, [limit, offset], (err, rows) => {
        if (err) {
            if (err.message && err.message.includes('no such table')) {
                return callback(null, []);
            }
            return callback(err);
        }
        
        // Логируем последний донат только при необходимости (убрано для уменьшения логов)
        // if (rows && rows.length > 0 && limit === 1) {
        //     const lastDonation = rows[0];
        //     console.log(`📋 Последний донат (api/donations?limit=1): ${lastDonation.username} - ${lastDonation.amount}₽, дата: ${lastDonation.created_at}`);
        // }
        
        callback(null, rows);
    });
}

// Загрузка токенов из БД при запуске
function loadDAToken() {
    db.get('SELECT da_access_token, dp_api_key, dp_webhook_secret, dp_widget_url, dp_last_transaction_id, dp_user_id, dp_last_429_error_ts, lesta_application_id, lesta_access_token, lesta_token_expires_at, lesta_account_id, lesta_nickname FROM app_state WHERE id = 1', (err, row) => {
        if (!err && row) {
            // Загружаем DonationAlerts токен
            if (row.da_access_token) {
            DA_CONFIG.accessToken = row.da_access_token;
            console.log('✅ Токен DonationAlerts загружен из БД');
            } else {
                console.log('⏳ Токен DonationAlerts не найден, требуется авторизация');
            }
            
            // Загружаем DonatePay настройки
            if (row.dp_api_key) {
                DP_CONFIG.apiKey = row.dp_api_key;
                console.log('✅ API ключ DonatePay загружен из БД');
                
                // Проверяем, изменился ли ключ в config.env
                if (process.env.DP_API_KEY && process.env.DP_API_KEY !== row.dp_api_key) {
                    console.log('🔄 Обнаружен новый API ключ в config.env, обновляем...');
                    DP_CONFIG.apiKey = process.env.DP_API_KEY;
                    DP_CONFIG.lastError = null; // Сбрасываем ошибку 429
                    // Обновляем ключ в БД и сбрасываем ошибку 429
                    db.run('UPDATE app_state SET dp_api_key = ?, dp_last_429_error_ts = NULL, dp_user_id = NULL WHERE id = 1', [process.env.DP_API_KEY], (err) => {
                        if (err) {
                            console.error('❌ Ошибка обновления ключа в БД:', err);
                        } else {
                            console.log('✅ API ключ DonatePay обновлен в БД, ошибка 429 сброшена');
                        }
                    });
                }
                
                // Загружаем время последней ошибки 429 из БД если есть
                if (row.dp_last_429_error_ts) {
                    const timeSinceError = Date.now() - row.dp_last_429_error_ts;
                    const timeoutMs = 300000; // 5 минут
                    if (timeSinceError < timeoutMs) {
                        const minutesLeft = Math.ceil((timeoutMs - timeSinceError) / 60000);
                        const secondsLeft = Math.ceil((timeoutMs - timeSinceError) / 1000) % 60;
                        console.log(`⏸️ Недавняя ошибка 429 обнаружена в БД (осталось ждать: ~${minutesLeft} мин ${secondsLeft} сек)`);
                        DP_CONFIG.lastError = { status: 429, message: 'Too Many Requests', timestamp: row.dp_last_429_error_ts };
                        console.log('💡 Попытка получить userId будет выполнена автоматически после истечения таймаута');
                    } else {
                        console.log('✅ Таймаут ошибки 429 истек, можно попробовать получить userId');
                        // Очищаем время ошибки в БД
                        db.run('UPDATE app_state SET dp_last_429_error_ts = NULL WHERE id = 1', (err) => {
                            if (!err) console.log('✅ Время ошибки 429 очищено из БД');
                        });
                    }
                }
                
                // Загружаем userId из БД если есть
                if (row.dp_user_id) {
                    DP_CONFIG.userId = row.dp_user_id;
                    console.log('✅ userId DonatePay загружен из БД:', DP_CONFIG.userId);
                    // Подключаемся к Centrifugo сразу если userId есть
                    (async () => {
                        try {
                            console.log('📡 Подключение к Centrifugo с сохраненным userId...');
                            await connectDonatePayCentrifugo();
                        } catch (error) {
                            console.error('❌ Ошибка подключения к Centrifugo:', error.message);
                        }
                    })();
                } else {
                    // Проверяем, можно ли получить userId (не было ли недавно ошибки 429)
                    const lastError = DP_CONFIG.lastError;
                    const timeSinceError = lastError && lastError.status === 429 ? (Date.now() - (lastError.timestamp || 0)) : Infinity;
                    const timeoutMs = 300000; // 5 минут
                    
                    if (!lastError || lastError.status !== 429 || timeSinceError > timeoutMs) {
                        // Получаем информацию о пользователе и подключаемся к Centrifugo
                        (async () => {
                            try {
                                console.log('🔄 Попытка получить userId при старте сервера...');
                                const userInfo = await getDonatePayUser();
                                if (userInfo && DP_CONFIG.userId) {
                                    console.log('✅ Информация о пользователе DonatePay получена, ID:', DP_CONFIG.userId);
                                    // Подключаемся к Centrifugo для real-time уведомлений
                                    await connectDonatePayCentrifugo();
                                }
                            } catch (error) {
                                console.error('❌ Ошибка инициализации DonatePay:', error.message);
                            }
                        })();
                    } else {
                        const minutesLeft = Math.ceil((timeoutMs - timeSinceError) / 60000);
                        console.log(`⏸️ Пропуск получения userId при старте из-за недавней ошибки 429 (осталось ждать: ~${minutesLeft} мин)`);
                        console.log('💡 userId будет получен автоматически после истечения таймаута');
                    }
                }
            } else if (process.env.DP_API_KEY) {
                // Если ключа нет в БД, но есть в config.env, сохраняем его в БД
                DP_CONFIG.apiKey = process.env.DP_API_KEY;
                console.log('✅ API ключ DonatePay загружен из config.env');
                console.log('🔑 API ключ (первые 10 символов):', process.env.DP_API_KEY.substring(0, 10) + '...');
                // Сбрасываем ошибку 429 при загрузке нового ключа из env
                DP_CONFIG.lastError = null;
                console.log('🔄 Ошибка 429 сброшена (новый ключ из config.env)');
                
                // Сохраняем в БД и сбрасываем ошибку 429
                db.run('UPDATE app_state SET dp_api_key = ?, dp_last_429_error_ts = NULL, dp_user_id = NULL WHERE id = 1', [process.env.DP_API_KEY], (err) => {
                    if (err) {
                        console.error('❌ Ошибка сохранения ключа в БД:', err);
                    } else {
                        console.log('✅ API ключ DonatePay сохранен в БД, ошибка 429 сброшена');
                    }
                });
                
                // Получаем информацию о пользователе и подключаемся к Centrifugo
                (async () => {
                    try {
                        console.log('🔄 Инициализация DonatePay...');
                        const userInfo = await getDonatePayUser();
                        if (userInfo && DP_CONFIG.userId) {
                            console.log('✅ Информация о пользователе DonatePay получена, ID:', DP_CONFIG.userId);
                            // Подключаемся к Centrifugo для real-time уведомлений
                            await connectDonatePayCentrifugo();
                        } else {
                            console.warn('⚠️ Не удалось получить информацию о пользователе DonatePay');
                        }
                    } catch (error) {
                        console.error('❌ Ошибка инициализации DonatePay:', error.message);
                        console.error('📋 Stack:', error.stack);
                    }
                })();
            } else {
                console.log('⏳ API ключ DonatePay не найден ни в БД, ни в config.env');
            }
            if (row.dp_webhook_secret) {
                DP_CONFIG.webhookSecret = row.dp_webhook_secret;
                console.log('✅ Webhook секрет DonatePay загружен из БД');
            }
            if (row.dp_widget_url) {
                DP_CONFIG.widgetUrl = row.dp_widget_url;
                console.log('✅ URL виджета DonatePay загружен из БД');
            }
            if (row.dp_last_transaction_id) {
                DP_CONFIG.lastTransactionId = parseInt(row.dp_last_transaction_id) || 0;
                console.log('✅ ID последней транзакции DonatePay загружен из БД:', DP_CONFIG.lastTransactionId);
            } else {
                console.log('⏳ ID последней транзакции DonatePay не найден, будет установлен при первом донате');
            }
            
            // Загружаем Lesta Games настройки
            if (row.lesta_application_id) {
                LESTA_CONFIG.applicationId = row.lesta_application_id;
                console.log('✅ Application ID Lesta Games загружен из БД');
            }
            if (row.lesta_access_token) {
                LESTA_CONFIG.accessToken = row.lesta_access_token;
                LESTA_CONFIG.tokenExpiresAt = row.lesta_token_expires_at || 0;
                console.log('✅ Access token Lesta Games загружен из БД');
            }
            if (row.lesta_account_id) {
                LESTA_CONFIG.accountId = row.lesta_account_id;
                console.log('✅ Account ID Lesta Games загружен из БД');
            }
            if (row.lesta_nickname) {
                LESTA_CONFIG.nickname = row.lesta_nickname;
                console.log('✅ Никнейм Lesta Games загружен из БД');
            }
            
            // Запускаем опрос если есть хотя бы одна платформа
            if (DA_CONFIG.accessToken || DP_CONFIG.apiKey) {
                startPollingDonationAlerts();
            }
            
            // Запускаем автосинхронизацию Lesta Games если настроена
            if (LESTA_CONFIG.accessToken && LESTA_CONFIG.accountId) {
                startLestaAutoSync();
            }
        } else {
            console.log('⏳ Настройки донатных платформ не найдены');
        }
    });
}

// OAuth авторизация DonationAlerts
app.get('/auth/donationalerts', (req, res) => {
    // Проверяем наличие обязательных параметров
    if (!DA_CONFIG.clientId || !DA_CONFIG.clientSecret) {
        return res.status(400).send(`
            <h3 style="color: red;">Ошибка настройки DonationAlerts</h3>
            <p><strong>Проблема:</strong> Client ID или Client Secret не настроены</p>
            <p><strong>Решение:</strong> Настройте переменные окружения:</p>
            <ul>
                <li>DA_CLIENT_ID - ваш Client ID из DonationAlerts</li>
                <li>DA_CLIENT_SECRET - ваш Client Secret из DonationAlerts</li>
            </ul>
            <p><strong>Текущие значения:</strong></p>
            <ul>
                <li>Client ID: ${DA_CONFIG.clientId ? 'настроен' : 'НЕ НАСТРОЕН'}</li>
                <li>Client Secret: ${DA_CONFIG.clientSecret ? 'настроен' : 'НЕ НАСТРОЕН'}</li>
            </ul>
            <p><a href="/admin">Вернуться в админку</a></p>
        `);
    }
    
    // Используем все необходимые scopes для работы с донатами
    const scopes = [
        'oauth-user-show',           // Получение профиля пользователя
        'oauth-donation-index',      // Просмотр донатов
        'oauth-donation-subscribe'   // Подписка на новые донаты
    ].join(' ');
    
    const authUrl = `https://www.donationalerts.com/oauth/authorize?client_id=${DA_CONFIG.clientId}&redirect_uri=${encodeURIComponent(DA_CONFIG.redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
    console.log('🔗 Перенаправление на OAuth:', authUrl);
    console.log('🔑 Параметры авторизации:', {
        client_id: DA_CONFIG.clientId,
        redirect_uri: DA_CONFIG.redirectUri,
        scope: scopes
    });
    res.redirect(authUrl);
});

// OAuth callback для DonationAlerts (новый путь)
app.get('/oauth/donationalerts/callback', async (req, res) => {
    try {
        const { code } = req.query;
        console.log('📥 Получен OAuth код:', code ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');
        
        if (!code) {
            throw new Error('Код авторизации не получен');
        }

        // Проверяем наличие обязательных параметров
        if (!DA_CONFIG.clientId || !DA_CONFIG.clientSecret) {
            throw new Error('Client ID или Client Secret не настроены');
        }

        // Формируем данные для получения токена (form-data)
        const formData = new URLSearchParams();
        formData.append('grant_type', 'authorization_code');
        formData.append('code', code);
        formData.append('redirect_uri', DA_CONFIG.redirectUri);
        formData.append('client_id', DA_CONFIG.clientId);
        formData.append('client_secret', DA_CONFIG.clientSecret);

        console.log('🔑 Параметры запроса токена:', {
            client_id: DA_CONFIG.clientId,
            client_secret: DA_CONFIG.clientSecret ? `${DA_CONFIG.clientSecret.substring(0, 10)}...` : 'ОТСУТСТВУЕТ',
            grant_type: 'authorization_code',
            code: code ? `${code.substring(0, 20)}...` : 'ОТСУТСТВУЕТ',
            redirect_uri: DA_CONFIG.redirectUri
        });

        // Пробуем сначала с Basic Auth (если DonationAlerts поддерживает)
        let tokenResponse;
        try {
            // Метод 1: Basic Authentication
            const basicAuth = Buffer.from(`${DA_CONFIG.clientId}:${DA_CONFIG.clientSecret}`).toString('base64');
            tokenResponse = await axios.post(
                'https://www.donationalerts.com/oauth/token',
                formData.toString(),
                { 
                    headers: { 
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json',
                        'Authorization': `Basic ${basicAuth}`
                    } 
                }
            );
            console.log('✅ Токен получен через Basic Auth');
        } catch (basicAuthError) {
            console.log('⚠️ Basic Auth не сработал, пробуем без него...');
            // Метод 2: Параметры в теле запроса (стандартный способ)
            tokenResponse = await axios.post(
                'https://www.donationalerts.com/oauth/token',
                formData.toString(),
                { 
                    headers: { 
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    } 
                }
            );
            console.log('✅ Токен получен через параметры в теле');
        }
        
        if (tokenResponse.data && tokenResponse.data.access_token) {
            DA_CONFIG.accessToken = tokenResponse.data.access_token;
            console.log('✅ Токен получен успешно');
            console.log('📊 Ответ сервера:', {
                token_type: tokenResponse.data.token_type,
                expires_in: tokenResponse.data.expires_in,
                scope: tokenResponse.data.scope
            });
        } else {
            throw new Error('Токен не получен в ответе сервера');
        }
        
        // Сохраняем токен в БД
        getAppState((state) => {
            if (state) {
                updateAppState({
                    da_access_token: DA_CONFIG.accessToken
                }, (err) => {
                    if (err) {
                        console.error('❌ Ошибка сохранения токена:', err);
                    } else {
                        console.log('✅ Токен сохранен в БД');
                    }
                });
            }
        });
        
        console.log('✅ DonationAlerts OAuth успешно!');
        
        // Запускаем опрос после авторизации
        startPollingDonationAlerts();
        
        // Дополнительная проверка донатов через 3 секунды
        setTimeout(() => {
            if (!isPollingInProgress) {
                console.log('🔄 Проверка донатов после авторизации DonationAlerts...');
                checkForNewDonations();
            }
        }, 3000);
        
        res.send(`
            <script>
                window.opener.postMessage({ type: 'OAUTH_SUCCESS' }, '*');
                setTimeout(() => window.close(), 1000);
            </script>
            <h3 style="text-align: center; margin-top: 50px; color: green;">
                ✅ Авторизация успешна! Окно закроется автоматически.
            </h3>
        `);
    } catch (error) {
        console.error('❌ OAuth ошибка:', error.response?.data || error.message);
        console.error('❌ Полная ошибка:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            message: error.message
        });
        
        let errorMessage = 'Неизвестная ошибка';
        if (error.response?.data?.error_description) {
            errorMessage = error.response.data.error_description;
        } else if (error.response?.data?.message) {
            errorMessage = error.response.data.message;
        } else if (error.message) {
            errorMessage = error.message;
        }
        
        const errorDetails = error.response?.data || {};
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Ошибка авторизации DonationAlerts</title>
                <style>
                    body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; background: #1a1a1a; color: #fff; }
                    h3 { color: #ff6b6b; }
                    code { background: #333; padding: 2px 6px; border-radius: 3px; }
                    .info-box { background: #2a2a2a; padding: 15px; border-radius: 8px; margin: 15px 0; border-left: 4px solid #6ea8fe; }
                    .error-box { background: #3a1a1a; padding: 15px; border-radius: 8px; margin: 15px 0; border-left: 4px solid #ff6b6b; }
                    ul, ol { line-height: 1.8; }
                    a { color: #6ea8fe; text-decoration: none; }
                    a:hover { text-decoration: underline; }
                </style>
            </head>
            <body>
                <h3>❌ Ошибка авторизации DonationAlerts</h3>
                
                <div class="error-box">
                    <p><strong>Ошибка:</strong> ${errorMessage}</p>
                    <p><strong>Код ошибки:</strong> ${errorDetails.error || 'неизвестно'}</p>
                    <p><strong>HTTP Статус:</strong> ${error.response?.status || 'неизвестно'}</p>
                    ${errorDetails.error_description ? `<p><strong>Описание:</strong> ${errorDetails.error_description}</p>` : ''}
                </div>
                
                <div class="info-box">
                    <h4>📋 Текущие настройки:</h4>
                    <ul>
                        <li><strong>Client ID:</strong> <code>${DA_CONFIG.clientId}</code></li>
                        <li><strong>Client Secret:</strong> ${DA_CONFIG.clientSecret ? '✅ Настроен' : '❌ Не настроен'}</li>
                        <li><strong>Redirect URI:</strong> <code>${DA_CONFIG.redirectUri}</code></li>
                    </ul>
                </div>
                
                <div class="info-box">
                    <h4>🔧 Возможные причины и решения:</h4>
                    <ol>
                        <li><strong>Неправильный Client ID или Client Secret</strong><br>
                            Проверьте файл <code>config.env</code> и убедитесь, что значения совпадают с настройками приложения в DonationAlerts.</li>
                        <li><strong>Redirect URI не совпадает</strong><br>
                            В настройках вашего приложения в DonationAlerts должен быть указан точно такой же Redirect URI:<br>
                            <code>${DA_CONFIG.redirectUri}</code><br>
                            Проверьте на странице: <a href="https://www.donationalerts.com/application/clients" target="_blank">https://www.donationalerts.com/application/clients</a></li>
                        <li><strong>Код авторизации истек</strong><br>
                            Коды авторизации действительны только один раз и в течение короткого времени. Попробуйте авторизоваться заново.</li>
                        <li><strong>Приложение не активировано</strong><br>
                            Убедитесь, что ваше приложение активировано в DonationAlerts.</li>
                    </ol>
                </div>
                
                <div class="info-box">
                    <h4>✅ Что проверить:</h4>
                    <ol>
                        <li>Откройте <a href="https://www.donationalerts.com/application/clients" target="_blank">настройки приложений</a> в DonationAlerts</li>
                        <li>Найдите приложение с ID: <code>${DA_CONFIG.clientId}</code></li>
                        <li>Проверьте, что Redirect URI точно совпадает: <code>${DA_CONFIG.redirectUri}</code></li>
                        <li>Убедитесь, что приложение активировано</li>
                        <li>Попробуйте авторизоваться заново</li>
                    </ol>
                </div>
                
                <p style="margin-top: 30px;">
                    <a href="/stream-integrations.html">← Вернуться к интеграциям</a> | 
                    <a href="/auth/donationalerts">🔄 Попробовать снова</a>
                </p>
            </body>
            </html>
        `);
    }
});

// OAuth авторизация Lesta Games
// /auth/lesta, /auth/lesta/callback вынесены в src/modules/lesta-oauth

// API эндпоинты для диагностики
app.get('/api/status', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ============================================================
//  НАСТРОЙКИ: чтение/запись config.env прямо из админки
// ============================================================
const ADMIN_CONFIG_FIELDS = [
    { group: 'DonationAlerts', key: 'DA_CLIENT_ID',           label: 'Client ID',      secret: false },
    { group: 'DonationAlerts', key: 'DA_CLIENT_SECRET',       label: 'Client Secret',  secret: true  },
    { group: 'DonationAlerts', key: 'DA_REDIRECT_URI',        label: 'Redirect URI',   secret: false },
    { group: 'DonatePay',      key: 'DP_API_KEY',             label: 'API ключ',       secret: true  },
    { group: 'DonatePay',      key: 'DP_WEBHOOK_SECRET',      label: 'Webhook Secret', secret: true  },
    { group: 'Lesta Games',    key: 'LESTA_APPLICATION_ID',   label: 'Application ID', secret: false },
    { group: 'Lesta Games',    key: 'LESTA_ACCESS_TOKEN',     label: 'Access Token',   secret: true  },
    { group: 'YouTube',        key: 'YT_CLIENT_ID',           label: 'Client ID',      secret: false },
    { group: 'YouTube',        key: 'YT_CLIENT_SECRET',       label: 'Client Secret',  secret: true  },
    { group: 'YouTube',        key: 'YT_REDIRECT_URI',        label: 'Redirect URI',   secret: false },
    { group: 'VK Play',        key: 'VKPLAY_CLIENT_ID',       label: 'Client ID',      secret: false },
    { group: 'VK Play',        key: 'VKPLAY_CLIENT_SECRET',   label: 'Client Secret',  secret: true  },
    { group: 'VK Play',        key: 'VKPLAY_REDIRECT_URI',    label: 'Redirect URI',   secret: false },
    { group: 'VK Play Bot',    key: 'VKPLAY_BOT_CLIENT_ID',   label: 'Bot Client ID',  secret: false },
    { group: 'VK Play Bot',    key: 'VKPLAY_BOT_CLIENT_SECRET', label: 'Bot Secret',   secret: true  },
    { group: 'VK Play Bot',    key: 'VKPLAY_BOT_REDIRECT_URI', label: 'Bot Redirect URI', secret: false },
    { group: 'Twitch',         key: 'TW_CLIENT_ID',           label: 'Client ID',      secret: false },
    { group: 'Twitch',         key: 'TW_CLIENT_SECRET',       label: 'Client Secret',  secret: true  },
    { group: 'Twitch',         key: 'TW_CHANNEL',             label: 'Канал (login)',  secret: false },
];

function resolveConfigEnvPath() {
    const candidates = [
        process.env.FRAG_USER_DATA ? path.join(process.env.FRAG_USER_DATA, 'config.env') : null,
        path.join(__dirname, 'config.env'),
    ].filter(Boolean);
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return path.join(__dirname, 'config.env');
}

// GET — отдать текущие настройки (секреты маскируются)
app.get('/api/admin/config', (req, res) => {
    try {
        const fields = ADMIN_CONFIG_FIELDS.map(f => {
            const raw = process.env[f.key] || '';
            const isSet = raw.length > 0;
            return {
                key: f.key,
                group: f.group,
                label: f.label,
                secret: f.secret,
                isSet,
                // секрет наружу не отдаём — только факт, что задан, и хвост
                value: f.secret ? '' : raw,
                hint: f.secret && isSet ? ('••••' + raw.slice(-4)) : '',
            };
        });
        res.json({ success: true, fields });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST — сохранить изменённые настройки в config.env
app.post('/api/admin/config', (req, res) => {
    try {
        const updates = req.body || {};
        const allowed = new Set(ADMIN_CONFIG_FIELDS.map(f => f.key));
        const secretKeys = new Set(ADMIN_CONFIG_FIELDS.filter(f => f.secret).map(f => f.key));

        // что реально меняем: только разрешённые ключи с непустым значением
        const toWrite = {};
        for (const [k, v] of Object.entries(updates)) {
            if (!allowed.has(k)) continue;
            const val = typeof v === 'string' ? v.trim() : '';
            if (val === '') continue; // пусто = «не менять» (особенно для секретов)
            toWrite[k] = val;
        }

        if (Object.keys(toWrite).length === 0) {
            return res.json({ success: true, changed: [], message: 'Нет изменений' });
        }

        const envPath = resolveConfigEnvPath();
        let lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
        const seen = new Set();
        lines = lines.map(line => {
            const m = line.match(/^([A-Z0-9_]+)=/);
            if (m && toWrite[m[1]] !== undefined) {
                seen.add(m[1]);
                return `${m[1]}=${toWrite[m[1]]}`;
            }
            return line;
        });
        // новые ключи, которых не было в файле
        for (const [k, v] of Object.entries(toWrite)) {
            if (!seen.has(k)) lines.push(`${k}=${v}`);
        }
        fs.writeFileSync(envPath, lines.join('\n'), 'utf8');

        // применяем «на горячую» в текущий процесс
        for (const [k, v] of Object.entries(toWrite)) {
            process.env[k] = v;
        }

        const changed = Object.keys(toWrite).map(k => secretKeys.has(k) ? `${k} (секрет)` : k);
        console.log('🔧 Настройки обновлены через админку:', changed.join(', '));
        res.json({
            success: true,
            changed,
            note: 'Часть параметров (порты, ключи интеграций) применится после перезапуска сервера.'
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Статус подключений для админки (читает реальное состояние из БД)
app.get('/api/admin/status', (req, res) => {
    db.get('SELECT da_access_token, dp_api_key, lesta_access_token FROM app_state WHERE id = 1', (err, row) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        row = row || {};
        res.json({
            success: true,
            da:    !!row.da_access_token,
            dp:    !!row.dp_api_key,
            lesta: !!row.lesta_access_token
        });
    });
});

// API для проверки статуса Centrifugo DonatePay
app.get('/api/dp-centrifugo-status', (req, res) => {
    const status = {
        apiKey: !!DP_CONFIG.apiKey,
        userId: DP_CONFIG.userId || null,
        centrifugoConnected: donationPlatformsModule.isCentrifugoConnected(),
        centrifugoState: donationPlatformsModule.isCentrifugoConnected() ? (donationPlatformsModule.getCentrifugoState() || 'unknown') : 'not_initialized',
        lastError: DP_CONFIG.lastError,
        lastTransactionId: DP_CONFIG.lastTransactionId,
        channel: DP_CONFIG.userId ? `$public:${DP_CONFIG.userId}` : null
    };
    res.json({ success: true, status });
});

app.get('/api/da-status', (req, res) => {
    res.json({ 
        hasToken: !!DA_CONFIG.accessToken,
        clientId: DA_CONFIG.clientId,
        hasClientSecret: !!DA_CONFIG.clientSecret
    });
});

app.get('/api/db-status', (req, res) => {
    db.get('SELECT COUNT(*) as count FROM donations', (err, row) => {
        if (err) {
            res.json({ connected: false, error: err.message });
        } else {
            res.json({ connected: true, donationsCount: row.count });
        }
    });
});

app.get('/api/da-oauth-test', (req, res) => {
    if (!DA_CONFIG.clientId || !DA_CONFIG.clientSecret) {
        return res.json({ 
            success: false, 
            error: 'Client ID или Client Secret не настроены' 
        });
    }
    
    const authUrl = `https://www.donationalerts.com/oauth/authorize?client_id=${DA_CONFIG.clientId}&redirect_uri=${encodeURIComponent(DA_CONFIG.redirectUri)}&response_type=code&scope=oauth-donation-index`;
    
    res.json({ 
        success: true,
        clientId: DA_CONFIG.clientId,
        clientSecret: DA_CONFIG.clientSecret,
        redirectUri: DA_CONFIG.redirectUri,
        authUrl: authUrl
    });
});

app.get('/api/da-api-test', async (req, res) => {
    if (!DA_CONFIG.accessToken) {
        return res.json({ 
            success: false, 
            error: 'Access token не настроен. Выполните OAuth авторизацию.' 
        });
    }
    
    try {
        const donations = await getDonationsFromAPI();
        res.json({ 
            success: true,
            donationsCount: donations.length,
            donations: donations.slice(0, 5) // Первые 5 донатов
        });
    } catch (error) {
        res.json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.post('/api/test-widget-da', async (req, res) => {
    const { token } = req.body;
    
    if (!token) {
        return res.json({ success: false, error: 'Токен не предоставлен' });
    }
    
    try {
        const widgetUrl = `https://www.donationalerts.com/widget/lastdonations?alert_type=1,20,27,28,29,30,31,32&limit=10&token=${token}`;
        
        const response = await axios.get(widgetUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        res.json({ 
            success: true,
            size: response.data.length,
            content: response.data,
            status: response.status
        });
    } catch (error) {
        res.json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Диагностика донатов
app.get('/api/debug-donations', async (req, res) => {
    const debugInfo = {
        timestamp: new Date().toISOString(),
        daConfig: {
            hasToken: !!DA_CONFIG.accessToken,
            clientId: DA_CONFIG.clientId,
            hasClientSecret: !!DA_CONFIG.clientSecret
        },
        polling: {
            isPollingInProgress: isPollingInProgress,
            pollDelayMs: pollDelayMs,
            hasPollingInterval: !!pollingInterval
        }
    };
    
    // Проверяем БД
    db.get('SELECT da_access_token FROM app_state WHERE id = 1', (err, row) => {
        if (err) {
            debugInfo.dbError = err.message;
        } else {
            debugInfo.dbToken = row ? (row.da_access_token ? 'ЕСТЬ' : 'НЕТ') : 'НЕТ ЗАПИСИ';
        }
        
        // Проверяем донаты в БД
        db.all('SELECT COUNT(*) as count FROM donations', (err, countRow) => {
            if (err) {
                debugInfo.dbCountError = err.message;
            } else {
                debugInfo.donationsCount = countRow[0].count;
            }
            
            // Получаем последние донаты
            db.all('SELECT * FROM donations ORDER BY created_at DESC LIMIT 5', (err, donations) => {
                if (err) {
                    debugInfo.lastDonationsError = err.message;
                } else {
                    debugInfo.lastDonations = donations;
                }
                
                // Тестируем API
                if (DA_CONFIG.accessToken) {
                    getDonationsFromAPI().then(apiDonations => {
                        debugInfo.apiTest = {
                            success: true,
                            count: apiDonations.length,
                            donations: apiDonations.slice(0, 3)
                        };
                        res.json(debugInfo);
                    }).catch(apiError => {
                        debugInfo.apiTest = {
                            success: false,
                            error: apiError.message
                        };
                        res.json(debugInfo);
                    });
                } else {
                    debugInfo.apiTest = {
                        success: false,
                        error: 'Нет access token'
                    };
                    res.json(debugInfo);
                }
            });
        });
    });
});

// Принудительная проверка донатов
app.post('/api/force-check-donations', async (req, res) => {
    console.log('🔄 Принудительная проверка донатов через API...');
    
    try {
        await checkForNewDonations();
        res.json({ success: true, message: 'Проверка донатов выполнена' });
    } catch (error) {
        console.error('❌ Ошибка принудительной проверки:', error);
        res.json({ success: false, error: error.message });
    }
});

// Принудительная проверка новых донатов (сброс фильтров)
app.post('/api/force-check-new-donations', async (req, res) => {
    console.log('🔄 Принудительная проверка новых донатов (сброс фильтров)...');
    
    try {
        // Сбрасываем фильтры для проверки всех донатов
        const originalFirstPollDone = firstPollDone;
        const originalLastSeenDonationId = lastSeenDonationId;
        
        firstPollDone = false;
        lastSeenDonationId = null;
        
        console.log('🔄 Сброшены фильтры, проверяем все донаты...');
        await checkForNewDonations();
        
        // Восстанавливаем фильтры
        firstPollDone = originalFirstPollDone;
        lastSeenDonationId = originalLastSeenDonationId;
        
        res.json({ 
            success: true, 
            message: 'Принудительная проверка новых донатов выполнена',
            filtersReset: true
        });
    } catch (error) {
        console.error('❌ Ошибка принудительной проверки новых донатов:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Сброс lastSeenDonationId для обработки всех донатов
app.post('/api/reset-last-seen-id', async (req, res) => {
    console.log('🔄 Сброс lastSeenDonationId...');
    
    try {
        const originalLastSeenDonationId = lastSeenDonationId;
        lastSeenDonationId = null;
        
        console.log(`🔄 lastSeenDonationId сброшен: ${originalLastSeenDonationId} -> null`);
        
        // Принудительно проверяем донаты
        await checkForNewDonations();
        
        res.json({ 
            success: true, 
            message: 'lastSeenDonationId сброшен и выполнена проверка донатов',
            originalId: originalLastSeenDonationId,
            newId: lastSeenDonationId
        });
    } catch (error) {
        console.error('❌ Ошибка сброса lastSeenDonationId:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для получения донатов через OAuth (DonationAlerts)
// getDonationsFromAPI, getDonatePayUser, getDonatePayNewTransactions вынесены
// в src/modules/donation-platforms

// API для получения статистики из Lesta Games
// Функция продления access_token
// prolongateLestaToken и getLestaPlayerStats вынесены в src/modules/lesta-sync
// Автосинхронизация с Lesta Games
const LESTA_HISTORY_HEARTBEAT_SEC = Number(process.env.LESTA_HISTORY_HEARTBEAT_SEC || 900);
const LESTA_MAX_BATTLES_DELTA = Number(process.env.LESTA_MAX_BATTLES_DELTA || 40);
const LESTA_RELIABLE_BATTLES_GAP = Number(process.env.LESTA_RELIABLE_BATTLES_GAP || 3000);

function isReliableSnapshotRow(row, referenceBattles) {
    if (!row) return false;
    const rowBattles = Number(row.battles) || 0;
    const ref = Number(referenceBattles) || 0;
    if (ref < 5000) return true;
    return rowBattles >= ref - LESTA_RELIABLE_BATTLES_GAP;
}

function emptyDeltaContribution() {
    return {
        battles_delta: 0,
        wins_delta: 0,
        losses_delta: 0,
        frags_delta: 0,
        damage_delta: 0,
        xp_delta: 0,
        is_resync: 1
    };
}

function safeLestaCounterDelta(previousValue, currentValue, maxDelta) {
    const limit = maxDelta != null ? maxDelta : LESTA_MAX_BATTLES_DELTA;
    const prev = Number(previousValue) || 0;
    const cur = Number(currentValue) || 0;
    const raw = cur - prev;
    if (raw < 0 || raw > limit) {
        return { delta: 0, resync: true, raw };
    }
    return { delta: raw, resync: false, raw };
}

function deriveSnapshotDeltas(previousRow, currentRow) {
    previousRow = previousRow || {};
    currentRow = currentRow || {};
    const battles = safeLestaCounterDelta(previousRow.battles, currentRow.battles);
    const wins = safeLestaCounterDelta(previousRow.wins, currentRow.wins);
    const losses = safeLestaCounterDelta(previousRow.losses, currentRow.losses);
    const frags = safeLestaCounterDelta(previousRow.frags, currentRow.frags, LESTA_MAX_BATTLES_DELTA * 3);
    const damage = safeLestaCounterDelta(previousRow.damage_dealt, currentRow.damage_dealt, 500000);
    const xp = safeLestaCounterDelta(previousRow.xp, currentRow.xp, 250000);
    const resync = battles.resync || wins.resync || losses.resync || frags.resync || damage.resync || xp.resync;
    return {
        battles_delta: battles.delta,
        wins_delta: wins.delta,
        losses_delta: losses.delta,
        frags_delta: frags.delta,
        damage_delta: damage.delta,
        xp_delta: xp.delta,
        is_resync: resync ? 1 : 0
    };
}

function aggregateDeltasList(deltasList) {
    let battlesPlayed = 0;
    let wins = 0;
    let losses = 0;
    let frags = 0;
    let damageDealt = 0;
    let xp = 0;
    for (const d of deltasList || []) {
        battlesPlayed += Number(d.battles_delta) || 0;
        wins += Number(d.wins_delta) || 0;
        losses += Number(d.losses_delta) || 0;
        frags += Number(d.frags_delta) || 0;
        damageDealt += Number(d.damage_delta) || 0;
        xp += Number(d.xp_delta) || 0;
    }
    const winRate = battlesPlayed > 0 ? Number(((wins / battlesPlayed) * 100).toFixed(1)) : 0;
    return {
        battlesPlayed,
        wins,
        losses,
        frags,
        damageDealt,
        xp,
        winRate,
        avgDamage: battlesPlayed > 0 ? Math.round(damageDealt / battlesPlayed) : 0,
        avgXp: battlesPlayed > 0 ? Math.round(xp / battlesPlayed) : 0,
        fragsPerBattle: battlesPlayed > 0 ? Number((frags / battlesPlayed).toFixed(2)) : 0
    };
}

function rowToDeltaContribution(row, previousRow, referenceBattles) {
    if (!isReliableSnapshotRow(row, referenceBattles)) {
        return emptyDeltaContribution();
    }
    if (previousRow && !isReliableSnapshotRow(previousRow, referenceBattles)) {
        return emptyDeltaContribution();
    }
    if (row && row.account_id != null) {
        return {
            battles_delta: row.battles_delta || 0,
            wins_delta: row.wins_delta || 0,
            losses_delta: row.losses_delta || 0,
            frags_delta: row.frags_delta || 0,
            damage_delta: row.damage_delta || 0,
            xp_delta: row.xp_delta || 0,
            is_resync: row.is_resync || 0
        };
    }
    return deriveSnapshotDeltas(previousRow, row);
}

function buildDeltaSeries(rows, referenceBattles) {
    const series = [];
    let prev = null;
    for (const row of rows || []) {
        series.push(rowToDeltaContribution(row, prev, referenceBattles));
        prev = row;
    }
    return series;
}

function insertLestaStatsSnapshot(stats, fragsDifference, previousCounters, accountId, callback) {
    if (typeof previousCounters === 'function') {
        callback = previousCounters;
        previousCounters = null;
        accountId = null;
    } else if (typeof accountId === 'function') {
        callback = accountId;
        accountId = null;
    }
    callback = callback || (() => {});

    const prev = previousCounters || {};
    const deltas = deriveSnapshotDeltas(
        {
            battles: prev.battles,
            frags: prev.frags,
            wins: prev.wins,
            losses: prev.losses,
            damage_dealt: prev.damage_dealt,
            xp: prev.xp
        },
        stats
    );

    if (deltas.is_resync && deltas.battles_delta === 0) {
        console.log('ℹ️ Lesta: скачок статистики (пересчёт API), дельта боёв не учитывается');
        updateAppState({ lesta_reliable_since: Math.floor(Date.now() / 1000) }, () => {});
    }

    const historyData = {
        battles: stats.battles,
        frags: stats.frags,
        wins: stats.wins,
        losses: stats.losses,
        damage_dealt: stats.damage_dealt,
        xp: stats.xp,
        win_rate: parseFloat(stats.winRate),
        frags_per_battle: parseFloat(stats.fragsPerBattle),
        avg_damage: Math.round(stats.damage_dealt / Math.max(stats.battles, 1)),
        avg_xp: Math.round(stats.xp / Math.max(stats.battles, 1)),
        frags_difference: fragsDifference || 0,
        account_id: accountId || LESTA_CONFIG.accountId || null,
        ...deltas
    };

    db.run(`INSERT INTO lesta_stats_history
            (battles, frags, wins, losses, damage_dealt, xp, win_rate, frags_per_battle, avg_damage, avg_xp, frags_difference,
             battles_delta, wins_delta, losses_delta, frags_delta, damage_delta, xp_delta, account_id, is_resync)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [historyData.battles, historyData.frags, historyData.wins, historyData.losses,
            historyData.damage_dealt, historyData.xp, historyData.win_rate, historyData.frags_per_battle,
            historyData.avg_damage, historyData.avg_xp, historyData.frags_difference,
            historyData.battles_delta, historyData.wins_delta, historyData.losses_delta,
            historyData.frags_delta, historyData.damage_delta, historyData.xp_delta,
            historyData.account_id, historyData.is_resync],
        function(err) {
            if (err) {
                console.error('❌ Ошибка сохранения истории Lesta:', err);
                return callback(err);
            }
            updateAppState({ lesta_last_history_at: Math.floor(Date.now() / 1000) }, () => {
                if (historyData.account_id) scheduleLestaTankSnapshot(historyData.account_id);
                callback(null);
            });
        }
    );
}

function getLestaCountersFromState(state) {
    if (!state) return null;
    return {
        battles: Number(state.lesta_last_battles) || 0,
        frags: Number(state.lesta_last_frags) || 0,
        wins: Number(state.lesta_last_wins) || 0,
        losses: Number(state.lesta_last_losses) || 0,
        damage_dealt: Number(state.lesta_last_damage_dealt) || 0,
        xp: Number(state.lesta_last_xp) || 0,
        win_rate: Number(state.lesta_last_win_rate) || 0,
        frags_per_battle: Number(state.lesta_last_frags_per_battle) || 0
    };
}

function computeLestaPeriodDelta(baseline, current) {
    baseline = baseline || {};
    current = current || {};
    const battlesPlayed = Math.max(0, (current.battles || 0) - (baseline.battles || 0));
    const wins = Math.max(0, (current.wins || 0) - (baseline.wins || 0));
    const losses = Math.max(0, (current.losses || 0) - (baseline.losses || 0));
    const frags = Math.max(0, (current.frags || 0) - (baseline.frags || 0));
    const damageDealt = Math.max(0, (current.damage_dealt || 0) - (baseline.damage_dealt || 0));
    const xp = Math.max(0, (current.xp || 0) - (baseline.xp || 0));
    const winRate = battlesPlayed > 0 ? Number(((wins / battlesPlayed) * 100).toFixed(1)) : 0;
    return {
        battlesPlayed,
        wins,
        losses,
        frags,
        damageDealt,
        xp,
        winRate,
        avgDamage: battlesPlayed > 0 ? Math.round(damageDealt / battlesPlayed) : 0,
        avgXp: battlesPlayed > 0 ? Math.round(xp / battlesPlayed) : 0,
        fragsPerBattle: battlesPlayed > 0 ? Number((frags / battlesPlayed).toFixed(2)) : 0
    };
}

function getLestaPeriodDateFilter(period) {
    switch (period) {
        case '1d': return '-1 day';
        case '7d': return '-7 days';
        case '30d': return '-30 days';
        case '180d': return '-180 days';
        case '365d': return '-365 days';
        default: return '-1 day';
    }
}

function fetchLestaHistoryWindow(period, referenceBattles, reliableSinceSec, callback) {
    if (typeof reliableSinceSec === 'function') {
        callback = reliableSinceSec;
        reliableSinceSec = 0;
    } else if (typeof referenceBattles === 'function') {
        callback = referenceBattles;
        referenceBattles = 0;
        reliableSinceSec = 0;
    }
    const dateFilter = getLestaPeriodDateFilter(period);
    const ref = Number(referenceBattles) || 0;
    const reliableSince = Number(reliableSinceSec) || 0;
    const keepRow = (row) => isHistoryRowInTrackingWindow(row, ref, reliableSince);

    dbRead.all(
        `SELECT * FROM lesta_stats_history
         WHERE timestamp <= datetime('now', ?)
         ORDER BY timestamp DESC LIMIT 500`,
        [dateFilter],
        (err, beforeRows) => {
            if (err) return callback(err);
            const anchorRow = (beforeRows || []).find(keepRow) || null;

            dbRead.all(
                `SELECT * FROM lesta_stats_history
                 WHERE timestamp >= datetime('now', ?)
                 ORDER BY timestamp ASC`,
                [dateFilter],
                (err2, periodRows) => {
                    if (err2) return callback(err2);

                    const reliablePeriod = (periodRows || []).filter(keepRow);
                    const rows = [];
                    if (anchorRow) rows.push(anchorRow);
                    reliablePeriod.forEach((row) => {
                        if (!anchorRow || row.id !== anchorRow.id) rows.push(row);
                    });

                    callback(null, {
                        anchorRow,
                        periodRows: reliablePeriod,
                        rows,
                        referenceBattles: ref,
                        reliableSince
                    });
                }
            );
        }
    );
}

function fetchLestaPeriodBaseline(period, referenceBattles, reliableSinceSec, callback) {
    if (typeof reliableSinceSec === 'function') {
        callback = reliableSinceSec;
        reliableSinceSec = 0;
    } else if (typeof referenceBattles === 'function') {
        callback = referenceBattles;
        referenceBattles = 0;
        reliableSinceSec = 0;
    }
    fetchLestaHistoryWindow(period, referenceBattles, reliableSinceSec, (err, data) => {
        if (err) return callback(err);
        callback(null, data.anchorRow || (data.rows.length ? data.rows[0] : null));
    });
}

function computeLestaPeriodStatsFromRows(rows, referenceBattles) {
    if (!rows || rows.length < 2) {
        return aggregateDeltasList([]);
    }
    const deltas = buildDeltaSeries(rows, referenceBattles);
    return aggregateDeltasList(deltas.slice(1));
}

function buildLestaDailyActivity(days, referenceBattles, reliableSinceSec, callback) {
    if (typeof reliableSinceSec === 'function') {
        callback = reliableSinceSec;
        reliableSinceSec = 0;
    } else if (typeof referenceBattles === 'function') {
        callback = referenceBattles;
        referenceBattles = 0;
        reliableSinceSec = 0;
    }
    const safeDays = Math.min(Math.max(Number(days) || 14, 1), 90);
    const ref = Number(referenceBattles) || 0;
    const reliableSince = Number(reliableSinceSec) || 0;
    const keepRow = (row) => isHistoryRowInTrackingWindow(row, ref, reliableSince);

    dbRead.all(
        `SELECT * FROM lesta_stats_history
         WHERE timestamp < datetime('now', ?)
         ORDER BY timestamp DESC LIMIT 500`,
        [`-${safeDays} days`],
        (err, beforeRows) => {
            if (err) return callback(err);
            const anchorRow = (beforeRows || []).find(keepRow) || null;

            dbRead.all(
                `SELECT * FROM lesta_stats_history
                 WHERE timestamp >= datetime('now', ?)
                 ORDER BY timestamp ASC`,
                [`-${safeDays} days`],
                (err2, periodRows) => {
                    if (err2) return callback(err2);

                    const reliablePeriod = (periodRows || []).filter(keepRow);
                    const rows = [];
                    if (anchorRow) rows.push(anchorRow);
                    reliablePeriod.forEach((row) => {
                        if (!anchorRow || row.id !== anchorRow.id) rows.push(row);
                    });
                    if (rows.length < 2) return callback(null, []);

                    const deltas = buildDeltaSeries(rows, ref);
                    const byDay = {};
                    for (let i = 1; i < rows.length; i++) {
                        const day = String(rows[i].timestamp).slice(0, 10);
                        if (!byDay[day]) byDay[day] = [];
                        byDay[day].push(deltas[i]);
                    }
                    const daily = Object.keys(byDay).sort().map((day) => ({
                        date: day,
                        ...aggregateDeltasList(byDay[day])
                    }));
                    callback(null, daily);
                }
            );
        }
    );
}

// lestaSyncTimer/stopLestaAutoSync живут в src/modules/lesta-sync
function detectLestaReliableSinceTimestamp(referenceBattles, callback) {
    const ref = Number(referenceBattles) || 0;
    if (ref < 5000) return callback(null, 0);

    dbRead.all(
        `SELECT id, timestamp, battles FROM lesta_stats_history ORDER BY id ASC`,
        (err, rows) => {
            if (err) return callback(err);
            let lastEnterReliableAt = null;
            let wasUnreliable = true;
            for (const row of rows || []) {
                const reliable = isReliableSnapshotRow(row, ref);
                if (reliable && wasUnreliable) {
                    lastEnterReliableAt = row.timestamp;
                    wasUnreliable = false;
                } else if (!reliable) {
                    wasUnreliable = true;
                }
            }
            if (!lastEnterReliableAt) return callback(null, 0);
            const ts = Math.floor(new Date(String(lastEnterReliableAt).replace(' ', 'T')).getTime() / 1000);
            callback(null, Number.isFinite(ts) ? ts : 0);
        }
    );
}

function ensureLestaReliableSince(callback) {
    callback = callback || (() => {});
    getAppState((state) => {
        if (!state || !state.lesta_account_id) return callback();
        const ref = Number(state.lesta_last_battles) || 0;

        detectLestaReliableSinceTimestamp(ref, (err, detectedTs) => {
            if (err || !detectedTs) return callback();
            const current = Number(state.lesta_reliable_since) || 0;
            if (detectedTs <= current) return callback();
            updateAppState({ lesta_reliable_since: detectedTs }, () => {
                console.log('✅ Lesta: надёжная статистика с', new Date(detectedTs * 1000).toLocaleString('ru-RU'));
                callback();
            });
        });
    });
}

function historyRowTimestampSec(row) {
    if (!row || !row.timestamp) return 0;
    const ts = Math.floor(new Date(String(row.timestamp).replace(' ', 'T')).getTime() / 1000);
    return Number.isFinite(ts) ? ts : 0;
}

function isHistoryRowInTrackingWindow(row, referenceBattles, reliableSinceSec) {
    if (!isReliableSnapshotRow(row, referenceBattles)) return false;
    if (reliableSinceSec > 0 && historyRowTimestampSec(row) < reliableSinceSec) return false;
    return true;
}

// Lesta-синк вынесен в src/modules/lesta-sync: получение статистики, продление
// токена, дельты боёв/фрагов, АВТОСПИСАНИЕ фрагов из режима 1, цикл автосинка.
// Поведение закреплено регресс-тестом npm run test-lesta.
const { createLestaSyncModule } = require('./src/modules/lesta-sync');
const lestaSyncModule = createLestaSyncModule({
    lestaConfig: LESTA_CONFIG,
    withLestaApiLock,
    getAppState,
    updateAppState,
    db,
    analytics,
    broadcastStateUpdate,
    safeLestaCounterDelta,
    historyHeartbeatSec: LESTA_HISTORY_HEARTBEAT_SEC,
    addBattleForce,
    insertLestaStatsSnapshot,
    ensureLestaReliableSince,
    afterSync: (stats, state) => {
        if (RAZBLOG_ENABLED && razblogModuleRef && razblogModuleRef.getService() && state.razblog_tracking_active) {
            razblogModuleRef.getService().syncFromLestaStats({ stats }, (razErr) => {
                if (razErr) console.warn('⚠️ razblog sync after lesta:', razErr.message);
            });
        }
        if (blitzModule) blitzModule.syncBlitzMedalsFromLesta();
    }
});
const prolongateLestaToken = lestaSyncModule.prolongateLestaToken;
const getLestaPlayerStats = lestaSyncModule.getLestaPlayerStats;
const applyLestaStats = lestaSyncModule.applyLestaStats;
const startLestaAutoSync = lestaSyncModule.startLestaAutoSync;
const stopLestaAutoSync = lestaSyncModule.stopLestaAutoSync;

// Webhook для DonatePay
// Тело уже распарсено глобальным express.json; сырые байты для подписи — в req.rawBody
// Намеренно отключено (2026-07-03): поллинг newTransactions — единственный источник
// DonatePay, как в MiniChat. Роут оставлен, чтобы не отдавать 404 на случай, если
// URL всё ещё указан в личном кабинете DonatePay, но донаты больше не обрабатывает —
// это устраняет третий параллельный путь наряду с поллингом и Centrifugo.
app.post('/webhook/donatepay', (req, res) => {
    res.json({ success: true });
});

// Опрос DonationAlerts и DonatePay
function startPollingDonationAlerts() {
    if (!DONATION_POLLING_ENABLED) {
        return;
    }
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
    if (nextPollTimeout) {
        clearTimeout(nextPollTimeout);
        nextPollTimeout = null;
    }

    console.log('🔄 Запуск опроса DonationAlerts и DonatePay...');
    firstPollDone = false;
    
    // Загружаем все ID донатов из базы данных при старте, чтобы не обрабатывать их повторно
    loadProcessedDonationIds(() => {
        firstPollDone = true;
        scheduleNextPoll(MIN_POLL_MS);
    });
    
    pollingInterval = setInterval(() => {
        if (!isPollingInProgress) {
            checkForNewDonations();
        }
        checkDiscountExpiration();
    }, 8000);
}

function checkDiscountExpiration() {
    const state = appStateStore.getCachedState();
    if (!state) return;
    const now = Math.floor(Date.now() / 1000);
    const discountUntil = state.timer_discount_until_ts || 0;
    if (state.timer_discount > 0 && discountUntil > 0 && now >= discountUntil) {
        updateAppState({
            timer_discount: 0,
            timer_discount_until_ts: 0
        });
    }
}

function scheduleNextPoll(delay) {
    const safeDelay = Math.min(Math.max(delay || pollDelayMs, MIN_POLL_MS), MAX_POLL_MS);
    pollDelayMs = safeDelay;
    if (nextPollTimeout) clearTimeout(nextPollTimeout);
    nextPollTimeout = setTimeout(checkForNewDonations, safeDelay);
}

// Загрузка всех ID донатов из базы данных при старте
function loadProcessedDonationIds(callback) {
    console.log('📋 Загрузка обработанных донатов из базы данных...');
    db.all('SELECT id FROM donations ORDER BY created_at DESC LIMIT 1000', (err, rows) => {
        if (err) {
            console.error('❌ Ошибка загрузки донатов из БД:', err);
            if (callback) callback();
            return;
        }
        
        const count = rows ? rows.length : 0;
        processedDonationIds.clear();
        
        if (rows && rows.length > 0) {
            rows.forEach(row => {
                if (row.id) {
                    processedDonationIds.add(row.id.toString());
                }
            });
            console.log(`✅ Загружено ${count} ID донатов из базы данных (будут пропущены при первом опросе)`);
        } else {
            console.log('ℹ️ В базе данных нет донатов');
        }
        
        if (callback) callback();
    });
}

// checkDonationExists вынесена в src/modules/donation-platforms

async function checkForNewDonations() {
    if (!DONATION_POLLING_ENABLED) {
        return;
    }
    if (!DA_CONFIG.accessToken && !DP_CONFIG.apiKey) {
        console.log('⏳ Ожидание настройки DonationAlerts или DonatePay...');
        scheduleNextPoll(MAX_POLL_MS);
        return;
    }

    if (isPollingInProgress) {
        console.log('⏭️ Предыдущий опрос ещё выполняется, пропуск');
        scheduleNextPoll(pollDelayMs);
        return;
    }

    isPollingInProgress = true;
    try {
        // Если DonatePay настроен, но userId не получен, пытаемся получить (опционально для Centrifugo)
        // ВАЖНО: Основной способ получения донатов - /newTransactions API (как в RutonyChat)
        // Centrifugo используется только как дополнительный источник
        if (DP_CONFIG.apiKey && !DP_CONFIG.userId) {
            const lastError = DP_CONFIG.lastError;
            const now = Date.now();
            const errorTimestamp = lastError?.timestamp || 0;
            const timeSinceError = lastError && lastError.status === 429 ? (now - errorTimestamp) : Infinity;
            
            // Увеличиваем таймаут до 10 минут для более безопасного подхода
            // Используем экспоненциальный backoff: 5 мин -> 10 мин -> 20 мин
            let timeoutMs = 300000; // 5 минут по умолчанию
            if (lastError && lastError.status === 429) {
                // Подсчитываем количество ошибок 429 только если это новая ошибка
                // Проверяем, не была ли уже засчитана эта ошибка
                const lastErrorTimestamp = lastError.timestamp || 0;
                const lastCountedErrorTimestamp = DP_CONFIG._last429ErrorTimestamp || 0;
                
                // Если это новая ошибка (новый timestamp), увеличиваем счетчик
                if (lastErrorTimestamp !== lastCountedErrorTimestamp) {
                    const errorCount = (DP_CONFIG._429ErrorCount || 0) + 1;
                    DP_CONFIG._429ErrorCount = errorCount;
                    DP_CONFIG._last429ErrorTimestamp = lastErrorTimestamp;
                    // Экспоненциальный backoff: 5, 10, 20 минут
                    timeoutMs = Math.min(300000 * Math.pow(2, errorCount - 1), 1200000); // Максимум 20 минут
                    console.log(`⏱️ Новая ошибка 429 #${errorCount}, таймаут увеличен до ${timeoutMs / 60000} минут`);
                } else {
                    // Используем уже установленный таймаут для этой ошибки
                    const errorCount = DP_CONFIG._429ErrorCount || 1;
                    timeoutMs = Math.min(300000 * Math.pow(2, errorCount - 1), 1200000);
                }
            }
            
            // Детальное логирование для отладки
            if (lastError && lastError.status === 429) {
                const secondsSinceError = Math.floor(timeSinceError / 1000);
                const minutesSinceError = Math.floor(secondsSinceError / 60);
                const secondsRemaining = Math.floor((timeoutMs - timeSinceError) / 1000);
                const minutesRemaining = Math.ceil(secondsRemaining / 60);
                
                console.log(`⏱️ Статус ошибки 429: прошло ${minutesSinceError} мин ${secondsSinceError % 60} сек`);
                console.log(`⏱️ Осталось ждать: ${minutesRemaining} мин ${secondsRemaining % 60} сек`);
                console.log(`💡 Используйте кнопку "🔄 СБРОСИТЬ ОШИБКУ 429" в админке для немедленного сброса`);
            }
            
            // Пытаемся получить информацию о пользователе только если не было ошибки 429 недавно
            // И только если прошло достаточно времени с последней попытки (минимум 1 минута между попытками)
            const lastAttempt = DP_CONFIG.lastUserInfoRequest || 0;
            const minIntervalBetweenAttempts = 60000; // 1 минута между попытками
            const canAttempt = (now - lastAttempt) >= minIntervalBetweenAttempts;
            
            if ((!lastError || lastError.status !== 429 || timeSinceError > timeoutMs) && canAttempt) {
                if (timeSinceError > timeoutMs && lastError && lastError.status === 429) {
                    console.log('✅ Таймаут ошибки 429 истек, пробуем получить userId снова');
                    DP_CONFIG.lastError = null;
                    DP_CONFIG._429ErrorCount = 0; // Сбрасываем счетчик ошибок
                    DP_CONFIG._last429ErrorTimestamp = null; // Сбрасываем timestamp последней ошибки
                    // Очищаем время ошибки в БД
                    updateAppState({
                        dp_last_429_error_ts: null
                    }, (err) => {
                        if (err) {
                            console.error('❌ Ошибка очистки времени ошибки 429:', err);
                        } else {
                            console.log('✅ Время ошибки 429 очищено из БД');
                        }
                    });
                }
                DP_CONFIG.lastUserInfoRequest = now; // Сохраняем время попытки
                console.log('🔄 Попытка получить информацию о пользователе DonatePay (только для Centrifugo)...');
                console.log('⏳ Это может занять несколько секунд...');
                const userInfo = await getDonatePayUser();
                if (userInfo && DP_CONFIG.userId && !donationPlatformsModule.isCentrifugoConnected()) {
                    // Подключаемся к Centrifugo если еще не подключены
                    console.log('📡 Подключение к Centrifugo для real-time уведомлений DonatePay...');
                    await connectDonatePayCentrifugo();
                }
            } else if (!canAttempt) {
                const secondsUntilNextAttempt = Math.ceil((minIntervalBetweenAttempts - (now - lastAttempt)) / 1000);
                console.log(`⏸️ Слишком рано для повторной попытки получения userId (осталось: ${secondsUntilNextAttempt} сек)`);
            } else {
                const minutesLeft = Math.ceil((timeoutMs - timeSinceError) / 60000);
                const secondsLeft = Math.ceil((timeoutMs - timeSinceError) / 1000) % 60;
                console.log(`⏸️ Пропуск получения userId из-за недавней ошибки 429 (осталось ждать: ~${minutesLeft} мин ${secondsLeft} сек)`);
                console.log(`💡 Centrifugo будет подключен автоматически после получения userId`);
                console.log(`💡 Используйте кнопку "🔄 СБРОСИТЬ ОШИБКУ 429" в админке для немедленного сброса`);
            }
        }
        
        // Проверяем статус Centrifugo подключения
        if (DP_CONFIG.apiKey && DP_CONFIG.userId) {
            if (!donationPlatformsModule.isCentrifugoConnected()) {
                console.log('⚠️ Centrifugo не подключен, но userId есть. Пытаемся подключиться...');
                await connectDonatePayCentrifugo();
            } else {
                // Проверяем состояние подключения (если есть метод state)
                try {
                    const state = donationPlatformsModule.getCentrifugoState();
                    if (state === 'disconnected' || state === 'closed') {
                        console.log('⚠️ Centrifugo отключен, пытаемся переподключиться...');
                        await connectDonatePayCentrifugo();
                    } else if (state === 'connected') {
                        // Все хорошо, подключение активно
                        // console.log('✅ Centrifugo подключен и активен');
                    }
                } catch (e) {
                    // Если нет свойства state, просто проверяем наличие объекта
                    // console.log('✅ Centrifugo объект существует');
                }
            }
        } else if (DP_CONFIG.apiKey && !DP_CONFIG.userId) {
            console.log('⏳ Ожидание получения userId для подключения к Centrifugo...');
            console.log('💡 После получения userId донаты будут приходить в real-time через Centrifugo');
        }
        
        // Получаем донаты из всех источников
        // DonatePay: используем ТОЛЬКО /newTransactions API (как в RutonyChat)
        // Приоритетная проверка DonatePay для быстрого получения донатов
        const dpNewTransactionsPromise = DP_CONFIG.apiKey ? getDonatePayNewTransactions() : Promise.resolve([]);
        const daDonationsPromise = DA_CONFIG.accessToken ? getDonationsFromAPI() : Promise.resolve([]);
        
        // Сначала проверяем DonatePay (приоритет), затем DonationAlerts
        const dpNewTransactions = await dpNewTransactionsPromise;
        const daDonations = await daDonationsPromise;
        
        // DonatePay донаты из /newTransactions API
        const dpDonations = dpNewTransactions || [];
        
        // Логируем количество донатов из каждого источника
        const centrifugoStatus = donationPlatformsModule.isCentrifugoConnected() ?
            (donationPlatformsModule.getCentrifugoState() === 'connected' ? '✅ Подключен' : `⚠️ ${donationPlatformsModule.getCentrifugoState() || 'Не подключен'}`) :
            '❌ Не инициализирован';
        
        const allDonations = [...daDonations, ...dpDonations];
        pollLog(`Poll: DA=${daDonations.length} DP=${dpDonations.length} centrifugo=${centrifugoStatus}`);
        
        if (allDonations.length > 0) {
            // Фильтруем донаты по времени - обрабатываем только за последние 2 дня
            const now = Date.now();
            const maxAgeMs = 2 * 24 * 60 * 60 * 1000; // 2 дня в миллисекундах
            let skippedOldCount = 0;
            let skippedProcessedCount = 0;
            let skippedByTimeCount = 0;
            
            for (let i = allDonations.length - 1; i >= 0; i--) {
                const donation = allDonations[i];
                const verdict = classifyDonationForPolling(donation, {
                    processedIds: processedDonationIds,
                    lastSeenDonationId,
                    nowMs: now,
                    maxAgeMs
                });
                const donationId = verdict.donationId;
                const isNumericId = verdict.isNumericId;

                if (verdict.action === 'skip_old_by_time') {
                    skippedByTimeCount++;
                    continue;
                }
                if (verdict.action === 'skip_already_processed') {
                    skippedProcessedCount++;
                    continue;
                }
                if (verdict.action === 'skip_old_by_id') {
                    skippedOldCount++;
                    continue;
                }

                console.log(`💰 Новый донат: ${donation.username} — ${donation.amount}${donation.currency || '₽'} (${donation.platform || 'unknown'}, ID ${donationId})`);

                processDonation({
                    id: donationId,
                    username: donation.username,
                    amount: parseFloat(donation.amount),
                    message: donation.message || '',
                    currency: donation.currency || 'RUB',
                    created_at: donation.created_at,
                    platform: donation.platform || 'unknown'
                }, true);
                
                processedDonationIds.add(donationId);
                
                // Для DonatePay донатов - немедленная проверка новых донатов для ускорения
                if (donation.platform === 'donatepay') {
                    setTimeout(() => {
                        if (!isPollingInProgress) {
                            console.log('⚡ Немедленная проверка новых DonatePay донатов после обработки...');
                            checkForNewDonations();
                        }
                    }, 500); // Проверка через 0.5 секунды после обработки доната
                }
                
                // Обновляем lastSeenDonationId только для числовых ID
                if (isNumericId && (!lastSeenDonationId || parseInt(donationId) > parseInt(lastSeenDonationId))) {
                    lastSeenDonationId = donationId;
                }
                
                if (processedDonationIds.size > 100) {
                    const first = processedDonationIds.values().next().value;
                    processedDonationIds.delete(first);
                }
            }
            
            // Логируем статистику пропущенных донатов (только если есть что пропускать)
            pollLog(`Skipped donations: old=${skippedByTimeCount} processed=${skippedProcessedCount} id=${skippedOldCount}`);

            // Сохраняем последний увиденный ID
            if (lastSeenDonationId) {
                getAppState((state) => {
                    if (state) {
                        updateAppState({ last_donation_id: lastSeenDonationId }, () => {});
                    }
                });
            }
        }
        // успешный опрос — уменьшим задержку до базовой
        scheduleNextPoll(5000);
    } catch (error) {
        const status = error.response?.status;
        if (status === 429) {
            // Превышен лимит запросов - увеличиваем интервал значительно
            console.warn('⚠️ Превышен лимит запросов API. Увеличиваем интервал опроса до 60 секунд.');
            scheduleNextPoll(60000); // 60 секунд при rate limit
        } else {
            console.error('❌ Ошибка опроса донатных платформ:', error.message);
            // экспоненциальный бекофф с ограничением
            const next = Math.min(pollDelayMs * 2, MAX_POLL_MS);
            scheduleNextPoll(next);
        }
    } finally {
        isPollingInProgress = false;
        if (!firstPollDone) firstPollDone = true;
    }
}

// Принудительная проверка новых донатов
async function forceCheckDonations() {
    console.log('🔄 Принудительная проверка донатов...');
    if (!isPollingInProgress) {
        await checkForNewDonations();
    } else {
        console.log('⏭️ Опрос уже выполняется, пропуск принудительной проверки');
    }
}

// Функция для автообновления статистики фрагов
async function autoRefreshFragStats() {
    console.log('🔄 Автообновление статистики фрагов...');
    
    try {
        // Получаем текущее состояние
        db.get('SELECT * FROM app_state WHERE id = 1', async (err, state) => {
            if (err) {
                console.error('❌ Ошибка получения состояния:', err);
                return;
            }
            
            if (!state) {
                console.log('⚠️ Нет состояния для автообновления');
                return;
            }
            
            // Проверяем Lesta Games если настроено
            if (state.lesta_account_id && state.lesta_application_id) {
                try {
                    // Запускаем синхронизацию Lesta Games
                    const stats = await getLestaPlayerStats();
                    if (stats) {
                        console.log('✅ Синхронизация Lesta Games выполнена');
                    }
                } catch (error) {
                    console.error('❌ Ошибка синхронизации Lesta Games:', error);
                }
            }
            
            // Проверяем донаты если настроено
            if (state.da_access_token) {
                forceCheckDonations();
            }
            
            console.log('✅ Автообновление статистики запущено');
        });
    } catch (error) {
        console.error('❌ Ошибка автообновления статистики:', error);
    }
}

// Запуск автообновления каждые 30 секунд
let autoRefreshInterval = null;

function startAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
    }
    
    console.log('🚀 Запуск автообновления статистики каждые 30 секунд');
    autoRefreshInterval = setInterval(autoRefreshFragStats, 30000); // 30 секунд
}

function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        console.log('⏹️ Автообновление статистики остановлено');
    }
}

// Функция обновления цели сбора донатов
function updateDonationGoal(donation) {
    db.get('SELECT * FROM donation_goals WHERE id = 1', (err, goal) => {
        if (err) {
            console.error('❌ Ошибка получения цели сбора:', err);
            return;
        }
        
        if (!goal) {
            console.log('⚠️ Цель сбора не найдена, пропускаем обновление');
            return;
        }
        
        const newCurrentAmount = goal.current_amount + donation.amount;
        const newTotalDonations = goal.total_donations + 1;
        const newAvgDonation = newCurrentAmount / newTotalDonations;
        
        // Обновляем цель
        db.run(`UPDATE donation_goals SET 
            current_amount = ?, 
            total_donations = ?, 
            avg_donation = ?, 
            last_donation_time = ?,
            updated_at = ?
            WHERE id = 1`, 
            [newCurrentAmount, newTotalDonations, newAvgDonation, 
             new Date().toISOString(), new Date().toISOString()], 
            function(err) {
                if (err) {
                    console.error('❌ Ошибка обновления цели сбора:', err);
                    return;
                }
                
                // Добавляем запись о донате
                db.run(`INSERT INTO goal_donations (goal_id, amount, username, message, is_manual) 
                        VALUES (1, ?, ?, ?, 0)`, 
                        [donation.amount, donation.username, donation.message || ''], (err) => {
                    if (err) {
                        console.error('❌ Ошибка добавления доната в цель:', err);
                    } else {
                        console.log(`💰 Цель сбора обновлена: ${donation.username} добавил ${donation.amount}₽`);
                    }
                });

                db.get('SELECT * FROM donation_goals WHERE id = 1', (goalErr, updatedGoal) => {
                    if (goalErr || !updatedGoal) {
                        if (goalErr) console.warn('⚠️ Не удалось получить goal для broadcast:', goalErr.message);
                        return;
                    }
                    persistDonationGoalSnapshot('donation', updatedGoal);
                    broadcastDonationWidgetState(updatedGoal, null);
                });
            }
        );
    });
}

// Функция обновления полоски сбора донатов
function updateDonationBar(donation) {
    db.get('SELECT * FROM donation_bars WHERE id = 1', (err, row) => {
        if (err) {
            console.error('❌ Ошибка получения полоски:', err);
            return;
        }
        
        if (!row) {
            // Создаем новую полоску если не существует
            db.run(`INSERT INTO donation_bars (id, current_amount) VALUES (1, ?)`, 
                    [donation.amount], (err) => {
                if (err) {
                    console.error('❌ Ошибка создания полоски:', err);
                    return;
                }
                
                db.get('SELECT * FROM donation_bars WHERE id = 1', (barErr, updatedBar) => {
                    if (barErr || !updatedBar) return;
                    broadcastDonationWidgetState(null, updatedBar);
                });
            });
        } else {
            const newAmount = row.current_amount + donation.amount;
            
            db.run(`UPDATE donation_bars SET current_amount = ?, updated_at = ? WHERE id = 1`, 
                    [newAmount, new Date().toISOString()], (err) => {
                if (err) {
                    console.error('❌ Ошибка обновления полоски:', err);
                    return;
                }
                
                db.get('SELECT * FROM donation_bars WHERE id = 1', (barErr, updatedBar) => {
                    if (barErr || !updatedBar) return;
                    broadcastDonationWidgetState(null, updatedBar);
                });
            });
        }
    });
}

// Обновление виджета «параметр от донатов» при каждом донате
function updateDonationDrivenWidgets(amount) {
    if (!amount || amount <= 0) return;
    db.all('SELECT * FROM donation_driven_widgets WHERE enabled = 1', (err, rows) => {
        if (err) {
            console.error('❌ Ошибка чтения donation_driven_widgets:', err);
            return;
        }
        if (!rows || rows.length === 0) return;
        rows.forEach((row) => {
            const perAmount = parseFloat(row.per_amount) || 100;
            const addValue = parseFloat(row.add_value) || 0.1;
            const cap = parseFloat(row.cap_value);
            if (perAmount <= 0) return;
            const increment = (amount / perAmount) * addValue;
            const current = parseFloat(row.current_value) || parseFloat(row.start_value);
            let newValue = current + increment;
            if (cap != null && !isNaN(cap)) newValue = Math.min(newValue, cap);
            newValue = Math.round(newValue * 1e6) / 1e6;
            db.run(
                'UPDATE donation_driven_widgets SET current_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [newValue, row.id],
                (updateErr) => {
                    if (updateErr) {
                        console.error('❌ Ошибка обновления donation_driven_widget:', updateErr);
                        return;
                    }
                    db.get('SELECT * FROM donation_driven_widgets WHERE id = ?', [row.id], (e, updated) => {
                        if (!e && updated) {
                            broadcastDonationDrivenWidgetUpdate(updated);
                        }
                    });
                }
            );
        });
    });
}

// Функция обработки донатов
// Единый дедуп для ВСЕХ входов (опрос DA/DP, Centrifugo, webhook, ручной/тест):
// синхронная отметка в processedDonationIds закрывает гонку двух путей в один тик,
// проверка по таблице donations — авторитет между рестартами и после чистки Set'а.
function processDonation(donationData, isRealtime = false) {
    const donationKey = donationData && donationData.id != null ? String(donationData.id) : null;
    if (!donationKey) {
        console.warn('⚠️ processDonation: донат без id, пропуск', donationData);
        return;
    }
    if (processedDonationIds.has(donationKey)) {
        pollLog('processDonation: дубль (память), пропуск', donationKey);
        return;
    }
    processedDonationIds.add(donationKey);
    if (processedDonationIds.size > 500) {
        const first = processedDonationIds.values().next().value;
        processedDonationIds.delete(first);
    }
    db.get('SELECT id FROM donations WHERE id = ?', [donationKey], (dupErr, existing) => {
        if (dupErr) {
            console.warn('⚠️ Дедуп-проверка по БД не удалась, продолжаем обработку:', dupErr.message);
        } else if (existing) {
            console.log(`⏭️ Донат ${donationKey} уже в БД — пропуск повторной обработки`);
            return;
        }
        processDonationCore(donationData, isRealtime);
    });
}

function processDonationCore(donationData, isRealtime = false) {
    pollLog('processDonation', isRealtime ? 'RT' : 'poll', donationData.id, donationData.username);

    getAppState((state) => {
        if (!state) {
            console.error('❌ STATE NOT FOUND for donation processing');
            return;
        }
        
        const amount = donationData.amount;
        const username = donationData.username;
        const message = donationData.message;
        const currentMode = state.current_mode || 'mode1';
        
        console.log(`🎉 Обработка доната: ${username} - ${amount}₽ в режиме ${currentMode}`);
        
        let donation = {
            id: donationData.id,
            username: username,
            amount: amount,
            message: message,
            currency: donationData.currency || 'RUB',
            isRealtime: isRealtime,
            timestamp: new Date().toLocaleTimeString('ru-RU')
        };
        
        let updatedState = {};
        let alertData = { ...donation };
        
        // ВАЖНО: Обрабатываем донат для ВСЕХ режимов одновременно!
        
        // Режим 1: Frag Tracker
        const fragCostPerUnit = state.frag_cost / state.frag_amount;
        const currentBalance = state.current_balance || 0;
        const totalAmount = currentBalance + amount;
        
        const fragUnitsEarned = Math.floor(totalAmount / fragCostPerUnit);
        const fragRemainingBalance = totalAmount % fragCostPerUnit;
        
        console.log(`💰 Расчет фрагов: (${currentBalance} + ${amount}) / ${fragCostPerUnit} = ${fragUnitsEarned} ${state.frag_name}, остаток: ${fragRemainingBalance}`);
        
        updatedState.current_balance = fragRemainingBalance;
        const oldTotalDonated = state.total_donated || 0;
        updatedState.total_donated = oldTotalDonated + amount;
        console.log(`💰 Обновление total_donated: ${oldTotalDonated} + ${amount} = ${updatedState.total_donated}`);
        
        // Нагрев от доната в режиме температуры
        heatFromDonation(amount);
        
        if (fragUnitsEarned > 0) {
            updatedState.frags_needed = (state.frags_needed || 0) + fragUnitsEarned;
            // Не добавляем запись боя/фрагов в frag_stats от доната, чтобы избежать фантомных боев
            console.log(`📊 Начислено ${fragUnitsEarned} фрагов от доната (без записи боя в frag_stats)`);
        }
        
        donation.fragsEarned = fragUnitsEarned;
        
        // Логика отображения в алерте
        if (fragUnitsEarned > 0) {
            // Если донат закрывает полоску до фрага - показываем количество фрагов
            alertData.fragsEarned = fragUnitsEarned;
            alertData.fragUnitName = state.frag_name;
            alertData.fragDisplayType = 'frags'; // Тип отображения: фраги
        } else {
            // Если донат не закрывает полоску - показываем "Добавил до +1 фрага"
            alertData.fragsEarned = 0;
            alertData.fragUnitName = state.frag_name;
            alertData.fragDisplayType = 'amount'; // Тип отображения: сумма
        }
        
        // Режим 2: Timer
        const baseCostPerMinute = state.cost_per_minute || 50;
        // Проверяем, активна ли скидка и не истекла ли она
        const now = Math.floor(Date.now() / 1000);
        const discountUntil = state.timer_discount_until_ts || 0;
        let discount = 0;
        if (state.timer_discount && state.timer_discount > 0) {
            if (discountUntil === 0 || now < discountUntil) {
                discount = state.timer_discount;
            } else {
                // Скидка истекла, отключаем её
                updatedState.timer_discount = 0;
                updatedState.timer_discount_until_ts = 0;
            }
        }
        const actualCostPerMinute = Math.max(1, baseCostPerMinute - discount);
        const secondsPerRuble = 60 / actualCostPerMinute;
        const timeEarned = Math.floor(amount * secondsPerRuble);
        
        console.log(`⏰ Расчет времени: ${amount}₽ × ${secondsPerRuble.toFixed(2)}сек/₽ = ${timeEarned}сек (Цена: ${actualCostPerMinute}₽/мин, скидка: ${discount}₽)`);
        
        // ВАЖНО: Используем атомарное обновление SQL для предотвращения гонки условий
        // Вместо чтения и записи используем UPDATE с инкрементом прямо в SQL
        // Это гарантирует, что время будет добавлено даже если таймер обновляется параллельно
        const currentTimerSeconds = state.timer_seconds || 0;
        const newTimerSeconds = currentTimerSeconds + timeEarned;
        
        // Используем специальный флаг для атомарного инкремента
        // Это гарантирует, что время будет добавлено даже если таймер обновляется параллельно (например, функцией updateTimer)
        updatedState._timer_seconds_increment = timeEarned;
        // Также сохраняем новое значение для логирования и других целей
        updatedState.timer_seconds = newTimerSeconds;
        
        console.log(`⏰ Обновление таймера: ${currentTimerSeconds} + ${timeEarned} = ${newTimerSeconds} сек (будет применено атомарно через SQL инкремент)`);
        console.log(`⏰ Флаг атомарного обновления установлен: _timer_seconds_increment = ${timeEarned}`);
        
        donation.timeEarned = timeEarned;
        alertData.timeEarned = timeEarned;
        alertData.timeFormatted = formatTimeDetailed(timeEarned);
        alertData.actualCostPerMinute = actualCostPerMinute;
        
        // Рулетка и прочие побочные потребители — подписчики donationBus (см. ниже по файлу)

        // Режим 3: Custom Tracker
        const customCostPerUnit = state.custom_unit_cost / state.custom_unit_amount;
        const customCurrentBalance = state.custom_current_balance || 0;
        const customTotalAmount = customCurrentBalance + amount;
        
        const customUnitsEarned = Math.floor(customTotalAmount / customCostPerUnit);
        const customRemainingBalance = customTotalAmount % customCostPerUnit;
        
        console.log(`🎯 Расчет кастомных единиц: (${customCurrentBalance} + ${amount}) / ${customCostPerUnit} = ${customUnitsEarned} ${state.custom_goal_name}, остаток: ${customRemainingBalance}`);
        
        updatedState.custom_current_balance = customRemainingBalance;
        
        if (customUnitsEarned > 0) {
            updatedState.custom_units_needed = (state.custom_units_needed || 0) + customUnitsEarned;
        }
        
        donation.customUnitsEarned = customUnitsEarned;
        alertData.customUnitsEarned = customUnitsEarned;
        alertData.customUnitName = state.custom_goal_name;
        
        // Сохраняем донат (не блокируем последующую логику при ошибке)
        saveDonation(donation, (err) => {
            if (err) {
                console.error('❌ Ошибка сохранения доната (продолжаем обработку):', err);
            }
            
            // Побочные потребители доната (аналитика, виджеты сбора, рулетка,
            // Blitz Challenge, ачивки) — подписчики donationBus. emit синхронный,
            // порядок и изоляция ошибок те же, что были у прямых вызовов.
            donationBus.emit({ donation, state, fragUnitsEarned, timeEarned, customUnitsEarned });

            // Получаем достижение донатера для отображения в алерте
            const normalizedUsername = normalizeUsername(username);
            const getDonorAchievement = (callback) => {
                if (!normalizedUsername || timeEarned <= 0) {
                    callback(null);
                    return;
                }
                // Получаем достижение после обновления
                db.get(`SELECT da.*, dat.icon as tier_icon, dat.color as tier_color, dat.name as tier_name, dat.custom_icon_url as tier_custom_icon_url
                        FROM donor_achievements da
                        LEFT JOIN donor_achievement_tiers dat ON da.current_tier_id = dat.id
                        WHERE da.normalized_username = ?`, [normalizedUsername], (err, achievement) => {
                    if (err || !achievement) {
                        callback(null);
                        return;
                    }
                    // Если tier_name не найден, возвращаем null вместо дефолтного "Новичок"
                    callback({
                        icon: achievement.tier_icon || '🏆',
                        color: achievement.tier_color || '#00f0ff',
                        name: achievement.tier_name || null, // Не используем дефолтное значение
                        custom_icon_url: achievement.tier_custom_icon_url || null
                    });
                });
            };
            
            // Обновляем состояние
            console.log(`🔄 Вызов updateAppState с обновлениями:`, {
                timer_seconds_increment: updatedState._timer_seconds_increment,
                timer_seconds: updatedState.timer_seconds,
                total_donated: updatedState.total_donated
            });
            
            updateAppState(updatedState, (err) => {
                if (err) {
                    console.error('❌ Ошибка обновления состояния:', err);
                    console.error('   Это может привести к потере времени в таймере!');
                    return;
                }
                
                console.log(`✅ Донат обработан для всех режимов`);
                console.log(`   🎯 Фраги: +${fragUnitsEarned} ${state.frag_name}, остаток: ${fragRemainingBalance}₽`);
                console.log(`   ⏰ Время: +${timeEarned} сек (должно быть добавлено в таймер)`);
                console.log(`   🎨 Кастом: +${customUnitsEarned} ${state.custom_goal_name}, остаток: ${customRemainingBalance}₽`);
                
                // Проверяем, что время действительно было добавлено (с небольшой задержкой для завершения транзакции)
                setTimeout(() => {
                    getAppState((updatedStateCheck) => {
                        if (updatedStateCheck) {
                            const actualTimerSeconds = updatedStateCheck.timer_seconds || 0;
                            const expectedTimerSeconds = (state.timer_seconds || 0) + timeEarned;
                            const difference = Math.abs(actualTimerSeconds - expectedTimerSeconds);
                            if (difference > 1) {
                                console.warn(`⚠️ ВНИМАНИЕ: Возможная проблема с обновлением таймера!`);
                                console.warn(`   Ожидалось: ${expectedTimerSeconds} сек, фактически: ${actualTimerSeconds} сек`);
                                console.warn(`   Разница: ${actualTimerSeconds - expectedTimerSeconds} сек`);
                                console.warn(`   Это может быть вызвано параллельным обновлением таймера или ошибкой в БД`);
                            } else {
                                console.log(`✅ Проверка таймера: время корректно обновлено (${actualTimerSeconds} сек, ожидалось ${expectedTimerSeconds} сек)`);
                            }
                        }
                    });
                }, 100);
                
                // Получаем достижение донатера и отправляем алерты
                // Используем небольшую задержку, чтобы дать время БД обновиться после updateDonorAchievement
                setTimeout(() => {
                    getDonorAchievement((donorAchievement) => {
                        // Получаем полное обновленное состояние для отправки
                        getAppState((fullState) => {
                            // Отправляем обновление состояния всем клиентам
                            broadcastStateUpdate(fullState);
                            
                            // Отправляем информацию о новом донате
                            console.log(`📢 Отправка NEW_DONATION через WebSocket: ID=${donation.id}, username=${donation.username}, amount=${donation.amount}₽`);
                            broadcastToClients({
                                type: 'NEW_DONATION',
                                donation: {
                                    ...donation,
                                    donorAchievement: donorAchievement // Добавляем достижение донатера
                                },
                                state: getBroadcastState(fullState)
                            });
                            
                            // Показываем алерты ДЛЯ ВСЕХ режимов независимо от текущего
                            const mode1Alert = {
                                ...alertData,
                                unitName: state.frag_name,
                                unitsEarned: fragUnitsEarned,
                                alertMode: 'mode1',
                                fragDisplayType: alertData.fragDisplayType
                            };
                            const mode2Alert = {
                                ...alertData,
                                unitName: 'времени',
                                unitsEarned: timeEarned,
                                alertMode: 'mode2',
                                donorAchievement: donorAchievement
                            };
                            const mode3Alert = {
                                ...alertData,
                                unitName: state.custom_goal_name,
                                unitsEarned: customUnitsEarned,
                                alertMode: 'mode3'
                            };

                            console.log('🚨 Отправка алертов для всех режимов:', {
                                mode1: { units: fragUnitsEarned },
                                mode2: { seconds: timeEarned, achievement: donorAchievement },
                                mode3: { units: customUnitsEarned }
                            });
                            broadcastToClients({ type: 'SHOW_ALERT', donation: mode1Alert });
                            broadcastToClients({ type: 'SHOW_ALERT', donation: mode2Alert });
                            broadcastToClients({ type: 'SHOW_ALERT', donation: mode3Alert });
                        });
                    });
                }, 100);
            });
        });
    });
}

// Форматирование времени для алертов
function formatTimeDetailed(seconds) {
    if (seconds < 60) {
        return `${seconds} сек`;
    } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return secs > 0 ? `${minutes}:${secs.toString().padStart(2, '0')} мин` : `${minutes} мин`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return minutes > 0 ? `${hours}:${minutes.toString().padStart(2, '0')} ч` : `${hours} ч`;
    }
}

// Broadcast состояние всем клиентам
function broadcastStateUpdate(fullState) {
    // Если fullState не передан, получаем его из базы данных
    if (!fullState) {
        dbRead.get('SELECT * FROM app_state WHERE id = 1', (err, state) => {
            if (err) {
                console.error('❌ Ошибка получения состояния для broadcast:', err);
                return;
            }
            if (state) {
                const broadcastState = getBroadcastState(state);
                if (process.env.DEBUG_STATE === '1') {
                    console.log('📢 Broadcast STATE_UPDATE to', wss.clients.size, 'clients');
                }
                broadcastToClients({
                    type: 'STATE_UPDATE',
                    state: broadcastState
                });
                // Дополнительно шлем специализированное событие для алерт-страниц
                broadcastToClients({
                    type: 'SET_ALERT_OPACITY',
                    opacity: broadcastState.widget_bg_opacity || 0.95
                });
            }
        });
        return;
    }
    
    const broadcastState = getBroadcastState(fullState);
    if (process.env.DEBUG_STATE === '1') {
        console.log('📢 Broadcast STATE_UPDATE to', wss.clients.size, 'clients');
    }
    broadcastToClients({
        type: 'STATE_UPDATE',
        state: broadcastState
    });
    // Дополнительно шлем специализированное событие для алерт-страниц
    broadcastToClients({
        type: 'SET_ALERT_OPACITY',
        opacity: broadcastState.widget_bg_opacity || 0.95
    });
}

function getBroadcastState(fullState) {
    // Если fullState не передан, получаем состояние из базы данных
    if (!fullState) {
        return null; // Возвращаем null, чтобы broadcastStateUpdate мог получить состояние из БД
    }
    
    // Вычисляем актуальное прошедшее время для таймера стрима
    const now = Math.floor(Date.now() / 1000);
    let currentStreamElapsedSec = fullState.stream_timer_initial_elapsed_sec || 0;
    if (fullState.stream_timer_last_update_ts && fullState.stream_timer_last_update_ts > 0) {
        const elapsedSinceLastUpdate = now - fullState.stream_timer_last_update_ts;
        currentStreamElapsedSec += Math.max(0, elapsedSinceLastUpdate);
    } else if (fullState.stream_timer_started_ts && fullState.stream_timer_started_ts > 0) {
        const elapsedSinceStart = now - fullState.stream_timer_started_ts;
        currentStreamElapsedSec += Math.max(0, elapsedSinceStart);
    }
    
    return {
        current_mode: fullState.current_mode,
        // Mode 1: Frag Tracker
        frags_needed: fullState.frags_needed,
        frags_done: fullState.frags_done,
        current_balance: fullState.current_balance,
        total_donated: fullState.total_donated,
        frag_cost: fullState.frag_cost,
        frag_amount: fullState.frag_amount,
        frag_name: fullState.frag_name,
        // Stream timer initial elapsed seconds (for widget) - вычисляем актуальное время
        stream_timer_initial_elapsed_sec: currentStreamElapsedSec,
        stream_timer_last_update_ts: fullState.stream_timer_last_update_ts,
        stream_timer_started_ts: fullState.stream_timer_started_ts,
        widget_left_label: fullState.widget_left_label,
        widget_right_label: fullState.widget_right_label,
        widget_progress_label: fullState.widget_progress_label,
        widget_bg_opacity: fullState.widget_bg_opacity,
        widget_cost_font_size: fullState.widget_cost_font_size,
        widget_opacity: fullState.widget_opacity,
        widget_background_blur: fullState.widget_background_blur,
        external_stats_url: fullState.external_stats_url,
        external_auto_sync: fullState.external_auto_sync,
        external_last_battles: fullState.external_last_battles,
        external_last_frag_per_battle: fullState.external_last_frag_per_battle,
        external_last_calc_frags: fullState.external_last_calc_frags,
        // Mode 2: Timer
        timer_seconds: fullState.timer_seconds,
        timer_paused: fullState.timer_paused,
        cost_per_minute: fullState.cost_per_minute,
        timer_discount: fullState.timer_discount,
        timer_discount_until_ts: fullState.timer_discount_until_ts,
        timer_alert_text: fullState.timer_alert_text,
        // Mode 2: Slowdown
        timer_slowdown_active: fullState.timer_slowdown_active,
        timer_slowdown_factor: fullState.timer_slowdown_factor,
        timer_slowdown_until_ts: fullState.timer_slowdown_until_ts,
        timer_manual_time_added: fullState.timer_manual_time_added || 0,
        // Mode 3: Custom Tracker
        custom_goal_name: fullState.custom_goal_name,
        custom_units_needed: fullState.custom_units_needed,
        custom_units_done: fullState.custom_units_done,
        custom_current_balance: fullState.custom_current_balance,
        custom_unit_cost: fullState.custom_unit_cost,
        custom_unit_amount: fullState.custom_unit_amount,
        custom_widget_left_label: fullState.custom_widget_left_label,
        custom_widget_right_label: fullState.custom_widget_right_label,
        custom_alert_text: fullState.custom_alert_text,
        // Common
        theme_mode1: fullState.theme_mode1,
        theme_mode2: fullState.theme_mode2,
        theme_mode3: fullState.theme_mode3,
        da_access_token: fullState.da_access_token,
        // Lesta Games data
        lesta_nickname: fullState.lesta_nickname,
        lesta_account_id: fullState.lesta_account_id,
        lesta_access_token: fullState.lesta_access_token,
        lesta_auto_sync: fullState.lesta_auto_sync,
        lesta_last_battles: fullState.lesta_last_battles,
        lesta_last_frags: fullState.lesta_last_frags,
        lesta_last_wins: fullState.lesta_last_wins,
        lesta_last_losses: fullState.lesta_last_losses,
        lesta_last_win_rate: fullState.lesta_last_win_rate,
        lesta_last_frags_per_battle: fullState.lesta_last_frags_per_battle,
        lesta_last_damage_dealt: fullState.lesta_last_damage_dealt,
        lesta_last_damage_received: fullState.lesta_last_damage_received,
        lesta_last_xp: fullState.lesta_last_xp,
        lesta_last_max_frags: fullState.lesta_last_max_frags,
        lesta_last_frags8p: fullState.lesta_last_frags8p,
        lesta_last_hits: fullState.lesta_last_hits,
        lesta_last_shots: fullState.lesta_last_shots,
        lesta_last_spotted: fullState.lesta_last_spotted,
        lesta_last_capture_points: fullState.lesta_last_capture_points,
        lesta_last_dropped_capture_points: fullState.lesta_last_dropped_capture_points,
        lesta_last_survived_battles: fullState.lesta_last_survived_battles,
        lesta_last_win_and_survived: fullState.lesta_last_win_and_survived,
        lesta_last_max_xp: fullState.lesta_last_max_xp,
        lesta_previous_frags: fullState.lesta_previous_frags,
        lesta_auto_deduct: fullState.lesta_auto_deduct,
        lesta_last_sync_time: fullState.lesta_last_sync_time
    };
}

// Управление таймером
// API для принудительной проверки донатов
// Диагностика опроса донатов
app.get('/api/diagnose-polling', async (req, res) => {
    try {
        console.log('🔍 Диагностика опроса донатов...');
        
        const diagnosis = {
            timestamp: new Date().toISOString(),
            daConfig: {
                hasToken: !!DA_CONFIG.accessToken,
                tokenPreview: DA_CONFIG.accessToken ? DA_CONFIG.accessToken.substring(0, 20) + '...' : 'НЕТ',
                clientId: DA_CONFIG.clientId,
                hasClientSecret: !!DA_CONFIG.clientSecret,
                apiUrl: DA_CONFIG.apiUrl
            },
            polling: {
                isPollingInProgress: isPollingInProgress,
                pollDelayMs: pollDelayMs,
                hasPollingInterval: !!pollingInterval,
                firstPollDone: firstPollDone,
                lastSeenDonationId: lastSeenDonationId,
                processedDonationIdsCount: processedDonationIds.size
            },
            testResults: {}
        };
        
        // Тест получения донатов
        if (DA_CONFIG.accessToken) {
            try {
                const donations = await getDonationsFromAPI();
                diagnosis.testResults.donationsApi = {
                    success: true,
                    count: donations.length,
                    sample: donations[0] || null
                };
            } catch (error) {
                diagnosis.testResults.donationsApi = {
                    success: false,
                    error: error.message
                };
            }
        } else {
            diagnosis.testResults.donationsApi = {
                success: false,
                error: 'Нет токена доступа'
            };
        }
        
        res.json(diagnosis);
    } catch (error) {
        console.error('❌ Ошибка диагностики опроса:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для управления автообновлением статистики фрагов
app.post('/api/auto-refresh/start', async (req, res) => {
    try {
        console.log('🚀 Запуск автообновления статистики через API...');
        startAutoRefresh();
        res.json({ success: true, message: 'Автообновление статистики запущено' });
    } catch (error) {
        console.error('❌ Ошибка запуска автообновления:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/auto-refresh/stop', async (req, res) => {
    try {
        console.log('⏹️ Остановка автообновления статистики через API...');
        stopAutoRefresh();
        res.json({ success: true, message: 'Автообновление статистики остановлено' });
    } catch (error) {
        console.error('❌ Ошибка остановки автообновления:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/auto-refresh/status', async (req, res) => {
    try {
        const isRunning = autoRefreshInterval !== null;
        res.json({ 
            success: true, 
            isRunning: isRunning,
            message: isRunning ? 'Автообновление активно' : 'Автообновление остановлено'
        });
    } catch (error) {
        console.error('❌ Ошибка получения статуса автообновления:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для принудительного обновления статистики фрагов
app.post('/api/force-refresh-frag-stats', async (req, res) => {
    try {
        console.log('🔄 Принудительное обновление статистики фрагов через API...');
        await autoRefreshFragStats();
        res.json({ success: true, message: 'Статистика фрагов обновлена' });
    } catch (error) {
        console.error('❌ Ошибка принудительного обновления:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для принудительного добавления боя
app.post('/api/add-battle-force', async (req, res) => {
    try {
        console.log('🔨 Принудительное добавление боя через API...');
        
        const { frags = 0, source = 'manual' } = req.body;
        const battleTime = new Date().toISOString();
        
        addBattleForce(battleTime, frags, source);
        
        res.json({ 
            success: true, 
            message: 'Бой принудительно добавлен',
            battle: { battleTime, frags, source }
        });
    } catch (error) {
        console.error('❌ Ошибка принудительного добавления боя:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для синхронизации состояния Lesta Games с локальной статистикой
// /api/sync-lesta-state вынесен в src/modules/lesta-routes

app.post('/api/timer-control', (req, res) => {
    const { action, seconds } = req.body;
    
    console.log('⏰ Управление таймером:', { action, seconds });
    console.log('⏰ Полное тело запроса:', JSON.stringify(req.body, null, 2));
    
    getAppState((state) => {
        if (!state) {
            return res.status(500).json({ error: 'Ошибка состояния' });
        }
        
        let updates = {};
        
        if (action === 'start') {
            updates.timer_paused = 0;
            console.log('▶️ Таймер запущен');
        } else if (action === 'set') {
            const newSeconds = parseInt(seconds) || 0;
            const oldSeconds = state.timer_seconds || 0;
            const isManual = req.body.isManual === true;
            
            updates.timer_seconds = newSeconds;
            
            // Если время увеличилось и это ручное добавление, увеличиваем счетчик
            if (isManual && newSeconds > oldSeconds) {
                const addedSeconds = newSeconds - oldSeconds;
                const currentManualTime = (state.timer_manual_time_added || 0);
                updates.timer_manual_time_added = currentManualTime + addedSeconds;
                console.log(`⏰ Установлено время: ${updates.timer_seconds}сек (добавлено вручную: +${addedSeconds}сек, всего вручную: ${updates.timer_manual_time_added}сек)`);
            } else {
                console.log(`⏰ Установлено время: ${updates.timer_seconds}сек`);
            }
            
            // Обновляем состояние с разрешением на обновление timer_manual_time_added (только если isManual)
            updateAppState(updates, (err) => {
                if (err) {
                    console.error('❌ Ошибка обновления таймера:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }
                
                // Получаем обновленное состояние и отправляем всем клиентам
                getAppState((updatedState) => {
                    if (updatedState) {
                        broadcastStateUpdate(updatedState);
                    }
                    res.json({ success: true, timer_seconds: updates.timer_seconds, timer_manual_time_added: updates.timer_manual_time_added });
                });
            }, isManual); // Разрешаем обновление timer_manual_time_added только если isManual === true
            return; // Выходим, чтобы не выполнять общий updateAppState ниже
        } else if (action === 'pause') {
            updates.timer_paused = 1;
            console.log('⏸️ Таймер на паузе');
        } else if (action === 'resume') {
            updates.timer_paused = 0;
            console.log('▶️ Таймер возобновлен');
        } else if (action === 'reset') {
            updates.timer_seconds = 0;
            updates.timer_paused = 0;
            updates.timer_manual_time_added = 0; // Обнуляем время, добавленное вручную
            console.log('🔄 Таймер сброшен');
            
            // Обновляем состояние с разрешением на обновление timer_manual_time_added (при сбросе)
            updateAppState(updates, (err) => {
                if (err) {
                    console.error('❌ Ошибка сброса таймера:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }
                
                // Получаем обновленное состояние и отправляем всем клиентам
                getAppState((updatedState) => {
                    if (updatedState) {
                        broadcastStateUpdate(updatedState);
                    }
                    res.json({ success: true });
                });
            }, true); // Разрешаем обновление timer_manual_time_added при сбросе
            return; // Выходим, чтобы не выполнять общий updateAppState ниже
        } else if (action === 'slowdown_start') {
            const { factor, duration_seconds } = req.body;
            const slowdownFactor = Math.max(0.1, parseFloat(factor) || 1.0);
            const durationSec = Math.max(1, parseInt(duration_seconds) || 0);
            const untilTs = durationSec > 0 ? Math.floor(Date.now() / 1000) + durationSec : 0;
            updates.timer_slowdown_active = 1;
            updates.timer_slowdown_factor = slowdownFactor;
            updates.timer_slowdown_until_ts = untilTs;
            console.log(`🐢 Замедление таймера: x${slowdownFactor} на ${durationSec} сек (до ${untilTs})`);
        } else if (action === 'slowdown_start_random') {
            // Получаем настройки из запроса или из БД, затем дефолт
            console.log('🎲 Получен запрос slowdown_start_random');
            console.log('🎲 req.body:', JSON.stringify(req.body, null, 2));
            
            getAppState((state) => {
                try {
                    const bodyVariants = Array.isArray(req.body?.variants) ? req.body.variants : null;
                    const bodyDuration = parseInt(req.body?.duration_seconds) || null;
                    const bodyDurationVariants = Array.isArray(req.body?.durationVariants) ? req.body.durationVariants : null;

                    console.log('🎲 Варианты из запроса:', bodyVariants);
                    console.log('🎲 Длительность из запроса:', bodyDuration);

                    let slowdownSettings = null;
                    if (bodyVariants && bodyVariants.length > 0) {
                        slowdownSettings = {
                            randomMode: true,
                            variants: bodyVariants,
                            duration: bodyDuration || 300,
                            durationVariants: bodyDurationVariants || null
                        };
                        console.log('✅ Используем варианты из запроса');
                    } else if (state.slowdown_random_settings) {
                        try {
                            slowdownSettings = JSON.parse(state.slowdown_random_settings);
                            console.log('✅ Используем варианты из БД');
                        } catch (parseError) {
                            console.error('❌ Ошибка парсинга настроек замедления:', parseError);
                        }
                    }
                    
                    // Если настроек нет, используем дефолтные
                    if (!slowdownSettings || !slowdownSettings.variants || slowdownSettings.variants.length === 0) {
                        console.log('⚠️ Настройки рандомного замедления не найдены, используем дефолтные');
                        slowdownSettings = {
                            randomMode: true,
                            variants: [
                                { factor: 1.5, chance: 20 },
                                { factor: 2.0, chance: 30 },
                                { factor: 2.5, chance: 25 },
                                { factor: 3.0, chance: 15 },
                                { factor: 4.0, chance: 10 }
                            ],
                            duration: 300,
                            durationVariants: [
                                { seconds: 180, chance: 20 },
                                { seconds: 300, chance: 30 },
                                { seconds: 420, chance: 25 },
                                { seconds: 600, chance: 15 },
                                { seconds: 900, chance: 10 }
                            ]
                        };
                    }

                    const wsClients = wsHub.getClients();
                    console.log('🎲 Запуск рандомного замедления, клиентов подключено:', wsClients.length);
                    console.log('🎲 Финальные настройки:', JSON.stringify(slowdownSettings, null, 2));

                    // 1) Отправляем окно прокрутки всем виджетам сразу
                    let spinSent = 0;
                    wsClients.forEach((client, index) => {
                        if (client.readyState === WebSocket.OPEN && client.clientType === 'WIDGET') {
                            try {
                                client.send(JSON.stringify({
                                    type: 'SLOWDOWN_START_RANDOM',
                                    variants: slowdownSettings.variants,
                                    duration: slowdownSettings.duration || 300,
                                    durationVariants: Array.isArray(slowdownSettings.durationVariants) ? slowdownSettings.durationVariants : undefined
                                }));
                                spinSent++;
                            } catch (e) {}
                        }
                    });
                    console.log(`🎰 Окно прокрутки отправлено ${spinSent} виджетам`);

                    // 2) Выбираем коэффициент на сервере (по шансам)
                    const variants = (slowdownSettings.variants || []).map(v => ({
                        factor: parseFloat(v.factor),
                        chance: parseFloat(v.chance)
                    })).filter(v => v.factor > 0 && v.chance > 0);
                    const totalChance = variants.reduce((sum, v) => sum + v.chance, 0) || 1;
                    let rnd = Math.random() * totalChance;
                    let selected = variants[0] || { factor: 1.5, chance: 100 };
                    for (const v of variants) {
                        if (rnd < v.chance) { selected = v; break; }
                        rnd -= v.chance;
                    }

                    // 2.1) Через ~2.0s сообщаем выбранный коэффициент (для остановки первой рулетки)
                    setTimeout(() => {
                        broadcastToClients({
                            type: 'SLOWDOWN_FACTOR_RESULT',
                            factor: selected.factor
                        });
                    }, 2000);

                    // 2.2) Выбираем длительность (если заданы варианты, то по шансам)
                    let selectedDuration = Math.max(1, parseInt(slowdownSettings.duration || 300));
                    if (Array.isArray(slowdownSettings.durationVariants) && slowdownSettings.durationVariants.length > 0) {
                        const durations = slowdownSettings.durationVariants
                            .map(d => ({ seconds: parseInt(d.seconds)||0, chance: parseFloat(d.chance)||0 }))
                            .filter(d => d.seconds > 0 && d.chance > 0);
                        if (durations.length > 0) {
                            const totalDurChance = durations.reduce((s, d) => s + d.chance, 0) || 1;
                            let r = Math.random() * totalDurChance;
                            let sel = durations[0];
                            for (const d of durations) { if (r < d.chance) { sel = d; break; } r -= d.chance; }
                            selectedDuration = Math.max(1, parseInt(sel.seconds)||selectedDuration);
                        }
                    }

                    // 3) Через ещё ~2.2s активируем замедление и шлём итог (после второй рулетки)
                    setTimeout(() => {
                        const untilTs = Math.floor(Date.now() / 1000) + selectedDuration;
                        const slowdownUpdates = {
                            timer_slowdown_active: 1,
                            timer_slowdown_factor: selected.factor,
                            timer_slowdown_until_ts: untilTs
                        };
                        console.log('🐢 Итог замедления:', selected, `на ${selectedDuration} сек (до ${untilTs})`);
                        updateAppState(slowdownUpdates, (err) => {
                            if (err) {
                                console.error('❌ Ошибка сохранения замедления:', err);
                                return;
                            }
                            getAppState((fullState) => {
                                if (fullState) broadcastStateUpdate(fullState);
                            });
                            broadcastToClients({
                                type: 'SLOWDOWN_RESULT',
                                factor: selected.factor,
                                duration: selectedDuration,
                                until_ts: untilTs
                            });
                        });
                    }, 4200);

                    // Отвечаем сразу, чтобы UI не ждал
                    res.json({ success: true, message: 'Запущено рандомное замедление (со спином)', duration: selectedDuration || 300 });
                } catch (error) {
                    console.error('❌ Ошибка запуска рандомного замедления:', error);
                    res.status(500).json({ error: 'Ошибка запуска рандомного замедления' });
                }
            });
            return; // Завершаем здесь, так как уже отправили ответ
        } else if (action === 'slowdown_stop') {
            updates.timer_slowdown_active = 0;
            updates.timer_slowdown_factor = 1.0;
            updates.timer_slowdown_until_ts = 0;
            console.log('🛑 Замедление таймера отключено');
        } else if (action === 'discount_start') {
            const { discount_amount, duration_seconds } = req.body;
            const discount = Math.max(0, parseInt(discount_amount) || 0);
            const durationSec = parseInt(duration_seconds) || 0;
            const untilTs = durationSec > 0 ? Math.floor(Date.now() / 1000) + durationSec : 0;
            updates.timer_discount = discount;
            updates.timer_discount_until_ts = untilTs;
            if (durationSec > 0) {
                console.log(`💰 Скидка активирована: -${discount} RUB на ${durationSec} сек (до ${untilTs})`);
            } else {
                console.log(`💰 Скидка активирована: -${discount} RUB (без ограничения времени)`);
            }
        } else if (action === 'discount_stop') {
            updates.timer_discount = 0;
            updates.timer_discount_until_ts = 0;
            console.log('🛑 Скидка отключена');
        } else {
            console.log('❓ Неизвестное действие:', action);
        }
        
        updateAppState(updates, (err) => {
            if (err) {
                console.error('❌ Ошибка управления таймером:', err);
                res.status(500).json({ error: err.message });
            } else {
                console.log('✅ Таймер успешно обновлен, broadcasting...');
                console.log('📡 Отправляемые обновления:', updates);
                // Получаем обновленное состояние и отправляем всем клиентам
                getAppState((fullState) => {
                    if (fullState) {
                        broadcastStateUpdate(fullState);
                    }
                });
                res.json({ success: true });
            }
        });
    });
});

// Управление фрагами/единицами
app.post('/api/manage-units', (req, res) => {
    const { action, amount, mode } = req.body;
    
    console.log('🔄 Управление единицами:', { action, amount, mode });
    
    getAppState((state) => {
        if (!state) {
            return res.status(500).json({ error: 'Ошибка состояния' });
        }
        
        let updates = {};
        
        if (mode === 'mode1') {
            if (action === 'add') {
                updates.frags_needed = (state.frags_needed || 0) + (parseInt(amount) || 1);
            } else if (action === 'complete') {
                const completeAmount = Math.min(state.frags_needed || 0, parseInt(amount) || 1);
                updates.frags_needed = (state.frags_needed || 0) - completeAmount;
                updates.frags_done = (state.frags_done || 0) + completeAmount;
                
                // Записываем статистику фрагов
                if (completeAmount > 0) {
                    addUniqueBattle(new Date().toISOString(), completeAmount, 'donation');
                }
            }
        } else if (mode === 'mode3') {
            if (action === 'add') {
                updates.custom_units_needed = (state.custom_units_needed || 0) + (parseInt(amount) || 1);
            } else if (action === 'complete') {
                const completeAmount = Math.min(state.custom_units_needed || 0, parseInt(amount) || 1);
                updates.custom_units_needed = (state.custom_units_needed || 0) - completeAmount;
                updates.custom_units_done = (state.custom_units_done || 0) + completeAmount;
            } else if (action === 'custom_complete') {
                const completeAmount = parseInt(amount) || 0;
                if (completeAmount > 0) {
                    updates.custom_units_needed = Math.max(0, (state.custom_units_needed || 0) - completeAmount);
                    updates.custom_units_done = (state.custom_units_done || 0) + completeAmount;
                }
            }
        }
        
        updateAppState(updates, (err) => {
            if (err) {
                console.error('❌ Ошибка управления единицами:', err);
                res.status(500).json({ error: err.message });
            } else {
                console.log('✅ Единицы успешно обновлены');
                
                // Проверяем донаты после изменения фрагов
                setTimeout(() => {
                    if (!isPollingInProgress) {
                        console.log('🔄 Проверка донатов после изменения фрагов...');
                        checkForNewDonations();
                    }
                }, 500);
                
                res.json({ success: true });
            }
        });
    });
});

// Смена режима
app.post('/api/change-mode', (req, res) => {
    const { mode } = req.body;
    
    console.log('🔄 Смена режима на:', mode);
    
    if (!['mode1', 'mode2', 'mode3'].includes(mode)) {
        return res.status(400).json({ error: 'Неверный режим' });
    }
    
    updateAppState({ current_mode: mode }, (err) => {
        if (err) {
            console.error('❌ Ошибка смены режима:', err);
            res.status(500).json({ error: err.message });
        } else {
            console.log('✅ Режим изменен на:', mode);
            res.json({ success: true });
        }
    });
});

// Управление прозрачностью виджетов
app.post('/api/widget-opacity', (req, res) => {
    const { opacity, target } = req.body;
    
    console.log('🎨 Управление прозрачностью:', { opacity, target });
    
    if (opacity >= 0.1 && opacity <= 1) {
        // Сохраняем значение прозрачности в состоянии, чтобы применять при инициализации
        updateAppState({ widget_bg_opacity: opacity }, (err) => {
            if (err) {
                console.error('❌ Ошибка сохранения прозрачности:', err);
            }
            // Всегда отправляем событие для мгновенного применения на клиентах
            broadcastToClients({
                type: 'SET_WIDGET_OPACITY',
                opacity: opacity,
                target: target || 'background'
            });
            res.json({ success: true });
        });
    } else {
        res.status(400).json({ error: 'Некорректное значение прозрачности' });
    }
});

// WebSocket для клиентов
const wss = new WebSocket.Server({ 
    server,
    path: '/ws'
});

// donatePayCentrifuge/connectDonatePayCentrifugo вынесены в src/modules/donation-platforms

wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).substr(2, 9);
    const url = new URL(req.url, `http://localhost:${port}`);
    const typeParam = (url.searchParams.get('type') || '').toLowerCase();
    const clientType = typeParam === 'alert' ? 'ALERT' : typeParam === 'widget' ? 'WIDGET' : 'DASHBOARD';
    console.log(`👤 Новый клиент подключен: ${clientId} (${clientType})`);
    
    // Логируем подключение клиента
    analytics.logEvent('client_connected', { clientId, clientType }, null, null, req);

    wsHub.addClient(ws);
    
    // Добавляем идентификатор для отладки
    ws.clientId = clientId;
    ws.clientType = clientType;
    
    // Отправляем текущее состояние (для dashboard и widget)
    if (clientType === 'DASHBOARD' || clientType === 'WIDGET') {
        getAppState((state) => {
            if (state) {
                ws.send(JSON.stringify({
                    type: 'INIT_STATE',
                    state: getBroadcastState(state)
                }));
            }
        });
    }
    
    // Автоматическая проверка донатов при подключении клиента
    setTimeout(() => {
        if (!isPollingInProgress) {
            console.log(`🔄 Проверка донатов при подключении клиента ${clientId}...`);
            checkForNewDonations();
        }
    }, 1000);
    
    // Отправляем историю донатов (только для dashboard)
    if (clientType === 'DASHBOARD') {
        getDonations(20, 0, (err, donations) => {
            if (!err && donations) {
                donations.forEach(donation => {
                    ws.send(JSON.stringify({
                        type: 'NEW_DONATION',
                        donation: {
                            ...donation,
                            isRealtime: donation.is_realtime === 1,
                            timestamp: new Date(donation.created_at).toLocaleTimeString('ru-RU')
                        }
                    }));
                });
            }
        });
    }
    
    ws.on('close', () => {
        console.log(`👤 Клиент отключен: ${clientId} (${clientType})`);
        
        // Логируем отключение клиента
        analytics.logEvent('client_disconnected', { clientId, clientType });

        wsHub.removeClient(ws);
    });
    
    ws.on('error', (error) => {
        console.error(`❌ Ошибка WebSocket клиента ${clientId} (${clientType}):`, error);
        wsHub.removeClient(ws);
    });
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`📨 Сообщение от клиента ${clientId} (${clientType}):`, message.type);
        } catch (error) {
            console.error(`❌ Ошибка парсинга сообщения от клиента ${clientId}:`, error);
        }
    });
});

// Broadcast to all clients
// broadcastToClients вынесен в src/core/websocket.js (см. wsHub в начале файла)

// Маршруты страниц (/, /admin, /dashboard/:mode, /widget/:mode, /alert/:mode…)
// вынесены в src/modules/pages (создан выше, до express.static).
pagesModule.registerPages(app);

// API для настройки DonatePay
app.post('/api/donatepay-config', async (req, res) => {
    try {
        const { apiKey, webhookSecret, widgetUrl } = req.body;
        
        console.log('🔧 Настройка DonatePay:', { 
            apiKey: apiKey ? `${apiKey.substring(0, 10)}...` : 'НЕТ', 
            webhookSecret: webhookSecret ? 'ЕСТЬ' : 'НЕТ',
            widgetUrl: widgetUrl || 'НЕТ'
        });
        
        // Логируем событие настройки
        if (analytics && analytics.logEvent) {
            analytics.logEvent('donatepay_config', { hasApiKey: !!apiKey, hasWebhookSecret: !!webhookSecret }, null, null, req);
        }
        
        // Проверяем, изменился ли API ключ
        const apiKeyChanged = apiKey && apiKey !== DP_CONFIG.apiKey;
        
        // Сохраняем в переменные окружения
        if (apiKey) {
            DP_CONFIG.apiKey = apiKey;
        }
        if (webhookSecret) {
            DP_CONFIG.webhookSecret = webhookSecret;
        }
        if (widgetUrl) {
            DP_CONFIG.widgetUrl = widgetUrl;
        }
        
        // Если API ключ изменился, сбрасываем ошибку 429
        if (apiKeyChanged) {
            console.log('🔄 API ключ DonatePay изменен, сбрасываем ошибку 429');
            DP_CONFIG.lastError = null;
            DP_CONFIG.userId = null; // Сбрасываем userId, чтобы получить новый
        }
        
        // Сохраняем в базу данных напрямую через SQL
        db.run(
            `UPDATE app_state SET 
                dp_api_key = COALESCE(?, dp_api_key),
                dp_webhook_secret = COALESCE(?, dp_webhook_secret),
                dp_widget_url = COALESCE(?, dp_widget_url),
                dp_last_429_error_ts = CASE WHEN ? = 1 THEN NULL ELSE dp_last_429_error_ts END,
                dp_user_id = CASE WHEN ? = 1 THEN NULL ELSE dp_user_id END
            WHERE id = 1`,
            [
                apiKey || null,
                webhookSecret || null,
                widgetUrl || null,
                apiKeyChanged ? 1 : 0, // Сбрасываем ошибку 429 если ключ изменился
                apiKeyChanged ? 1 : 0  // Сбрасываем userId если ключ изменился
            ],
            async (err) => {
                if (err) {
                    console.error('❌ Ошибка сохранения настроек DonatePay:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка сохранения: ' + err.message });
                }
                
                console.log('✅ Настройки DonatePay сохранены в БД');
                
                    // Если API ключ настроен, получаем информацию о пользователе и подключаемся к Centrifugo
                    if (apiKey) {
                        try {
                            console.log('🔍 Попытка получить информацию о пользователе DonatePay...');
                            
                            // Добавляем задержку перед запросом, чтобы избежать 429 ошибки
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            
                            const userInfo = await getDonatePayUser();
                            if (userInfo) {
                                console.log('✅ Информация о пользователе получена успешно');
                                // Подключаемся к Centrifugo для real-time уведомлений
                                await connectDonatePayCentrifugo();
                                
                                // Запускаем опрос донатов если еще не запущен
                                if (!pollingInterval) {
                                    startPollingDonationAlerts();
                                } else {
                                    // Если опрос уже запущен, принудительно проверяем донаты через 5 секунд
                                    setTimeout(() => {
                                        if (!isPollingInProgress) {
                                            console.log('🔄 Проверка донатов после настройки DonatePay...');
                                            checkForNewDonations();
                                        }
                                    }, 5000);
                                }
                                
                                return res.json({ 
                                    success: true, 
                                    message: 'DonatePay настроен с real-time уведомлениями',
                                    userInfo: {
                                        id: userInfo.id,
                                        name: userInfo.name
                                    }
                                });
                            } else {
                                console.warn('⚠️ Не удалось получить информацию о пользователе');
                                
                                // Если получили 429, планируем повторную попытку через 2 минуты
                                const lastError = DP_CONFIG.lastError;
                                if (lastError && lastError.status === 429) {
                                    console.log('⏰ Планируем повторную попытку получения информации о пользователе через 2 минуты...');
                                    setTimeout(async () => {
                                        console.log('🔄 Повторная попытка получить информацию о пользователе DonatePay...');
                                        const retryUserInfo = await getDonatePayUser();
                                        if (retryUserInfo) {
                                            console.log('✅ Информация о пользователе получена при повторной попытке');
                                            await connectDonatePayCentrifugo();
                                            if (!pollingInterval) {
                                                startPollingDonationAlerts();
                                            }
                                        }
                                    }, 120000); // 2 минуты
                                    
                                    return res.json({ 
                                        success: true, 
                                        message: 'DonatePay настроен (real-time через Centrifugo)',
                                        warning: 'Превышен лимит запросов к DonatePay API. Ключ сохранен, информация о пользователе будет получена автоматически через 2 минуты. После получения userId подключится Centrifugo для real-time уведомлений.'
                                    });
                                }
                                
                                return res.json({ 
                                    success: true, 
                                    message: 'DonatePay настроен (real-time через Centrifugo)',
                                    warning: 'Не удалось получить информацию о пользователе. Проверьте API ключ в логах сервера. Ключ сохранен, попробуйте позже. После получения userId подключится Centrifugo для real-time уведомлений.'
                                });
                            }
                        } catch (error) {
                            console.error('❌ Ошибка настройки DonatePay:', error);
                            return res.json({ 
                                success: true, 
                                message: 'DonatePay настроен (real-time через Centrifugo)',
                                warning: `Ошибка: ${error.message}. Проверьте логи сервера для подробностей. После получения userId подключится Centrifugo для real-time уведомлений.`
                            });
                        }
                } else {
                    return res.json({ 
                        success: true, 
                        message: 'Настройки DonatePay сохранены'
                    });
                }
            }
        );
    } catch (error) {
        console.error('❌ Ошибка обработки запроса DonatePay:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// API для тестирования последних событий
app.post('/api/test-last-events', async (req, res) => {
    try {
        const { lastEventsUrl } = req.body;
        
        if (!lastEventsUrl) {
            return res.json({ success: false, error: 'URL last-events не указан' });
        }

        console.log('🧪 Тестовый запрос last-events:', lastEventsUrl);
        
        const response = await axios.get(lastEventsUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });

        const events = response.data || [];
        const donations = events.filter(event => event.type === 'donation' && event.status === 'success');

        res.json({
            success: true,
            eventsCount: events.length,
            donationsCount: donations.length,
            events: events.slice(0, 10) // Первые 10 событий
        });

    } catch (error) {
        console.error('❌ Ошибка тестирования last-events:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для тестирования виджета
app.post('/api/test-widget', async (req, res) => {
    try {
        const { widgetUrl } = req.body;
        
        if (!widgetUrl) {
            return res.json({ success: false, error: 'URL виджета не указан' });
        }

        console.log('🧪 Тестовый запрос виджета:', widgetUrl);
        
        const response = await axios.get(widgetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        const elements = $('.donation, .alert, .notification, .donate-item, *').length;
        const text = $.text().trim();

        res.json({
            success: true,
            htmlLength: response.data.length,
            elementsCount: elements,
            text: text.substring(0, 1000) // Первые 1000 символов
        });

    } catch (error) {
        console.error('❌ Ошибка тестирования виджета:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для тестирования DonatePay
app.get('/api/donatepay-test', async (req, res) => {
    try {
        console.log('🧪 Тестовый запрос DonatePay...');
        console.log('🔍 Текущая конфигурация:', {
            apiKey: DP_CONFIG.apiKey ? `${DP_CONFIG.apiKey.substring(0, 10)}...` : 'ОТСУТСТВУЕТ',
            apiKeyFromEnv: process.env.DP_API_KEY ? `${process.env.DP_API_KEY.substring(0, 10)}...` : 'ОТСУТСТВУЕТ В ENV',
            userId: DP_CONFIG.userId || 'НЕ ПОЛУЧЕН',
            lastTransactionId: DP_CONFIG.lastTransactionId || 0,
            lastError: DP_CONFIG.lastError ? {
                status: DP_CONFIG.lastError.status,
                message: DP_CONFIG.lastError.message,
                timestamp: DP_CONFIG.lastError.timestamp ? new Date(DP_CONFIG.lastError.timestamp).toISOString() : 'НЕТ'
            } : 'НЕТ'
        });
        
        if (!DP_CONFIG.apiKey) {
            // Проверяем, есть ли ключ в env, но не загружен в конфиг
            if (process.env.DP_API_KEY) {
                console.log('⚠️ API ключ есть в config.env, но не загружен в DP_CONFIG. Загружаем...');
                DP_CONFIG.apiKey = process.env.DP_API_KEY;
            } else {
                return res.json({ 
                    success: false, 
                    error: 'API ключ не настроен',
                    details: 'Настройте API ключ DonatePay в разделе интеграций или в config.env',
                    hasEnvKey: !!process.env.DP_API_KEY,
                    hasConfigKey: !!DP_CONFIG.apiKey
                });
            }
        }

        // Проверяем, не было ли недавно ошибки 429
        const lastError = DP_CONFIG.lastError;
        if (lastError && lastError.status === 429) {
            const timeSinceError = Date.now() - (lastError.timestamp || 0);
            const timeoutMs = 300000; // 5 минут (как в остальных местах)
            const timeRemaining = Math.max(0, timeoutMs - timeSinceError);
            const minutesRemaining = Math.ceil(timeRemaining / 60000);
            const secondsRemaining = Math.ceil(timeRemaining / 1000);
            
            if (timeRemaining > 0) {
                console.log(`⏰ Слишком рано для повторного запроса. Осталось: ${secondsRemaining} секунд`);
                return res.json({ 
                    success: false, 
                    error: 'Превышен лимит запросов к DonatePay API',
                    details: `Подождите еще ${minutesRemaining > 0 ? minutesRemaining + ' ' + (minutesRemaining === 1 ? 'минуту' : minutesRemaining < 5 ? 'минуты' : 'минут (рекомендуется 5 минут)') : Math.ceil(secondsRemaining / 60) + ' минут'} перед повторной попыткой`,
                    retryAfter: secondsRemaining,
                    lastErrorTime: lastError.timestamp ? new Date(lastError.timestamp).toISOString() : null,
                    canReset: true // Позволяем сбросить ошибку вручную
                });
            } else {
                console.log('✅ Прошло достаточно времени с последней ошибки 429, можно попробовать снова');
                DP_CONFIG.lastError = null; // Сбрасываем ошибку
                // Очищаем время ошибки в БД
                getAppState((state) => {
                    if (state) {
                        updateAppState({
                            dp_last_429_error_ts: null
                        }, (err) => {
                            if (err) console.error('❌ Ошибка очистки времени ошибки 429:', err);
                        });
                    }
                });
            }
        }

        // Добавляем задержку перед запросом (увеличена для безопасности)
        console.log('⏳ Ожидание 3 секунды перед запросом к DonatePay API...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Тестируем получение информации о пользователе
        const userInfo = await getDonatePayUser();
        if (!userInfo) {
            const errorDetails = DP_CONFIG.lastError || {};
            let errorMessage = 'Не удалось получить информацию о пользователе';
            let details = 'Проверьте логи сервера для подробностей';
            
            if (errorDetails.status === 429) {
                errorMessage = 'Превышен лимит запросов к DonatePay API';
                details = 'Подождите 1-2 минуты и попробуйте снова';
            } else if (errorDetails.status === 401) {
                errorMessage = 'Неверный API ключ';
                details = 'Проверьте правильность API ключа в настройках DonatePay';
            } else if (errorDetails.status) {
                errorMessage = `Ошибка API: ${errorDetails.status}`;
                details = errorDetails.message || 'Неизвестная ошибка';
            }
            
            return res.json({ 
                success: false, 
                error: errorMessage,
                details: details,
                lastError: errorDetails.status ? {
                    status: errorDetails.status,
                    message: errorDetails.message
                } : null
            });
        }

        // ВАЖНО: Все API запросы для получения донатов ОТКЛЮЧЕНЫ
        // Используем ТОЛЬКО Centrifugo для real-time донатов
        // Это предотвращает ошибки 429 и обеспечивает стабильную работу
        console.log('📌 Все API запросы для получения донатов отключены');
        console.log('📌 Используется ТОЛЬКО Centrifugo для real-time донатов');
        
        const newTransactionsDonations = [];
        const newTransactionsError = null;
        const widgetDonations = [];
        const lastEventsDonations = [];
        
        // Проверяем статус Centrifugo
        let centrifugoStatus = 'not_connected';
        let centrifugoConnected = false;
        if (donationPlatformsModule.isCentrifugoConnected()) {
            try {
                const state = donationPlatformsModule.getCentrifugoState();
                centrifugoStatus = state || 'unknown';
                centrifugoConnected = (state === 'connected');
            } catch (e) {
                centrifugoStatus = 'error_checking';
            }
        }
        
        res.json({ 
            success: true, 
            message: 'DonatePay API работает корректно',
            userInfo: {
                id: userInfo.id,
                name: userInfo.name
            },
            note: 'Используется ТОЛЬКО Centrifugo для real-time донатов. Все API запросы отключены для избежания ошибок 429.',
            pollingDisabled: true,
            apiRequestsDisabled: true,
            centrifugoStatus: centrifugoStatus,
            centrifugoConnected: centrifugoConnected,
            newTransactionsCount: 0,
            newTransactionsError: 'API запросы отключены',
            lastTransactionId: DP_CONFIG.lastTransactionId || 0,
            widgetDonationsCount: 0,
            lastEventsCount: 0,
            widgetUrl: DP_CONFIG.widgetUrl || 'Не настроен',
            message: 'Донаты получаются ТОЛЬКО через Centrifugo WebSocket в реальном времени'
        });
    } catch (error) {
        console.error('❌ Ошибка тестирования DonatePay:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для сброса ошибки 429 DonatePay
app.post('/api/donatepay-reset-429', async (req, res) => {
    try {
        console.log('🔄 Сброс ошибки 429 DonatePay...');
        
        // Сбрасываем ошибку в памяти
        DP_CONFIG.lastError = null;
        DP_CONFIG._429ErrorCount = 0; // Сбрасываем счетчик ошибок
        DP_CONFIG._last429ErrorTimestamp = null; // Сбрасываем timestamp последней ошибки
        DP_CONFIG.lastUserInfoRequest = null; // Сбрасываем время последней попытки
        
        // Очищаем время ошибки в БД
        getAppState((state) => {
            if (state) {
                updateAppState({
                    dp_last_429_error_ts: null
                }, (err) => {
                    if (err) {
                        console.error('❌ Ошибка очистки времени ошибки 429:', err);
                        return res.status(500).json({ 
                            success: false, 
                            error: 'Ошибка очистки времени ошибки 429: ' + err.message 
                        });
                    } else {
                        console.log('✅ Ошибка 429 сброшена (включая счетчик ошибок)');
                        res.json({ 
                            success: true, 
                            message: 'Ошибка 429 успешно сброшена. Теперь можно протестировать DonatePay API.' 
                        });
                    }
                });
            } else {
                res.status(500).json({ success: false, error: 'Не удалось получить состояние приложения' });
            }
        });
    } catch (error) {
        console.error('❌ Ошибка сброса ошибки 429:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для создания тестового уведомления DonatePay
app.post('/api/donatepay-notification', async (req, res) => {
    try {
        const { name, sum, comment, date, notification } = req.body;
        
        if (!DP_CONFIG.apiKey) {
            return res.json({ 
                success: false, 
                error: 'API ключ DonatePay не настроен' 
            });
        }
        
        if (!name || !sum) {
            return res.json({ 
                success: false, 
                error: 'Не указаны обязательные параметры: name, sum' 
            });
        }
        
        console.log('🔔 Создание тестового уведомления DonatePay:', {
            name: name,
            sum: sum,
            comment: comment || 'Нет',
            notification: notification !== undefined ? notification : 'По умолчанию (1)'
        });
        
        const params = {
            access_token: DP_CONFIG.apiKey,
            name: name,
            sum: parseFloat(sum),
            notification: notification !== undefined ? notification : '1' // По умолчанию создавать
        };
        
        if (comment) {
            params.comment = comment;
        }
        
        if (date) {
            params.date = date;
        }
        
        const response = await axios.post(`${DP_CONFIG.apiUrl}/notification`, null, {
            params: params,
            timeout: 10000,
            validateStatus: function (status) {
                return status < 500;
            }
        });
        
        if (response.status === 429) {
            DP_CONFIG.lastError = { status: 429, message: 'Too Many Requests', timestamp: Date.now() };
            return res.json({ 
                success: false, 
                error: 'Превышен лимит запросов к DonatePay API',
                details: 'Подождите 1-2 минуты и попробуйте снова'
            });
        }
        
        if (response.status === 401) {
            DP_CONFIG.lastError = { status: 401, message: 'Unauthorized', timestamp: Date.now() };
            return res.json({ 
                success: false, 
                error: 'Неверный API ключ',
                details: 'Проверьте правильность API ключа'
            });
        }
        
        if (response.status !== 200) {
            return res.json({ 
                success: false, 
                error: `Ошибка API: ${response.status}`,
                details: response.data?.message || 'Неизвестная ошибка',
                response: response.data
            });
        }
        
        console.log('✅ Тестовое уведомление DonatePay создано успешно');
        
        res.json({ 
            success: true, 
            message: 'Тестовое уведомление создано успешно',
            data: response.data.data || response.data
        });
        
    } catch (error) {
        console.error('❌ Ошибка создания уведомления DonatePay:', error);
        const status = error.response?.status;
        const errorData = error.response?.data;
        
        if (status === 429) {
            DP_CONFIG.lastError = { status: 429, message: 'Too Many Requests', timestamp: Date.now() };
            return res.json({ 
                success: false, 
                error: 'Превышен лимит запросов к DonatePay API',
                details: 'Подождите 1-2 минуты и попробуйте снова'
            });
        }
        
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: errorData ? JSON.stringify(errorData, null, 2) : 'Нет дополнительной информации'
        });
    }
});

// Смена отслеживаемого аккаунта по account_id (публичная статистика, OAuth не обязателен)
// /api/lesta-set-account, /api/reset-lesta, /api/lesta-config, /api/lesta-stats
// вынесены в src/modules/lesta-routes

// /api/lesta-search вынесен в src/modules/lesta-oauth

// API для сброса статистики фрагов
app.delete('/api/frag-stats', async (req, res) => {
    try {
        console.log('🗑️ Запрос на сброс статистики фрагов');
        db.run('DELETE FROM frag_stats', function(err) {
            if (err) {
                console.error('❌ Ошибка сброса статистики фрагов:', err);
                return res.status(500).json({ success: false, message: 'Ошибка базы данных' });
            }
            console.log('✅ Статистика фрагов сброшена');
            res.json({ success: true, message: 'Статистика фрагов сброшена' });
        });
    } catch (error) {
        console.error('❌ Ошибка сброса статистики фрагов:', error);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// API для ручного редактирования статистики
app.post('/api/edit-stats-manually', async (req, res) => {
    try {
        console.log('✏️ Ручное редактирование статистики');
        
        const { totalBattles, totalFrags, battlesWithoutFrags } = req.body;
        
        if (!totalBattles || totalFrags === undefined || battlesWithoutFrags === undefined) {
            return res.status(400).json({ 
                success: false, 
                message: 'Необходимо указать: totalBattles, totalFrags, battlesWithoutFrags' 
            });
        }
        
        // Проверяем корректность данных
        if (battlesWithoutFrags > totalBattles) {
            return res.status(400).json({ 
                success: false, 
                message: 'Количество боев без фрагов не может быть больше общего количества боев' 
            });
        }
        
        if (totalFrags < 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Количество фрагов не может быть отрицательным' 
            });
        }
        
        // Рассчитываем распределение боев
        const battlesWithFrags = totalBattles - battlesWithoutFrags;
        const fragsPerBattle = battlesWithFrags > 0 ? Math.floor(totalFrags / battlesWithFrags) : 0;
        const remainingFrags = totalFrags - (fragsPerBattle * battlesWithFrags);
        
        console.log(`📊 Ручное редактирование:`);
        console.log(`   Всего боев: ${totalBattles}`);
        console.log(`   Боев с фрагами: ${battlesWithFrags}`);
        console.log(`   Боев без фрагов: ${battlesWithoutFrags}`);
        console.log(`   Всего фрагов: ${totalFrags}`);
        console.log(`   Фрагов за бой: ${fragsPerBattle}`);
        console.log(`   Остаток фрагов: ${remainingFrags}`);
        
        // Очищаем существующую статистику
        db.run('DELETE FROM frag_stats', (err) => {
            if (err) {
                console.error('❌ Ошибка очистки статистики:', err);
                return res.status(500).json({ success: false, message: 'Ошибка очистки статистики' });
            }
            
            console.log('✅ Статистика очищена');
            
            // Записываем бои
            let completedBattles = 0;
            const totalBattlesToProcess = totalBattles;
            
            function addBattle(battleIndex, frags) {
                const battleTime = new Date(Date.now() - (totalBattlesToProcess - battleIndex) * 60000).toISOString();
                
                db.run(
                    'INSERT INTO frag_stats (battle_time, frags) VALUES (?, ?)',
                    [battleTime, frags],
                    function(err) {
                        if (err) {
                            console.error('❌ Ошибка записи боя:', err);
                            return res.status(500).json({ success: false, message: 'Ошибка записи боя' });
                        }
                        
                        completedBattles++;
                        console.log(`✅ Записан бой ${battleIndex}/${totalBattlesToProcess}: ${frags} фрагов`);
                        
                        if (completedBattles === totalBattlesToProcess) {
                            // НЕ обновляем состояние Lesta Games при редактировании локальной статистики
                            // Это позволяет системе продолжать отслеживать изменения от реальной статистики Lesta Games
                            console.log('✅ Локальная статистика фрагов обновлена');
                            console.log('⚠️ Состояние Lesta Games НЕ изменено - система будет отслеживать изменения от реальной статистики');
                            
                            res.json({
                                success: true,
                                message: 'Локальная статистика фрагов успешно отредактирована',
                                stats: {
                                    totalBattles,
                                    totalFrags,
                                    battlesWithFrags,
                                    battlesWithoutFrags,
                                    fragsPerBattle,
                                    remainingFrags
                                },
                                note: 'Состояние Lesta Games не изменено - система продолжит отслеживать изменения от реальной статистики'
                            });
                        }
                    }
                );
            }
            
            // Записываем бои с фрагами
            for (let i = 0; i < battlesWithFrags; i++) {
                let frags = fragsPerBattle;
                if (i === 0 && remainingFrags > 0) {
                    frags += remainingFrags; // Добавляем остаток к первому бою
                }
                addBattle(i + 1, frags);
            }
            
            // Записываем бои без фрагов
            for (let i = 0; i < battlesWithoutFrags; i++) {
                addBattle(battlesWithFrags + i + 1, 0);
            }
        });
    } catch (error) {
        console.error('❌ Ошибка редактирования:', error);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// API для получения текущей статистики
app.get('/api/get-current-stats', async (req, res) => {
    try {
        console.log('📊 Получение текущей статистики');
        
        // Получаем состояние Lesta Games
        db.get('SELECT lesta_last_battles, lesta_last_frags FROM app_state WHERE id = 1', (err, state) => {
            if (err) {
                console.error('❌ Ошибка получения состояния:', err);
                return res.status(500).json({ success: false, message: 'Ошибка базы данных' });
            }
            
            if (!state) {
                return res.json({ 
                    success: false, 
                    message: 'Нет данных о состоянии',
                    stats: { totalBattles: 0, totalFrags: 0, battlesWithoutFrags: 0 }
                });
            }
            
            // Получаем статистику фрагов
            db.all('SELECT frags FROM frag_stats', (err, rows) => {
                if (err) {
                    console.error('❌ Ошибка получения статистики фрагов:', err);
                    return res.status(500).json({ success: false, message: 'Ошибка базы данных' });
                }
                
                const totalBattles = rows.length;
                const totalFrags = rows.reduce((sum, row) => sum + row.frags, 0);
                const battlesWithoutFrags = rows.filter(row => row.frags === 0).length;
                
                res.json({
                    success: true,
                    stats: {
                        totalBattles,
                        totalFrags,
                        battlesWithoutFrags,
                        lestaBattles: state.lesta_last_battles || 0,
                        lestaFrags: state.lesta_last_frags || 0
                    }
                });
            });
        });
    } catch (error) {
        console.error('❌ Ошибка получения статистики:', error);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// API для инициализации стартовых значений статистики
app.post('/api/initialize-starting-stats', async (req, res) => {
    try {
        console.log('🚀 Инициализация стартовых значений статистики');
        
        const { totalBattles, totalFrags, battlesWithoutFrags } = req.body;
        
        if (!totalBattles || totalFrags === undefined || battlesWithoutFrags === undefined) {
            return res.status(400).json({ 
                success: false, 
                message: 'Необходимо указать: totalBattles, totalFrags, battlesWithoutFrags' 
            });
        }
        
        // Очищаем существующую статистику
        db.run('DELETE FROM frag_stats', (err) => {
            if (err) {
                console.error('❌ Ошибка очистки статистики:', err);
                return res.status(500).json({ success: false, message: 'Ошибка очистки статистики' });
            }
            
            console.log('✅ Статистика очищена');
            
            // Рассчитываем распределение боев
            const battlesWithFrags = totalBattles - battlesWithoutFrags;
            const fragsPerBattle = battlesWithFrags > 0 ? Math.floor(totalFrags / battlesWithFrags) : 0;
            const remainingFrags = totalFrags - (fragsPerBattle * battlesWithFrags);
            
            console.log(`📊 Расчеты:`);
            console.log(`   Всего боев: ${totalBattles}`);
            console.log(`   Боев с фрагами: ${battlesWithFrags}`);
            console.log(`   Боев без фрагов: ${battlesWithoutFrags}`);
            console.log(`   Всего фрагов: ${totalFrags}`);
            console.log(`   Фрагов за бой: ${fragsPerBattle}`);
            console.log(`   Остаток фрагов: ${remainingFrags}`);
            
            // Записываем бои с фрагами
            let completedBattles = 0;
            const totalBattlesToProcess = totalBattles;
            
            function addBattle(battleIndex, frags) {
                const battleTime = new Date(Date.now() - (totalBattlesToProcess - battleIndex) * 60000).toISOString();
                
                db.run(
                    'INSERT INTO frag_stats (battle_time, frags) VALUES (?, ?)',
                    [battleTime, frags],
                    function(err) {
                        if (err) {
                            console.error('❌ Ошибка записи боя:', err);
                            return res.status(500).json({ success: false, message: 'Ошибка записи боя' });
                        }
                        
                        completedBattles++;
                        console.log(`✅ Записан бой ${battleIndex}/${totalBattlesToProcess}: ${frags} фрагов`);
                        
                        if (completedBattles === totalBattlesToProcess) {
                            // НЕ обновляем состояние Lesta Games при инициализации локальной статистики
                            // Это позволяет системе продолжать отслеживать изменения от реальной статистики Lesta Games
                            console.log('✅ Локальная статистика фрагов инициализирована');
                            console.log('⚠️ Состояние Lesta Games НЕ изменено - система будет отслеживать изменения от реальной статистики');
                            
                            res.json({
                                success: true,
                                message: 'Локальная статистика фрагов инициализирована',
                                stats: {
                                    totalBattles,
                                    totalFrags,
                                    battlesWithFrags,
                                    battlesWithoutFrags,
                                    fragsPerBattle,
                                    remainingFrags
                                },
                                note: 'Состояние Lesta Games не изменено - система продолжит отслеживать изменения от реальной статистики'
                            });
                        }
                    }
                );
            }
            
            // Записываем бои с фрагами
            for (let i = 0; i < battlesWithFrags; i++) {
                let frags = fragsPerBattle;
                if (i === 0 && remainingFrags > 0) {
                    frags += remainingFrags; // Добавляем остаток к первому бою
                }
                addBattle(i + 1, frags);
            }
            
            // Записываем бои без фрагов
            for (let i = 0; i < battlesWithoutFrags; i++) {
                addBattle(battlesWithFrags + i + 1, 0);
            }
        });
    } catch (error) {
        console.error('❌ Ошибка инициализации:', error);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// API для диагностики логики подсчета боев и фрагов
app.get('/api/battle-frag-logic-test', async (req, res) => {
    try {
        console.log('🧪 Тестирование логики подсчета боев и фрагов');
        
        // Получаем текущее состояние
        db.get('SELECT lesta_last_battles, lesta_last_frags, lesta_previous_frags FROM app_state WHERE id = 1', (err, state) => {
            if (err) {
                console.error('❌ Ошибка получения состояния:', err);
                return res.status(500).json({ success: false, message: 'Ошибка базы данных' });
            }
            
            if (!state) {
                return res.json({ success: false, message: 'Нет состояния для тестирования' });
            }
            
            // Получаем свежую статистику от Lesta API
            getLestaPlayerStats().then(stats => {
                if (!stats) {
                    return res.json({ success: false, message: 'Не удалось получить статистику Lesta Games' });
                }
                
                const currentBattles = stats.battles;
                const currentFrags = stats.frags;
                const previousBattles = state.lesta_last_battles || 0;
                const previousFrags = state.lesta_last_frags || 0;
                const battlesDifference = currentBattles - previousBattles;
                const fragsDifference = currentFrags - previousFrags;
                
                const result = {
                    success: true,
                    current: {
                        battles: currentBattles,
                        frags: currentFrags
                    },
                    previous: {
                        battles: previousBattles,
                        frags: previousFrags
                    },
                    differences: {
                        battles: battlesDifference,
                        frags: fragsDifference
                    },
                    logic: {
                        newBattles: battlesDifference > 0,
                        newFrags: fragsDifference > 0,
                        battlesToRecord: battlesDifference,
                        fragsToDistribute: fragsDifference
                    },
                    recommendation: ''
                };
                
                // Генерируем рекомендацию
                if (battlesDifference > 0) {
                    if (fragsDifference > 0) {
                        result.recommendation = `Записать ${battlesDifference} боев: первый бой с ${fragsDifference} фрагами, остальные ${battlesDifference - 1} боев с 0 фрагами`;
                    } else {
                        result.recommendation = `Записать ${battlesDifference} боев с 0 фрагами каждый`;
                    }
                } else if (fragsDifference > 0) {
                    result.recommendation = `Записать фраг от доната: ${fragsDifference} фрагов`;
                } else {
                    result.recommendation = 'Изменений нет, ничего записывать не нужно';
                }
                
                res.json(result);
            }).catch(error => {
                console.error('❌ Ошибка получения статистики Lesta:', error);
                res.status(500).json({ success: false, message: 'Ошибка получения статистики Lesta Games' });
            });
        });
    } catch (error) {
        console.error('❌ Ошибка тестирования логики:', error);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// API для диагностики статистики фрагов
app.get('/api/frag-stats/diagnose', async (req, res) => {
    try {
        console.log('🔍 Запрос диагностики статистики фрагов');
        
        const today = new Date().toISOString().split('T')[0];
        
        db.all(`
            SELECT * FROM frag_stats 
            WHERE date(battle_time) = ? 
            ORDER BY battle_time DESC
        `, [today], (err, rows) => {
            if (err) {
                console.error('❌ Ошибка получения данных:', err);
                return res.status(500).json({ success: false, message: 'Ошибка базы данных' });
            }
            
            const totalBattles = rows.length;
            const totalFrags = rows.reduce((sum, row) => sum + row.frags, 0);
            const battlesWithFrags = rows.filter(row => row.frags > 0).length;
            const battlesWithoutFrags = rows.filter(row => row.frags === 0).length;
            
            // Проверяем на дубликаты по времени
            const timeGroups = {};
            rows.forEach(row => {
                const timeKey = new Date(row.battle_time).toLocaleTimeString('ru-RU', { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                });
                if (!timeGroups[timeKey]) {
                    timeGroups[timeKey] = [];
                }
                timeGroups[timeKey].push(row);
            });
            
            const duplicates = [];
            Object.keys(timeGroups).forEach(timeKey => {
                if (timeGroups[timeKey].length > 1) {
                    duplicates.push({
                        time: timeKey,
                        battles: timeGroups[timeKey]
                    });
                }
            });
            
            const result = {
                success: true,
                date: today,
                totalBattles,
                totalFrags,
                battlesWithFrags,
                battlesWithoutFrags,
                avgFragsPerBattle: totalBattles > 0 ? (totalFrags / totalBattles).toFixed(2) : '0.00',
                duplicates,
                battles: rows.map(row => ({
                    id: row.id,
                    time: new Date(row.battle_time).toLocaleString(),
                    frags: row.frags,
                    type: row.frags > 0 ? 'Бой с фрагами' : 'Бой без фрагов'
                }))
            };
            
            res.json(result);
        });
    } catch (error) {
        console.error('❌ Ошибка диагностики статистики фрагов:', error);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// API для удаления одного боя без фрагов
app.delete('/api/frag-stats/remove-one-zero', async (req, res) => {
    try {
        console.log('🗑️ Запрос на удаление одного боя без фрагов');
        
        // Находим самый последний бой без фрагов
        db.get(`
            SELECT id, battle_time, frags 
            FROM frag_stats 
            WHERE frags = 0 
            ORDER BY battle_time DESC 
            LIMIT 1
        `, (err, row) => {
            if (err) {
                console.error('❌ Ошибка поиска боя без фрагов:', err);
                return res.status(500).json({ success: false, message: 'Ошибка базы данных' });
            }
            
            if (!row) {
                console.log('✅ Боев без фрагов не найдено');
                return res.json({ success: true, message: 'Боев без фрагов не найдено' });
            }
            
            console.log('🔍 Найден бой без фрагов:', { id: row.id, time: row.battle_time, frags: row.frags });
            
            // Удаляем этот бой
            db.run('DELETE FROM frag_stats WHERE id = ?', [row.id], function(err) {
                if (err) {
                    console.error('❌ Ошибка удаления боя:', err);
                    return res.status(500).json({ success: false, message: 'Ошибка удаления' });
                }
                
                console.log(`✅ Бой успешно удален (ID: ${row.id})`);
                
                // Проверяем результат
                db.all('SELECT COUNT(*) as count, SUM(frags) as total_frags FROM frag_stats', (err, stats) => {
                    if (err) {
                        console.error('❌ Ошибка проверки результата:', err);
                        return res.status(500).json({ success: false, message: 'Ошибка проверки' });
                    }
                    
                    const result = {
                        success: true,
                        message: 'Бой без фрагов удален',
                        removedBattle: {
                            id: row.id,
                            time: row.battle_time,
                            frags: row.frags
                        },
                        currentStats: {
                            totalBattles: stats[0].count,
                            totalFrags: stats[0].total_frags || 0
                        }
                    };
                    
                    res.json(result);
                });
            });
        });
    } catch (error) {
        console.error('❌ Ошибка удаления боя без фрагов:', error);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// API для получения статистики фрагов
app.get('/api/frag-stats', async (req, res) => {
    const { period } = req.query;
    
    try {
        console.log('📊 Запрос статистики фрагов для периода:', period);
        
        // Получаем реальные данные из БД
        getFragStats(period, (err, rows) => {
            if (err) {
                console.error('❌ Ошибка получения статистики фрагов из БД:', err);
                return res.status(500).json({ 
                    success: false, 
                    message: 'Ошибка базы данных' 
                });
            }
            
            // Если данных нет, возвращаем пустые данные
            if (!rows || rows.length === 0) {
                console.log('📊 Нет данных в БД');
                const emptyData = {
                    totalFrags: 0,
                    totalBattles: 0,
                    battlesWithFrags: 0,
                    battlesWithoutFrags: 0,
                    bestHour: '—',
                    avgFragsPerBattle: '0.00',
                    hourlyStats: Array.from({length: 24}, (_, i) => ({ hour: i, frags: 0 })),
                    dailyStats: [],
                    battleStats: []
                };
                return res.json({
                    success: true,
                    data: emptyData
                });
            }
            
            // Обрабатываем реальные данные
            const realData = processFragStatsData(rows, period);
            
            res.json({
                success: true,
                data: realData
            });
        });
    } catch (error) {
        console.error('❌ Ошибка получения статистики фрагов:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Ошибка сервера' 
        });
    }
});

// Функции для работы со статистикой фрагов
function addFragStats(battleTime, frags) {
    db.run(
        'INSERT INTO frag_stats (battle_time, frags) VALUES (?, ?)',
        [battleTime, frags],
        function(err) {
            if (err) {
                console.error('❌ Ошибка сохранения статистики фрагов:', err);
            } else {
                console.log('✅ Статистика фрагов сохранена:', { battleTime, frags });
            }
        }
    );
}

// Функция для добавления боя с фрагами (только прирост фрагов)
function addFragBattle(battleTime, frags) {
    if (frags > 0) {
        addFragStats(battleTime, frags);
    }
}

// Функция для добавления всех боев от Lesta API (включая бои без фрагов)
function addLestaBattle(battleTime, frags = 0) {
    db.run(
        'INSERT INTO frag_stats (battle_time, frags) VALUES (?, ?)',
        [battleTime, frags],
        function(err) {
            if (err) {
                console.error('❌ Ошибка сохранения боя Lesta:', err);
            } else {
                console.log('✅ Бой Lesta сохранен:', { battleTime, frags });
            }
        }
    );
}

// Функция для принудительного добавления боя (без проверки дублирования)
function addBattleForce(battleTime, frags = 0, source = 'lesta') {
    console.log('🔨 Принудительное добавление боя:', { battleTime, frags, source });
    
    db.run(
        'INSERT INTO frag_stats (battle_time, frags) VALUES (?, ?)',
        [battleTime, frags],
        function(err) {
            if (err) {
                console.error('❌ Ошибка сохранения боя:', err);
            } else {
                console.log('✅ Бой принудительно сохранен:', { battleTime, frags, source });
            }
        }
    );
}

// Функция для добавления уникального боя (предотвращает дублирование)
function addUniqueBattle(battleTime, frags = 0, source = 'lesta') {
    // Проверяем, не был ли уже записан бой в последние 2 минуты
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    
    db.get(
        'SELECT COUNT(*) as count FROM frag_stats WHERE battle_time >= ? AND battle_time <= ?',
        [twoMinutesAgo, battleTime],
        function(err, row) {
            if (err) {
                console.error('❌ Ошибка проверки дублирования:', err);
                return;
            }
            
            // Если в последние 2 минуты уже есть записи, не добавляем новую
            if (row.count > 0) {
                console.log('⚠️ Бой уже записан в последние 2 минуты, пропускаем дублирование');
                return;
            }
            
            // Добавляем бой
            db.run(
                'INSERT INTO frag_stats (battle_time, frags) VALUES (?, ?)',
                [battleTime, frags],
                function(err) {
                    if (err) {
                        console.error('❌ Ошибка сохранения уникального боя:', err);
                    } else {
                        console.log('✅ Уникальный бой сохранен:', { battleTime, frags, source });
                    }
                }
            );
        }
    );
}

function getFragStats(period, callback) {
    let query = 'SELECT * FROM frag_stats ORDER BY battle_time DESC';
    let params = [];
    
    if (period === 'day') {
        query = 'SELECT * FROM frag_stats WHERE battle_time >= datetime("now", "-1 day") ORDER BY battle_time DESC';
    } else if (period === 'week') {
        query = 'SELECT * FROM frag_stats WHERE battle_time >= datetime("now", "-7 days") ORDER BY battle_time DESC';
    } else if (period === 'month') {
        query = 'SELECT * FROM frag_stats WHERE battle_time >= datetime("now", "-30 days") ORDER BY battle_time DESC';
    }
    
    db.all(query, params, callback);
}

// Функция для обработки реальных данных статистики фрагов
function processFragStatsData(rows, period) {
    const data = {
        totalFrags: 0,
        totalBattles: 0, // Общее количество боев
        battlesWithFrags: 0,  // Бои с фрагами
        battlesWithoutFrags: 0, // Бои без фрагов
        bestHour: '—',
        avgFragsPerBattle: '0.00',
        hourlyStats: [],
        dailyStats: [],
        battleStats: []
    };
    
    // Инициализируем массивы для часов и дней
    const hourlyData = new Array(24).fill(0);
    const dailyData = {};
    
    // Обрабатываем каждую запись
    rows.forEach(row => {
        const battleTime = new Date(row.battle_time);
        const hour = battleTime.getHours();
        const date = battleTime.toISOString().split('T')[0];
        
        // Обновляем общую статистику
        data.totalFrags += row.frags;
        data.totalBattles++; // Общее количество боев
        
        // Подсчитываем бои с фрагами и без фрагов
        if (row.frags > 0) {
            data.battlesWithFrags++;
        } else {
            data.battlesWithoutFrags++;
        }
        
        // Обновляем данные по часам
        hourlyData[hour] += row.frags;
        
        // Обновляем данные по дням
        if (!dailyData[date]) {
            dailyData[date] = 0;
        }
        dailyData[date] += row.frags;
        
        // Добавляем в статистику по боям
        data.battleStats.push({
            frags: row.frags,
            time: battleTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
            hasFrags: row.frags > 0
        });
    });
    
    // Формируем данные по часам
    for (let hour = 0; hour < 24; hour++) {
        data.hourlyStats.push({ hour, frags: hourlyData[hour] });
    }
    
    // Находим лучший час
    const bestHourData = data.hourlyStats.reduce((max, current) => 
        current.frags > max.frags ? current : max
    );
    if (bestHourData.frags > 0) {
        data.bestHour = `${bestHourData.hour}:00 (${bestHourData.frags} фрагов)`;
        data.bestHourData = bestHourData; // Сохраняем данные для дальнейшего использования
    }
    
    // Формируем данные по дням
    Object.keys(dailyData).sort().forEach(date => {
        data.dailyStats.push({ date, frags: dailyData[date] });
    });
    
    // Вычисляем среднее количество фрагов за бой
    if (data.totalBattles > 0) {
        data.avgFragsPerBattle = (data.totalFrags / data.totalBattles).toFixed(2);
    }
    
    return data;
}


// --- Lesta: техника и достижения (хелперы) ---
const LESTA_TANK_STATS_FIELDS = 'tank_id,all,mark_of_mastery,last_battle_time,battle_life_time';

function ensureLestaConfigFromState() {
    return new Promise((resolve) => {
        getAppState((state) => {
            if (state?.lesta_application_id) LESTA_CONFIG.applicationId = state.lesta_application_id;
            if (state?.lesta_access_token) LESTA_CONFIG.accessToken = state.lesta_access_token;
            if (state?.lesta_account_id) LESTA_CONFIG.accountId = state.lesta_account_id;
            if (state?.lesta_nickname) LESTA_CONFIG.nickname = state.lesta_nickname;
            resolve(state);
        });
    });
}

function normalizeTankStatsList(apiData, accountId) {
    if (!apiData) return { tanks: [], hidden: false };
    const accKey = String(accountId);
    const raw = apiData[accKey] ?? apiData[accountId];
    if (raw === null) return { tanks: [], hidden: true };
    if (!raw) return { tanks: [], hidden: false };

    let list = [];
    if (Array.isArray(raw)) {
        list = raw;
    } else if (typeof raw === 'object') {
        list = Object.entries(raw).map(([tankId, stats]) => ({
            tank_id: Number(tankId),
            ...(typeof stats === 'object' ? stats : {})
        }));
    }

    const tanks = list
        .map((item) => ({
            ...item,
            tank_id: item.tank_id != null ? Number(item.tank_id) : item.tank_id,
            statistics: { all: item.all || {} }
        }))
        .filter((item) => (item.all?.battles || item.statistics?.all?.battles || 0) > 0);

    return { tanks, hidden: false };
}

async function enrichTanksWithVehicleNames(tanks, language = 'ru') {
    if (!tanks.length) return tanks;
    try {
        const vehiclesResponse = await axios.get(`${LESTA_CONFIG.apiUrl}/encyclopedia/vehicles/`, {
            params: {
                application_id: LESTA_CONFIG.applicationId,
                fields: 'tank_id,name,tier,type,nation,is_premium',
                language
            },
            timeout: 30000
        });
        if (vehiclesResponse.data.status !== 'ok' || !vehiclesResponse.data.data) {
            return tanks;
        }
        const vehiclesRaw = vehiclesResponse.data.data;
        const vehicles = {};
        if (Array.isArray(vehiclesRaw)) {
            vehiclesRaw.forEach((v) => {
                if (v?.tank_id != null) vehicles[v.tank_id] = v;
            });
        } else {
            Object.assign(vehicles, vehiclesRaw);
        }
        return tanks.map((tank) => {
            const vId = tank.tank_id;
            const vehicleInfo = vehicles[vId] || vehicles[String(vId)] || {};
            return {
                ...tank,
                name: vehicleInfo.name || vehicleInfo.short_name || tank.name || `Танк #${vId}`,
                tier: vehicleInfo.tier || tank.tier || 0,
                type: vehicleInfo.type || tank.type || 'unknown',
                nation: vehicleInfo.nation || tank.nation || 'unknown',
                is_premium: vehicleInfo.is_premium || tank.is_premium || false
            };
        });
    } catch (e) {
        console.warn('⚠️ Энциклопедия техники недоступна:', e.message);
        return tanks.map((tank) => ({
            ...tank,
            name: tank.name || `Танк #${tank.tank_id}`
        }));
    }
}

function tanksToSnapshotMap(tanks) {
    const map = {};
    for (const tank of tanks || []) {
        const stats = tank.statistics?.all || tank.all || {};
        const tankId = tank.tank_id;
        if (tankId == null) continue;
        map[String(tankId)] = {
            battles: Number(stats.battles) || 0,
            wins: Number(stats.wins) || 0,
            frags: Number(stats.frags) || 0,
            damage_dealt: Number(stats.damage_dealt) || 0,
            name: tank.name || '',
            tier: Number(tank.tier) || 0
        };
    }
    return map;
}

function parseTankSnapshotMap(row) {
    if (!row || !row.tanks_json) return {};
    try {
        const parsed = JSON.parse(row.tanks_json);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function insertLestaTankSnapshot(accountId, tanksMap, callback) {
    callback = callback || (() => {});
    if (!accountId || !tanksMap) return callback(null);
    db.run(
        `INSERT INTO lesta_tank_snapshots (account_id, tanks_json) VALUES (?, ?)`,
        [String(accountId), JSON.stringify(tanksMap)],
        callback
    );
}

function fetchTankSnapshotBaseline(period, accountId, reliableSinceSec, callback) {
    const dateFilter = getLestaPeriodDateFilter(period);
    const accountStr = String(accountId);
    const reliableSince = Number(reliableSinceSec) || 0;
    const reliableSql = reliableSince > 0 ? ` AND timestamp >= datetime(?, 'unixepoch')` : '';
    const anchorParams = reliableSince > 0 ? [accountStr, dateFilter, reliableSince] : [accountStr, dateFilter];
    const inPeriodParams = reliableSince > 0 ? [accountStr, dateFilter, reliableSince] : [accountStr, dateFilter];

    dbRead.get(
        `SELECT * FROM lesta_tank_snapshots
         WHERE account_id = ? AND timestamp <= datetime('now', ?)${reliableSql}
         ORDER BY timestamp DESC LIMIT 1`,
        anchorParams,
        (err, anchorRow) => {
            if (err) return callback(err);
            dbRead.get(
                `SELECT * FROM lesta_tank_snapshots
                 WHERE account_id = ? AND timestamp >= datetime('now', ?)${reliableSql}
                 ORDER BY timestamp ASC LIMIT 1`,
                inPeriodParams,
                (err2, oldestInPeriod) => {
                    if (err2) return callback(err2);
                    if (anchorRow && oldestInPeriod) {
                        const anchorTs = new Date(anchorRow.timestamp).getTime();
                        const oldestTs = new Date(oldestInPeriod.timestamp).getTime();
                        return callback(null, anchorTs <= oldestTs ? anchorRow : oldestInPeriod);
                    }
                    callback(null, anchorRow || oldestInPeriod || null);
                }
            );
        }
    );
}

function fetchNewestTankSnapshotInPeriod(period, accountId, reliableSinceSec, callback) {
    const dateFilter = getLestaPeriodDateFilter(period);
    const accountStr = String(accountId);
    const reliableSince = Number(reliableSinceSec) || 0;
    const reliableSql = reliableSince > 0 ? ` AND timestamp >= datetime(?, 'unixepoch')` : '';
    const params = reliableSince > 0 ? [accountStr, dateFilter, reliableSince] : [accountStr, dateFilter];
    dbRead.get(
        `SELECT * FROM lesta_tank_snapshots
         WHERE account_id = ? AND timestamp >= datetime('now', ?)${reliableSql}
         ORDER BY timestamp DESC LIMIT 1`,
        params,
        callback
    );
}

function computeTankPeriodChanges(currentMap, baselineMap, maxBattlesDelta) {
    maxBattlesDelta = maxBattlesDelta || LESTA_MAX_BATTLES_DELTA * 80;
    const changes = [];
    const ids = new Set([...Object.keys(currentMap || {}), ...Object.keys(baselineMap || {})]);
    ids.forEach((id) => {
        const cur = currentMap[id] || { battles: 0, wins: 0, frags: 0, damage_dealt: 0, name: '', tier: 0 };
        const base = baselineMap[id] || { battles: 0, wins: 0, frags: 0, damage_dealt: 0, name: '', tier: 0 };
        const battlesPlayed = (cur.battles || 0) - (base.battles || 0);
        if (battlesPlayed <= 0 || battlesPlayed > maxBattlesDelta) return;
        const wins = Math.max(0, (cur.wins || 0) - (base.wins || 0));
        const frags = Math.max(0, (cur.frags || 0) - (base.frags || 0));
        const damageDealt = Math.max(0, (cur.damage_dealt || 0) - (base.damage_dealt || 0));
        changes.push({
            tank_id: Number(id),
            name: cur.name || base.name || `Танк ${id}`,
            tier: cur.tier || base.tier || 0,
            battlesPlayed,
            wins,
            frags,
            winRate: battlesPlayed > 0 ? Number(((wins / battlesPlayed) * 100).toFixed(1)) : 0,
            avgDamage: battlesPlayed > 0 ? Math.round(damageDealt / battlesPlayed) : 0,
            fragsPerBattle: battlesPlayed > 0 ? Number((frags / battlesPlayed).toFixed(2)) : 0
        });
    });
    changes.sort((a, b) => b.battlesPlayed - a.battlesPlayed);
    return changes;
}

async function fetchAccountTanksForAccount(accountId, language = 'ru') {
    await ensureLestaConfigFromState();
    const targetAccountId = String(accountId || LESTA_CONFIG.accountId || '');
    if (!targetAccountId || !LESTA_CONFIG.applicationId) {
        return { tanks: [], hidden: false, error: 'NO_ACCOUNT' };
    }

    const params = {
        application_id: LESTA_CONFIG.applicationId,
        account_id: targetAccountId,
        fields: LESTA_TANK_STATS_FIELDS,
        language
    };
    if (LESTA_CONFIG.accessToken) params.access_token = LESTA_CONFIG.accessToken;

    const response = await axios.get(`${LESTA_CONFIG.apiUrl}/tanks/stats/`, {
        params,
        timeout: 60000,
        validateStatus: (status) => status < 500
    });

    if (response.data?.status === 'error') {
        return {
            tanks: [],
            hidden: false,
            error: response.data.error?.code || 'API_ERROR',
            message: response.data.error?.message
        };
    }

    const { tanks: rawTanks, hidden } = normalizeTankStatsList(response.data?.data, targetAccountId);
    if (hidden || (rawTanks.length === 0 && response.data?.data?.[targetAccountId] === null)) {
        return { tanks: [], hidden: true, error: 'STATS_HIDDEN' };
    }

    const tanks = await enrichTanksWithVehicleNames(rawTanks, language);
    return { tanks, hidden: false };
}

const LESTA_TANK_SNAPSHOT_MIN_SEC = Number(process.env.LESTA_TANK_SNAPSHOT_MIN_SEC || 600);

async function captureLestaTankSnapshot(accountId) {
    if (!accountId) return false;
    const state = await ensureLestaConfigFromState();
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - (Number(state?.lesta_last_tank_snapshot_at) || 0) < LESTA_TANK_SNAPSHOT_MIN_SEC) {
        return false;
    }

    const { tanks, hidden, error } = await fetchAccountTanksForAccount(accountId);
    if (hidden || error || !tanks.length) return false;

    const tanksMap = tanksToSnapshotMap(tanks);
    await new Promise((resolve, reject) => {
        insertLestaTankSnapshot(accountId, tanksMap, (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve) => {
        updateAppState({ lesta_last_tank_snapshot_at: nowSec }, () => resolve());
    });
    return true;
}

function scheduleLestaTankSnapshot(accountId) {
    if (!accountId) return;
    captureLestaTankSnapshot(accountId).catch((e) => {
        console.warn('⚠️ Снимок техники Lesta:', e.message);
    });
}

// Остальные Lesta-роуты (achievements, tankstats, vehicles, player-tanks,
// tank-period, prolongate, test-stats(+inject), sync, period, session, history)
// вынесены в src/modules/lesta-routes; startLestaSession/resetLestaSession — там же

// /api/analytics/* вынесены в src/modules/donations-analytics

// API для получения состояния
app.get('/api/state', (req, res) => {
    getAppState((state) => {
        if (!state) {
            return res.status(500).json({ success: false, error: 'Не удалось получить состояние' });
        }

        // Не пишем в БД на каждый GET — иначе SQLite блокируется при опросе виджетов.
        // Актуальное время стрима считается в getBroadcastState() на лету.
        const broadcastState = getBroadcastState(state);
        res.json({ success: true, state: broadcastState });
    });
});

// API для обновления состояния
app.post('/api/state', (req, res) => {
    console.log('📝 Обновление состояния через API:', req.body);
    
    // Если обновляется stream_timer_initial_elapsed_sec, также обновляем stream_timer_last_update_ts
    const updates = { ...req.body };
    if (updates.stream_timer_initial_elapsed_sec !== undefined) {
        updates.stream_timer_last_update_ts = Math.floor(Date.now() / 1000);
    }
    
    updateAppState(updates, (err) => {
        if (err) {
            res.status(500).json({ success: false, error: err.message });
        } else {
            console.log('✅ Состояние обновлено, отправляем broadcast...');
            console.log('📝 Обновленные поля:', Object.keys(updates));
            if (updates.cost_per_minute !== undefined) {
                console.log('💵 Обновление cost_per_minute:', updates.cost_per_minute);
            }
            // Получаем обновленное состояние и отправляем всем клиентам
            // Добавляем небольшую задержку, чтобы БД точно обновилась
            setTimeout(() => {
                getAppState((fullState) => {
                    if (fullState) {
                        console.log('📢 Отправка broadcast с cost_per_minute:', fullState.cost_per_minute);
                        broadcastStateUpdate(fullState);
                    } else {
                        console.error('❌ Не удалось получить состояние для broadcast');
                    }
                });
            }, 50); // Небольшая задержка для гарантии обновления БД
            res.json({ success: true });
        }
    });
});



// Ручное добавление доната
app.post('/api/manual-donation', (req, res) => {
    try {
        const { username, amount, message } = req.body;
        
        console.log('🎯 Ручной донат получен:', { username, amount, message });
        
        if (!username || !amount) {
            console.log('❌ Ошибка: Имя и сумма обязательны');
            return res.status(400).json({ error: 'Имя и сумма обязательны' });
        }

        const donationData = {
            id: `manual_${Date.now()}`,
            username: username,
            amount: parseFloat(amount),
            message: message || '',
            currency: 'RUB'
        };

        console.log(`🎯 Ручной донат: ${username} - ${amount}₽`);
        console.log('🎯 Вызываем processDonation...');
        processDonation(donationData, true);
        
        // Запускаем проверку донатов после ручного добавления
        setTimeout(() => {
            if (!isPollingInProgress) {
                console.log('🔄 Проверка донатов после ручного добавления...');
                checkForNewDonations();
            }
        }, 500);
        
        res.json({ success: true, donation: donationData });
        
    } catch (error) {
        console.error('❌ Ошибка ручного доната:', error);
        res.status(500).json({ error: 'Не удалось добавить донат' });
    }
});

// Тестовый донат
app.post('/api/test-donation', (req, res) => {
    const { username, amount, message } = req.body;
    
    const testDonation = {
        id: `test_${Date.now()}`,
        username: username || 'Тестовый Донатер',
        amount: parseFloat(amount) || 150,
        message: message || 'Это тестовый донат! 🎉',
        currency: 'RUB'
    };
    
    console.log('🧪 Тестовый донат:', testDonation.username, '-', testDonation.amount + '₽');
    processDonation(testDonation, true);
    res.json({ success: true, donation: testDonation });
});

// Исправить рассинхронизацию total_donated
app.post('/api/fix-total-donated', (req, res) => {
    console.log('🔧 Исправляем рассинхронизацию total_donated...');
    
    // Получаем реальную сумму из таблицы donations
    db.get('SELECT SUM(amount) as totalAmount FROM donations', (err, donationsRow) => {
        if (err) {
            console.error('❌ Ошибка при получении суммы донатов:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        const realTotalAmount = donationsRow ? donationsRow.totalAmount : 0;
        console.log('📊 Реальная сумма из таблицы donations:', realTotalAmount);
        
        // Обновляем total_donated в app_state
        db.run('UPDATE app_state SET total_donated = ? WHERE id = 1', [realTotalAmount], function(err) {
            if (err) {
                console.error('❌ Ошибка при обновлении total_donated:', err);
                return res.status(500).json({ success: false, error: err.message });
            }
            
            console.log('✅ total_donated успешно обновлен до:', realTotalAmount);
            console.log('🔄 Изменений в БД:', this.changes);
            
            res.json({ 
                success: true, 
                message: 'total_donated исправлен',
                oldValue: '59856514.07',
                newValue: realTotalAmount,
                changes: this.changes
            });
        });
    });
});

// Обнулить количество донатов (удалить все записи из таблицы donations)
app.post('/api/reset-donations-count', (req, res) => {
    console.log('🔄 Обнуляем количество донатов...');
    // Проверяем наличие таблицы donations
    db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name='donations'`, (tableErr, tables) => {
        if (tableErr) {
            console.error('❌ Ошибка проверки таблицы donations:', tableErr);
            // Даже если ошибка проверки, всё равно обнуляем total_donated и оповещаем клиентов
            return db.run('UPDATE app_state SET total_donated = 0 WHERE id = 1', function(uErr) {
                if (uErr) {
                    console.error('❌ Ошибка при обновлении total_donated:', uErr);
                    return res.status(500).json({ success: false, error: uErr.message });
                }
                broadcastStateUpdate();
                broadcastToClients({ type: 'DONATIONS_RESET' });
                res.json({ success: true, message: 'Сумма донатов обнулена (таблица недоступна)', deletedCount: 0, totalDonated: 0 });
            });
        }

        const proceedAfterDelete = (deletedCount) => {
            db.run('UPDATE app_state SET total_donated = 0 WHERE id = 1', function(err) {
                if (err) {
                    console.error('❌ Ошибка при обновлении total_donated:', err);
                    return res.status(500).json({ success: false, error: err.message });
                }
                console.log('✅ total_donated обновлен до 0');
                broadcastStateUpdate();
                broadcastToClients({ type: 'DONATIONS_RESET' });
                res.json({ success: true, message: 'Количество донатов обнулено', deletedCount, totalDonated: 0 });
            });
        };

        // Если таблицы нет — просто обнуляем total_donated
        if (!tables || tables.length === 0) {
            console.warn('⚠️ Таблица donations не найдена — обнуляем только сумму');
            return proceedAfterDelete(0);
        }

        // Удаляем все записи из таблицы donations
        db.run('DELETE FROM donations', function(err) {
            if (err) {
                console.error('❌ Ошибка при удалении донатов:', err);
                // Даже если удаление не удалось — обнулим сумму в состоянии, чтобы UI синхронизировался
                return proceedAfterDelete(0);
            }
            console.log('✅ Все донаты удалены из таблицы donations');
            console.log('🗑️ Удалено записей:', this.changes);
            proceedAfterDelete(this.changes || 0);
        });
    });
});

// /api/donations-analytics, /api/donations-timer-analysis, /api/donations-mode-analysis,
// /api/timer-modes-analytics, /api/donors-grouped, /api/donations-stats,
// /api/donations-stats-small-donors-debug, /api/donations-stats-small-donors
// вынесены в src/modules/donations-analytics

// Получить историю донатов
app.get('/api/donations', (req, res) => {
    const requestedLimit = parseInt(req.query.limit, 10);
    const requestedOffset = parseInt(req.query.offset, 10);
    const limit = Math.min(Math.max(requestedLimit && requestedLimit > 0 ? requestedLimit : 200, 1), 1000);
    const offset = Math.max(requestedOffset && requestedOffset > 0 ? requestedOffset : 0, 0);

    getDonations(limit, offset, (err, donations) => {
        if (err) {
            if (err.message && err.message.includes('no such table')) {
                return res.json({ donations: [], total: 0, offset, limit, nextOffset: offset });
            }
            return res.status(500).json({ error: 'Не удалось получить донаты' });
        }
        res.json({
            donations: (donations || []).map(d => ({
                ...d,
                isRealtime: d.is_realtime === 1,
                timestamp: new Date(d.created_at).toLocaleTimeString('ru-RU')
            })),
            total: (donations || []).length,
            offset,
            limit,
            nextOffset: offset + (donations || []).length
        });
    });
});

// Корректировка суммы донатора и общей суммы
app.post('/api/donations/adjust', express.json(), (req, res) => {
    const { username, amount } = req.body || {};
    
    if (!username || amount === undefined || amount === 0) {
        return res.status(400).json({ success: false, error: 'Укажите username и amount (может быть отрицательным)' });
    }
    
    const adjustAmount = parseFloat(amount);
    console.log(`🔧 Корректировка суммы донатора: ${username}, сумма: ${adjustAmount}₽`);
    
    // Получаем текущее состояние
    db.get('SELECT timer_seconds, total_donated FROM app_state WHERE id = 1', (err, state) => {
        if (err) {
            console.error('❌ Ошибка получения состояния:', err);
            return res.status(500).json({ success: false, error: 'Ошибка получения состояния' });
        }
        
        const currentTotalDonated = state.total_donated || 0;
        const newTotalDonated = Math.max(0, currentTotalDonated - adjustAmount);
        
        console.log(`📊 Текущая общая сумма: ${currentTotalDonated}₽`);
        console.log(`📊 Новая общая сумма: ${newTotalDonated}₽ (изменение: ${-adjustAmount}₽)`);
        
        // Создаем корректирующий донат с отрицательной суммой
        const correctionId = `correction_${Date.now()}`;
        const normalizedUsername = normalizeUsername(username);
        
        // Вычисляем время, которое нужно вычесть (если adjustAmount отрицательный, то время тоже отрицательное)
        // Используем текущую стоимость минуты из состояния
        db.get('SELECT cost_per_minute FROM app_state WHERE id = 1', (err, costState) => {
            if (err) {
                console.error('❌ Ошибка получения стоимости:', err);
                return res.status(500).json({ success: false, error: 'Ошибка получения стоимости' });
            }
            
            const costPerMinute = costState?.cost_per_minute || 50;
            const secondsPerRuble = 60 / costPerMinute;
            const timeAdjustment = Math.floor(adjustAmount * secondsPerRuble);
            
            // Вставляем корректирующий донат
            db.run(
                `INSERT INTO donations (id, username, amount, message, currency, is_realtime, time_earned, normalized_username, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
                [correctionId, username, -adjustAmount, `Корректировка суммы: ${adjustAmount > 0 ? '+' : ''}${adjustAmount}₽`, 'RUB', 0, -timeAdjustment, normalizedUsername],
                function(err) {
                    if (err) {
                        console.error('❌ Ошибка создания корректирующего доната:', err);
                        return res.status(500).json({ success: false, error: 'Ошибка создания корректирующего доната' });
                    }
                    
                    console.log(`✅ Корректирующий донат создан (ID: ${correctionId})`);
                    
                    // Обновляем общую сумму в состоянии
                    db.run(
                        'UPDATE app_state SET total_donated = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
                        [newTotalDonated],
                        function(err) {
                            if (err) {
                                console.error('❌ Ошибка обновления общей суммы:', err);
                                return res.status(500).json({ success: false, error: 'Ошибка обновления общей суммы' });
                            }
                            
                            console.log('✅ Общая сумма обновлена');
                            
                            // Получаем полное состояние для отправки клиентам
                            getAppState((fullState) => {
                                if (fullState) {
                                    // Отправляем обновление состояния
                                    broadcastStateUpdate();
                                    // Отправляем специальное сообщение о корректировке
                                    broadcastToClients({ 
                                        type: 'DONATION_ADJUSTED',
                                        username,
                                        adjustAmount,
                                        newTotalDonated,
                                        state: fullState
                                    });
                                } else {
                                    // Если не удалось получить состояние, отправляем хотя бы сообщение
                                    broadcastToClients({ 
                                        type: 'DONATION_ADJUSTED',
                                        username,
                                        adjustAmount,
                                        newTotalDonated
                                    });
                                }
                            });
                            
                            res.json({ 
                                success: true,
                                message: 'Сумма скорректирована',
                                username,
                                adjustAmount,
                                newTotalDonated,
                                correctionDonationId: correctionId
                            });
                        }
                    );
                }
            );
        });
    });
});

// Добавление доната только для топа дня (без изменения общей суммы)
app.post('/api/donations/add-for-top', express.json(), (req, res) => {
    const { username, amount, message } = req.body || {};
    
    if (!username || amount === undefined || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Укажите username и amount (должен быть положительным)' });
    }
    
    const donationAmount = parseFloat(amount);
    console.log(`📊 Добавление доната для топа дня: ${username}, сумма: ${donationAmount}₽`);
    
    const donationId = `manual_top_${Date.now()}`;
    const normalizedUsername = normalizeUsername(username);
    const donationMessage = message || `Донат для топа дня: ${donationAmount}₽`;
    
    console.log(`📅 Создание доната для топа дня:`);
    console.log(`   - Пользователь: ${username} (normalized: ${normalizedUsername})`);
    console.log(`   - Сумма: ${donationAmount}₽`);
    
    // Используем datetime('now') в SQLite для получения локального времени сервера
    // Это гарантирует, что дата будет в том же формате, что и CURRENT_TIMESTAMP
    db.run(
        `INSERT INTO donations (id, username, amount, message, currency, is_realtime, time_earned, normalized_username, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [donationId, username, donationAmount, donationMessage, 'RUB', 0, 0, normalizedUsername],
        function(err) {
            if (err) {
                console.error('❌ Ошибка создания доната для топа:', err);
                return res.status(500).json({ success: false, error: 'Ошибка создания доната' });
            }
            
            console.log(`✅ Донат для топа дня создан (ID: ${donationId})`);
            
            // Получаем созданную дату из базы для проверки
            db.get(
                `SELECT created_at FROM donations WHERE id = ?`,
                [donationId],
                (dateErr, row) => {
                    if (!dateErr && row) {
                        console.log(`   - Дата создания (из БД): ${row.created_at}`);
                    }
                    
                    // Проверяем, что донат попал в топ дня
                    const now = new Date();
                    const todayStart = new Date(now);
                    todayStart.setHours(0, 0, 0, 0);
                    const todayEnd = new Date(todayStart.getTime() + 86400000);
                    
                    // SQLite datetime('now') возвращает локальное время в формате 'YYYY-MM-DD HH:MM:SS'
                    // Используем тот же формат для сравнения
                    const formatSqlDate = (date) => {
                        const year = date.getFullYear();
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const day = String(date.getDate()).padStart(2, '0');
                        const hours = String(date.getHours()).padStart(2, '0');
                        const minutes = String(date.getMinutes()).padStart(2, '0');
                        const seconds = String(date.getSeconds()).padStart(2, '0');
                        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
                    };
                    
                    const todayStartStr = formatSqlDate(todayStart);
                    const todayEndStr = formatSqlDate(todayEnd);
                    
                    console.log(`🔍 Проверка доната в топе дня:`);
                    console.log(`   - Дата начала дня (локальное): ${todayStartStr}`);
                    console.log(`   - Дата конца дня (локальное): ${todayEndStr}`);
                    console.log(`   - Normalized username: ${normalizedUsername}`);
                    
                    // Проверяем все донаты пользователя за сегодня
                    db.all(
                        `SELECT id, amount, created_at FROM donations 
                         WHERE normalized_username = ? AND created_at >= ? AND created_at < ?
                         ORDER BY created_at DESC`,
                        [normalizedUsername, todayStartStr, todayEndStr],
                        (checkErr, rows) => {
                            if (!checkErr && rows) {
                                const total = rows.reduce((sum, r) => sum + (r.amount || 0), 0);
                                console.log(`📊 Проверка: найдено ${rows.length} донатов ${username} за сегодня, сумма: ${total}₽`);
                                rows.forEach(r => {
                                    console.log(`   - ${r.id}: ${r.amount}₽, дата: ${r.created_at}`);
                                });
                            } else if (checkErr) {
                                console.error('❌ Ошибка проверки донатов:', checkErr);
                            }
                        }
                    );
                }
            );
            
            // Отправляем обновление для виджетов топа
            broadcastToClients({ 
                type: 'TOP_DONORS_UPDATE',
                message: 'Обновление топа донатеров'
            });
            
            res.json({ 
                success: true,
                message: 'Донат добавлен для топа дня',
                username,
                amount: donationAmount,
                donationId: donationId
            });
        }
    );
});

// Удаление конкретного доната по ID
app.post('/api/donations/delete', express.json(), (req, res) => {
    const { donationId } = req.body || {};
    
    if (!donationId) {
        return res.status(400).json({ success: false, error: 'Не указан ID доната' });
    }
    
    console.log(`🗑️ Удаление доната ID: ${donationId}`);
    
    // Сначала получаем информацию о донате
    db.get('SELECT id, username, amount, time_earned FROM donations WHERE id = ?', [donationId], (err, donation) => {
        if (err) {
            console.error('❌ Ошибка получения доната:', err);
            return res.status(500).json({ success: false, error: 'Ошибка получения доната' });
        }
        
        if (!donation) {
            return res.status(404).json({ success: false, error: 'Донат не найден' });
        }
        
        const amountToRemove = donation.amount || 0;
        const timeToRemove = donation.time_earned || 0;
        
        console.log(`📊 Донат найден: ${donation.username} - ${amountToRemove}₽, время: ${timeToRemove}с`);
        
        // Получаем текущее состояние
        db.get('SELECT timer_seconds, total_donated FROM app_state WHERE id = 1', (err, state) => {
            if (err) {
                console.error('❌ Ошибка получения состояния:', err);
                return res.status(500).json({ success: false, error: 'Ошибка получения состояния' });
            }
            
            const currentTimerSeconds = state.timer_seconds || 0;
            const currentTotalDonated = state.total_donated || 0;
            
            const newTimerSeconds = Math.max(0, currentTimerSeconds - timeToRemove);
            const newTotalDonated = Math.max(0, currentTotalDonated - amountToRemove);
            
            console.log(`📊 Текущее состояние: таймер=${currentTimerSeconds}с, донатов=${currentTotalDonated}₽`);
            console.log(`📊 Новое состояние: таймер=${newTimerSeconds}с, донатов=${newTotalDonated}₽`);
            
            // Удаляем донат
            db.run('DELETE FROM donations WHERE id = ?', [donationId], function(err) {
                if (err) {
                    console.error('❌ Ошибка удаления доната:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка удаления доната' });
                }
                
                if (this.changes === 0) {
                    return res.status(404).json({ success: false, error: 'Донат не найден' });
                }
                
                console.log(`✅ Донат удален (ID: ${donationId})`);
                
                // Обновляем состояние
                db.run(
                    'UPDATE app_state SET timer_seconds = ?, total_donated = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
                    [newTimerSeconds, newTotalDonated],
                    function(err) {
                        if (err) {
                            console.error('❌ Ошибка обновления состояния:', err);
                            return res.status(500).json({ success: false, error: 'Ошибка обновления состояния' });
                        }
                        
                        console.log('✅ Состояние обновлено');
                        
                        // Отправляем обновление клиентам
                        broadcastStateUpdate();
                        broadcastToClients({ 
                            type: 'DONATION_DELETED',
                            donationId,
                            newTimerSeconds,
                            newTotalDonated
                        });
                        
                        res.json({ 
                            success: true,
                            message: 'Донат удален',
                            removedAmount: amountToRemove,
                            removedTime: timeToRemove,
                            newTimerSeconds,
                            newTotalDonated
                        });
                    }
                );
            });
        });
    });
});

app.get('/api/donors', (req, res) => {
    const requestedLimit = parseInt(req.query.limit, 10);
    const requestedOffset = parseInt(req.query.offset, 10);
    const limit = Math.min(Math.max(requestedLimit && requestedLimit > 0 ? requestedLimit : 100, 1), 1000);
    const offset = Math.max(requestedOffset && requestedOffset > 0 ? requestedOffset : 0, 0);

    function queryDonors(tryFallback = false) {
        const normalizedExpr = donationsHasNormalizedUsername ? "NULLIF(normalized_username, '')" : null;
        const groupExpression = normalizedExpr ? `COALESCE(${normalizedExpr}, username)` : 'username';
        const donorsQuery = `
            SELECT
                ${groupExpression} AS normalized_username,
                MAX(username) AS username,
                COUNT(*) AS donations_count,
                SUM(amount) AS total_amount,
                SUM(time_earned) AS total_time_seconds,
                MAX(created_at) AS last_donation
            FROM donations
            WHERE username IS NOT NULL 
              AND username != '' 
              AND username != 'Zhuzhu'
              AND (${normalizedExpr || "username"} IS NULL OR ${normalizedExpr || "username"} != '${normalizeUsername('Zhuzhu')}')
            GROUP BY ${groupExpression}
            ORDER BY total_amount DESC
            LIMIT ? OFFSET ?
        `;

        db.all(donorsQuery, [limit, offset], (err, donors) => {
            if (err) {
                if (!tryFallback && err.message && err.message.includes('normalized_username')) {
                    console.warn('⚠️ normalized_username не найден, пробуем без него');
                    donationsHasNormalizedUsername = false;
                    return queryDonors(true);
                }
                if (err.message && err.message.includes('no such table')) {
                    return res.json({
                        success: true,
                        donors: [],
                        totalUnique: 0,
                        offset,
                        limit,
                        nextOffset: offset
                    });
                }

                console.error('❌ Ошибка получения донатеров:', err);
                return res.status(500).json({ success: false, error: 'Не удалось получить донатеров' });
            }

            const distinctExpr = normalizedExpr ? `DISTINCT ${groupExpression}` : 'DISTINCT username';
            db.get(`SELECT COUNT(${distinctExpr}) AS total_unique FROM donations`, (countErr, row) => {
                if (countErr) {
                    if (countErr.message && countErr.message.includes('no such table')) {
                        return res.json({
                            success: true,
                            donors: [],
                            totalUnique: 0,
                            offset,
                            limit,
                            nextOffset: offset
                        });
                    }
                    console.error('❌ Ошибка подсчета донатеров:', countErr);
                }

                res.json({
                    success: true,
                    donors: (donors || []).map(donor => ({
                        normalized_username: donor.normalized_username,
                        username: donor.username,
                        donations_count: donor.donations_count || 0,
                        total_amount: Math.round(donor.total_amount || 0),
                        total_time_seconds: donor.total_time_seconds || 0,
                        last_donation: donor.last_donation || null
                    })),
                    totalUnique: row?.total_unique || (donors || []).length,
                    offset,
                    limit,
                    nextOffset: offset + (donors || []).length
                });
            });
        });
    }

    queryDonors();
});

app.get('/api/top-donors', (req, res) => {
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Math.min(Math.max(!isNaN(requestedLimit) ? requestedLimit : 10, 1), 20);
    const isDaily = req.query.daily === '1' || req.query.daily === 'true';

    const normalizeDateInput = (value) => {
        if (!value) return null;
        const date = new Date(value);
        if (isNaN(date.getTime())) return null;
        return date;
    };

    let startDate = null;
    let endDate = null;

    // Функция для форматирования даты в формат SQLite (локальное время)
    const formatSqlDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    };

    if (isDaily) {
        const now = new Date();
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        endDate = new Date(startDate.getTime() + 86400000);
        
        // Логируем для отладки
        console.log(`📅 Топ дня: начало дня = ${formatSqlDate(startDate)}, конец дня = ${formatSqlDate(endDate)}`);
    } else {
        startDate = normalizeDateInput(req.query.startDate);
        endDate = normalizeDateInput(req.query.endDate);
    }

    // Определяем выражение для нормализованного имени ДО использования
    const normalizedExpr = "CASE WHEN d.normalized_username IS NULL OR TRIM(d.normalized_username) = '' THEN d.username ELSE d.normalized_username END";
    const aggregatedAlias = 'aggregated_username';

    const conditions = [];
    const params = [];
    if (startDate) {
        conditions.push('d.created_at >= ?');
        params.push(formatSqlDate(startDate));
    }
    if (endDate) {
        conditions.push('d.created_at <= ?');
        params.push(formatSqlDate(endDate));
    }

    // Исключаем Zhuzhu из топов (проверяем и username, и normalized_username)
    conditions.push(`d.username != ? AND (d.normalized_username IS NULL OR d.normalized_username = '' OR d.normalized_username != ?)`);
    params.push('Zhuzhu');
    const excludedNorm = normalizeUsername('Zhuzhu');
    params.push(excludedNorm);

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
        SELECT 
            ${normalizedExpr} AS ${aggregatedAlias},
            MAX(d.username) AS username,
            COUNT(*) AS donation_count,
            SUM(d.amount) AS total_amount,
            SUM(d.time_earned) AS total_time_seconds,
            dat.id AS tier_id,
            dat.name AS tier_name,
            dat.icon AS tier_icon,
            dat.custom_icon_url AS tier_custom_icon_url,
            dat.color AS tier_color
        FROM donations d
        LEFT JOIN donor_achievements da ON da.normalized_username = ${normalizedExpr}
        LEFT JOIN donor_achievement_tiers dat ON dat.id = da.current_tier_id
            ${whereClause}
        GROUP BY ${aggregatedAlias}
        ORDER BY total_amount DESC
        LIMIT ?
    `;

    params.push(limit);

    // Логируем запрос для отладки
    if (isDaily) {
        console.log(`🔍 Запрос топа дня: WHERE created_at >= '${formatSqlDate(startDate)}' AND created_at <= '${formatSqlDate(endDate)}'`);
    }

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('❌ Ошибка получения топ-донатеров:', err);
            return res.status(500).json({ success: false, error: err.message });
        }

        const donors = (rows || []).map(row => ({
            normalized_username: row[aggregatedAlias],
            username: row.username,
            donations_count: row.donation_count || 0,
            total_amount: Math.round(row.total_amount || 0),
            total_time_seconds: row.total_time_seconds || 0,
            tier_id: row.tier_id,
            tier_name: row.tier_name,
            tier_icon: row.tier_icon,
            tier_custom_icon_url: row.tier_custom_icon_url,
            tier_color: row.tier_color || '#f5f5f5'
        }));

        // Логируем топ донатеров для отладки
        if (isDaily) {
            console.log(`📊 Топ дня (api/top-donors, daily=1): найдено ${donors.length} донатеров`);
            donors.slice(0, 5).forEach(d => {
                console.log(`   - ${d.username} (${d.normalized_username}): ${d.total_amount}₽, ${d.donations_count} донатов`);
            });
        } else {
            console.log('📊 Топ донатеров (api/top-donors):', donors.slice(0, 5).map(d => `${d.username} (${d.normalized_username}): ${d.total_amount}₽, ${d.donations_count} донатов`).join(', '));
        }
        
        // Проверяем, есть ли Бетмен в топе
        const batman = donors.find(d => d.normalized_username && d.normalized_username.toLowerCase().includes('бетмен'));
        if (batman) {
            console.log(`🦇 Бетмен найден в топе: ${batman.username} (${batman.normalized_username}) - ${batman.total_amount}₽, ${batman.donations_count} донатов`);
        } else {
            console.log('⚠️ Бетмен НЕ найден в топе донатеров');
        }

        res.json({
            success: true,
            donors,
            period: {
                type: isDaily ? 'daily' : 'range',
                start: startDate ? startDate.toISOString() : null,
                end: endDate ? endDate.toISOString() : null
            }
        });
    });
});

// Endpoint для общего топа донатеров (используется виджетом)
app.get('/api/donors/top', (req, res) => {
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Math.min(Math.max(!isNaN(requestedLimit) ? requestedLimit : 10, 1), 100);
    const fromDate = req.query.from_date;

    const formatSqlDate = (date) => date.toISOString().replace('T', ' ').split('.')[0];

    // Определяем выражение для нормализованного имени ДО использования
    const normalizedExpr = "CASE WHEN d.normalized_username IS NULL OR TRIM(d.normalized_username) = '' THEN d.username ELSE d.normalized_username END";
    const aggregatedAlias = 'aggregated_username';

    const conditions = [];
    const params = [];
    if (fromDate) {
        conditions.push('d.created_at >= ?');
        params.push(formatSqlDate(new Date(fromDate)));
    }

    // Исключаем Zhuzhu из топов
    conditions.push(`d.username != ? AND (d.normalized_username IS NULL OR d.normalized_username = '' OR d.normalized_username != ?)`);
    params.push('Zhuzhu');
    const excludedNorm = normalizeUsername('Zhuzhu');
    params.push(excludedNorm);

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
        SELECT 
            ${normalizedExpr} AS ${aggregatedAlias},
            MAX(d.username) AS username,
            COUNT(*) AS donation_count,
            SUM(d.amount) AS total_amount,
            SUM(d.time_earned) AS total_time_seconds,
            dat.id AS tier_id,
            dat.name AS tier_name,
            dat.icon AS tier_icon,
            dat.custom_icon_url AS tier_custom_icon_url,
            dat.color AS tier_color
        FROM donations d
        LEFT JOIN donor_achievements da ON da.normalized_username = ${normalizedExpr}
        LEFT JOIN donor_achievement_tiers dat ON dat.id = da.current_tier_id
            ${whereClause}
        GROUP BY ${aggregatedAlias}
        ORDER BY total_amount DESC
        LIMIT ?
    `;

    params.push(limit);

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('❌ Ошибка получения топ-донатеров:', err);
            return res.status(500).json({ success: false, error: err.message });
        }

        const donors = (rows || []).map(row => ({
            normalized_username: row[aggregatedAlias],
            username: row.username,
            donations_count: row.donation_count || 0,
            total_amount: Math.round(row.total_amount || 0),
            total_time_seconds: row.total_time_seconds || 0,
            display_amount: Math.round(row.total_amount || 0),
            display_time_earned: row.total_time_seconds || 0,
            period_time_earned: row.total_time_seconds || 0,
            tier_info: row.tier_id ? {
                id: row.tier_id,
                title: row.tier_name,
                icon: row.tier_icon,
                icon_path: row.tier_custom_icon_url,
                color: row.tier_color || '#f5f5f5'
            } : null
        }));

        res.json({
            success: true,
            donors
        });
    });
});

// Endpoint для топа донатеров за сутки
app.get('/api/donors/top/today', (req, res) => {
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Math.min(Math.max(!isNaN(requestedLimit) ? requestedLimit : 10, 1), 100);

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    
    // Используем локальное время для совместимости с datetime('now') в SQLite
    const formatSqlDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    };

    // Определяем выражение для нормализованного имени ДО использования
    const normalizedExpr = "CASE WHEN d.normalized_username IS NULL OR TRIM(d.normalized_username) = '' THEN d.username ELSE d.normalized_username END";
    const aggregatedAlias = 'aggregated_username';

    // Исключаем Zhuzhu из топов
    const excludedNorm = normalizeUsername('Zhuzhu');

    const query = `
        SELECT 
            ${normalizedExpr} AS ${aggregatedAlias},
            MAX(d.username) AS username,
            COUNT(*) AS donation_count,
            SUM(d.amount) AS today_amount,
            SUM(d.time_earned) AS today_time_earned,
            dat.id AS tier_id,
            dat.name AS tier_name,
            dat.icon AS tier_icon,
            dat.custom_icon_url AS tier_custom_icon_url,
            dat.color AS tier_color
        FROM donations d
        LEFT JOIN donor_achievements da ON da.normalized_username = ${normalizedExpr}
        LEFT JOIN donor_achievement_tiers dat ON dat.id = da.current_tier_id
        WHERE d.created_at >= ?
          AND d.username != ?
          AND (d.normalized_username IS NULL OR d.normalized_username = '' OR d.normalized_username != ?)
        GROUP BY ${aggregatedAlias}
        ORDER BY today_amount DESC
        LIMIT ?
    `;

    db.all(query, [formatSqlDate(todayStart), 'Zhuzhu', excludedNorm, limit], (err, rows) => {
        if (err) {
            console.error('❌ Ошибка получения топа за сутки:', err);
            return res.status(500).json({ success: false, error: err.message });
        }

        const donors = (rows || []).map(row => ({
            normalized_username: row[aggregatedAlias],
            username: row.username,
            donations_count: row.donation_count || 0,
            today_amount: Math.round(row.today_amount || 0),
            today_time_earned: row.today_time_earned || 0,
            display_amount: Math.round(row.today_amount || 0),
            display_time_earned: row.today_time_earned || 0,
            tier_info: row.tier_id ? {
                id: row.tier_id,
                title: row.tier_name,
                icon: row.tier_icon,
                icon_path: row.tier_custom_icon_url,
                color: row.tier_color || '#f5f5f5'
            } : null
        }));

        res.json({
            success: true,
            donors
        });
    });
});

// Ручное добавление доната (для добавления записей в топ)
// Очистка истории донатов
app.post('/api/clear-donations', (req, res) => {
    db.run('DELETE FROM donations', (err) => {
        if (err) {
            console.error('❌ Ошибка очистки донатов:', err);
            res.status(500).json({ error: 'Не удалось очистить донаты' });
        } else {
            console.log('✅ История донатов очищена');
            processedDonationIds.clear();
            db.run('DELETE FROM donor_achievements', (achievementErr) => {
                if (achievementErr) {
                    console.error('❌ Не удалось очистить достижения донатеров:', achievementErr);
                } else {
                    console.log('✅ Достижения донатеров также очищены');
                }
            });
            res.json({ success: true });
        }
    });
});

// Сброс статистики
app.post('/api/reset-stats', (req, res) => {
    const { mode } = req.body;
    
    console.log('🔄 Сброс статистики для режима:', mode);
    
    let resetState = {
        total_donated: 0,
        timer_discount: 0,
        stream_timer_initial_elapsed_sec: 0,
        stream_timer_last_update_ts: 0,
        stream_timer_started_ts: 0
    };
    
    if (mode === 'mode1' || mode === 'all') {
        resetState = {
            ...resetState,
            frags_needed: 10,
            frags_done: 0,
            current_balance: 0,
            frag_cost: 50,
            frag_amount: 1,
            frag_name: "фраг",
            widget_left_label: "ОСТАЛОСЬ",
            widget_right_label: "СДЕЛАНО",
            widget_progress_label: "До +1 фрага:"
        };
    }
    
    if (mode === 'mode2' || mode === 'all') {
        resetState = {
            ...resetState,
            timer_seconds: 0,
            timer_paused: 0,
            cost_per_minute: 50,
            timer_alert_text: "добавил времени",
            timer_slowdown_active: 0,
            timer_slowdown_factor: 1.0,
            timer_slowdown_until_ts: 0
        };
    }
    
    if (mode === 'mode3' || mode === 'all') {
        resetState = {
            ...resetState,
            custom_units_needed: 10,
            custom_units_done: 0,
            custom_current_balance: 0,
            custom_unit_cost: 50,
            custom_unit_amount: 1,
            custom_goal_name: "единица",
            custom_widget_left_label: "ОСТАЛОСЬ",
            custom_widget_right_label: "СДЕЛАНО",
            custom_alert_text: "добавил к цели"
        };
    }
    
    updateAppState(resetState, (err) => {
        if (err) {
            console.error('❌ Ошибка сброса статистики:', err);
            return res.status(500).json({ error: 'Не удалось сбросить статистику' });
        }
        
        // Очищаем историю донатов если полный сброс
        if (mode === 'all') {
            db.run('DELETE FROM donations', (err) => {
                if (err) {
                    console.error('❌ Ошибка очистки донатов:', err);
                } else {
                    console.log('✅ История донатов очищена');
                }
                
                processedDonationIds.clear();
                console.log('✅ Множество обработанных донатов очищено');
            db.run('DELETE FROM donor_achievements', (achievementErr) => {
                if (achievementErr) {
                    console.error('❌ Не удалось очистить достижения донатеров при сбросе', achievementErr);
                } else {
                    console.log('✅ Достижения донатеров очищены при сбросе');
                }
            });
                
                console.log('✅ Статистика сброшена для режима:', mode);
                res.json({ success: true });
            });
        } else {
            processedDonationIds.clear();
            console.log('✅ Статистика сброшена для режима:', mode);
            res.json({ success: true });
        }
    });
});

// Удаление донатора и всех его донатов по имени
app.post('/api/admin/delete-donor', (req, res) => {
    const { username } = req.body || {};

    if (!username || typeof username !== 'string' || !username.trim()) {
        return res.status(400).json({ success: false, error: 'Некорректное имя донатера' });
    }

    const rawName = username.trim();
    const normalizedName = normalizeUsername(rawName);

    console.log(`🧹 Запрос на удаление донатора: "${rawName}" (normalized: "${normalizedName}")`);

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Сначала получаем все донаты этого пользователя, чтобы скорректировать цель сбора
        db.all(
            'SELECT amount FROM donations WHERE username = ? OR normalized_username = ?',
            [rawName, normalizedName],
            (selectErr, rows) => {
                if (selectErr) {
                    console.error('❌ Ошибка выборки донатов донатора:', selectErr);
                    db.run('ROLLBACK');
                    return res.status(500).json({ success: false, error: 'Ошибка выборки донатов' });
                }

                const totalAmountToRemove = (rows || []).reduce((sum, row) => sum + (row.amount || 0), 0);
                const donationCountToRemove = (rows || []).length;

                // Удаляем из основной таблицы донатов
                db.run(
                    'DELETE FROM donations WHERE username = ? OR normalized_username = ?',
                    [rawName, normalizedName],
                    function (err) {
                        if (err) {
                            console.error('❌ Ошибка удаления донатов донатора:', err);
                            db.run('ROLLBACK');
                            return res.status(500).json({ success: false, error: 'Ошибка удаления донатов' });
                        }

                        const deletedDonations = this.changes || 0;
                        console.log(`🧹 Удалено донатов из таблицы donations: ${deletedDonations}`);

                        // Корректируем цель сбора и историю цели
                        db.get('SELECT * FROM donation_goals WHERE id = 1', (goalErr, goal) => {
                            if (goalErr) {
                                console.error('❌ Ошибка получения цели сбора при удалении донатора:', goalErr);
                            } else if (goal && donationCountToRemove > 0 && totalAmountToRemove > 0) {
                                const newCurrent = Math.max(0, (goal.current_amount || 0) - totalAmountToRemove);
                                const newTotalCount = Math.max(0, (goal.total_donations || 0) - donationCountToRemove);
                                const newAvg = newTotalCount > 0 ? newCurrent / newTotalCount : 0;

                                db.run(
                                    `UPDATE donation_goals SET 
                                        current_amount = ?, 
                                        total_donations = ?, 
                                        avg_donation = ?, 
                                        updated_at = ?
                                     WHERE id = 1`,
                                    [newCurrent, newTotalCount, newAvg, new Date().toISOString()],
                                    (updErr) => {
                                        if (updErr) {
                                            console.error('❌ Ошибка корректировки цели сбора при удалении донатора:', updErr);
                                        } else {
                                            console.log(`🧹 Цель сбора скорректирована: -${totalAmountToRemove}₽, -${donationCountToRemove} донатов`);
                                        }
                                    }
                                );
                            }
                        });

                        // Удаляем донаты этого пользователя из истории цели
                        db.run(
                            'DELETE FROM goal_donations WHERE username = ?',
                            [rawName],
                            (goalDonErr) => {
                                if (goalDonErr) {
                                    console.error('❌ Ошибка удаления донатов донатора из goal_donations:', goalDonErr);
                                } else {
                                    console.log('🧹 Удалены записи донатора из goal_donations');
                                }
                            }
                        );

                        // Удаляем достижения донатора
                        db.run(
                            'DELETE FROM donor_achievements WHERE normalized_username = ?',
                            [normalizedName],
                            function (achErr) {
                                if (achErr) {
                                    console.error('❌ Ошибка удаления достижений донатора:', achErr);
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ success: false, error: 'Ошибка удаления достижений донатора' });
                                }

                                console.log(`🧹 Удалены достижения донатора "${rawName}"`);

                                db.run('COMMIT', (commitErr) => {
                                    if (commitErr) {
                                        console.error('❌ Ошибка фиксации транзакции при удалении донатора:', commitErr);
                                        return res.status(500).json({ success: false, error: 'Ошибка фиксации изменений' });
                                    }

                                    console.log(`✅ Донатор "${rawName}" полностью удалён из базы (донаты, топы, статистика сбора)`);
                                    res.json({
                                        success: true,
                                        deletedDonations,
                                        removedFromGoalAmount: totalAmountToRemove,
                                        removedFromGoalCount: donationCountToRemove
                                    });
                                });
                            }
                        );
                    }
                );
            }
        );
    });
});

// ==================== API для сбора донатов ====================
// ==================== API для сбора донатов (вынесено в src/modules/donation-widgets) ====================
donationWidgetsModule.registerRoutes(app);

// --- Виджет «параметр от донатов» вынесен в src/modules/donation-driven-widget ---
const { createDonationDrivenWidgetModule } = require("./src/modules/donation-driven-widget");
const donationDrivenWidgetModule = createDonationDrivenWidgetModule({
    db,
    broadcastToClients: (...args) => broadcastToClients(...args),
    getAppState: (...args) => getAppState(...args),
    updateAppState: (...args) => updateAppState(...args)
});
const {
    getDonationDrivenWidgetById,
    normalizeDonationDrivenWidgetRow,
    enrichDonationDrivenWidgetWithLesta,
    broadcastDonationDrivenWidgetUpdate
} = donationDrivenWidgetModule;
donationDrivenWidgetModule.registerRoutes(app);

// Инициализация DonatePay при старте сервера
async function initializeDonatePay() {
    if (!DONATION_POLLING_ENABLED) {
        return;
    }
    if (!DP_CONFIG.apiKey) {
        console.log('⚠️ API ключ DonatePay не настроен');
        return;
    }

    try {
        console.log('🔍 Инициализация DonatePay...');
        const userInfo = await getDonatePayUser();
        if (userInfo) {
            console.log('✅ DonatePay инициализирован:', {
                id: DP_CONFIG.userId,
                name: userInfo.name
            });
            
            // Подключаемся к Centrifugo для real-time уведомлений
            await connectDonatePayCentrifugo();
            
            // Запускаем опрос донатов
            if (!pollingInterval) {
                startPollingDonationAlerts();
            }
        }
    } catch (error) {
        console.error('❌ Ошибка инициализации DonatePay:', error.message);
    }
}

// Lesta-роуты вынесены в src/modules/lesta-routes (тела 1:1)
const { createLestaRoutesModule } = require('./src/modules/lesta-routes');
const lestaRoutesModule = createLestaRoutesModule({
    lestaConfig: LESTA_CONFIG,
    db,
    dbRead,
    analytics,
    getAppState,
    updateAppState,
    broadcastStateUpdate,
    getLestaPlayerStats,
    prolongateLestaToken,
    applyLestaStats,
    startLestaAutoSync,
    stopLestaAutoSync,
    getLestaCountersFromState,
    computeLestaPeriodDelta,
    fetchLestaHistoryWindow,
    computeLestaPeriodStatsFromRows,
    buildLestaDailyActivity,
    fetchAccountTanksForAccount,
    scheduleLestaTankSnapshot,
    ensureLestaConfigFromState,
    tanksToSnapshotMap,
    fetchTankSnapshotBaseline,
    insertLestaTankSnapshot,
    parseTankSnapshotMap,
    computeTankPeriodChanges,
    fetchNewestTankSnapshotInPeriod
});
lestaRoutesModule.registerRoutes(app);
const startLestaSession = lestaRoutesModule.startLestaSession;
const resetLestaSession = lestaRoutesModule.resetLestaSession;

// HTTP/Centrifugo-интеграции DonationAlerts/DonatePay вынесены в
// src/modules/donation-platforms (тела 1:1). DA_CONFIG/DP_CONFIG передаются
// по ссылке — OAuth callback и /api/admin/config в server.js продолжают
// писать в тот же объект.
const { createDonationPlatformsModule } = require('./src/modules/donation-platforms');
const donationPlatformsModule = createDonationPlatformsModule({
    daConfig: DA_CONFIG,
    dpConfig: DP_CONFIG,
    getAppState,
    updateAppState,
    db,
    processDonation,
    pollLog
});
const getDonationsFromAPI = donationPlatformsModule.getDonationsFromAPI;
const getDonatePayUser = donationPlatformsModule.getDonatePayUser;
const checkDonationExists = donationPlatformsModule.checkDonationExists;
const getDonatePayNewTransactions = donationPlatformsModule.getDonatePayNewTransactions;
const connectDonatePayCentrifugo = donationPlatformsModule.connectDonatePayCentrifugo;

// Модули (src/modules/*)
const moduleDeps = {
    db,
    appRoot: APP_ROOT,
    userData: USER_DATA,
    getAppState,
    updateAppState,
    broadcastToClients,
    getLestaCountersFromState,
    computeLestaPeriodDelta,
    fetchLestaHistoryWindow,
    computeLestaPeriodStatsFromRows,
    getLestaPlayerStats,
    normalizeUsername,
    saveIntegration,
    loadIntegration,
    withApiQueue,
    wss,
    lestaConfig: LESTA_CONFIG,
    broadcastStateUpdate,
    startLestaAutoSync,
    startLestaSession,
    resetLestaSession,
    analytics,
    getDonationsHasNormalizedUsername: () => donationsHasNormalizedUsername
};
const moduleConfig = {
    razblogEnabled: RAZBLOG_ENABLED,
    createRazblogirovkaGoldService,
    archiveDir: RAZBLOG_ARCHIVE_DIR
};
const modules = registerModules(app, moduleDeps, moduleConfig);
blitzModule = modules.blitz;
razblogModuleRef = modules.razblog;
rouletteModuleRef = modules.roulette;

function updateBlitzChallenge(amount, donation) {
    if (blitzModule) blitzModule.updateBlitzChallenge(amount, donation);
}

// ===== Подписчики события «донат» =====
// Порядок подписки повторяет прежний порядок прямых вызовов из processDonation.
donationBus.subscribe('analytics', (ev) => {
    analytics.logEvent('donation_received', {
        donation_id: ev.donation.id,
        username: ev.donation.username,
        amount: ev.donation.amount,
        currency: ev.donation.currency,
        message: ev.donation.message,
        is_realtime: ev.donation.isRealtime,
        frags_earned: ev.fragUnitsEarned,
        time_earned: ev.timeEarned,
        custom_units_earned: ev.customUnitsEarned
    });
    analytics.updateDonationStats(ev.donation);
});
donationBus.subscribe('donation-goal', (ev) => updateDonationGoal(ev.donation));
donationBus.subscribe('donation-bar', (ev) => updateDonationBar(ev.donation));
donationBus.subscribe('donation-driven-widget', (ev) => updateDonationDrivenWidgets(ev.donation.amount));
donationBus.subscribe('roulette', (ev) => {
    if (rouletteModuleRef) rouletteModuleRef.addDonationToRoulette(ev.donation.amount);
});
donationBus.subscribe('blitz-challenge', (ev) => updateBlitzChallenge(ev.donation.amount, ev.donation));
donationBus.subscribe('donor-achievements', (ev) => {
    // Только для режима таймера; вызывается один раз на донат
    if (ev.timeEarned > 0 && ev.donation.username) {
        updateDonorAchievement(ev.donation.username, ev.timeEarned, ev.donation.id);
    }
});

// Запуск сервера
server.listen(port, async () => {
    preloadAppStateCache();

    console.log(`
🎯 ==================================
✅ Сервер запущен: http://localhost:${port}
FRAG_SERVER_READY:${port}
✅ WebSocket: ws://localhost:${port}/ws
📺 OBS Виджеты:
   Режим 1: http://localhost:${port}/widget/mode1
   Режим 2: http://localhost:${port}/widget/mode2  
   Режим 3: http://localhost:${port}/widget/mode3
   Сбор донатов: http://localhost:${port}/widget/donation-goal
   Параметр от донатов: http://localhost:${port}/widget/donation-driven
   Replay Live: http://localhost:${port}/widget-replay-live
   Яндекс Музыка: http://localhost:${port}/widget-yandex-music
   Итоги боя: http://localhost:${port}/widget-replay-summary?demo=1
   Итоги карусель: http://localhost:${port}/widget-replay-summary-carousel?demo=1
   Карточки карусели: http://localhost:${port}/widget-replay-summary-carousel-cards${RAZBLOG_ENABLED ? `
   Копилка золота: http://localhost:${port}/widget/razblogirovka-gold` : ''}
🚨 OBS Алерты:
   Режим 1: http://localhost:${port}/alert/mode1
   Режим 2: http://localhost:${port}/alert/mode2
   Режим 3: http://localhost:${port}/alert/mode3
🏠 Главная: http://localhost:${port}
👨‍💼 Админка: http://localhost:${port}/admin
📊 Аналитика: http://localhost:${port}/analytics
🔗 Интеграции стримов: http://localhost:${port}/stream-integrations.html
🔗 Авторизация DA: http://localhost:${port}/auth/donationalerts
🔗 Авторизация Lesta: http://localhost:${port}/auth/lesta
🔗 Статистика Lesta: http://localhost:${port}/lesta-stats${RAZBLOG_ENABLED ? `
🔗 РазБЛОГировка 2026: http://localhost:${port}/razblogirovka` : ''}
🔗 Тест Lesta API: http://localhost:${port}/lesta-test
🔗 DonatePay Webhook: http://localhost:${port}/webhook/donatepay (отключён, только поллинг)
🎯 ==================================
    `);

    if (RAZBLOG_ENABLED) {
        if (razblogModuleRef) razblogModuleRef.initRazblogirovkaGoldService();
        setInterval(() => {
            const svc = razblogModuleRef && razblogModuleRef.getService();
            if (!svc) return;
            getAppState((state) => {
                if (!state || !state.razblog_tracking_active) return;
                svc.syncFromLestaStats({}, (err) => {
                    if (err) console.warn('⚠️ razblogirovka auto-sync:', err.message);
                });
            });
        }, 20000);
    } else {
        getAppState((state) => {
            if (state && state.razblog_tracking_active) {
                updateAppState({ razblog_tracking_active: 0 }, (err) => {
                    if (!err) console.log('📦 РазБЛОГировка: отслеживание остановлено (модуль в архиве)');
                });
            }
        });
        console.log('📦 РазБЛОГировка 2026 отключена (RAZBLOG_ENABLED=0)');
    }

    if (!DONATION_POLLING_ENABLED) {
        console.log('⏸️ Опрос донатов отключён (DONATION_POLLING=0)');
    }
    setInterval(checkDiscountExpiration, 10000);

    if (process.env.VKPLAY_POLLING !== '1') {
        console.log('⏸️ VK Play polling отключён (VKPLAY_POLLING=1 для включения)');
    }
    
    // Восстанавливаем время таймера стрима при загрузке сервера
    getAppState((state) => {
        if (state && state.stream_timer_last_update_ts && state.stream_timer_last_update_ts > 0) {
            const now = Math.floor(Date.now() / 1000);
            const elapsedSinceLastUpdate = now - state.stream_timer_last_update_ts;
            const newElapsedSec = (state.stream_timer_initial_elapsed_sec || 0) + elapsedSinceLastUpdate;
            
            console.log(`📺 Восстановление времени таймера стрима: ${state.stream_timer_initial_elapsed_sec} + ${elapsedSinceLastUpdate} = ${newElapsedSec} секунд`);
            
            // Обновляем время в БД
            updateAppState({ 
                stream_timer_initial_elapsed_sec: newElapsedSec,
                stream_timer_last_update_ts: now
            });
        }
    });
    
    // Инициализируем DonatePay
    await initializeDonatePay();
    
    loadDAToken();
    
    // Загрузка сохраненных интеграций
    setTimeout(async () => {
        console.log('🔄 Загрузка сохраненных интеграций...');
        await loadSavedIntegrations();
    }, 1000);
    
    // Автоматический запуск опроса донатов при старте сервера
    if (DONATION_POLLING_ENABLED) {
        setTimeout(() => {
            console.log('🔄 Запуск автоматического опроса донатов...');
            startPollingDonationAlerts();
        }, 2000);
    }
    
    // Запуск автообновления статистики фрагов
    setTimeout(() => {
        console.log('🔄 Запуск автообновления статистики фрагов...');
        startAutoRefresh();
    }, 5000); // Задержка 5 секунд после запуска опроса донатов
});

// Простой HTTPS с самоподписанным сертификатом для VK Play
try {
    const httpsEnabled = process.env.HTTPS_ENABLED === 'true';
    const httpsPort = Number(process.env.HTTPS_PORT || 3443);
    
    if (httpsEnabled) {
        // Создаем самоподписанный сертификат программно
        const { execSync } = require('child_process');
        const path = require('path');
        
        try {
            // Создаем папку certs если не существует
            if (!fs.existsSync('certs')) {
                fs.mkdirSync('certs');
            }
            
            // Генерируем сертификат через PowerShell
            const certCmd = `$cert = New-SelfSignedCertificate -DnsName "localhost" -CertStoreLocation "Cert:\\CurrentUser\\My" -NotAfter (Get-Date).AddYears(1); $pwd = ConvertTo-SecureString -String "password" -AsPlainText -Force; Export-PfxCertificate -Cert $cert -FilePath "${path.resolve('certs/localhost.pfx')}" -Password $pwd`;
            execSync(`powershell -Command "${certCmd}"`, { stdio: 'ignore' });
            
            // Запускаем HTTPS сервер
            if (fs.existsSync('certs/localhost.pfx')) {
                const httpsServer = https.createServer({ 
                    pfx: fs.readFileSync('certs/localhost.pfx'), 
                    passphrase: 'password' 
                }, app);
                httpsServer.listen(httpsPort, () => {
                    console.log(`🔒 HTTPS запущен: https://localhost:${httpsPort}`);
                    console.log(`⚠️ Примите самоподписанный сертификат в браузере для https://localhost:${httpsPort}`);
                });
            }
        } catch (certError) {
            console.warn('⚠️ Не удалось создать сертификат:', certError.message);
        }
    }
} catch (e) {
    console.warn('⚠️ Ошибка запуска HTTPS:', e?.message || e);
}

// =====================
// Stream integrations stubs (YouTube, VK Play)
// =====================

// YouTube интеграция вынесена в src/modules/youtube-integration
// In-memory mock state (replace with real storage/session later)

// VK Play состояние (vkplayIntegration, vkplayBotIntegration, хелперы лайков/зрителей) вынесено в src/modules/vkplay-integration

// Кэш: структура stream_integrations уже проверена (не дергаем PRAGMA при каждом save)
let streamIntegrationsSchemaReady = false;

// Функции для работы с интеграциями в БД
function saveIntegration(platform, data) {
    return new Promise((resolve, reject) => {
        const doInsert = () => {
            const sql = `INSERT OR REPLACE INTO stream_integrations 
                (platform, access_token, refresh_token, expires_at, channel_name, channel_url, live_title, viewers_count, likes_count, chat_enabled, user_id, user_nick, poll_interval_sec, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
            db.run(sql, [
                platform,
                data.tokens?.access_token || null,
                data.tokens?.refresh_token || null,
                data.expires_at || 0,
                data.channel || null,
                data.channelUrl || null,
                data.liveTitle || null,
                data.viewers || 0,
                data.likes || 0,
                data.chatEnabled ? 1 : 0,
                data.userId || null,
                data.userNick || null,
                (data.pollIntervalSec != null ? data.pollIntervalSec : 60)
            ], function(err2) {
                if (err2) reject(err2);
                else resolve(this.lastID);
            });
        };
        if (streamIntegrationsSchemaReady) {
            doInsert();
            return;
        }
        // Проверяем наличие колонок только один раз за запуск
        db.all("PRAGMA table_info(stream_integrations)", (err, columns) => {
            if (err) {
                console.error('❌ Ошибка проверки колонок stream_integrations:', err);
                // Продолжаем без этих полей
                const sql = `INSERT OR REPLACE INTO stream_integrations 
                    (platform, access_token, refresh_token, expires_at, channel_name, channel_url, live_title, viewers_count, chat_enabled, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
                
                db.run(sql, [
                    platform,
                    data.tokens?.access_token || null,
                    data.tokens?.refresh_token || null,
                    data.expires_at || 0,
                    data.channel || null,
                    data.channelUrl || null,
                    data.liveTitle || null,
                    data.viewers || 0,
                    data.chatEnabled ? 1 : 0
                ], function(err2) {
                    if (err2) reject(err2);
                    else resolve(this.lastID);
                });
                return;
            }
            
            const hasUserId = columns.some(col => col.name === 'user_id');
            const hasUserNick = columns.some(col => col.name === 'user_nick');
            const hasLikesCount = columns.some(col => col.name === 'likes_count');
            const hasPollInterval = columns.some(col => col.name === 'poll_interval_sec');
            
            // Добавляем колонки, если их нет
            if (!hasUserId) {
                db.run('ALTER TABLE stream_integrations ADD COLUMN user_id INTEGER', () => {});
            }
            if (!hasUserNick) {
                db.run('ALTER TABLE stream_integrations ADD COLUMN user_nick TEXT', () => {});
            }
            if (!hasLikesCount) {
                db.run('ALTER TABLE stream_integrations ADD COLUMN likes_count INTEGER DEFAULT 0', () => {});
            }
            if (!hasPollInterval) {
                db.run('ALTER TABLE stream_integrations ADD COLUMN poll_interval_sec INTEGER DEFAULT 60', () => {});
            }
            streamIntegrationsSchemaReady = true;
            doInsert();
        });
    });
}

function loadIntegration(platform) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM stream_integrations WHERE platform = ? ORDER BY updated_at DESC LIMIT 1', [platform], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// Загрузка сохраненных интеграций при запуске
async function loadSavedIntegrations() {
    try {
        // YouTube: гидратация вынесена в src/modules/youtube-integration
        await modules.youtube.hydrateFromDb();

        await modules.vkplay.hydrateFromDb();
    } catch (error) {
        console.warn('⚠️ Ошибка загрузки интеграций:', error.message);
    }
}

// Status endpoints
// /integrations/youtube/status вынесен в src/modules/youtube-integration

// VK Play статус/OAuth/бот/чат/поллинг/награды-роли вынесены в src/modules/vkplay-integration

// =====================
// Режим "Температура" - нагревание от донатов
// =====================

let temperatureMode = {
    active: false,
    currentAmount: 0, // текущая сумма в рублях
    targetAmount: 10000, // целевая сумма для пика
    coolingRate: 50, // скорость охлаждения в рублях в секунду
    peakRewardMinutes: 5, // минут добавляется при достижении пика
    lastHeatUpdate: Date.now(),
    // Таймер автоотключения режима перегрева
    autoOffDurationSec: 0, // 0 = без автоотключения, иначе длительность в секундах
    autoOffUntilTs: 0,      // unix‑время, когда нужно выключить режим
    peakReached: false      // флаг, что пик уже достигнут (чтобы награда выдавалась только один раз)
};

// Нагрев от доната
function heatFromDonation(amount) {
    console.log(`🔥🔥🔥 heatFromDonation вызвана с суммой: ${amount}₽, режим активен: ${temperatureMode.active}`);
    console.log(`🔥🔥🔥 Текущая сумма до нагрева: ${temperatureMode.currentAmount}₽`);
    
    if (!temperatureMode.active) {
        console.log('🔥🔥🔥 Режим температуры неактивен, пропускаем нагрев');
        return;
    }
    
    // Добавляем сумму доната к текущей сумме
    temperatureMode.currentAmount += amount;
    
    console.log(`🔥🔥🔥 Донат ${amount}₽ добавил к температуре. Текущая сумма: ${temperatureMode.currentAmount.toFixed(0)}₽`);
    
    // Уведомляем клиентов
    broadcastToClients({
        type: 'temperature_update',
        currentAmount: temperatureMode.currentAmount,
        targetAmount: temperatureMode.targetAmount,
        coolingRate: temperatureMode.coolingRate,
        peakRewardMinutes: temperatureMode.peakRewardMinutes,
        autoOffDurationSec: temperatureMode.autoOffDurationSec,
        autoOffUntilTs: temperatureMode.autoOffUntilTs
    });
    
    console.log(`🔥🔥🔥 Отправлено обновление температуры клиентам`);
}

// Обновление температуры (охлаждение)
function updateTemperature() {
    if (!temperatureMode.active) return;
    
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    
    // Проверяем таймер автоотключения режима перегрева
    if (temperatureMode.autoOffUntilTs && nowSec >= temperatureMode.autoOffUntilTs) {
        temperatureMode.active = false;
        temperatureMode.currentAmount = 0;
        temperatureMode.autoOffUntilTs = 0;
        temperatureMode.lastHeatUpdate = now;
        temperatureMode.peakReached = false; // Сбрасываем флаг при выключении
        
        console.log('🔥 Режим температуры автоматически выключен по таймеру');
        
        broadcastToClients({
            type: 'temperature_mode_toggle',
            active: temperatureMode.active,
            currentAmount: temperatureMode.currentAmount,
            targetAmount: temperatureMode.targetAmount,
            coolingRate: temperatureMode.coolingRate,
            peakRewardMinutes: temperatureMode.peakRewardMinutes,
            autoOffDurationSec: temperatureMode.autoOffDurationSec,
            autoOffUntilTs: temperatureMode.autoOffUntilTs
        });
        
        return;
    }
    const deltaTime = (now - temperatureMode.lastHeatUpdate) / 1000; // секунды
    temperatureMode.lastHeatUpdate = now;
    
    // Охлаждение (уменьшение суммы)
    temperatureMode.currentAmount = Math.max(0, temperatureMode.currentAmount - (temperatureMode.coolingRate * deltaTime));
    
    // Отправляем обновление клиентам при остывании
    broadcastToClients({
        type: 'temperature_update',
        currentAmount: temperatureMode.currentAmount,
        targetAmount: temperatureMode.targetAmount,
        coolingRate: temperatureMode.coolingRate,
        peakRewardMinutes: temperatureMode.peakRewardMinutes,
        autoOffDurationSec: temperatureMode.autoOffDurationSec,
        autoOffUntilTs: temperatureMode.autoOffUntilTs
    });
    
    // Проверка достижения пика (только если еще не достигли)
    if (temperatureMode.currentAmount >= temperatureMode.targetAmount && !temperatureMode.peakReached) {
        // Получаем текущее состояние и добавляем время к таймеру
        getAppState((state) => {
            if (!state) return;
            
            // Добавляем время к таймеру
            const rewardSeconds = temperatureMode.peakRewardMinutes * 60;
            const newTimerSeconds = (state.timer_seconds || 0) + rewardSeconds;
            
            // Устанавливаем флаг, что пик достигнут
            temperatureMode.peakReached = true;
            
            console.log(`🔥 Температура достигла пика! Добавлено ${temperatureMode.peakRewardMinutes} минут к таймеру`);
            console.log(`🔥 Таймер: ${state.timer_seconds}с + ${rewardSeconds}с = ${newTimerSeconds}с`);
            
            // Обновляем состояние в БД
            updateAppState({
                timer_seconds: newTimerSeconds
            }, (err) => {
                if (err) {
                    console.error('❌ Ошибка обновления состояния после пика температуры:', err);
                } else {
                    console.log('✅ Состояние обновлено после пика температуры');
                }
            });
            
            // Уведомляем клиентов
            broadcastToClients({
                type: 'temperature_peak',
                rewardMinutes: temperatureMode.peakRewardMinutes,
                newTimerSeconds: newTimerSeconds
            });
        });
    }
    
    // Сбрасываем флаг достижения пика, если температура упала ниже целевой
    if (temperatureMode.currentAmount < temperatureMode.targetAmount && temperatureMode.peakReached) {
        temperatureMode.peakReached = false;
        console.log('🔥 Температура упала ниже пика, флаг сброшен');
    }
}

// API для управления режимом температуры
app.post('/api/temperature/toggle', (req, res) => {
    const body = req.body || {};
    const durationSecondsRaw = parseInt(body.durationSeconds, 10);
    const durationSeconds = Number.isFinite(durationSecondsRaw) && durationSecondsRaw > 0
        ? Math.min(durationSecondsRaw, 360 * 60) // максимум 6 часов
        : 0;
    
    const nowSec = Math.floor(Date.now() / 1000);
    
    // Переключаем режим
    temperatureMode.active = !temperatureMode.active;
    temperatureMode.currentAmount = 0;
    temperatureMode.lastHeatUpdate = Date.now();
    temperatureMode.peakReached = false; // Сбрасываем флаг при переключении
    
    if (temperatureMode.active) {
        // Включили режим: стартуем таймер автоотключения (если задан)
        if (durationSeconds > 0) {
            temperatureMode.autoOffDurationSec = durationSeconds;
            temperatureMode.autoOffUntilTs = nowSec + durationSeconds;
        } else if (temperatureMode.autoOffDurationSec > 0) {
            // Используем сохранённую длительность
            temperatureMode.autoOffUntilTs = nowSec + temperatureMode.autoOffDurationSec;
        } else {
            // Автоотключение отключено
            temperatureMode.autoOffUntilTs = 0;
        }
    } else {
        // Выключили режим вручную — очищаем таймер автоотключения
        temperatureMode.autoOffUntilTs = 0;
    }
    
    console.log(`🔥 Режим температуры ${temperatureMode.active ? 'включен' : 'выключен'}`);
    
    broadcastToClients({
        type: 'temperature_mode_toggle',
        active: temperatureMode.active,
        currentAmount: temperatureMode.currentAmount,
        targetAmount: temperatureMode.targetAmount,
        coolingRate: temperatureMode.coolingRate,
        peakRewardMinutes: temperatureMode.peakRewardMinutes,
        autoOffDurationSec: temperatureMode.autoOffDurationSec,
        autoOffUntilTs: temperatureMode.autoOffUntilTs
    });
    
    res.json({ 
        success: true, 
        active: temperatureMode.active,
        autoOffDurationSec: temperatureMode.autoOffDurationSec,
        autoOffUntilTs: temperatureMode.autoOffUntilTs
    });
});

app.post('/api/temperature/settings', (req, res) => {
    const { targetAmount, coolingRate, peakRewardMinutes, autoOffMinutes } = req.body;
    
    if (targetAmount !== undefined) temperatureMode.targetAmount = Math.max(100, Math.min(1000000, parseInt(targetAmount) || 10000));
    if (coolingRate !== undefined) temperatureMode.coolingRate = Math.max(1, Math.min(1000, parseInt(coolingRate) || 50));
    if (peakRewardMinutes !== undefined) temperatureMode.peakRewardMinutes = Math.max(1, Math.min(60, parseInt(peakRewardMinutes) || 5));
    
    if (autoOffMinutes !== undefined) {
        const minutesRaw = parseInt(autoOffMinutes, 10);
        const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0
            ? Math.min(minutesRaw, 360) // максимум 6 часов
            : 0;
        temperatureMode.autoOffDurationSec = minutes * 60;
        
        // Если режим активен, обновляем время автоотключения
        if (temperatureMode.active && temperatureMode.autoOffDurationSec > 0) {
            const nowSec = Math.floor(Date.now() / 1000);
            temperatureMode.autoOffUntilTs = nowSec + temperatureMode.autoOffDurationSec;
        }
    }
    
    console.log(`🔥 Настройки температуры обновлены:`, {
        targetAmount: temperatureMode.targetAmount,
        coolingRate: temperatureMode.coolingRate,
        peakRewardMinutes: temperatureMode.peakRewardMinutes,
        autoOffDurationSec: temperatureMode.autoOffDurationSec
    });
    
    res.json({ 
        success: true, 
        settings: {
            targetAmount: temperatureMode.targetAmount,
            coolingRate: temperatureMode.coolingRate,
            peakRewardMinutes: temperatureMode.peakRewardMinutes,
            autoOffDurationSec: temperatureMode.autoOffDurationSec
        }
    });
});

// API расписания стрима (на сегодня)
app.get('/api/schedule', (req, res) => {
    getAppState((state) => {
        let settings = {
            title: 'Расписание',
            slots: []
        };

        if (state && state.schedule_settings) {
            try {
                const parsed = JSON.parse(state.schedule_settings);
                if (parsed && typeof parsed === 'object') {
                    settings.title = parsed.title || settings.title;
                    if (Array.isArray(parsed.slots)) {
                        settings.slots = parsed.slots;
                    }
                }
            } catch (error) {
                console.error('❌ Ошибка парсинга schedule_settings, используем значения по умолчанию:', error);
            }
        }

        res.json({ success: true, ...settings });
    });
});

app.post('/api/schedule', (req, res) => {
    const { title, slots } = req.body || {};
    const safeTitle = (title && typeof title === 'string' ? title.trim() : '') || 'Расписание';
    const safeSlots = Array.isArray(slots) ? slots.map(s => ({
        start: (s.start || '').toString().trim(),
        end: (s.end || '').toString().trim(),
        text: (s.text || '').toString().trim()
    })).filter(s => s.start && s.end && s.text) : [];

    const payload = {
        title: safeTitle,
        slots: safeSlots
    };

    updateAppState({ schedule_settings: JSON.stringify(payload) }, (err) => {
        if (err) {
            console.error('❌ Ошибка сохранения расписания:', err);
            res.status(500).json({ success: false, error: 'Ошибка сохранения расписания' });
        } else {
            res.json({ success: true, title: safeTitle, slots: safeSlots });
        }
    });
});

// API турнира
app.get('/api/tournament', (req, res) => {
    getAppState((state) => {
        let tournament = {
            title: 'Турнир',
            teams: [],
            bracket: [],
            currentRound: 0,
            status: 'inactive' // inactive, active, completed
        };

        if (state && state.tournament_data) {
            try {
                const parsed = JSON.parse(state.tournament_data);
                if (parsed && typeof parsed === 'object') {
                    tournament = { ...tournament, ...parsed };
                }
            } catch (error) {
                console.error('❌ Ошибка парсинга tournament_data, используем значения по умолчанию:', error);
            }
        }

        res.json({ success: true, tournament });
    });
});

app.post('/api/tournament', (req, res) => {
    const { tournament } = req.body || {};
    
    if (!tournament || typeof tournament !== 'object') {
        return res.status(400).json({ success: false, error: 'Неверные данные турнира' });
    }

    // Валидация и очистка данных
    const safeTournament = {
        title: (tournament.title && typeof tournament.title === 'string' ? tournament.title.trim() : '') || 'Турнир',
        teams: Array.isArray(tournament.teams) ? tournament.teams.map(t => ({
            id: String(t.id || ''),
            name: String(t.name || '').trim(),
            wins: Math.max(0, parseInt(t.wins) || 0),
            eliminated: !!t.eliminated
        })).filter(t => t.id && t.name) : [],
        bracket: Array.isArray(tournament.bracket) ? tournament.bracket : [],
        currentRound: Math.max(0, parseInt(tournament.currentRound) || 0),
        status: ['inactive', 'active', 'completed'].includes(tournament.status) ? tournament.status : 'inactive'
    };

    updateAppState({ tournament_data: JSON.stringify(safeTournament) }, (err) => {
        if (err) {
            console.error('❌ Ошибка сохранения турнира:', err);
            res.status(500).json({ success: false, error: 'Ошибка сохранения турнира' });
        } else {
            // Отправляем обновление всем клиентам через WebSocket
            broadcastToClients({
                type: 'TOURNAMENT_UPDATE',
                tournament: safeTournament
            });
            res.json({ success: true, tournament: safeTournament });
        }
    });
});

app.post('/api/temperature/hide-all', (req, res) => {
    console.log('👁️ Скрытие всех виджетов температуры');
    
    // Отправляем команду скрытия всем виджетам температуры
    broadcastToClients({
        type: 'temperature_hide_all',
        hide: true
    });
    
    res.json({ success: true });
});

app.get('/api/temperature/status', (req, res) => {
    res.json({
        success: true,
        temperatureMode: {
            active: temperatureMode.active,
            currentAmount: temperatureMode.currentAmount,
            targetAmount: temperatureMode.targetAmount,
            coolingRate: temperatureMode.coolingRate,
            peakRewardMinutes: temperatureMode.peakRewardMinutes,
            autoOffDurationSec: temperatureMode.autoOffDurationSec,
            autoOffUntilTs: temperatureMode.autoOffUntilTs
        }
    });
});

// Stream counter API endpoints
app.post('/api/stream-counter/set-time', (req, res) => {
    const { totalSeconds } = req.body;
    
    if (totalSeconds !== undefined && totalSeconds >= 0) {
        getAppState((state) => {
            const now = Math.floor(Date.now() / 1000);
            state.stream_timer_initial_elapsed_sec = parseInt(totalSeconds);
            state.stream_timer_last_update_ts = now;
            state.stream_timer_started_ts = now;
            console.log(`📺 Время стрима установлено: ${totalSeconds} секунд`);
            
            // Обновляем состояние в БД
            updateAppState({ 
                stream_timer_initial_elapsed_sec: state.stream_timer_initial_elapsed_sec,
                stream_timer_last_update_ts: state.stream_timer_last_update_ts,
                stream_timer_started_ts: state.stream_timer_started_ts
            });
            
            res.json({ success: true, totalSeconds: state.stream_timer_initial_elapsed_sec });
        });
    } else {
        res.json({ success: false, error: 'Invalid totalSeconds value' });
    }
});

app.post('/api/stream-counter/start', (req, res) => {
    console.log('📺 Запуск счетчика стрима');
    
    getAppState((state) => {
        const now = Math.floor(Date.now() / 1000);
        // Если время не установлено, устанавливаем 0
        if (state.stream_timer_initial_elapsed_sec === undefined || state.stream_timer_initial_elapsed_sec === null) {
            state.stream_timer_initial_elapsed_sec = 0;
        }
        state.stream_timer_last_update_ts = now;
        state.stream_timer_started_ts = now;
        
        // Обновляем состояние в БД
        updateAppState({ 
            stream_timer_initial_elapsed_sec: state.stream_timer_initial_elapsed_sec,
            stream_timer_last_update_ts: state.stream_timer_last_update_ts,
            stream_timer_started_ts: state.stream_timer_started_ts
        });
        
        res.json({ success: true });
    });
});

app.post('/api/stream-counter/reset', (req, res) => {
    console.log('📺 Сброс счетчика стрима');
    
    getAppState((state) => {
        const now = Math.floor(Date.now() / 1000);
        state.stream_timer_initial_elapsed_sec = 0;
        state.stream_timer_last_update_ts = now;
        state.stream_timer_started_ts = now;
        
        // Обновляем состояние в БД
        updateAppState({ 
            stream_timer_initial_elapsed_sec: state.stream_timer_initial_elapsed_sec,
            stream_timer_last_update_ts: state.stream_timer_last_update_ts,
            stream_timer_started_ts: state.stream_timer_started_ts
        });
        
        res.json({ success: true });
    });
});

app.get('/api/stream-counter/status', (req, res) => {
    getAppState((state) => {
        res.json({
            success: true,
            totalSeconds: state.stream_timer_initial_elapsed_sec || 0
        });
    });
});

// API для управления настройками рандомного замедления
app.get('/api/slowdown/settings', (req, res) => {
    getAppState((state) => {
        try {
            let settings = null;
            if (state.slowdown_random_settings) {
                settings = JSON.parse(state.slowdown_random_settings);
            }
            
            // Если настроек нет, возвращаем дефолтные
            if (!settings) {
                settings = {
                    randomMode: false,
                    variants: [
                        { factor: 1.5, chance: 20 },
                        { factor: 2.0, chance: 30 },
                        { factor: 2.5, chance: 25 },
                        { factor: 3.0, chance: 15 },
                        { factor: 4.0, chance: 10 }
                    ],
                    duration: 300,
                    durationVariants: [
                        { seconds: 180, chance: 20 },
                        { seconds: 300, chance: 30 },
                        { seconds: 420, chance: 25 },
                        { seconds: 600, chance: 15 },
                        { seconds: 900, chance: 10 }
                    ]
                };
            }
            
            res.json({ success: true, settings });
        } catch (error) {
            console.error('❌ Ошибка получения настроек замедления:', error);
            res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
        }
    });
});

app.post('/api/slowdown/settings', (req, res) => {
    const { randomMode, variants, duration, durationVariants } = req.body;
    
    try {
        const settings = {
            randomMode: randomMode !== undefined ? randomMode : false,
            variants: variants || [],
            duration: duration || 300,
            durationVariants: Array.isArray(durationVariants) ? durationVariants : null
        };
        
        // Валидация
        if (!Array.isArray(settings.variants) || settings.variants.length === 0) {
            return res.status(400).json({ success: false, error: 'Должен быть хотя бы один вариант' });
        }
        
        if (settings.duration < 1) {
            return res.status(400).json({ success: false, error: 'Длительность должна быть больше 0' });
        }

        if (settings.durationVariants) {
            const valid = settings.durationVariants
                .map(d => ({ seconds: parseInt(d.seconds)||0, chance: parseFloat(d.chance)||0 }))
                .filter(d => d.seconds > 0 && d.chance >= 0);
            if (valid.length === 0) {
                return res.status(400).json({ success: false, error: 'Неверные варианты времени' });
            }
            settings.durationVariants = valid;
        }
        
        // Сохраняем в БД
        getAppState((state) => {
            updateAppState({ 
                slowdown_random_settings: JSON.stringify(settings) 
            }, (err) => {
                if (err) {
                    console.error('❌ Ошибка сохранения настроек замедления:', err);
                    res.status(500).json({ success: false, error: 'Ошибка сохранения настроек' });
                } else {
                    console.log('✅ Настройки замедления сохранены:', settings);
                    res.json({ success: true, settings });
                }
            });
        });
    } catch (error) {
        console.error('❌ Ошибка обработки настроек замедления:', error);
        res.status(500).json({ success: false, error: 'Ошибка обработки настроек' });
    }
});

// Запускаем обновление температуры каждую секунду
setInterval(updateTemperature, 1000);

// Автоматическое обновление таймера каждую секунду
function scheduleTimerDbFlush() {
    if (timerDbFlushTimeout) return;
    timerDbFlushTimeout = setTimeout(() => {
        timerDbFlushTimeout = null;
        const cached = appStateStore.getCachedState();
        if (!cached) return;
        updateAppState(
            { timer_seconds: cached.timer_seconds },
            (err) => {
                if (err) console.error('❌ Ошибка сохранения таймера в БД:', err);
            }
        );
    }, TIMER_DB_FLUSH_MS);
}

function updateTimer() {
    // Живой объект кэша: тик меняет timer_seconds прямо в нём, БД пишем раз в 10 с
    const state = appStateStore.getCachedState();
    if (!state) return;

    // Тикаем в памяти; в SQLite пишем раз в 10 с, чтобы не блокировать чтения
    if (!state.timer_paused && state.timer_seconds > 0) {
        const newSeconds = Math.max(0, (state.timer_seconds || 0) - 1);
        if (newSeconds !== state.timer_seconds) {
            state.timer_seconds = newSeconds;
            scheduleTimerDbFlush();
        }
    }
}

// API для достижений донатеров вынесен в src/modules/donor-achievements

setInterval(updateTimer, 1000);

// Автоматическое обновление времени таймера стрима каждую минуту
setInterval(() => {
    getAppState((state) => {
        if (!state) return;
        
        // Если время было установлено, обновляем его на основе прошедшего времени
        if (state.stream_timer_last_update_ts && state.stream_timer_last_update_ts > 0) {
            const now = Math.floor(Date.now() / 1000);
            const elapsedSinceLastUpdate = now - state.stream_timer_last_update_ts;
            const newElapsedSec = (state.stream_timer_initial_elapsed_sec || 0) + elapsedSinceLastUpdate;
            
            // Обновляем время в БД
            updateAppState({ 
                stream_timer_initial_elapsed_sec: newElapsedSec,
                stream_timer_last_update_ts: now
            });
            
            // Обновляем состояние в памяти для broadcast
            state.stream_timer_initial_elapsed_sec = newElapsedSec;
            state.stream_timer_last_update_ts = now;
            
            // Отправляем обновление всем клиентам
            broadcastStateUpdate(state);
        }
    });
}, 60000); // Каждую минуту

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Остановка сервера...');
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }
    if (timerDbFlushTimeout) {
        clearTimeout(timerDbFlushTimeout);
        timerDbFlushTimeout = null;
    }
    const cachedOnExit = appStateStore.getCachedState();
    if (cachedOnExit) {
        db.run(
            'UPDATE app_state SET timer_seconds = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
            [cachedOnExit.timer_seconds],
            () => {}
        );
    }
    db.close();
    dbRead.close();
    server.close(() => {
        console.log('✅ Сервер остановлен');
        process.exit(0);
    });
});
