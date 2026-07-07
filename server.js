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
const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;
const { registerModules } = require('./src/registerModules');
const { computeFragAward, computeTimerAward, computeCustomAward } = require('./src/core/donation-math');
const { createDonationsStore } = require('./src/core/donations-store');
const { createTemperatureModule } = require('./src/modules/temperature');
const { createBroadcastState } = require('./src/core/broadcast-state');
const { createFragStats, processFragStatsData } = require('./src/core/frag-stats');
const { createDonationOrchestrator } = require('./src/core/donation-orchestrator');
const { initBlitzChallengeSchema } = require('./src/modules/blitz-challenge/schema');
const { initBossOrdersSchema } = require('./src/modules/boss-orders/schema');
let blitzModule = null;
let razblogModuleRef = null;
let rouletteModuleRef = null;

/** РазБЛОГировка 2026 — включена по умолчанию (RAZBLOG_ENABLED=0 для отключения) */
const RAZBLOG_ENABLED = process.env.RAZBLOG_ENABLED !== '0';
const RAZBLOG_PUBLIC_DIR = path.join(__dirname, 'src', 'modules', 'razblog', 'public');
let createRazblogirovkaGoldService = null;
if (RAZBLOG_ENABLED) {
    createRazblogirovkaGoldService = require('./src/modules/razblog/razblogirovkaGoldService').createRazblogirovkaGoldService;
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
            try { poller.setLastSeenDonationId(row.last_donation_id.toString()); } catch {}
        }
    }
});
const preloadAppStateCache = appStateStore.preloadAppStateCache;
const getAppState = appStateStore.getAppState;
const updateAppState = appStateStore.updateAppState;
const wsHub = createWebSocketHub();
const broadcastToClients = wsHub.broadcastToClients;
// wss объявлен ниже (WebSocket.Server); геттер лениво читает его в момент вызова,
// когда полная загрузка модуля уже завершена.
const broadcastStateModule = createBroadcastState({
    dbRead,
    broadcastToClients,
    getWssClientCount: () => wss.clients.size
});
const getBroadcastState = broadcastStateModule.getBroadcastState;
const broadcastStateUpdate = broadcastStateModule.broadcastStateUpdate;
// Статистика боёв/фрагов вынесена в src/core/frag-stats.js
const fragStatsModule = createFragStats({ db });
const addBattleForce = fragStatsModule.addBattleForce;
const addUniqueBattle = fragStatsModule.addUniqueBattle;
const getFragStats = fragStatsModule.getFragStats;
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
let processedDonationIds = new Set();
// Остальное состояние опроса живёт в donation-poller (см. const poller ниже).

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
    razblogPublicDir: RAZBLOG_PUBLIC_DIR
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
// Хранилище донатов/достижений вынесено в src/core/donations-store.js
const donationsStore = createDonationsStore({ db, getAppState });
const updateDonorAchievement = donationsStore.updateDonorAchievement;
const normalizeUsername = donationsStore.normalizeUsername;
const saveDonation = donationsStore.saveDonation;
const getDonations = donationsStore.getDonations;

// Оркестрация обработки доната вынесена в src/core/donation-orchestrator.js.
// heatFromDonation/temperatureModule объявляются НИЖЕ по файлу (после этой
// точки) — передаём ленивой обёрткой (тот же приём, что для wss выше):
// тело стрелки не выполняется до реального доната, когда модуль уже загружен.
const donationOrchestrator = createDonationOrchestrator({
    db,
    getAppState,
    updateAppState,
    pollLog,
    processedDonationIds,
    computeFragAward,
    computeTimerAward,
    computeCustomAward,
    heatFromDonation: (amount) => heatFromDonation(amount),
    saveDonation,
    normalizeUsername,
    donationBus,
    broadcastStateUpdate,
    broadcastToClients,
    getBroadcastState
});
const processDonation = donationOrchestrator.processDonation;


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
                poller.startPollingDonationAlerts();
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
        poller.startPollingDonationAlerts();
        
        // Дополнительная проверка донатов через 3 секунды
        setTimeout(() => {
            if (!poller.isPollingInProgress()) {
                console.log('🔄 Проверка донатов после авторизации DonationAlerts...');
                poller.checkForNewDonations();
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
// Диагностические/тестовые роуты (/api/status, /api/db-status, /api/da-*,
// /api/donatepay-test, /api/debug-donations, /api/diagnose-polling и т.д.)
// вынесены в src/modules/diagnostics (регистрируется ниже, после создания
// donation-platforms — deps-функции берутся оттуда).

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









// Принудительная проверка донатов
app.post('/api/force-check-donations', async (req, res) => {
    console.log('🔄 Принудительная проверка донатов через API...');
    
    try {
        await poller.checkForNewDonations();
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
        const originalFirstPollDone = poller.getFirstPollDone();
        const originalLastSeenDonationId = poller.getLastSeenDonationId();
        
        poller.setFirstPollDone(false);
        poller.setLastSeenDonationId(null);
        
        console.log('🔄 Сброшены фильтры, проверяем все донаты...');
        await poller.checkForNewDonations();
        
        // Восстанавливаем фильтры
        poller.setFirstPollDone(originalFirstPollDone);
        poller.setLastSeenDonationId(originalLastSeenDonationId);
        
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
        const originalLastSeenDonationId = poller.getLastSeenDonationId();
        poller.setLastSeenDonationId(null);
        
        console.log(`🔄 lastSeenDonationId сброшен: ${originalLastSeenDonationId} -> null`);
        
        // Принудительно проверяем донаты
        await poller.checkForNewDonations();
        
        res.json({ 
            success: true, 
            message: 'lastSeenDonationId сброшен и выполнена проверка донатов',
            originalId: originalLastSeenDonationId,
            newId: poller.getLastSeenDonationId()
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
// Чистая дельта-математика Lesta вынесена в src/core/lesta-delta.js
// (юнит-тесты: tests/lesta-delta.test.js). Здесь остаются только функции с БД.
const {
    LESTA_HISTORY_HEARTBEAT_SEC,
    safeLestaCounterDelta,
    getLestaCountersFromState,
    computeLestaPeriodDelta,
    computeLestaPeriodStatsFromRows
} = require('./src/core/lesta-delta');

// История снапшотов Lesta вынесена в src/core/lesta-history.js.
const { createLestaHistory } = require('./src/core/lesta-history');
const lestaHistory = createLestaHistory({ db, dbRead, getAppState, updateAppState, LESTA_CONFIG });
const {
    insertLestaStatsSnapshot,
    fetchLestaHistoryWindow,
    buildLestaDailyActivity,
    ensureLestaReliableSince,
    ensureLestaConfigFromState,
    fetchAccountTanksForAccount,
    scheduleLestaTankSnapshot,
    tanksToSnapshotMap,
    parseTankSnapshotMap,
    insertLestaTankSnapshot,
    fetchTankSnapshotBaseline,
    fetchNewestTankSnapshotInPeriod,
    computeTankPeriodChanges
} = lestaHistory;


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
// Цикл опроса донат-платформ вынесен в src/core/donation-poller.js (poller ниже).

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
                poller.forceCheckDonations();
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



// Управление таймером
// API для принудительной проверки донатов
// Диагностика опроса донатов

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
                    if (!poller.isPollingInProgress()) {
                        console.log('🔄 Проверка донатов после изменения фрагов...');
                        poller.checkForNewDonations();
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
        if (!poller.isPollingInProgress()) {
            console.log(`🔄 Проверка донатов при подключении клиента ${clientId}...`);
            poller.checkForNewDonations();
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
                                if (!poller.hasPollingInterval()) {
                                    poller.startPollingDonationAlerts();
                                } else {
                                    // Если опрос уже запущен, принудительно проверяем донаты через 5 секунд
                                    setTimeout(() => {
                                        if (!poller.isPollingInProgress()) {
                                            console.log('🔄 Проверка донатов после настройки DonatePay...');
                                            poller.checkForNewDonations();
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
                                            if (!poller.hasPollingInterval()) {
                                                poller.startPollingDonationAlerts();
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



// Танко-снапшоты Lesta вынесены в src/core/lesta-history.js

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
            if (!poller.isPollingInProgress()) {
                console.log('🔄 Проверка донатов после ручного добавления...');
                poller.checkForNewDonations();
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

// Донат-CRUD (/api/donations*, /api/donors*, clear/reset, delete-donor)
// вынесен в src/modules/donations-crud (регистрация ниже, рядом с poller).

// /api/admin/delete-donor вынесен в src/modules/donations-crud

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
const { broadcastDonationDrivenWidgetUpdate } = donationDrivenWidgetModule;
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
            if (!poller.hasPollingInterval()) {
                poller.startPollingDonationAlerts();
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
const getDonatePayNewTransactions = donationPlatformsModule.getDonatePayNewTransactions;
const connectDonatePayCentrifugo = donationPlatformsModule.connectDonatePayCentrifugo;

const { createDonationPoller } = require('./src/core/donation-poller');
const poller = createDonationPoller({
    db,
    pollLog,
    getAppState,
    updateAppState,
    appStateStore,
    DA_CONFIG,
    DP_CONFIG,
    DONATION_POLLING_ENABLED,
    processedDonationIds,
    processDonation,
    getDonationsFromAPI,
    getDonatePayUser,
    getDonatePayNewTransactions,
    connectDonatePayCentrifugo,
    donationPlatformsModule
});

const { createDonationsCrudModule } = require('./src/modules/donations-crud');
createDonationsCrudModule({
    db,
    getAppState,
    updateAppState,
    getDonations,
    normalizeUsername,
    processedDonationIds,
    broadcastStateUpdate,
    broadcastToClients,
    getDonationsHasNormalizedUsername: () => donationsHasNormalizedUsername,
    setDonationsHasNormalizedUsername: (v) => { donationsHasNormalizedUsername = !!v; }
}).registerRoutes(app);

// Диагностические/тестовые роуты (вынесены в src/modules/diagnostics).
// Регистрация здесь, а не в registerModules: deps завязаны на функции
// donation-platforms и polling-переменные, живущие в server.js.
const { createDiagnosticsModule } = require('./src/modules/diagnostics');
createDiagnosticsModule({
    db,
    daConfig: DA_CONFIG,
    dpConfig: DP_CONFIG,
    getAppState,
    updateAppState,
    getDonationsFromAPI,
    getDonatePayUser,
    getLestaPlayerStats,
    isCentrifugoConnected: donationPlatformsModule.isCentrifugoConnected,
    getCentrifugoState: donationPlatformsModule.getCentrifugoState,
    getPollingState: () => ({
        isPollingInProgress: poller.isPollingInProgress(),
        pollDelayMs: poller.getPollDelayMs(),
        hasPollingInterval: poller.hasPollingInterval(),
        firstPollDone: poller.getFirstPollDone(),
        lastSeenDonationId: poller.getLastSeenDonationId(),
        processedDonationIdsCount: processedDonationIds.size
    })
}).registerRoutes(app);

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
    createRazblogirovkaGoldService
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
    setInterval(() => poller.checkDiscountExpiration(), 10000);

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
            poller.startPollingDonationAlerts();
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

// Режим "Температура" вынесен в src/modules/temperature/
const temperatureModule = createTemperatureModule({ getAppState, updateAppState, broadcastToClients });
const heatFromDonation = temperatureModule.heatFromDonation;
temperatureModule.registerRoutes(app);
temperatureModule.start();

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
    poller.stopPolling();
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
