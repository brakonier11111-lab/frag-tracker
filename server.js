const { APP_ROOT, USER_DATA, loadEnv, resolveDbPath } = require('./src/bootstrap/paths');
loadEnv();

const logger = require('./src/utils/logger');
const console = { log: logger.info, warn: logger.warn, error: logger.error };

const path = require('path');
const fs = require('fs');

const express = require('express');
const axios = require('axios');
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
const { initBlitzChallengeSchema } = require('./src/modules/blitz-challenge/schema');
let blitzModule = null;
let razblogModuleRef = null;

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

// Кэш app_state в памяти — убирает очередь на SQLite при опросе виджетов и таймере
let memoryAppState = null;
let memoryAppStateLoaded = false;
let timerDbFlushTimeout = null;
const TIMER_DB_FLUSH_MS = 10000;

function mergeIntoMemoryAppState(fields, values, atomicTimerIncrement) {
    if (!memoryAppState) memoryAppState = { id: 1 };
    if (atomicTimerIncrement) {
        memoryAppState.timer_seconds = Math.max(
            0,
            (Number(memoryAppState.timer_seconds) || 0) + atomicTimerIncrement
        );
    }
    fields.forEach((key, idx) => {
        memoryAppState[key] = values[idx];
    });
}

function preloadAppStateCache(callback) {
    dbRead.get('SELECT * FROM app_state WHERE id = 1', (err, row) => {
        if (!err && row) {
            memoryAppState = row;
            memoryAppStateLoaded = true;
            if (row.last_donation_id) {
                try { lastSeenDonationId = row.last_donation_id.toString(); } catch {}
            }
        }
        if (callback) callback(err, row);
    });
}

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
// (broadcastToClients объявлен ниже как function-declaration и хоистится, поэтому
// доступен здесь несмотря на то, что текстуально определён позже).
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

let clients = [];
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
app.use(express.json({ limit: '50mb' }));
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

app.get('/widget-donors-top.html', (req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.sendFile(path.join(__dirname, 'public', 'widget-donors-top.html'));
});
app.get('/donation-driven-widget', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'donation-driven-widget.html'));
});

function sendReplayLivePublic(res, filename) {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.sendFile(path.join(__dirname, 'public', filename));
}

app.get('/replay-live', (req, res) => sendReplayLivePublic(res, 'replay-live.html'));
app.get('/widget-replay-live', (req, res) => sendReplayLivePublic(res, 'widget-replay-live.html'));
app.get('/widget-replay-summary', (req, res) => sendReplayLivePublic(res, 'widget-replay-summary.html'));
app.get('/widget-replay-summary-carousel', (req, res) => sendReplayLivePublic(res, 'widget-replay-summary-carousel.html'));
app.get('/widget-replay-summary-carousel-cards', (req, res) => sendReplayLivePublic(res, 'widget-replay-summary-carousel-cards.html'));
app.get('/replay-summary.css', (req, res) => sendReplayLivePublic(res, 'replay-summary.css'));
app.get('/replay-summary-ui.js', (req, res) => sendReplayLivePublic(res, 'replay-summary-ui.js'));

// Кэш для компонентов и стилей (меню и переходы быстрее)
app.use('/components', express.static(path.join(__dirname, 'public', 'components'), { maxAge: '1h' }));
app.use('/styles', express.static(path.join(__dirname, 'public', 'styles'), { maxAge: '1d' }));
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

// Функции для работы с БД
function getAppState(callback) {
    if (memoryAppStateLoaded && memoryAppState) {
        callback(memoryAppState);
        return;
    }
    dbRead.get('SELECT * FROM app_state WHERE id = 1', (err, row) => {
        if (err) {
            console.error('❌ Ошибка получения состояния:', err);
            callback(null);
        } else {
            if (row) {
                memoryAppState = row;
                memoryAppStateLoaded = true;
            }
            callback(row);
            if (row && row.last_donation_id) {
                try { lastSeenDonationId = row.last_donation_id.toString(); } catch {}
            }
        }
    });
}

function updateAppState(newState, callback, allowManualTimeUpdate = false) {
    // ВАЖНО: timer_manual_time_added обновляется ТОЛЬКО через /api/timer-control с isManual: true
    // Исключаем его из автоматических обновлений, чтобы предотвратить случайное изменение
    // ВАЖНО: Для timer_seconds используем атомарное обновление, если это инкремент
    // Это предотвращает гонку условий, когда таймер обновляется параллельно
    const timerSecondsIncrement = newState._timer_seconds_increment;
    const useAtomicTimerUpdate = timerSecondsIncrement !== undefined && timerSecondsIncrement > 0;
    
    const fields = Object.keys(newState).filter(key => {
        if (key === 'id') return false;
        if (key === 'created_at' || key === 'updated_at') return false;
        if (key === '_forceFullUpdate') return false;
        // Пропускаем специальный флаг инкремента
        if (key === '_timer_seconds_increment') return false;
        // Разрешаем обновление timer_manual_time_added только если явно разрешено (из /api/timer-control)
        if (key === 'timer_manual_time_added' && !allowManualTimeUpdate) {
            console.log(`⚠️ Игнорируем обновление timer_manual_time_added (разрешено только через /api/timer-control)`);
            return false;
        }
        // Если используем атомарное обновление, исключаем timer_seconds из обычного обновления
        if (key === 'timer_seconds' && useAtomicTimerUpdate) {
            return false;
        }
        return true;
    });

    // Защита от случайной передачи всего state — иначе SQLite блокируется на секунды
    if (fields.length > 35 && !newState._forceFullUpdate) {
        const err = new Error(`updateAppState: слишком много полей (${fields.length}), вероятно передан весь state`);
        console.error('❌', err.message);
        if (callback) callback(err);
        return;
    }
    
    const values = fields.map(key => {
        const value = newState[key];
        // Преобразуем объекты и массивы в JSON строки
        if (typeof value === 'object' && value !== null) {
            return JSON.stringify(value);
        }
        return value;
    });
    
    // Если нужно атомарное обновление timer_seconds, используем SQL инкремент
    let setClause;
    if (useAtomicTimerUpdate) {
        // Используем атомарное обновление: timer_seconds = timer_seconds + increment
        const otherSetClause = fields.map(key => `${key} = ?`).join(', ');
        setClause = `timer_seconds = timer_seconds + ${timerSecondsIncrement}${fields.length > 0 ? ', ' + otherSetClause : ''}`;
        console.log(`⏰ АТОМАРНОЕ обновление timer_seconds: +${timerSecondsIncrement} сек`);
    } else {
        setClause = fields.map(key => `${key} = ?`).join(', ');
    }
    
    if (process.env.DEBUG_STATE === '1') {
        console.log('🔄 Обновление состояния в БД:', fields);
    }
    
    db.run(`UPDATE app_state SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
        values, function(err) {
            if (err) {
                console.error('❌ Ошибка обновления состояния:', err);
                console.error('   SQL:', `UPDATE app_state SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`);
                console.error('   Values:', values);
                if (callback) callback(err);
            } else {
                mergeIntoMemoryAppState(fields, values, useAtomicTimerUpdate ? timerSecondsIncrement : 0);
                memoryAppStateLoaded = true;
                if (process.env.DEBUG_STATE === '1') {
                    console.log('✅ Состояние успешно обновлено в БД');
                }
                if (callback) callback(null);
            }
        });
}

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
app.get('/auth/lesta', (req, res) => {
    if (!LESTA_CONFIG.applicationId) {
        return res.status(400).send(`
            <h3 style="color: red;">Ошибка настройки</h3>
            <p>Application ID Lesta Games не настроен. Настройте его в админке.</p>
        `);
    }
    
    // Согласно документации Lesta Games, используем правильный URL
    const redirectUri = `http://localhost:${port}/auth/lesta/callback`;
    // prompt=login — попытка показать форму входа, а не подставить сохранённую сессию Lesta
    const authUrl = `${LESTA_CONFIG.openIdUrl}?application_id=${LESTA_CONFIG.applicationId}&redirect_uri=${encodeURIComponent(redirectUri)}&prompt=login`;
    
    console.log('🔗 Авторизация Lesta Games:');
    console.log('   Application ID:', LESTA_CONFIG.applicationId);
    console.log('   Redirect URI:', redirectUri);
    console.log('   Auth URL:', authUrl);
    
    res.redirect(authUrl);
});

app.get('/auth/lesta/callback', async (req, res) => {
    try {
        const { status, access_token, account_id, nickname, expires_at, code, message } = req.query;
        
        console.log('📥 Получен Lesta Games OAuth ответ:', { 
            status: status || 'НЕ УКАЗАН',
            access_token: access_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ',
            account_id: account_id ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ',
            nickname: nickname || 'НЕ УКАЗАН',
            expires_at: expires_at || 'НЕ УКАЗАН',
            code: code || 'НЕТ',
            message: message || 'НЕТ'
        });
        
        // Проверяем статус авторизации
        if (status === 'error') {
            // Специальный кейс для протухшей сессии AUTH_EXPIRED — сразу даём понятный текст и кнопку "повторить"
            if (code === 'AUTH_EXPIRED') {
                return res.status(200).send(`
                    <h3 style="color: red; text-align: center; margin-top: 40px;">Ошибка авторизации Lesta Games</h3>
                    <p style="text-align: center; max-width: 520px; margin: 10px auto; line-height: 1.5;">
                        Сессия авторизации истекла (код: AUTH_EXPIRED, 403).<br>
                        Это нормальная ситуация, если окно авторизации было открыто слишком долго.
                    </p>
                    <p style="text-align: center; margin-top: 20px;">
                        <a href="/auth/lesta" style="display: inline-block; padding: 10px 18px; border-radius: 6px; background: #0ea5e9; color: #fff; text-decoration: none; font-weight: 600;">
                            🔁 Попробовать авторизоваться ещё раз
                        </a>
                    </p>
                    <p style="text-align: center; margin-top: 10px; font-size: 13px; color: #666;">
                        Если ошибка повторяется сразу, проверьте системное время и попробуйте позже.
                    </p>
                `);
            }

            return res.status(200).send(`
                <h3 style="color: red; text-align: center; margin-top: 40px;">Ошибка авторизации Lesta Games</h3>
                <p style="text-align: center; max-width: 520px; margin: 10px auto; line-height: 1.5;">
                    Ошибка авторизации: ${message || 'Неизвестная ошибка'}${code ? ` (код: ${code})` : ''}.
                </p>
                <p style="text-align: center; margin-top: 20px;">
                    <a href="/auth/lesta" style="display: inline-block; padding: 10px 18px; border-radius: 6px; background: #0ea5e9; color: #fff; text-decoration: none; font-weight: 600;">
                        🔁 Попробовать ещё раз
                    </a>
                </p>
            `);
        }
        
        if (status !== 'ok') {
            return res.status(200).send(`
                <h3 style="color: red; text-align: center; margin-top: 40px;">Неожиданный статус авторизации Lesta Games</h3>
                <p style="text-align: center; max-width: 520px; margin: 10px auto; line-height: 1.5;">
                    Статус: ${status || 'не указан'}.
                </p>
                <p style="text-align: center; margin-top: 20px;">
                    <a href="/auth/lesta" style="display: inline-block; padding: 10px 18px; border-radius: 6px; background: #0ea5e9; color: #fff; text-decoration: none; font-weight: 600;">
                        🔁 Попробовать ещё раз
                    </a>
                </p>
            `);
        }
        
        if (!account_id) {
            throw new Error('ID аккаунта не получен');
        }

        LESTA_CONFIG.accessToken = access_token || null;
        LESTA_CONFIG.accountId = account_id;
        LESTA_CONFIG.nickname = nickname || 'Неизвестный игрок';
        LESTA_CONFIG.tokenExpiresAt = expires_at ? parseInt(expires_at) : null;
        
        console.log('✅ Lesta Games OAuth успешно!');
        console.log('   Игрок:', LESTA_CONFIG.nickname);
        console.log('   Account ID:', LESTA_CONFIG.accountId);
        console.log('   Access Token:', LESTA_CONFIG.accessToken ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');
        console.log('   Истекает:', expires_at ? new Date(expires_at * 1000).toLocaleString('ru-RU') : 'НЕ УКАЗАН');
        
        // Сохраняем только поля Lesta (не spread всего state — иначе дублируется updated_at в SQL)
        updateAppState({
            lesta_access_token: LESTA_CONFIG.accessToken,
            lesta_token_expires_at: LESTA_CONFIG.tokenExpiresAt,
            lesta_account_id: LESTA_CONFIG.accountId,
            lesta_nickname: LESTA_CONFIG.nickname
        }, (err) => {
            if (err) {
                console.error('❌ Ошибка сохранения данных Lesta Games:', err);
            } else {
                console.log('✅ Данные Lesta Games сохранены в БД');
                if (typeof broadcastStateUpdate === 'function') broadcastStateUpdate();
            }
        });
        
        // Запускаем автосинхронизацию
        startLestaAutoSync();
        
        res.send(`
            <script>
                window.opener.postMessage({ type: 'LESTA_OAUTH_SUCCESS' }, '*');
            </script>
            <h3 style="text-align: center; margin-top: 50px; color: green;">
                ✅ Авторизация Lesta Games успешна!<br><br>
                <strong>Игрок:</strong> ${LESTA_CONFIG.nickname}<br>
                <strong>Account ID:</strong> ${LESTA_CONFIG.accountId}<br>
                <strong>Access Token:</strong> ${LESTA_CONFIG.accessToken ? 'Получен' : 'Не получен'}<br>
                <strong>Истекает:</strong> ${expires_at ? new Date(expires_at * 1000).toLocaleString('ru-RU') : 'Не указано'}<br><br>
                Вы можете закрыть это окно вручную.
            </h3>
        `);
    } catch (error) {
        console.error('❌ Lesta Games OAuth ошибка:', error.message);
        res.status(500).send(`
            <h3 style="color: red;">Ошибка авторизации Lesta Games</h3>
            <p>${error.message}</p>
            <p>Попробуйте еще раз или обратитесь к администратору.</p>
        `);
    }
});

// API эндпоинты для диагностики
app.get('/api/status', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// API для проверки статуса Centrifugo DonatePay
app.get('/api/dp-centrifugo-status', (req, res) => {
    const status = {
        apiKey: !!DP_CONFIG.apiKey,
        userId: DP_CONFIG.userId || null,
        centrifugoConnected: !!donatePayCentrifuge,
        centrifugoState: donatePayCentrifuge ? (donatePayCentrifuge.state || 'unknown') : 'not_initialized',
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
async function getDonationsFromAPI() {
    if (!DA_CONFIG.accessToken) {
        console.log('⚠️ Токен DonationAlerts не настроен');
        return [];
    }

    try {
        pollLog('DonationAlerts: запрос донатов...');
        
        // Запрашиваем только последние 5 донатов для уменьшения нагрузки
        // Старые донаты будут отфильтрованы по времени при обработке
        const response = await axios.get(`${DA_CONFIG.apiUrl}/alerts/donations`, {
            headers: {
                'Authorization': `Bearer ${DA_CONFIG.accessToken}`,
                'Content-Type': 'application/json'
            },
            params: {
                page: 1,
                per_page: 5  // Уменьшено с 10 до 5 для оптимизации
            },
            timeout: 10000
        });

        pollLog('DonationAlerts: получено', response.data.data?.length || 0);
        
        if (response.data.data && response.data.data.length > 0) {
            console.log('📊 Пример доната:', response.data.data[0]);
            console.log('📊 Всего донатов в ответе:', response.data.data.length);
        } else {
            console.log('⚠️ Донатов в ответе API нет');
        }
        
        return response.data.data || [];
    } catch (error) {
        console.error('❌ Ошибка API DonationAlerts:', error.response?.status, error.response?.data || error.message);
        
        if (error.response?.status === 401) {
            DA_CONFIG.accessToken = null;
            console.log('🔑 Токен устарел, требуется повторная авторизация');
            
            getAppState((state) => {
                if (state) {
                    updateAppState({
                        da_access_token: null
                    }, () => {});
                }
            });
        }
        
        return [];
    }
}

// API для получения информации о пользователе DonatePay
async function getDonatePayUser() {
    if (!DP_CONFIG.apiKey) {
        console.log('⚠️ API ключ DonatePay не настроен');
        return null;
    }

    try {
        console.log('🔍 Запрос информации о пользователе DonatePay...');
        console.log('📋 Параметры запроса:', {
            url: `${DP_CONFIG.apiUrl}/user`,
            apiKey: DP_CONFIG.apiKey ? `${DP_CONFIG.apiKey.substring(0, 10)}...` : 'ОТСУТСТВУЕТ'
        });
        
        const response = await axios.get(`${DP_CONFIG.apiUrl}/user`, {
            params: {
                access_token: DP_CONFIG.apiKey
            },
            timeout: 10000,
            validateStatus: function (status) {
                return status < 500; // Разрешаем все статусы кроме 5xx
            }
        });

        console.log('📥 Ответ от DonatePay API:', {
            status: response.status,
            statusText: response.statusText,
            hasData: !!response.data,
            dataKeys: response.data ? Object.keys(response.data) : []
        });

        if (response.status === 429) {
            const errorTimestamp = Date.now();
            DP_CONFIG.lastError = { status: 429, message: 'Too Many Requests', timestamp: errorTimestamp };
            // Сохраняем время ошибки в БД
            getAppState((state) => {
                if (state) {
                    updateAppState({
                        dp_last_429_error_ts: errorTimestamp
                    }, (err) => {
                        if (err) {
                            console.error('❌ Ошибка сохранения времени ошибки 429:', err);
                        } else {
                            console.log('✅ Время ошибки 429 сохранено в БД');
                        }
                    });
                }
            });
            console.warn('⚠️ DonatePay API: Превышен лимит запросов (Too Many Attempts).');
            console.warn('💡 Подождите 5 минут перед повторной попыткой. Запросы будут автоматически возобновлены.');
            console.warn('📋 Ответ сервера:', JSON.stringify(response.data, null, 2));
            return null;
        }

        if (response.status === 401) {
            DP_CONFIG.lastError = { status: 401, message: 'Unauthorized', timestamp: Date.now() };
            console.warn('⚠️ DonatePay API: Неавторизован. Проверьте API ключ.');
            console.warn('📋 Ответ сервера:', JSON.stringify(response.data, null, 2));
            return null;
        }

        if (response.status !== 200) {
            console.error('❌ DonatePay API вернул ошибку:', {
                status: response.status,
                statusText: response.statusText,
                data: response.data
            });
            return null;
        }

        if (response.data && response.data.data) {
            DP_CONFIG.userId = response.data.data.id;
            
            // Сохраняем userId в БД для будущих запусков
            getAppState((state) => {
                if (state) {
                    // Сохраняем userId в БД для будущих запусков
                    updateAppState({
                        dp_user_id: DP_CONFIG.userId
                    }, (err) => {
                        if (!err) {
                            console.log('✅ userId сохранен в БД для будущих запусков:', DP_CONFIG.userId);
                        } else {
                            console.error('❌ Ошибка сохранения userId в БД:', err);
                        }
                    });
                }
            });
            
            // Сбрасываем ошибку при успешном запросе
            if (DP_CONFIG.lastError && DP_CONFIG.lastError.status === 429) {
                console.log('✅ Успешный запрос /user после ошибки 429, сбрасываем флаг ошибки');
                DP_CONFIG.lastError = null;
                // Очищаем время ошибки в БД
                getAppState((state) => {
                    if (state) {
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
                });
            }
            
            console.log('✅ Получена информация о пользователе DonatePay:', {
                id: response.data.data.id,
                name: response.data.data.name,
                avatar: response.data.data.avatar,
                balance: response.data.data.balance
            });
            return response.data.data;
        }

        console.warn('⚠️ DonatePay API: Неожиданный формат ответа:', JSON.stringify(response.data, null, 2));
        return null;
    } catch (error) {
        const status = error.response?.status;
        const errorData = error.response?.data;
        
        console.error('❌ Ошибка API DonatePay /user:', {
            status: status || 'НЕТ СТАТУСА',
            statusText: error.response?.statusText || 'НЕТ',
            message: error.message,
            data: errorData ? JSON.stringify(errorData, null, 2) : 'НЕТ ДАННЫХ',
            code: error.code,
            url: error.config?.url,
            apiKey: DP_CONFIG.apiKey ? `${DP_CONFIG.apiKey.substring(0, 10)}...` : 'ОТСУТСТВУЕТ'
        });
        
        if (status === 429) {
            const errorTimestamp = Date.now();
            DP_CONFIG.lastError = { status: 429, message: 'Too Many Requests', timestamp: errorTimestamp };
            // Сохраняем время ошибки в БД
            getAppState((state) => {
                if (state) {
                    updateAppState({
                        dp_last_429_error_ts: errorTimestamp
                    }, (err) => {
                        if (err) {
                            console.error('❌ Ошибка сохранения времени ошибки 429:', err);
                        } else {
                            console.log('✅ Время ошибки 429 сохранено в БД');
                        }
                    });
                }
            });
            console.warn('⚠️ DonatePay API: Превышен лимит запросов (Too Many Attempts).');
            console.warn('💡 Подождите 5 минут перед повторной попыткой. Запросы будут автоматически возобновлены.');
        } else if (status === 401) {
            DP_CONFIG.lastError = { status: 401, message: 'Unauthorized', timestamp: Date.now() };
            console.warn('⚠️ DonatePay API: Неавторизован. Проверьте API ключ.');
            console.warn('💡 Убедитесь, что API ключ правильный и активный');
        } else if (status === 404) {
            console.warn('⚠️ DonatePay API: Endpoint не найден. Проверьте URL API.');
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            console.warn('⚠️ DonatePay API: Проблема с подключением к серверу.');
        } else {
            console.error('❌ Неизвестная ошибка API DonatePay');
        }
        return null;
    }
}

// ПРОСТАЯ функция для парсинга HTML виджета last-events и получения новых донатов
async function getDonatePayLastEventsSimple() {
    // Используем токен из widgetUrl или напрямую
    let widgetToken = null;
    
    if (DP_CONFIG.widgetUrl) {
        // Извлекаем токен из URL - поддерживаем разные форматы
        const url = DP_CONFIG.widgetUrl.trim();
        
        // Формат 1: https://widget.donatepay.ru/last-events?token=XXX
        if (url.includes('last-events') && url.includes('token=')) {
            const match = url.match(/token=([^&]+)/);
            if (match) widgetToken = match[1];
        }
        // Формат 2: https://widget.donatepay.ru/alert-box/widget/XXX
        else if (url.includes('widget/')) {
            const match = url.match(/widget\/([^/?]+)/);
            if (match) widgetToken = match[1];
        }
        // Формат 3: Просто токен
        else if (!url.includes('http') && !url.includes('/')) {
            widgetToken = url;
        }
        // Формат 4: Любой URL с token=
        else if (url.includes('token=')) {
            const match = url.match(/token=([^&]+)/);
            if (match) widgetToken = match[1];
        }
        
        console.log('🔑 Извлеченный токен виджета:', widgetToken ? widgetToken.substring(0, 10) + '...' : 'НЕ НАЙДЕН');
    }
    
    if (!widgetToken) {
        console.log('⚠️ Токен виджета DonatePay не найден');
        return [];
    }
    
    // Парсим HTML страницу виджета
    const lastEventsUrl = `https://widget.donatepay.ru/last-events?token=${widgetToken}`;
    
    try {
        console.log('🔍 Парсинг HTML виджета last-events DonatePay...');
        console.log('📋 URL:', lastEventsUrl.replace(/token=[^&]+/, 'token=***'));
        
        const response = await axios.get(lastEventsUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 10000
        });
        
        const html = response.data;
        const $ = cheerio.load(html);
        const donations = [];
        
        console.log('📄 Размер HTML ответа:', html.length, 'символов');
        console.log('🔍 Поиск донатов в HTML...');
        
        // Сохраняем HTML для отладки (первые 5000 символов)
        const htmlPreview = html.substring(0, 5000);
        console.log('📋 HTML превью (первые 5000 символов):');
        console.log(htmlPreview);
        console.log('---');
        
        // Сначала ищем данные в JavaScript переменных (самый надежный способ)
        const scriptTags = $('script');
        console.log(`📜 Найдено <script> тегов: ${scriptTags.length}`);
        let foundInScripts = false;
        
        for (let i = 0; i < scriptTags.length && !foundInScripts; i++) {
            const script = scriptTags[i];
            const scriptContent = $(script).html() || '';
            
            if (!scriptContent || scriptContent.length < 50) continue;
            
            console.log(`📜 Обработка скрипта ${i + 1}/${scriptTags.length}, длина: ${scriptContent.length}`);
            
            // Ищем JSON данные с донатами
            const jsonPatterns = [
                /var\s+events\s*=\s*(\[[^\]]+\])/gi,
                /var\s+donations\s*=\s*(\[[^\]]+\])/gi,
                /const\s+events\s*=\s*(\[[^\]]+\])/gi,
                /let\s+events\s*=\s*(\[[^\]]+\])/gi,
                /events:\s*(\[[^\]]+\])/gi,
                /donations:\s*(\[[^\]]+\])/gi,
                /"events"\s*:\s*(\[[^\]]+\])/gi,
                /"donations"\s*:\s*(\[[^\]]+\])/gi
            ];
            
            for (const pattern of jsonPatterns) {
                if (foundInScripts) break;
                const matches = scriptContent.match(pattern);
                if (matches) {
                    console.log(`✅ Найдены данные в JavaScript переменной`);
                    try {
                        console.log(`📋 Найден паттерн в скрипте ${i}, длина скрипта: ${scriptContent.length}`);
                        
                        // Пробуем разные способы извлечения JSON
                        // Способ 1: Ищем полный JSON массив
                        const jsonArrayPatterns = [
                            /\[[\s\S]*?\{[\s\S]*?"(?:sum|amount|what|name|username)"[\s\S]*?\}[\s\S]*?\]/g,
                            /\[[\s\S]*?\{[\s\S]*?\}[\s\S]*?\]/g,
                            /(\[[\s\S]{100,}\])/g  // Массив длиннее 100 символов
                        ];
                        
                        for (const jsonPattern of jsonArrayPatterns) {
                            const jsonMatches = scriptContent.match(jsonPattern);
                            if (jsonMatches) {
                                for (const jsonStr of jsonMatches) {
                                    try {
                                        const events = JSON.parse(jsonStr);
                                        if (Array.isArray(events) && events.length > 0) {
                                            console.log(`✅ Распарсено ${events.length} событий из JSON массива`);
                                            console.log(`📊 Пример события:`, JSON.stringify(events[0], null, 2));
                                            
                                            events.forEach((event, idx) => {
                                                const amount = parseFloat(event.sum || event.amount || event.summa || 0);
                                                if (amount > 0) {
                                                    const eventId = event.id || event.transaction_id || `dp_js_${Date.now()}_${idx}`;
                                                    const username = event.what || event.name || event.username || event.user || 'Аноним';
                                                    const message = event.comment || event.message || '';
                                                    const createdAt = event.created_at || event.date || event.time || new Date().toISOString();
                                                    
                                                    donations.push({
                                                        id: `dp_${eventId}`,
                                                        username: username,
                                                        amount: amount,
                                                        message: message,
                                                        currency: 'RUB',
                                                        platform: 'donatepay_widget',
                                                        created_at: createdAt,
                                                        original_id: eventId
                                                    });
                                                    
                                                    console.log(`✅ Найден донат из JS: ${username} - ${amount}₽ (ID: ${eventId})`);
                                                }
                                            });
                                            foundInScripts = true;
                                            break;
                                        }
                                    } catch (parseError) {
                                        // Продолжаем пробовать другие паттерны
                                        continue;
                                    }
                                }
                                if (foundInScripts) break;
                            }
                        }
                        
                        // Способ 2: Ищем объект с данными (не массив)
                        if (!foundInScripts) {
                            const objectPatterns = [
                                /\{[\s\S]*?"(?:events|donations|data)"[\s\S]*?:[\s\S]*?\[[\s\S]*?\][\s\S]*?\}/g,
                                /window\.(?:events|donations|data)\s*=\s*(\[[\s\S]*?\])/g
                            ];
                            
                            for (const objPattern of objectPatterns) {
                                const objMatches = scriptContent.match(objPattern);
                                if (objMatches) {
                                    for (const objStr of objMatches) {
                                        try {
                                            const data = JSON.parse(objStr);
                                            const events = data.events || data.donations || data.data || (Array.isArray(data) ? data : []);
                                            if (Array.isArray(events) && events.length > 0) {
                                                console.log(`✅ Распарсено ${events.length} событий из объекта`);
                                                events.forEach((event, idx) => {
                                                    const amount = parseFloat(event.sum || event.amount || event.summa || 0);
                                                    if (amount > 0) {
                                                        const eventId = event.id || event.transaction_id || `dp_js_${Date.now()}_${idx}`;
                                                        const username = event.what || event.name || event.username || event.user || 'Аноним';
                                                        const message = event.comment || event.message || '';
                                                        const createdAt = event.created_at || event.date || event.time || new Date().toISOString();
                                                        
                                                        donations.push({
                                                            id: `dp_${eventId}`,
                                                            username: username,
                                                            amount: amount,
                                                            message: message,
                                                            currency: 'RUB',
                                                            platform: 'donatepay_widget',
                                                            created_at: createdAt,
                                                            original_id: eventId
                                                        });
                                                        
                                                        console.log(`✅ Найден донат из JS объекта: ${username} - ${amount}₽ (ID: ${eventId})`);
                                                    }
                                                });
                                                foundInScripts = true;
                                                break;
                                            }
                                        } catch (parseError) {
                                            continue;
                                        }
                                    }
                                    if (foundInScripts) break;
                                }
                            }
                        }
                    } catch (e) {
                        console.log('⚠️ Ошибка парсинга JSON из JavaScript:', e.message);
                        console.log('   Stack:', e.stack);
                    }
                }
            }
            
        }
        
        // Если не нашли в JavaScript, ищем в HTML
        if (!foundInScripts) {
            console.log('🔍 Поиск донатов в HTML элементах...');
            
            // Пробуем разные селекторы
            const selectors = [
                '.donation-item',
                '.event-item',
                '.last-event',
                '.event',
                '[class*="donation"]',
                '[class*="event"]',
                '.item',
                'li',
                '.transaction',
                '[data-id]',
                '[data-amount]'
            ];
            
            let foundElements = null;
            for (const selector of selectors) {
                const elements = $(selector);
                if (elements.length > 0) {
                    foundElements = elements;
                    console.log(`✅ Найдено элементов с селектором "${selector}": ${elements.length}`);
                    break;
                }
            }
            
            // Если не нашли через селекторы, ищем все элементы с текстом, содержащим числа и имена
            if (!foundElements || foundElements.length === 0) {
                console.log('🔍 Поиск донатов по тексту...');
                // Ищем все элементы, которые могут содержать донаты
                const allElements = $('div, li, span, p, td');
                console.log(`📊 Всего элементов для проверки: ${allElements.length}`);
                
                // Берем первые 50 элементов для проверки (чтобы не проверять все)
                allElements.slice(0, 50).each((index, element) => {
                    const $el = $(element);
                    const text = $el.text().trim();
                    
                    // Ищем паттерн: имя + сумма (например: "Иван 100₽" или "Иван 100 руб")
                    const donationPattern = /([А-Яа-яA-Za-z0-9_\-\.]+)\s+(\d+[.,]?\d*)\s*(?:₽|руб|RUB)/i;
                    const match = text.match(donationPattern);
                    
                    if (match && match.length >= 3) {
                        const username = match[1].trim();
                        const amount = parseFloat(match[2].replace(',', '.'));
                        
                        if (amount > 0 && username.length > 0) {
                            const eventId = $el.attr('data-id') || $el.attr('id') || `dp_text_${Date.now()}_${index}`;
                            
                            donations.push({
                                id: `dp_${eventId}`,
                                username: username,
                                amount: amount,
                                message: '',
                                currency: 'RUB',
                                platform: 'donatepay_widget',
                                created_at: new Date().toISOString(),
                                original_id: eventId
                            });
                            
                            console.log(`✅ Найден донат по тексту: ${username} - ${amount}₽ (ID: ${eventId})`);
                        }
                    }
                });
            } else {
                foundElements = foundElements; // Используем найденные элементы
            }
        }
        
        // Если не нашли через селекторы, ищем в JavaScript переменных
        if (foundElements.length === 0) {
            console.log('🔍 Поиск данных в JavaScript переменных...');
            const scriptTags = $('script');
            scriptTags.each((i, script) => {
                const scriptContent = $(script).html() || '';
                
                // Ищем массивы событий в JavaScript
                const patterns = [
                    /events\s*[:=]\s*\[([^\]]+)\]/gi,
                    /donations\s*[:=]\s*\[([^\]]+)\]/gi,
                    /data\s*[:=]\s*\[([^\]]+)\]/gi,
                    /\[({[^}]+"type"[^}]*"donation"[^}]+})\]/gi
                ];
                
                for (const pattern of patterns) {
                    const matches = scriptContent.match(pattern);
                    if (matches) {
                        console.log(`✅ Найдены данные в JavaScript: ${matches.length} совпадений`);
                        // Парсим JSON из найденных строк
                        try {
                            const jsonMatch = scriptContent.match(/\[(\{[^}]+\}(?:,\s*\{[^}]+\})*)\]/);
                            if (jsonMatch) {
                                const events = JSON.parse('[' + jsonMatch[1] + ']');
                                if (Array.isArray(events)) {
                                    foundElements = events.map((e, idx) => ({ data: e, index: idx }));
                                    console.log(`✅ Распарсено ${events.length} событий из JavaScript`);
                                    break;
                                }
                            }
                        } catch (e) {
                            console.log('⚠️ Ошибка парсинга JSON из JavaScript:', e.message);
                        }
                    }
                }
            });
        }
        
        // Обрабатываем найденные элементы
        if (Array.isArray(foundElements)) {
            // Данные из JavaScript массива
            foundElements.forEach((element, index) => {
                try {
                    const eventData = element.data || element;
                    const amount = parseFloat(eventData.sum || eventData.amount || eventData.summa || 0);
                    if (amount > 0) {
                        const eventId = eventData.id || eventData.transaction_id || `dp_${Date.now()}_${index}`;
                        const username = eventData.what || eventData.name || eventData.username || eventData.user || 'Аноним';
                        const message = eventData.comment || eventData.message || '';
                        const createdAt = eventData.created_at || eventData.date || eventData.time || new Date().toISOString();
                        
                        donations.push({
                            id: `dp_${eventId}`,
                            username: username,
                            amount: amount,
                            message: message,
                            currency: 'RUB',
                            platform: 'donatepay_widget',
                            created_at: createdAt,
                            original_id: eventId
                        });
                        
                        console.log(`✅ Найден донат: ${username} - ${amount}₽ (ID: ${eventId})`);
                    }
                } catch (e) {
                    console.log(`⚠️ Ошибка обработки элемента ${index}:`, e.message);
                }
            });
        } else {
            // Данные из HTML элементов
            foundElements.each((index, element) => {
                try {
                    const $el = $(element);
                    
                    // Пробуем разные способы извлечения данных
                    let eventData = {
                        id: $el.attr('data-id') || $el.attr('id') || $el.find('[data-id]').attr('data-id') || `event_${Date.now()}_${index}`,
                        username: $el.attr('data-username') || $el.attr('data-name') || $el.find('[data-username]').attr('data-username') || 
                                $el.find('[class*="name"]').first().text().trim() || $el.find('[class*="user"]').first().text().trim() || '',
                        amount: 0,
                        message: $el.attr('data-message') || $el.attr('data-comment') || $el.find('[class*="message"]').first().text().trim() || 
                                $el.find('[class*="comment"]').first().text().trim() || '',
                        created_at: $el.attr('data-time') || $el.attr('data-date') || $el.find('[data-time]').attr('data-time') || new Date().toISOString()
                    };
                    
                    // Парсим сумму из разных мест
                    const amountText = $el.attr('data-amount') || $el.attr('data-sum') || 
                                      $el.find('[data-amount]').attr('data-amount') ||
                                      $el.find('[class*="amount"]').first().text() ||
                                      $el.find('[class*="sum"]').first().text() ||
                                      $el.text();
                    
                    if (amountText) {
                        const amountMatch = amountText.match(/[\d.,]+/);
                        if (amountMatch) {
                            eventData.amount = parseFloat(amountMatch[0].replace(',', '.'));
                        }
                    }
                    
                    // Если не нашли сумму, пробуем найти число в тексте элемента
                    if (eventData.amount === 0) {
                        const text = $el.text();
                        const numbers = text.match(/[\d.,]+/g);
                        if (numbers && numbers.length > 0) {
                            // Берем самое большое число (скорее всего это сумма)
                            eventData.amount = Math.max(...numbers.map(n => parseFloat(n.replace(',', '.'))));
                        }
                    }
                    
                    // Проверяем, что это донат (есть сумма и имя)
                    if (eventData.amount > 0 && eventData.username) {
                        donations.push({
                            id: `dp_${eventData.id}`,
                            username: eventData.username,
                            amount: eventData.amount,
                            message: eventData.message,
                            currency: 'RUB',
                            platform: 'donatepay_widget',
                            created_at: eventData.created_at,
                            original_id: eventData.id
                        });
                        
                        console.log(`✅ Найден донат: ${eventData.username} - ${eventData.amount}₽ (ID: ${eventData.id})`);
                    }
                } catch (e) {
                    console.log(`⚠️ Ошибка обработки элемента ${index}:`, e.message);
                }
            });
        }
        
        console.log(`✅ Всего найдено донатов в виджете: ${donations.length}`);
        
        if (donations.length > 0) {
            console.log(`📊 Примеры найденных донатов:`);
            donations.slice(0, 3).forEach((d, idx) => {
                console.log(`   ${idx + 1}. ${d.username} - ${d.amount}₽ (ID: ${d.id})`);
            });
        } else {
            console.log('⚠️ Донаты не найдены в виджете');
            console.log('💡 Проверьте структуру HTML виджета в логах выше');
        }
        
        return donations;
        
    } catch (error) {
        console.error('❌ Ошибка парсинга виджета last-events:', error.message);
        if (error.response) {
            console.error('   Статус:', error.response.status);
            console.error('   Данные:', error.response.data?.substring(0, 200));
        }
        return [];
    }
}

// Функция для получения последних событий из виджета DonatePay (старая версия - оставлена для совместимости)
async function getDonatePayLastEvents() {
    // Извлекаем токен из widgetUrl
    let widgetToken = null;
    
    if (!DP_CONFIG.widgetUrl) {
        console.log('⚠️ URL виджета DonatePay не настроен для last-events');
        return [];
    }
    
    // Извлекаем токен из URL
    if (DP_CONFIG.widgetUrl.includes('token=')) {
        widgetToken = DP_CONFIG.widgetUrl.split('token=')[1]?.split('&')[0];
    } else if (DP_CONFIG.widgetUrl.includes('widget/')) {
        widgetToken = DP_CONFIG.widgetUrl.split('widget/')[1]?.split('?')[0]?.split('/')[0];
    } else if (DP_CONFIG.widgetUrl.includes('last-events')) {
        // Если это уже URL last-events, извлекаем токен из него
        widgetToken = DP_CONFIG.widgetUrl.split('token=')[1]?.split('&')[0];
    } else {
        // Возможно, это уже токен
        widgetToken = DP_CONFIG.widgetUrl.trim();
    }
    
    if (!widgetToken) {
        console.log('⚠️ Не удалось извлечь токен из URL виджета');
        return [];
    }
    
    // Используем правильный API endpoint /last-events/fetch вместо /last-events
    const lastEventsUrl = `https://widget.donatepay.ru/last-events/fetch?token=${widgetToken}`;

    try {
        console.log('🔍 Запрос последних событий DonatePay через API...');
        console.log('📋 URL:', lastEventsUrl.replace(/token=[^&]+/, 'token=***'));
        
        const response = await axios.get(lastEventsUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        // Проверяем, что получили JSON, а не HTML
        if (typeof response.data === 'string' && response.data.includes('<!DOCTYPE')) {
            console.warn('⚠️ Получен HTML вместо JSON. Возможно, неправильный endpoint или токен.');
            console.warn('💡 Попробуйте использовать токен из виджета last-events');
            return [];
        }

        console.log('📊 Ответ last-events API:', JSON.stringify(response.data, null, 2));

        const donations = [];
        
        // Обрабатываем разные форматы ответа
        let events = null;
        
        if (Array.isArray(response.data)) {
            // Прямой массив событий
            events = response.data;
        } else if (response.data && typeof response.data === 'object') {
            // Данные могут быть в объекте
            if (Array.isArray(response.data.data)) {
                events = response.data.data;
            } else if (Array.isArray(response.data.events)) {
                events = response.data.events;
            } else if (Array.isArray(response.data.items)) {
                events = response.data.items;
            } else {
                // Попробуем найти массив в любом свойстве
                for (const key in response.data) {
                    if (Array.isArray(response.data[key])) {
                        events = response.data[key];
                        console.log(`📋 Найден массив событий в поле: ${key}`);
                        break;
                    }
                }
            }
        }
        
        if (events && Array.isArray(events)) {
            console.log(`📊 Получено ${events.length} событий из API`);
            events.forEach((event, index) => {
                // Обрабатываем разные форматы событий
                if (event.type === 'donation' || event.sum || event.amount) {
                    // Проверяем статус, если есть
                    if (event.status && event.status !== 'success') {
                        console.log(`⏭️ Пропуск события с статусом ${event.status}:`, event);
                        return;
                    }
                    
                    const eventId = event.id || event.transaction_id || `events_${Date.now()}_${index}`;
                    const username = event.what || event.name || event.username || 'Аноним';
                    const amount = parseFloat(event.sum || event.amount || 0);
                    const message = event.comment || event.message || '';
                    const createdAt = event.created_at || event.date || new Date().toISOString();
                    
                    if (amount > 0) {
                        donations.push({
                            id: `dp_events_${eventId}`,
                            username: username,
                            amount: amount,
                            message: message,
                            currency: 'RUB',
                            platform: 'donatepay_events',
                            created_at: createdAt,
                            original_id: eventId
                        });
                        console.log(`✅ Добавлен донат из last-events: ${username} - ${amount}₽ (ID: ${eventId})`);
                    }
                }
            });
        } else {
            console.warn('⚠️ Не удалось найти массив событий в ответе API');
            console.warn('📋 Структура ответа:', Object.keys(response.data || {}));
        }

        console.log(`✅ Найдено событий в last-events: ${donations.length}`);
        if (donations.length > 0) {
            console.log(`📊 Пример доната из last-events:`, donations[0]);
        }
        return donations;

    } catch (error) {
        const status = error.response?.status;
        if (status === 429) {
            console.warn('⚠️ DonatePay last-events: Превышен лимит запросов. Увеличиваем интервал опроса.');
        } else if (status === 401) {
            console.warn('⚠️ DonatePay last-events: Неавторизован. Проверьте настройки.');
        } else {
            console.error('❌ Ошибка получения last-events DonatePay:', error.message);
        }
        return [];
    }
}

// Функция для считывания донатов из виджета DonatePay (alert-box или другие виджеты)
async function getDonatePayWidgetDonations() {
    if (!DP_CONFIG.widgetUrl) {
        console.log('⚠️ URL виджета DonatePay не настроен');
        return [];
    }

    try {
        console.log('🔍 Считывание донатов из виджета DonatePay...');
        console.log('📋 URL виджета:', DP_CONFIG.widgetUrl.replace(/\/[^\/]+$/, '/***'));
        
        // Извлекаем токен из URL для возможного использования API
        let widgetToken = null;
        if (DP_CONFIG.widgetUrl.includes('alert-box/widget/')) {
            widgetToken = DP_CONFIG.widgetUrl.split('alert-box/widget/')[1]?.split('?')[0]?.split('/')[0];
        } else if (DP_CONFIG.widgetUrl.includes('token=')) {
            widgetToken = DP_CONFIG.widgetUrl.split('token=')[1]?.split('&')[0];
        } else if (DP_CONFIG.widgetUrl.includes('widget/')) {
            widgetToken = DP_CONFIG.widgetUrl.split('widget/')[1]?.split('?')[0]?.split('/')[0];
        }
        
        // Сначала пытаемся получить данные через API, если это alert-box виджет
        if (widgetToken && DP_CONFIG.widgetUrl.includes('alert-box')) {
            try {
                // Пробуем API endpoint для alert-box (если существует)
                const apiUrl = `https://widget.donatepay.ru/alert-box/all-settings/${widgetToken}`;
                console.log('🔍 Попытка получить настройки alert-box через API...');
                
                const apiResponse = await axios.get(apiUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    },
                    timeout: 5000
                });
                
                // Если получили JSON с данными, используем их
                if (apiResponse.data && typeof apiResponse.data === 'object') {
                    console.log('✅ Получены данные alert-box через API');
                    // Здесь можно обработать данные из API, если они содержат информацию о донатах
                }
            } catch (apiError) {
                // API может не существовать или требовать авторизацию - это нормально
                console.log('📋 API alert-box недоступен, используем парсинг HTML');
            }
        }
        
        const response = await axios.get(DP_CONFIG.widgetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        const donations = [];

        // Для alert-box виджета ищем специфичные классы
        // Alert-box обычно использует Vue.js и может иметь структуру с v-for
        const selectors = [
            '.donation', '.alert', '.notification', '.donate-item',
            '.alert-box-item', '.alert-item', '.donation-item',
            '[class*="donation"]', '[class*="alert"]', '[class*="notification"]',
            '.v-card', '.v-list-item', '.alert-box'
        ];
        
        let foundElements = false;
        
        for (const selector of selectors) {
            const elements = $(selector);
            if (elements.length > 0) {
                console.log(`📋 Найдено элементов с селектором "${selector}": ${elements.length}`);
                foundElements = true;
                
                elements.each((index, element) => {
                    const $el = $(element);
                    
                    // Извлекаем данные доната
                    const username = $el.find('.username, .name, .donor-name, .donor, [class*="name"]').text().trim() || 
                                   $el.find('h3, h4, h5, .title, [class*="title"]').text().trim() || 
                                   $el.attr('data-username') || 'Аноним';
                    
                    const amountText = $el.find('.amount, .sum, .money, [class*="amount"], [class*="sum"]').text().trim() || 
                                     $el.find('.price, .cost, [class*="price"], [class*="cost"]').text().trim() ||
                                     $el.attr('data-amount') || '';
                    
                    const amount = parseFloat(amountText.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
                    
                    const message = $el.find('.message, .comment, .text, [class*="message"], [class*="comment"]').text().trim() || 
                                  $el.attr('data-message') || '';
                    
                    const timeText = $el.find('.time, .date, .timestamp, [class*="time"], [class*="date"]').text().trim() || '';
                    
                    // Также проверяем data-атрибуты
                    const dataId = $el.attr('data-id') || $el.attr('id') || null;
                    
                    if (amount > 0) {
                        donations.push({
                            id: dataId ? `dp_widget_${dataId}` : `dp_widget_${Date.now()}_${index}`,
                            username: username,
                            amount: amount,
                            message: message,
                            currency: 'RUB',
                            platform: 'donatepay_widget',
                            timeText: timeText
                        });
                        console.log(`✅ Найден донат в виджете: ${username} - ${amount}₽`);
                    }
                });
                
                if (donations.length > 0) break; // Если нашли донаты, прекращаем поиск
            }
        }

        // Если не нашли донаты через селекторы, пытаемся извлечь из JavaScript переменных
        if (donations.length === 0) {
            console.log('📋 Парсинг JavaScript переменных в HTML...');
            
            // Ищем window.user, window.config или другие переменные с данными
            const htmlContent = response.data;
            
            // Пытаемся найти данные в window.user или window.config
            const userMatch = htmlContent.match(/window\.user\s*=\s*({[^}]+})/);
            const configMatch = htmlContent.match(/window\.config\s*=\s*({[^}]+})/);
            
            if (userMatch || configMatch) {
                console.log('✅ Найдены JavaScript переменные в HTML');
            }
            
            // Также ищем данные в script тегах с Vue.js или другими фреймворками
            $('script').each((index, element) => {
                const scriptContent = $(element).html() || '';
                
                // Ищем JSON данные о донатах
                const jsonMatch = scriptContent.match(/donations?\s*[:=]\s*(\[[^\]]+\])/);
                if (jsonMatch) {
                    try {
                        const donationsData = JSON.parse(jsonMatch[1]);
                        if (Array.isArray(donationsData)) {
                            donationsData.forEach((donation, idx) => {
                                if (donation.sum || donation.amount) {
                                    donations.push({
                                        id: `dp_widget_${donation.id || Date.now()}_${idx}`,
                                        username: donation.what || donation.name || 'Аноним',
                                        amount: parseFloat(donation.sum || donation.amount || 0),
                                        message: donation.comment || donation.message || '',
                                        currency: 'RUB',
                                        platform: 'donatepay_widget',
                                        created_at: donation.created_at || new Date().toISOString()
                                    });
                                }
                            });
                            console.log(`✅ Найдено ${donations.length} донатов из JavaScript переменных`);
                        }
                    } catch (e) {
                        // Игнорируем ошибки парсинга
                    }
                }
            });
        }
        
        // Если всё ещё не нашли, пробуем поиск по тексту (более агрессивный)
        if (donations.length === 0) {
            console.log('📋 Поиск донатов по текстовым паттернам...');
            $('*').each((index, element) => {
                const $el = $(element);
                const text = $el.text().trim();
                
                // Ищем паттерны типа "Имя: 100₽" или "100₽ от Имя" или "100 руб"
                const amountMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:₽|руб|RUB)/i);
                if (amountMatch && text.length < 200) { // Ограничиваем длину текста
                    const amount = parseFloat(amountMatch[1].replace(',', '.'));
                    if (amount > 0) {
                        // Пытаемся найти имя донатера
                        const nameMatch = text.match(/(?:от\s+)?([А-Яа-яA-Za-z0-9_]{2,20})/);
                        const username = nameMatch ? nameMatch[1] : 'Аноним';
                        
                        // Проверяем, что это не дубликат
                        const isDuplicate = donations.some(d => 
                            d.username === username && Math.abs(d.amount - amount) < 0.01
                        );
                        
                        if (!isDuplicate) {
                            donations.push({
                                id: `dp_widget_${Date.now()}_${index}`,
                                username: username,
                                amount: amount,
                                message: text,
                                currency: 'RUB',
                                platform: 'donatepay_widget'
                            });
                        }
                    }
                }
            });
        }

        console.log(`✅ Найдено донатов в виджете: ${donations.length}`);
        if (donations.length > 0) {
            console.log(`📊 Примеры донатов из виджета:`, donations.slice(0, 3).map(d => ({
                id: d.id,
                username: d.username,
                amount: d.amount
            })));
        } else {
            console.log('⚠️ Донаты в виджете не найдены. Возможные причины:');
            console.log('   - Виджет пуст (нет недавних донатов)');
            console.log('   - Структура HTML виджета изменилась');
            console.log('   - Виджет загружается динамически через JavaScript');
            console.log('💡 Для real-time донатов рекомендуется использовать Centrifugo');
        }
        return donations;

    } catch (error) {
        const status = error.response?.status;
        if (status === 429) {
            console.warn('⚠️ DonatePay widget: Превышен лимит запросов. Увеличиваем интервал опроса.');
        } else if (status === 401 || status === 403) {
            console.warn('⚠️ DonatePay widget: Неавторизован или доступ запрещен. Проверьте URL виджета.');
        } else {
            console.error('❌ Ошибка считывания виджета DonatePay:', error.message);
        }
        return [];
    }
}

// ПРОСТАЯ функция для получения донатов через newTransactions API (как в RutonyChat)
// Использует endpoint /newTransactions с параметром after для получения только новых транзакций
// Работает точно так же, как в RutonyChat - простой polling без сложной логики
async function getDonatePayNewTransactions() {
    if (!DP_CONFIG.apiKey) {
        return [];
    }

    try {
        // Используем lastTransactionId для получения только новых транзакций
        // Если был флаг ошибки "after incorrect", не используем after
        let afterId = DP_CONFIG.lastTransactionId || 0;
        const skipAfter = DP_CONFIG._skipAfter || false;
        
        if (skipAfter) {
            console.log('⚠️ Пропуск параметра "after" из-за предыдущей ошибки "after incorrect"');
            afterId = 0;
        }
        
        // Проверяем, что токен есть
        if (!DP_CONFIG.apiKey || DP_CONFIG.apiKey.trim() === '') {
            console.error('❌ DonatePay API ключ отсутствует или пустой!');
            return [];
        }
        
        // Простой запрос к API (как в RutonyChat)
        // Если afterId вызывает ошибку "after incorrect", не передаем его
        const params = {
            access_token: DP_CONFIG.apiKey.trim(),
            type: 'donation'
        };
        
        // Передаем after только если он больше 0 и не вызывает ошибку
        // Если API вернул "after incorrect", в следующий раз не передаем after
        if (afterId > 0) {
            params.after = afterId;
        }
        
        pollLog('DonatePay /newTransactions after=', afterId || 0);
        
        const response = await axios.get(`${DP_CONFIG.widgetApiUrl}/newTransactions`, {
            params: params,
            timeout: 10000
        });

        pollLog('DonatePay response', response.status, Array.isArray(response.data) ? response.data.length : 'obj');
        
        // Проверяем ответ на ошибки
        if (response.data && response.data.status === 'error') {
            const errorMessage = response.data.message || 'Неизвестная ошибка';
            console.error('❌ DonatePay API ошибка:', errorMessage);
            
            if (errorMessage.includes('after incorrect')) {
                console.warn('⚠️ Параметр "after" неправильный. В следующий раз запросим без него.');
                // Устанавливаем флаг, чтобы в следующий раз не передавать after
                DP_CONFIG._skipAfter = true;
                // Сбрасываем lastTransactionId
                DP_CONFIG.lastTransactionId = 0;
                getAppState((state) => {
                    if (state) {
                        updateAppState({
                            dp_last_transaction_id: 0
                        }, (err) => {
                            if (!err) {
                                console.log('✅ lastTransactionId сброшен в БД');
                            }
                        });
                    }
                });
            } else if (errorMessage.includes('token')) {
                console.error('💡 Проблема с токеном. Проверьте, что API ключ правильный и загружен из config.env');
                console.error('   Текущий API ключ:', DP_CONFIG.apiKey ? `${DP_CONFIG.apiKey.substring(0, 10)}...` : 'ОТСУТСТВУЕТ');
            }
            return [];
        }
        
        // Простая обработка ошибок (как в RutonyChat)
        if (response.status !== 200) {
            console.error('❌ DonatePay API вернул статус:', response.status);
            console.error('   Полный ответ:', JSON.stringify(response.data, null, 2));
            if (response.status === 429) {
                console.warn('⚠️ DonatePay API: Превышен лимит запросов. Пропускаем этот запрос.');
            } else if (response.status === 401) {
                console.warn('⚠️ DonatePay API: Неавторизован. Проверьте API ключ.');
            } else {
                console.warn(`⚠️ DonatePay API: Ошибка ${response.status}. Продолжаем работу.`);
            }
            return [];
        }
        
        // Обрабатываем ответ API (простая логика, как в RutonyChat)
        let transactions = [];
        if (Array.isArray(response.data)) {
            transactions = response.data;
            console.log('✅ Найден массив транзакций в response.data, количество:', transactions.length);
        } else if (response.data?.data && Array.isArray(response.data.data)) {
            transactions = response.data.data;
            console.log('✅ Найден массив транзакций в response.data.data, количество:', transactions.length);
        } else if (response.data?.transactions && Array.isArray(response.data.transactions)) {
            transactions = response.data.transactions;
            console.log('✅ Найден массив транзакций в response.data.transactions, количество:', transactions.length);
        } else {
            // Если формат неожиданный, логируем для отладки
            console.warn('⚠️ Неожиданный формат ответа DonatePay API');
            console.warn('   Структура ответа:', JSON.stringify(response.data, null, 2));
            return [];
        }
        
        // Преобразуем формат DonatePay в стандартный
        const processedDonations = [];
        let maxTransactionId = parseInt(afterId) || 0;
        
        console.log('🔍 Обработка транзакций, всего:', transactions.length);
        
        // Используем for...of вместо forEach, чтобы можно было использовать await
        for (let index = 0; index < transactions.length; index++) {
            const transaction = transactions[index];
            
            // Логируем первые 3 транзакции для отладки
            if (index < 3) {
                console.log(`📋 Транзакция #${index + 1}:`, {
                    id: transaction.id,
                    type: transaction.type,
                    status: transaction.status,
                    what: transaction.what,
                    sum: transaction.sum,
                    comment: transaction.comment,
                    created_at: transaction.created_at
                });
            }
            
            // Обрабатываем донаты - статус может быть 'success', 'user', 'paid' и т.д.
            // Главное - это тип 'donation' и наличие суммы
            const isDonation = transaction.type === 'donation';
            // Статусы, которые означают успешный/обработанный донат
            const validStatuses = ['success', 'user', 'paid', 'complete', 'done'];
            const isValidStatus = validStatuses.includes(transaction.status);
            
            if (isDonation && isValidStatus) {
                const transactionId = parseInt(transaction.id) || 0;
                const amount = parseFloat(transaction.sum || 0);
                
                if (amount > 0 && transactionId > 0) {
                    // Обрабатываем комментарий - убираем префикс "Комментарий: " если есть
                    let message = transaction.comment || '';
                    if (message.startsWith('Комментарий: ')) {
                        message = message.substring('Комментарий: '.length).trim();
                    }
                    
                    const donationId = `dp_${transaction.id}`;
                    
                    // ВАЖНО: Проверяем, не был ли этот донат уже обработан (есть в базе)
                    const donationExists = await checkDonationExists(donationId);
                    if (donationExists) {
                        console.log(`⏭️ Пропуск DonatePay доната (уже в базе): ID=${donationId}, transactionId=${transactionId}, username=${transaction.what}, amount=${amount}₽`);
                        // Все равно обновляем максимальный ID, чтобы не проверять этот донат снова
                        if (transactionId > maxTransactionId) {
                            maxTransactionId = transactionId;
                        }
                        continue;
                    }
                    
                    const donation = {
                        id: donationId,
                        username: transaction.what || 'Аноним',
                        amount: amount,
                        message: message,
                        currency: transaction.currency || 'RUB',
                        platform: 'donatepay',
                        created_at: transaction.created_at || new Date().toISOString(),
                        original_id: transaction.id
                    };
                    
                    processedDonations.push(donation);
                    console.log(`✅ Новый донат DonatePay: ${donation.username} - ${donation.amount}₽ (ID: ${donation.id}, transactionId: ${transactionId}, статус: ${transaction.status})`);
                    
                    // Обновляем максимальный ID
                    if (transactionId > maxTransactionId) {
                        maxTransactionId = transactionId;
                    }
                } else {
                    if (index < 3) {
                        console.log(`⏭️ Пропуск транзакции #${index + 1}: amount=${amount}, transactionId=${transactionId}`);
                    }
                }
            } else {
                if (index < 3) {
                    console.log(`⏭️ Пропуск транзакции #${index + 1}: type=${transaction.type}, status=${transaction.status} (не подходит под критерии)`);
                }
            }
        }
        
        // Сохраняем ID последней транзакции (как в RutonyChat)
        if (maxTransactionId > parseInt(afterId || 0)) {
            DP_CONFIG.lastTransactionId = maxTransactionId;
            // Сбрасываем флаг skipAfter, так как теперь у нас есть валидный ID
            if (DP_CONFIG._skipAfter) {
                DP_CONFIG._skipAfter = false;
                console.log('✅ Флаг skipAfter сброшен, теперь будем использовать after');
            }
            // Сохраняем в БД
            getAppState((state) => {
                if (state) {
                    updateAppState({
                        dp_last_transaction_id: maxTransactionId
                    }, (err) => {
                        if (err) {
                            console.error('❌ Ошибка сохранения lastTransactionId:', err);
                        } else {
                            console.log('✅ lastTransactionId сохранен:', maxTransactionId);
                        }
                    });
                }
            });
        }
        
        if (processedDonations.length > 0) {
            console.log(`✅ DonatePay: получено ${processedDonations.length} новых донатов`);
        }
        
        return processedDonations;
        
    } catch (error) {
        // Детальная обработка ошибок для диагностики
        const status = error.response?.status;
        const errorData = error.response?.data;
        
        if (errorData && errorData.status === 'error') {
            console.error('❌ DonatePay API ошибка:', errorData.message || 'Неизвестная ошибка');
            if (errorData.message && errorData.message.includes('token')) {
                console.error('💡 Проблема с токеном! Проверьте:');
                console.error('   1. API ключ в config.env: DP_API_KEY=...');
                console.error('   2. Текущий API ключ:', DP_CONFIG.apiKey ? `${DP_CONFIG.apiKey.substring(0, 10)}...` : 'ОТСУТСТВУЕТ');
                console.error('   3. Длина ключа:', DP_CONFIG.apiKey ? DP_CONFIG.apiKey.length : 0);
            }
        } else if (status === 429) {
            console.warn('⚠️ DonatePay API: Превышен лимит запросов. Пропускаем этот запрос.');
        } else if (status === 401) {
            console.warn('⚠️ DonatePay API: Неавторизован. Проверьте API ключ.');
        } else {
            // Только для неожиданных ошибок логируем детали
            if (status && status >= 500) {
                console.error('❌ Ошибка сервера DonatePay:', status, error.message);
            } else if (errorData) {
                console.error('❌ DonatePay API ответ:', JSON.stringify(errorData, null, 2));
            }
        }
        return [];
    }
}

// API для получения донатов из DonatePay (старая функция - отключена)
// ⚠️ ВНИМАНИЕ: Эта функция ОТКЛЮЧЕНА для polling
// DonatePay использует ТОЛЬКО real-time уведомления через Centrifugo
// Эта функция оставлена для совместимости, но НЕ вызывается в основном коде
async function getDonatePayDonations() {
    console.warn('⚠️ ВНИМАНИЕ: getDonatePayDonations() вызвана, но polling ОТКЛЮЧЕН!');
    console.warn('💡 DonatePay использует ТОЛЬКО real-time через Centrifugo. Эта функция не должна вызываться.');
    
    if (!DP_CONFIG.apiKey) {
        console.log('⚠️ API ключ DonatePay не настроен');
        return [];
    }

    try {
        console.log('🔍 Запрос донатов из DonatePay через /transactions...');
        
        // Проверяем, не было ли недавно ошибки 429
        const lastError = DP_CONFIG.lastError;
        if (lastError && lastError.status === 429) {
            const timeSinceError = Date.now() - (lastError.timestamp || 0);
            // Увеличиваем время ожидания до 5 минут после ошибки 429
            if (timeSinceError < 300000) { // 5 минут
                const minutesLeft = Math.ceil((300000 - timeSinceError) / 60000);
                console.log(`⏸️ Пропуск запроса донатов из-за недавней ошибки 429 (осталось ждать: ~${minutesLeft} мин)`);
                return [];
            } else {
                // Сбрасываем ошибку после истечения таймаута
                console.log('✅ Таймаут ошибки 429 истек, пробуем запрос снова');
                DP_CONFIG.lastError = null;
            }
        }
        
        const response = await axios.get(`${DP_CONFIG.apiUrl}/transactions`, {
            params: {
                access_token: DP_CONFIG.apiKey,
                limit: 25,
                type: 'donation',
                status: 'success',
                order: 'DESC'
            },
            timeout: 10000,
            validateStatus: function (status) {
                return status < 500; // Разрешаем все статусы кроме 5xx
            }
        });

        // Обрабатываем ошибки статуса
        if (response.status === 429) {
            DP_CONFIG.lastError = { status: 429, message: 'Too Many Requests', timestamp: Date.now() };
            console.warn('⚠️ DonatePay API /transactions: Превышен лимит запросов.');
            console.warn('💡 Подождите 5 минут перед следующей попыткой. Запросы будут автоматически возобновлены.');
            return [];
        }

        if (response.status === 401) {
            DP_CONFIG.lastError = { status: 401, message: 'Unauthorized', timestamp: Date.now() };
            console.warn('⚠️ DonatePay API /transactions: Неавторизован. Проверьте API ключ.');
            return [];
        }

        if (response.status !== 200) {
            console.error('❌ DonatePay API /transactions вернул ошибку:', {
                status: response.status,
                statusText: response.statusText,
                data: response.data
            });
            return [];
        }

        // Сбрасываем ошибку при успешном запросе
        if (DP_CONFIG.lastError && DP_CONFIG.lastError.status === 429) {
            console.log('✅ Успешный запрос после ошибки 429, сбрасываем флаг ошибки');
            DP_CONFIG.lastError = null;
        }

        console.log('✅ Получены донаты DonatePay:', response.data.data?.length || 0);
        console.log('📊 Последний обработанный ID:', DP_CONFIG.lastTransactionId || 'нет');
        
        if (response.data.data && response.data.data.length > 0) {
            console.log('📊 Пример доната:', {
                id: response.data.data[0].id,
                username: response.data.data[0].what,
                amount: response.data.data[0].sum,
                status: response.data.data[0].status,
                type: response.data.data[0].type
            });
            
            // Показываем все ID для отладки
            const allIds = response.data.data.map(d => d.id).slice(0, 5);
            console.log('📋 Первые 5 ID транзакций:', allIds);
        }
        
        // Преобразуем формат DonatePay в стандартный
        const donations = response.data.data || [];
        const processedDonations = [];
        
        // Сортируем донаты по ID (по убыванию, так как order=DESC)
        // Но на всякий случай сортируем еще раз
        donations.sort((a, b) => {
            const idA = parseInt(a.id) || 0;
            const idB = parseInt(b.id) || 0;
            return idB - idA; // По убыванию
        });
        
        let maxTransactionId = parseInt(DP_CONFIG.lastTransactionId) || 0;
        console.log('📊 Текущий lastTransactionId:', maxTransactionId);
        
        for (const donation of donations) {
            const transactionId = parseInt(donation.id) || 0;
            
            // Проверяем, новая ли это транзакция
            // Используем строгое сравнение: только если ID больше последнего обработанного
            if (transactionId > maxTransactionId) {
                console.log(`🆕 Найден новый донат DonatePay: ID=${transactionId}, username=${donation.what}, amount=${donation.sum}`);
                processedDonations.push({
                    id: `dp_${donation.id}`,
                    username: donation.what || 'Аноним',
                    amount: parseFloat(donation.sum) || 0,
                    message: donation.comment || '',
                    currency: 'RUB',
                    created_at: donation.created_at,
                    platform: 'donatepay'
                });
                
                // Обновляем максимальный ID
                if (transactionId > maxTransactionId) {
                    maxTransactionId = transactionId;
                }
            } else {
                console.log(`⏭️ Пропуск уже обработанного доната: ID=${transactionId} <= ${maxTransactionId}`);
            }
        }
        
        // Сохраняем ID последней транзакции если были новые донаты
        if (maxTransactionId > (DP_CONFIG.lastTransactionId || 0)) {
            DP_CONFIG.lastTransactionId = maxTransactionId;
            
            // Сохраняем в БД
            getAppState((state) => {
                if (state) {
                    updateAppState({
                        dp_last_transaction_id: maxTransactionId
                    }, (err) => {
                        if (err) {
                            console.error('❌ Ошибка сохранения ID последней транзакции:', err);
                        } else {
                            console.log('✅ ID последней транзакции сохранен:', maxTransactionId);
                        }
                    });
                }
            });
        }
        
        console.log(`🆕 Новых донатов DonatePay: ${processedDonations.length}`);
        
        // НЕ обрабатываем донаты здесь - они будут обработаны в checkForNewDonations()
        // Это гарантирует единообразную обработку всех донатов
        
        return processedDonations;
    } catch (error) {
        const status = error.response?.status;
        const errorData = error.response?.data;
        
        console.error('❌ Ошибка API DonatePay /transactions:', {
            status: status || 'НЕТ СТАТУСА',
            statusText: error.response?.statusText || 'НЕТ',
            message: error.message,
            data: errorData ? JSON.stringify(errorData, null, 2) : 'НЕТ ДАННЫХ',
            code: error.code
        });
        
        if (status === 429) {
            DP_CONFIG.lastError = { status: 429, message: 'Too Many Requests', timestamp: Date.now() };
            console.warn('⚠️ DonatePay API /transactions: Превышен лимит запросов.');
            console.warn('💡 Подождите 5 минут перед следующей попыткой. Запросы будут автоматически возобновлены.');
        } else if (status === 401) {
            DP_CONFIG.lastError = { status: 401, message: 'Unauthorized', timestamp: Date.now() };
            console.warn('⚠️ DonatePay API /transactions: Неавторизован. Проверьте API ключ.');
        }
        return [];
    }
}

// API для получения статистики из Lesta Games
// Функция продления access_token
async function prolongateLestaToken() {
    if (!LESTA_CONFIG.accessToken) {
        console.log('⚠️ Нет access_token для продления');
        return false;
    }

    try {
        console.log('🔄 Продление access_token Lesta Games...');
        
        const response = await axios.get('https://api.tanki.su/wot/auth/prolongate/', {
            params: {
                application_id: LESTA_CONFIG.applicationId,
                access_token: LESTA_CONFIG.accessToken
            },
            timeout: 10000
        });

        if (response.data.status === 'ok') {
            const newToken = response.data.data.access_token;
            const expiresAt = response.data.data.expires_at;
            
            // Обновляем токен в конфигурации
            LESTA_CONFIG.accessToken = newToken;
            
            // Сохраняем в БД
            updateAppState({
                lesta_access_token: newToken,
                lesta_token_expires_at: expiresAt
            }, (err) => {
                if (err) {
                    console.error('❌ Ошибка сохранения нового токена:', err);
                } else {
                    console.log('✅ Access_token продлен и сохранен');
                }
            });
            
            return true;
        } else {
            console.error('❌ Ошибка продления токена:', response.data.error);
            return false;
        }
    } catch (error) {
        console.error('❌ Ошибка запроса продления токена:', error.message);
        return false;
    }
}

async function getLestaPlayerStats() {
    if (!LESTA_CONFIG.applicationId || !LESTA_CONFIG.accountId) {
        return null;
    }

    return withLestaApiLock(async () => {
    // Проверяем срок действия токена и продлеваем при необходимости
    const now = Math.floor(Date.now() / 1000);
    const tokenExpiresAt = LESTA_CONFIG.tokenExpiresAt || 0;
    
    if (tokenExpiresAt > 0 && (tokenExpiresAt - now) < 3600) { // Продлеваем если осталось меньше часа
        const prolonged = await prolongateLestaToken();
        if (!prolonged) {
            console.log('⚠️ Не удалось продлить токен Lesta, продолжаем с текущим');
        }
    }

    try {
        const response = await axios.get(`${LESTA_CONFIG.apiUrl}/account/info/`, {
            params: {
                application_id: LESTA_CONFIG.applicationId,
                account_id: LESTA_CONFIG.accountId,
                access_token: LESTA_CONFIG.accessToken, // Опциональный параметр для приватных данных
                extra: 'statistics.rating', // Запрашиваем рейтинговую статистику (клановые/турнирные доступны по умолчанию)
                fields: 'statistics.all.battles,statistics.all.frags,statistics.all.wins,statistics.all.losses,statistics.all.damage_dealt,statistics.all.damage_received,statistics.all.xp,statistics.all.max_frags,statistics.all.frags8p,statistics.all.hits,statistics.all.shots,statistics.all.spotted,statistics.all.capture_points,statistics.all.dropped_capture_points,statistics.all.survived_battles,statistics.all.win_and_survived,statistics.all.max_xp,statistics.rating.battles,statistics.rating.wins,statistics.rating.losses,statistics.rating.frags,statistics.rating.damage_dealt,statistics.rating.xp,statistics.clan.battles,statistics.clan.wins,statistics.clan.losses,statistics.clan.frags,statistics.clan.damage_dealt,statistics.clan.damage_received,statistics.clan.xp,nickname'
            },
            timeout: 8000
        });

        if (response.data.status === 'ok' && response.data.data) {
            const playerData = response.data.data[LESTA_CONFIG.accountId];
            
            if (playerData && playerData.statistics && playerData.statistics.all) {
                const stats = playerData.statistics.all;
                const ratingStats = playerData.statistics.rating || {};
                const clanStats = playerData.statistics.clan || {};
                
                if (process.env.DEBUG_LESTA === '1') {
                    console.log('📊 Детальная статистика по типам боёв:', {
                        all_battles: stats.battles || 0,
                        rating_battles: ratingStats.battles || 0,
                        clan_battles: clanStats.battles || 0
                    });
                }
                
                // Суммируем все типы боёв: обычные (all) + рейтинговые (rating) + клановые/турнирные (clan)
                // По документации API, statistics.all.battles может не включать рейтинговые и клановые бои
                const totalBattles = (stats.battles || 0) + (ratingStats.battles || 0) + (clanStats.battles || 0);
                const totalWins = (stats.wins || 0) + (ratingStats.wins || 0) + (clanStats.wins || 0);
                const totalLosses = (stats.losses || 0) + (ratingStats.losses || 0) + (clanStats.losses || 0);
                const totalFrags = (stats.frags || 0) + (ratingStats.frags || 0) + (clanStats.frags || 0);
                const totalDamageDealt = (stats.damage_dealt || 0) + (ratingStats.damage_dealt || 0) + (clanStats.damage_dealt || 0);
                const totalXp = (stats.xp || 0) + (ratingStats.xp || 0) + (clanStats.xp || 0);
                
                if (process.env.DEBUG_LESTA === '1') {
                    console.log('✅ Lesta sync:', playerData.nickname, 'battles', totalBattles, 'frags', totalFrags);
                }
                
                return {
                    nickname: playerData.nickname || LESTA_CONFIG.nickname,
                    battles: totalBattles,
                    frags: totalFrags,
                    wins: totalWins,
                    losses: totalLosses,
                    damage_dealt: totalDamageDealt,
                    damage_received: stats.damage_received || 0,
                    xp: totalXp,
                    max_frags: stats.max_frags || 0,
                    frags8p: stats.frags8p || 0,
                    hits: stats.hits || 0,
                    shots: stats.shots || 0,
                    spotted: stats.spotted || 0,
                    capture_points: stats.capture_points || 0,
                    dropped_capture_points: stats.dropped_capture_points || 0,
                    survived_battles: stats.survived_battles || 0,
                    win_and_survived: stats.win_and_survived || 0,
                    max_xp: stats.max_xp || 0,
                    winRate: totalBattles > 0 ? (totalWins / totalBattles * 100).toFixed(1) : 0,
                    fragsPerBattle: totalBattles > 0 ? (totalFrags / totalBattles).toFixed(2) : 0,
                    avgDamage: totalBattles > 0 ? (totalDamageDealt / totalBattles).toFixed(0) : 0,
                    avgXp: totalBattles > 0 ? (totalXp / totalBattles).toFixed(0) : 0,
                    accuracy: stats.shots > 0 ? (stats.hits / stats.shots * 100).toFixed(1) : 0
                };
            } else {
                console.log('⚠️ Статистика не найдена в ответе API');
                console.log('🔍 Структура данных:', JSON.stringify(playerData, null, 2));
            }
        } else if (response.data.status === 'error') {
            console.error('❌ Ошибка Lesta Games API:', response.data.error);
        } else {
            console.log('⚠️ Неожиданный статус ответа:', response.data.status);
        }
        
        console.log('⚠️ Не удалось получить статистику Lesta Games');
        return null;
    } catch (error) {
        console.error('❌ Ошибка API Lesta Games:', error.response?.status, error.response?.data || error.message);
        
        // Обработка ошибок согласно документации Lesta Games API
        if (error.response?.data?.error) {
            const apiError = error.response.data.error;
            console.error('API Error:', apiError.code, apiError.message);
            
            switch (apiError.code) {
                case 'ACCOUNT_ID_NOT_SPECIFIED':
                    console.error('❌ Не заполнено обязательное поле account_id');
                    break;
                case 'INVALID_APPLICATION_ID':
                    console.error('❌ Неверный идентификатор приложения');
                    break;
                case 'REQUEST_LIMIT_EXCEEDED':
                    console.error('❌ Превышены лимиты квотирования');
                    break;
                case 'SOURCE_NOT_AVAILABLE':
                    console.error('❌ Источник данных не доступен');
                    break;
                default:
                    console.error('❌ Неизвестная ошибка API:', apiError.code);
            }
        }
        
        return null;
    }
    });
}

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

let lestaSyncTimer = null;
function stopLestaAutoSync() {
    if (lestaSyncTimer) {
        clearTimeout(lestaSyncTimer);
        lestaSyncTimer = null;
    }
    console.log('⏹️ Автосинхронизация Lesta Games остановлена');
}
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

async function startLestaAutoSync() {
    if (lestaSyncTimer) {
        clearTimeout(lestaSyncTimer);
    }
    
    console.log('🔄 Запуск автосинхронизации Lesta Games...');
    ensureLestaReliableSince();
    
    const syncLesta = async () => {
        try {
            const stats = await getLestaPlayerStats();
            if (stats) {
                // Логируем событие синхронизации
                analytics.logEvent('lesta_sync', {
                    battles: stats.battles,
                    frags: stats.frags,
                    winRate: stats.winRate,
                    fragsPerBattle: stats.fragsPerBattle
                });
                
                // Обновляем статистику в БД и отслеживаем изменения фрагов
                getAppState((state) => {
                    if (state) {
                        const previousFrags = state.lesta_previous_frags || 0;
                        const currentFrags = stats.frags;
                        const fragsDifference = currentFrags - previousFrags;
                        
                        const previousCounters = {
                            battles: state.lesta_last_battles || 0,
                            frags: state.lesta_last_frags || 0,
                            wins: state.lesta_last_wins || 0,
                            losses: state.lesta_last_losses || 0,
                            damage_dealt: state.lesta_last_damage_dealt || 0,
                            xp: state.lesta_last_xp || 0
                        };

                        const battlesSafe = safeLestaCounterDelta(previousCounters.battles, stats.battles);
                        const battlesDifference = battlesSafe.resync ? 0 : battlesSafe.delta;
                        const fragsSafe = safeLestaCounterDelta(previousCounters.frags, stats.frags, LESTA_MAX_BATTLES_DELTA * 3);
                        const effectiveFragsDifference = battlesSafe.resync ? 0 : fragsDifference;

                        if (battlesDifference > 0) {
                            console.log(`📊 Новых боев от Lesta API: ${battlesDifference}, изменение фрагов: ${effectiveFragsDifference}`);
                            
                            let remainingFrags = effectiveFragsDifference;
                            
                            for (let i = 0; i < battlesDifference; i++) {
                                let battleFrags = 0;
                                
                                if (remainingFrags > 0) {
                                    battleFrags = remainingFrags;
                                    remainingFrags = 0;
                                }
                                
                                addBattleForce(new Date().toISOString(), battleFrags, 'lesta');
                                console.log(`✅ Записан бой ${i + 1}/${battlesDifference}: ${battleFrags} фрагов`);
                            }
                        } else if (effectiveFragsDifference > 0) {
                            console.log(`ℹ️ Изменение фрагов без новых боев: +${effectiveFragsDifference} (боев не добавляем)`);
                        } else if (battlesSafe.resync) {
                            console.log(`ℹ️ Lesta: пересчёт статистики API (${previousCounters.battles} → ${stats.battles}), бои не добавляем`);
                        }
                        
                        const statsChanged =
                            stats.battles !== (state.lesta_last_battles || 0) ||
                            stats.frags !== (state.lesta_last_frags || 0) ||
                            stats.wins !== (state.lesta_last_wins || 0) ||
                            stats.damage_dealt !== (state.lesta_last_damage_dealt || 0);

                        const nowSec = Math.floor(Date.now() / 1000);
                        const lastHistoryAt = Number(state.lesta_last_history_at) || 0;
                        const needsHeartbeat = (nowSec - lastHistoryAt) >= LESTA_HISTORY_HEARTBEAT_SEC;
                        const hasActivity = statsChanged || effectiveFragsDifference > 0 || battlesDifference > 0;

                        if (!hasActivity) {
                            if (needsHeartbeat) {
                                updateAppState({ lesta_last_sync_time: nowSec }, (err) => {
                                    if (!err) insertLestaStatsSnapshot(stats, 0, previousCounters, state.lesta_account_id);
                                });
                            } else {
                                updateAppState({ lesta_last_sync_time: nowSec }, () => {});
                            }
                            return;
                        }

                        const updates = {
                            lesta_last_battles: stats.battles,
                            lesta_last_frags: stats.frags,
                            lesta_last_wins: stats.wins,
                            lesta_last_losses: stats.losses,
                            lesta_last_win_rate: parseFloat(stats.winRate),
                            lesta_last_frags_per_battle: parseFloat(stats.fragsPerBattle),
                            lesta_last_damage_dealt: stats.damage_dealt,
                            lesta_last_damage_received: stats.damage_received,
                            lesta_last_xp: stats.xp,
                            lesta_last_max_frags: stats.max_frags,
                            lesta_last_frags8p: stats.frags8p,
                            lesta_last_hits: stats.hits,
                            lesta_last_shots: stats.shots,
                            lesta_last_spotted: stats.spotted,
                            lesta_last_capture_points: stats.capture_points,
                            lesta_last_dropped_capture_points: stats.dropped_capture_points,
                            lesta_last_survived_battles: stats.survived_battles,
                            lesta_last_win_and_survived: stats.win_and_survived,
                            lesta_last_max_xp: stats.max_xp,
                            lesta_previous_frags: currentFrags,
                            lesta_last_sync_time: nowSec
                        };
                        
                        updateAppState(updates, (err) => {
                            if (err) {
                                console.error('❌ Ошибка обновления статистики Lesta Games:', err);
                            } else if (process.env.DEBUG_LESTA === '1') {
                                console.log('✅ Статистика Lesta Games обновлена в БД');
                            }

                            if (err) {
                                // skip history/broadcast on error
                            } else if (statsChanged || effectiveFragsDifference !== 0) {
                                insertLestaStatsSnapshot(stats, effectiveFragsDifference, previousCounters, state.lesta_account_id);
                                // Если фраги увеличились, автоматически списываем фраги
                                if (effectiveFragsDifference > 0) {
                                    console.log(`🎯 Обнаружено увеличение фрагов: +${effectiveFragsDifference}`);
                                    console.log(`   Было: ${previousFrags}, Стало: ${currentFrags}`);
                                    
                                    // Списываем фраги из режима 1 (фраг-трекер)
                                    getAppState((currentState) => {
                                        if (currentState) {
                                            const currentNeeded = currentState.frags_needed || 0;
                                            const currentDone = currentState.frags_done || 0;
                                            
                                            const toComplete = Math.min(currentNeeded, effectiveFragsDifference);
                                            
                                            if (toComplete > 0) {
                                                const newNeeded = currentNeeded - toComplete;
                                                const newDone = currentDone + toComplete;
                                                
                                                updateAppState({
                                                    frags_needed: newNeeded,
                                                    frags_done: newDone
                                                }, (err) => {
                                                    if (err) {
                                                        console.error('❌ Ошибка списания фрагов:', err);
                                                    } else {
                                                        console.log(`✅ Автоматически списано ${toComplete} фрагов из режима 1`);
                                                        console.log(`   Нужно сделать: ${newNeeded}, Сделано: ${newDone}`);
                                                        
                                                        // Обновляем последнюю запись в истории с информацией о списанных фрагах
                                                        db.run(`UPDATE lesta_stats_history 
                                                                SET auto_deducted = ? 
                                                                WHERE id = (SELECT MAX(id) FROM lesta_stats_history)`,
                                                            [toComplete],
                                                            function(err) {
                                                                if (err) {
                                                                    console.error('❌ Ошибка обновления истории автосписания:', err);
                                                                }
                                                            }
                                                        );
                                                        
                                                        // Логируем событие автосписания
                                                        analytics.logEvent('lesta_auto_deduct', {
                                                            frags_difference: fragsDifference,
                                                            frags_deducted: toComplete,
                                                            previous_frags: previousFrags,
                                                            current_frags: currentFrags
                                                        });
                                                    }
                                                });
                                            } else {
                                                console.log(`ℹ️ Нет фрагов для списания (нужно сделать: ${currentNeeded})`);
                                            }
                                        }
                                    });
                                }
                            }

                            if (!err && (statsChanged || fragsDifference !== 0)) {
                                Object.assign(state, updates);
                                broadcastStateUpdate(state);
                            }

                            if (RAZBLOG_ENABLED && !err && razblogModuleRef && razblogModuleRef.getService() && state.razblog_tracking_active) {
                                razblogModuleRef.getService().syncFromLestaStats({ stats }, (razErr) => {
                                    if (razErr) console.warn('⚠️ razblog sync after lesta:', razErr.message);
                                });
                            }
                        });
                    }
                });
            }
        } catch (error) {
            console.error('❌ Ошибка автосинхронизации Lesta Games:', error.message);
        } finally {
            // Повторяем каждые 30 секунд (реже — меньше нагрузка на Lesta и SQLite)
            lestaSyncTimer = setTimeout(syncLesta, 20 * 1000);
        }
    };
    
    // Запускаем первую синхронизацию
    syncLesta();
}

// Webhook для DonatePay
app.post('/webhook/donatepay', express.raw({ type: 'application/json' }), (req, res) => {
    try {
        const signature = req.headers['x-donatepay-signature'];
        const payload = req.body;
        
        // Проверка подписи (если настроен секрет)
        if (DP_CONFIG.webhookSecret) {
            const crypto = require('crypto');
            const expectedSignature = crypto
                .createHmac('sha256', DP_CONFIG.webhookSecret)
                .update(payload)
                .digest('hex');
            
            if (signature !== `sha256=${expectedSignature}`) {
                console.log('❌ Неверная подпись DonatePay webhook');
                return res.status(401).json({ error: 'Invalid signature' });
            }
        }
        
        const donation = JSON.parse(payload);
        
        if (donation.type === 'donation' && donation.status === 'success') {
            console.log(`💰 DonatePay webhook: ${donation.what} - ${donation.sum}₽`);
            
            processDonation({
                id: `dp_${donation.id}`,
                username: donation.what || 'Аноним',
                amount: parseFloat(donation.sum),
                message: donation.comment || '',
                currency: 'RUB'
            }, true);
            
            // Дополнительная проверка донатов после webhook
            setTimeout(() => {
                if (!isPollingInProgress) {
                    console.log('🔄 Проверка донатов после webhook DonatePay...');
                    checkForNewDonations();
                }
            }, 1000);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Ошибка обработки DonatePay webhook:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
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
    if (!memoryAppStateLoaded || !memoryAppState) return;
    const state = memoryAppState;
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

// Проверка существования доната в базе данных
function checkDonationExists(donationId) {
    return new Promise((resolve) => {
        db.get('SELECT id FROM donations WHERE id = ?', [donationId], (err, row) => {
            if (err) {
                console.error('❌ Ошибка проверки доната в БД:', err);
                resolve(false);
                return;
            }
            resolve(!!row);
        });
    });
}

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
                if (userInfo && DP_CONFIG.userId && !donatePayCentrifuge) {
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
            if (!donatePayCentrifuge) {
                console.log('⚠️ Centrifugo не подключен, но userId есть. Пытаемся подключиться...');
                await connectDonatePayCentrifugo();
            } else {
                // Проверяем состояние подключения (если есть метод state)
                try {
                    const state = donatePayCentrifuge.state;
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
        const centrifugoStatus = donatePayCentrifuge ? 
            (donatePayCentrifuge.state === 'connected' ? '✅ Подключен' : `⚠️ ${donatePayCentrifuge.state || 'Не подключен'}`) : 
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
                const donationId = donation.id.toString();
                
                // Проверяем время создания доната - пропускаем старые (старше 2 дней)
                let donationTime = null;
                if (donation.created_at) {
                    if (typeof donation.created_at === 'string') {
                        donationTime = new Date(donation.created_at).getTime();
                    } else if (typeof donation.created_at === 'number') {
                        donationTime = donation.created_at * 1000; // Если это timestamp в секундах
                    }
                } else if (donation.created_at_ts) {
                    donationTime = donation.created_at_ts * 1000;
                }
                
                // Если есть время создания и донат старше 2 дней - пропускаем сразу
                if (donationTime && (now - donationTime) > maxAgeMs) {
                    skippedByTimeCount++;
                    // Пропускаем без логирования, чтобы не засорять логи
                    continue;
                }
                
                if (processedDonationIds.has(donationId)) {
                    skippedProcessedCount++;
                    continue;
                }
                
                // Для донатов с числовыми ID (DonationAlerts) - пропускаем старые
                // Для донатов с префиксом (DonatePay: dp_xxx) - обрабатываем все новые
                const isNumericId = /^\d+$/.test(donationId);
                if (isNumericId && lastSeenDonationId && parseInt(donationId) <= parseInt(lastSeenDonationId)) {
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
function processDonation(donationData, isRealtime = false) {
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
        
        // Рулетка: добавляем деньги к полоске сбора (если рулетка активна)
        if (amount > 0) {
            console.log(`🎰 Проверка рулетки: донат ${amount}₽`);
            db.get('SELECT * FROM roulette_state WHERE id = 1', (err, rouletteState) => {
                if (err) {
                    console.error('❌ Ошибка получения состояния рулетки:', err);
                    return;
                }
                if (!rouletteState) {
                    console.log('⚠️ Состояние рулетки не найдено, создаем...');
                    // Создаем запись если её нет
                    db.run('INSERT INTO roulette_state (id, is_active, target_amount, current_amount, accumulated_roulettes) VALUES (1, 0, 1000, 0, 0)', (insertErr) => {
                        if (insertErr) {
                            console.error('❌ Ошибка создания состояния рулетки:', insertErr);
                        } else {
                            console.log('✅ Состояние рулетки создано');
                        }
                    });
                    return;
                }
                console.log(`🎰 Состояние рулетки: активна=${rouletteState.is_active} (тип: ${typeof rouletteState.is_active}), текущая=${rouletteState.current_amount || 0}₽, цель=${rouletteState.target_amount || 1000}₽, накоплено=${rouletteState.accumulated_roulettes || 0}`);
                // Проверяем активность: может быть 1, true, или строка "1"
                const isActive = rouletteState.is_active === 1 || rouletteState.is_active === true || rouletteState.is_active === '1' || parseInt(rouletteState.is_active) === 1;
                console.log(`🎰 Рулетка активна: ${isActive} (проверка: is_active=${rouletteState.is_active}, parseInt=${parseInt(rouletteState.is_active || 0)})`);
                if (isActive) {
                    console.log(`✅ Рулетка активна! Добавляем ${amount}₽ к текущей сумме ${rouletteState.current_amount || 0}₽`);
                    const currentAmount = parseFloat(rouletteState.current_amount || 0);
                    const targetAmount = parseFloat(rouletteState.target_amount || 1000);
                    const accumulatedRoulettes = parseInt(rouletteState.accumulated_roulettes || 0);
                    
                    // Добавляем сумму к текущей
                    let newCurrentAmount = currentAmount + amount;
                    let newAccumulatedRoulettes = accumulatedRoulettes;
                    
                    // Если полоска заполнена или переполнена, накапливаем рулетки
                    while (newCurrentAmount >= targetAmount && targetAmount > 0) {
                        newAccumulatedRoulettes++;
                        newCurrentAmount -= targetAmount;
                        console.log(`🎰 Накоплена рулетка! Всего: ${newAccumulatedRoulettes}, остаток: ${newCurrentAmount.toFixed(2)}₽`);
                    }
                    
                    const wasComplete = currentAmount >= targetAmount;
                    const isNowComplete = newCurrentAmount >= targetAmount || newAccumulatedRoulettes > accumulatedRoulettes;
                    
                    db.run('UPDATE roulette_state SET current_amount = ?, accumulated_roulettes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', 
                        [newCurrentAmount, newAccumulatedRoulettes], (err) => {
                            if (!err) {
                                // Получаем обновленное состояние
                                db.get('SELECT * FROM roulette_state WHERE id = 1', (err, updatedRoulette) => {
                                    if (!err && updatedRoulette) {
                                        console.log(`🎰 Рулетка обновлена: текущая сумма=${updatedRoulette.current_amount.toFixed(2)}₽, накоплено рулеток=${updatedRoulette.accumulated_roulettes}`);
                                        
                                        // Отправляем обновление всем клиентам
                                        broadcastToClients({
                                            type: 'ROULETTE_UPDATE',
                                            state: updatedRoulette
                                        });
                                        
                                        // Если полоска только что заполнилась, отправляем уведомление
                                        if (!wasComplete && isNowComplete) {
                                            console.log('🎰 Рулетка заполнена! Отправка уведомления о необходимости крутить барабан');
                                            broadcastToClients({
                                                type: 'ROULETTE_COMPLETE',
                                                state: updatedRoulette,
                                                message: `Полоска рулетки заполнена! Пора крутить барабан!`
                                            });
                                        }
                                    }
                                });
                            } else {
                                console.error('❌ Ошибка обновления рулетки:', err);
                            }
                        });
                } else {
                    if (!err && rouletteState) {
                        const isActive = rouletteState.is_active === 1 || rouletteState.is_active === true || rouletteState.is_active === '1' || parseInt(rouletteState.is_active) === 1;
                        if (!isActive) {
                            console.log('⚠️ Рулетка неактивна (is_active=' + rouletteState.is_active + '), пропускаем добавление доната');
                        }
                    } else if (err) {
                        console.error('❌ Ошибка получения состояния рулетки:', err);
                    }
                }
            });
        }
        
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
            
            // Логируем событие доната в аналитику
            analytics.logEvent('donation_received', {
                donation_id: donation.id,
                username: donation.username,
                amount: donation.amount,
                currency: donation.currency,
                message: donation.message,
                is_realtime: donation.isRealtime,
                frags_earned: fragUnitsEarned,
                time_earned: timeEarned,
                custom_units_earned: customUnitsEarned
            });
            
            // Обновляем статистику донатов
            try { analytics.updateDonationStats(donation); } catch (e) { console.warn('⚠️ Ошибка обновления статистики донатов:', e); }
            
            // Обновляем цель сбора донатов
            try { updateDonationGoal(donation); } catch (e) { console.warn('⚠️ Ошибка обновления цели донатов:', e); }
            
            // Обновляем полоску сбора донатов
            try { updateDonationBar(donation); } catch (e) { console.warn('⚠️ Ошибка обновления полоски сбора:', e); }
            
            // Виджет «параметр от донатов»: за каждые per_amount ₽ добавляем add_value к current_value
            try { updateDonationDrivenWidgets(donation.amount); } catch (e) { console.warn('⚠️ Ошибка обновления виджета по донатам:', e); }

            // Tanks Blitz Challenge: каждый донат усложняет челлендж
            try { updateBlitzChallenge(donation.amount, donation); } catch (e) { console.warn('⚠️ Ошибка обновления Blitz Challenge:', e); }
            
            // Обновляем достижения донатера (только для режима таймера)
            // ВАЖНО: Вызываем только один раз, чтобы избежать дублирования
            if (timeEarned > 0 && username) {
                try { 
                    updateDonorAchievement(username, timeEarned, donation.id); 
                } catch (e) { 
                    console.warn('⚠️ Ошибка обновления достижений донатера:', e); 
                }
            }
            
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
app.post('/api/sync-lesta-state', async (req, res) => {
    try {
        console.log('🔄 Синхронизация состояния Lesta Games с локальной статистикой...');
        
        // Получаем текущую локальную статистику
        db.all('SELECT frags FROM frag_stats', (err, rows) => {
            if (err) {
                console.error('❌ Ошибка получения локальной статистики:', err);
                return res.status(500).json({ success: false, message: 'Ошибка получения статистики' });
            }
            
            const totalBattles = rows.length;
            const totalFrags = rows.reduce((sum, row) => sum + row.frags, 0);
            
            console.log(`📊 Локальная статистика: ${totalBattles} боев, ${totalFrags} фрагов`);
            
            // Обновляем состояние Lesta Games
            db.run(
                `UPDATE app_state SET 
                    lesta_last_battles = ?, 
                    lesta_last_frags = ?,
                    lesta_previous_frags = ?
                WHERE id = 1`,
                [totalBattles, totalFrags, totalFrags],
                function(err) {
                    if (err) {
                        console.error('❌ Ошибка обновления состояния Lesta Games:', err);
                        return res.status(500).json({ success: false, message: 'Ошибка обновления состояния' });
                    }
                    
                    console.log('✅ Состояние Lesta Games синхронизировано с локальной статистикой');
                    
                    res.json({
                        success: true,
                        message: 'Состояние Lesta Games синхронизировано с локальной статистикой',
                        stats: {
                            totalBattles,
                            totalFrags
                        },
                        note: 'Теперь система будет отслеживать изменения от этих значений'
                    });
                }
            );
        });
    } catch (error) {
        console.error('❌ Ошибка синхронизации:', error);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});


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

                    console.log('🎲 Запуск рандомного замедления, клиентов подключено:', clients.length);
                    console.log('🎲 Финальные настройки:', JSON.stringify(slowdownSettings, null, 2));

                    // 1) Отправляем окно прокрутки всем виджетам сразу
                    let spinSent = 0;
                    clients.forEach((client, index) => {
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

// Centrifugo для DonatePay real-time уведомлений
let donatePayCentrifuge = null;

// Функция подключения к Centrifugo DonatePay
async function connectDonatePayCentrifugo() {
    if (!DP_CONFIG.apiKey) {
        console.log('⚠️ DonatePay не настроен для Centrifugo (нет API ключа)');
        return;
    }
    
    // Если userId не получен, пытаемся получить информацию о пользователе
    if (!DP_CONFIG.userId) {
        console.log('⚠️ UserId не получен, пытаемся получить информацию о пользователе...');
        const userInfo = await getDonatePayUser();
        if (!userInfo || !DP_CONFIG.userId) {
            console.log('⚠️ Не удалось получить информацию о пользователе, Centrifugo не подключен');
            return;
        }
    }

    try {
        console.log('🔗 Подключение к Centrifugo DonatePay...');
        console.log('📋 Параметры:', {
            userId: DP_CONFIG.userId,
            apiKey: DP_CONFIG.apiKey ? `${DP_CONFIG.apiKey.substring(0, 10)}...` : 'ОТСУТСТВУЕТ',
            centrifugoUrl: DP_CONFIG.centrifugoUrl,
            socketTokenUrl: DP_CONFIG.socketTokenUrl
        });
        
        // Получаем токен для подключения
        const tokenResponse = await axios.post(DP_CONFIG.socketTokenUrl, {
            access_token: DP_CONFIG.apiKey
        }, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        console.log('📥 Ответ от socket/token:', {
            status: tokenResponse.status,
            hasToken: !!tokenResponse.data?.token
        });

        if (!tokenResponse.data || !tokenResponse.data.token) {
            console.error('❌ Не удалось получить токен для Centrifugo');
            console.error('📋 Ответ:', JSON.stringify(tokenResponse.data, null, 2));
            return;
        }

        const connectionToken = tokenResponse.data.token;
        console.log('✅ Токен для Centrifugo получен');

        // Создаем подключение к Centrifugo с новым API (v4+)
        // Используем subscribeEndpoint и subscribeParams согласно документации
        donatePayCentrifuge = new Centrifuge(DP_CONFIG.centrifugoUrl, {
            token: connectionToken,
            subscribeEndpoint: DP_CONFIG.socketTokenUrl,
            subscribeParams: {
                access_token: DP_CONFIG.apiKey
            },
            disableWithCredentials: true
        });

        // Подписываемся на канал пользователя
        const channel = `$public:${DP_CONFIG.userId}`;
        console.log('📡 Подписка на канал:', channel);
        console.log('📋 Канал для получения донатов DonatePay в real-time');
        
        const subscription = donatePayCentrifuge.newSubscription(channel);

        subscription.on('publication', (ctx) => {
            console.log('💰💰💰 DonatePay real-time уведомление получено через Centrifugo! 💰💰💰');
            console.log('📨 Полные данные:', JSON.stringify(ctx.data, null, 2));
            
            // Обрабатываем донат - проверяем разные форматы данных
            const data = ctx.data || {};
            let donationData = null;
            
            // Формат 1: прямое поле type === 'donation'
            if (data.type === 'donation') {
                donationData = {
                    id: `dp_${data.id || Date.now()}`,
                    username: data.what || data.name || 'Аноним',
                    amount: parseFloat(data.sum || data.amount || 0),
                    message: data.comment || data.message || '',
                    currency: 'RUB',
                    created_at: data.created_at || new Date().toISOString(),
                    platform: 'donatepay'
                };
            }
            // Формат 2: в vars может быть информация о донате
            else if (data.vars) {
                const vars = data.vars;
                if (vars.type === 'donation' || vars.sum) {
                    donationData = {
                        id: `dp_${data.id || vars.id || Date.now()}`,
                        username: vars.what || vars.name || 'Аноним',
                        amount: parseFloat(vars.sum || vars.amount || 0),
                        message: vars.comment || vars.message || '',
                        currency: 'RUB',
                        created_at: vars.created_at || data.created_at || new Date().toISOString(),
                        platform: 'donatepay'
                    };
                }
            }
            // Формат 3: если есть поля what и sum, это донат
            else if (data.what && data.sum) {
                donationData = {
                    id: `dp_${data.id || Date.now()}`,
                    username: data.what || 'Аноним',
                    amount: parseFloat(data.sum || 0),
                    message: data.comment || data.message || '',
                    currency: 'RUB',
                    created_at: data.created_at || new Date().toISOString(),
                    platform: 'donatepay'
                };
            }
            
            // Обрабатываем донат если он найден
            if (donationData && donationData.amount > 0) {
                console.log('✅ Обработка доната из Centrifugo (real-time):', donationData);
                
                // Обновляем lastTransactionId если есть реальный ID
                if (data.id) {
                    const transactionId = parseInt(data.id) || 0;
                    if (transactionId > (parseInt(DP_CONFIG.lastTransactionId) || 0)) {
                        DP_CONFIG.lastTransactionId = transactionId;
                        // Сохраняем в БД
                        getAppState((state) => {
                            if (state) {
                                updateAppState({
                                    dp_last_transaction_id: transactionId
                                }, (err) => {
                                    if (err) {
                                        console.error('❌ Ошибка сохранения ID последней транзакции:', err);
                                    } else {
                                        console.log('✅ ID последней транзакции сохранен:', transactionId);
                                    }
                                });
                            }
                        });
                    }
                }
                
                processDonation(donationData, true); // true = realtime
            } else {
                console.log('⚠️ Получено уведомление, но не удалось извлечь данные доната');
            }
        });

        subscription.on('subscribed', (ctx) => {
            console.log('✅ Подписка на DonatePay канал активна:', channel);
            console.log('🎉 Готов к получению донатов DonatePay в real-time через Centrifugo!');
            console.log('📡 Все новые донаты будут приходить мгновенно через WebSocket');
        });

        subscription.on('subscribing', (ctx) => {
            console.log('🔄 Подписка на DonatePay канал в процессе...');
        });

        subscription.on('unsubscribed', (ctx) => {
            console.log('⚠️ Отписка от DonatePay канала:', ctx);
        });

        subscription.on('error', (ctx) => {
            console.error('❌ Ошибка подписки DonatePay:', ctx);
        });

        // Обработчики событий подключения
        donatePayCentrifuge.on('connecting', (ctx) => {
            console.log('🔄 Подключение к Centrifugo DonatePay...');
        });

        donatePayCentrifuge.on('connected', (ctx) => {
            console.log('✅ Подключение к Centrifugo DonatePay установлено');
        });

        donatePayCentrifuge.on('disconnected', (ctx) => {
            console.log('⚠️ Отключение от Centrifugo DonatePay:', ctx);
        });

        donatePayCentrifuge.on('error', (ctx) => {
            console.error('❌ Ошибка Centrifugo DonatePay:', ctx);
        });

        // Подключаемся и подписываемся
        subscription.subscribe();
        donatePayCentrifuge.connect();
        
        console.log('✅ Инициализация Centrifugo DonatePay завершена');

    } catch (error) {
        console.error('❌ Ошибка подключения к Centrifugo DonatePay:', error.message);
        console.error('📋 Детали ошибки:', {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status
        });
    }
}

wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).substr(2, 9);
    const url = new URL(req.url, `http://localhost:${port}`);
    const typeParam = (url.searchParams.get('type') || '').toLowerCase();
    const clientType = typeParam === 'alert' ? 'ALERT' : typeParam === 'widget' ? 'WIDGET' : 'DASHBOARD';
    console.log(`👤 Новый клиент подключен: ${clientId} (${clientType})`);
    
    // Логируем подключение клиента
    analytics.logEvent('client_connected', { clientId, clientType }, null, null, req);
    
    clients.push(ws);
    
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
        
        clients = clients.filter(client => client !== ws);
    });
    
    ws.on('error', (error) => {
        console.error(`❌ Ошибка WebSocket клиента ${clientId} (${clientType}):`, error);
        clients = clients.filter(client => client !== ws);
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
function broadcastToClients(message) {
    const debug = process.env.DEBUG_BROADCAST === '1';
    if (debug) {
        console.log('📢 BROADCAST:', message.type, '| clients:', clients.length);
    }

    let sentCount = 0;
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(message));
                sentCount++;
            } catch (error) {
                console.error(`❌ Ошибка отправки WS ${client.clientId}:`, error.message);
            }
        }
    });

    if (debug) {
        console.log(`   Отправлено ${sentCount}/${clients.length}`);
    }
}

// Маршруты
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/analytics', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'analytics.html'));
});

app.get('/lesta-test', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'lesta-test.html'));
});

app.get('/lesta-api-test', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'lesta-api-test.html'));
});

app.get('/donatepay-test', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'donatepay-test.html'));
});

app.get('/lesta-stats', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'lesta-stats.html'));
});

app.get('/dashboard/:mode', (req, res) => {
    const mode = req.params.mode;
    let file = 'mode1-frag-tracker.html';
    
    if (mode === 'mode2') file = 'mode2-timer.html';
    
    res.sendFile(path.join(__dirname, 'public', file));
});

// Прямые маршруты для режимов
app.get('/mode1-frag-tracker', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'mode1-frag-tracker.html'));
});

app.get('/mode2-timer', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'mode2-timer.html'));
});


app.get('/widget/:mode', (req, res) => {
    const mode = req.params.mode;
    let file = 'widget-mode1.html';
    let filePath = 'public';
    
    if (mode === 'mode2') file = 'widget-mode2.html';
    else if (mode === 'mode3') file = 'widget-mode3.html';
    else if (mode === 'marathon') file = 'widget-marathon.html';
    else if (mode === 'donation-goal') {
        file = 'donation-goal.html';
        filePath = 'public/widget';
    }
    else if (mode === 'donation-bar') file = 'widget-donation-bar.html';
    else if (mode === 'donation-driven') file = 'widget-donation-driven.html';
    else if (mode === 'tanks-blitz-challenge') file = 'widget-tanks-blitz-challenge.html';
    else if (mode === 'razblogirovka-gold') {
        if (!RAZBLOG_ENABLED) {
            return res.status(410).send('РазБЛОГировка 2026 отключена');
        }
        file = 'widget-razblogirovka-gold.html';
        filePath = path.join(RAZBLOG_ARCHIVE_DIR, 'public');
    }
    
    // Отключаем кэширование для виджетов
    res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    
    res.sendFile(path.join(__dirname, filePath, file));
});

app.get('/alert/:mode', (req, res) => {
    const mode = req.params.mode;
    let file = 'alert-mode1.html';
    
    if (mode === 'mode2') file = 'alert-mode2.html';
    else if (mode === 'mode3') file = 'alert-mode3.html';
    
    res.sendFile(path.join(__dirname, 'public', file));
});

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
        if (donatePayCentrifuge) {
            try {
                const state = donatePayCentrifuge.state;
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
app.post('/api/lesta-set-account', async (req, res) => {
    const accountId = req.body && req.body.accountId != null ? String(req.body.accountId).trim() : '';
    const nickname = req.body && req.body.nickname != null ? String(req.body.nickname).trim() : '';

    if (!accountId) {
        return res.status(400).json({ success: false, error: 'Укажите accountId' });
    }
    if (!LESTA_CONFIG.applicationId) {
        return res.status(400).json({ success: false, error: 'Application ID Lesta не настроен (админка)' });
    }

    LESTA_CONFIG.accountId = accountId;
    if (nickname) LESTA_CONFIG.nickname = nickname;

    try {
        const stats = await getLestaPlayerStats();
        const resolvedNickname = (stats && stats.nickname) || nickname || LESTA_CONFIG.nickname || 'Игрок';

        updateAppState({
            lesta_account_id: accountId,
            lesta_nickname: resolvedNickname,
            lesta_last_sync_time: Math.floor(Date.now() / 1000)
        }, (err) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Ошибка сохранения аккаунта' });
            }
            LESTA_CONFIG.nickname = resolvedNickname;
            startLestaAutoSync();
            if (typeof broadcastStateUpdate === 'function') broadcastStateUpdate();
            res.json({
                success: true,
                accountId,
                nickname: resolvedNickname,
                stats,
                message: 'Аккаунт для отслеживания установлен'
            });
        });
    } catch (error) {
        console.error('❌ lesta-set-account:', error);
        res.status(500).json({ success: false, error: error.message || 'Ошибка получения статистики' });
    }
});

// Полный сброс привязки Lesta (токен, аккаунт, кэш статистики; application_id сохраняется)
app.post('/api/reset-lesta', (req, res) => {
    stopLestaAutoSync();
    LESTA_CONFIG.accessToken = null;
    LESTA_CONFIG.accountId = null;
    LESTA_CONFIG.nickname = null;
    LESTA_CONFIG.tokenExpiresAt = null;

    const resetFields = {
        lesta_access_token: null,
        lesta_token_expires_at: 0,
        lesta_account_id: null,
        lesta_nickname: null,
        lesta_last_battles: null,
        lesta_last_frags: null,
        lesta_last_wins: null,
        lesta_last_losses: null,
        lesta_last_win_rate: null,
        lesta_last_frags_per_battle: null,
        lesta_last_damage_dealt: null,
        lesta_last_xp: null,
        lesta_last_damage_received: null,
        lesta_last_max_frags: null,
        lesta_last_frags8p: null,
        lesta_last_hits: null,
        lesta_last_shots: null,
        lesta_last_spotted: null,
        lesta_last_capture_points: null,
        lesta_last_dropped_capture_points: null,
        lesta_last_survived_battles: null,
        lesta_last_win_and_survived: null,
        lesta_last_max_xp: null,
        lesta_previous_frags: null,
        lesta_last_sync_time: 0
    };

    updateAppState(resetFields, (err) => {
        if (err) {
            console.error('❌ reset-lesta:', err);
            return res.status(500).json({ success: false, error: 'Ошибка сброса' });
        }
        if (typeof broadcastStateUpdate === 'function') broadcastStateUpdate();
        res.json({ success: true, message: 'Данные Lesta сброшены' });
    });
});

// API для настройки Lesta Games
app.post('/api/lesta-config', (req, res) => {
    const { applicationId } = req.body;
    
    console.log('🔧 Настройка Lesta Games:', { applicationId: applicationId ? 'ЕСТЬ' : 'НЕТ' });
    
    // Логируем событие настройки
    analytics.logEvent('lesta_config', { hasApplicationId: !!applicationId }, null, null, req);
    
    // Сохраняем в переменные окружения
    if (applicationId) {
        LESTA_CONFIG.applicationId = applicationId;
    }
    
    updateAppState({
        lesta_application_id: applicationId || ''
    }, (err) => {
        if (err) {
            console.error('❌ Ошибка сохранения настроек Lesta Games:', err);
            res.status(500).json({ success: false, error: 'Ошибка сохранения' });
        } else {
            console.log('✅ Настройки Lesta Games сохранены в БД');
            res.json({ success: true, message: 'Lesta Games настроен и сохранен' });
        }
    });
});

// API для получения статистики Lesta Games
app.get('/api/lesta-stats', async (req, res) => {
    try {
        // Сначала пытаемся получить свежую статистику
        const freshStats = await getLestaPlayerStats();
        
        if (freshStats) {
            res.json({ success: true, stats: freshStats, source: 'api' });
        } else {
            // Если не удалось получить свежую статистику, берем из БД
            getAppState((state) => {
                if (state && state.lesta_last_battles !== null) {
                    const savedStats = {
                        nickname: state.lesta_nickname || 'Неизвестный игрок',
                        battles: state.lesta_last_battles || 0,
                        frags: state.lesta_last_frags || 0,
                        wins: Math.round((state.lesta_last_win_rate || 0) * (state.lesta_last_battles || 0) / 100),
                        losses: (state.lesta_last_battles || 0) - Math.round((state.lesta_last_win_rate || 0) * (state.lesta_last_battles || 0) / 100),
                        damage_dealt: state.lesta_last_damage_dealt || 0,
                        xp: state.lesta_last_xp || 0,
                        winRate: state.lesta_last_win_rate || 0,
                        fragsPerBattle: state.lesta_last_frags_per_battle || 0,
                        avgDamage: state.lesta_last_battles > 0 ? Math.round((state.lesta_last_damage_dealt || 0) / state.lesta_last_battles) : 0,
                        avgXp: state.lesta_last_battles > 0 ? Math.round((state.lesta_last_xp || 0) / state.lesta_last_battles) : 0
                    };
                    res.json({ success: true, stats: savedStats, source: 'database' });
                } else {
                    res.status(404).json({ success: false, error: 'Статистика не найдена' });
                }
            });
        }
    } catch (error) {
        console.error('❌ Ошибка получения статистики Lesta Games:', error);
        res.status(500).json({ success: false, error: 'Ошибка получения статистики' });
    }
});

// API для поиска игрока Lesta Games по никнейму
app.get('/api/lesta-search', async (req, res) => {
    const { nickname } = req.query;
    
    if (!nickname) {
        return res.status(400).json({ success: false, error: 'Никнейм не указан' });
    }
    
    if (!LESTA_CONFIG.applicationId) {
        return res.status(400).json({ success: false, error: 'Application ID не настроен' });
    }
    
    try {
        console.log('🔍 Поиск игрока Lesta Games:', nickname);
        
        const response = await axios.get(`${LESTA_CONFIG.apiUrl}/account/list/`, {
            params: {
                application_id: LESTA_CONFIG.applicationId,
                search: nickname,
                fields: 'account_id,nickname',
                type: 'startswith',
                limit: 100
            },
            timeout: 10000
        });
        
        console.log('📊 Ответ поиска Lesta Games:', response.data);
        
        if (response.data.status === 'ok' && response.data.data) {
            const players = response.data.data;
            res.json({ success: true, players });
        } else {
            res.status(404).json({ success: false, error: 'Игрок не найден' });
        }
    } catch (error) {
        console.error('❌ Ошибка поиска игрока Lesta Games:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Ошибка поиска игрока' });
    }
});

// API для ручной синхронизации Lesta Games
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

app.get('/api/lesta-achievements', async (req, res) => {
    const { account_id, fields, language } = req.query;
    
    if (!account_id) {
        return res.status(400).json({ 
            success: false, 
            error: 'ACCOUNT_ID_NOT_SPECIFIED',
            message: 'Не заполнено обязательное поле account_id'
        });
    }
    
    if (!LESTA_CONFIG.applicationId) {
        return res.status(400).json({ 
            success: false, 
            error: 'INVALID_APPLICATION_ID',
            message: 'Application ID не настроен'
        });
    }
    
    try {
        console.log('🏆 Запрос достижений Lesta Games для игрока:', account_id);
        
        const params = {
            application_id: LESTA_CONFIG.applicationId,
            account_id: account_id,
            fields: fields || 'achievements,max_series',
            language: language || 'ru'
        };
        
        const response = await axios.get(`${LESTA_CONFIG.apiUrl}/account/achievements/`, {
            params,
            timeout: 10000
        });
        
        console.log('🏆 Ответ достижений Lesta Games:', response.data);
        
        if (response.data.status === 'ok') {
            let payload = response.data.data;
            const accKey = String(account_id);
            if (payload && payload[accKey]) {
                payload = payload[accKey];
            }
            res.json({ success: true, data: payload });
        } else {
            res.status(404).json({ 
                success: false, 
                error: response.data.error?.code || 'UNKNOWN_ERROR',
                message: response.data.error?.message || 'Ошибка получения достижений'
            });
        }
    } catch (error) {
        console.error('❌ Ошибка получения достижений Lesta Games:', error.response?.data || error.message);
        
        const errorCode = error.response?.data?.error?.code || 'SOURCE_NOT_AVAILABLE';
        const errorMessage = error.response?.data?.error?.message || 'Источник данных не доступен';
        
        res.status(500).json({ 
            success: false, 
            error: errorCode,
            message: errorMessage
        });
    }
});

// API для получения статистики по технике Lesta Games
app.get('/api/lesta-tankstats', async (req, res) => {
    const { account_id, tank_id, fields, language } = req.query;
    
    if (!account_id) {
        return res.status(400).json({ 
            success: false, 
            error: 'ACCOUNT_ID_NOT_SPECIFIED',
            message: 'Не заполнено обязательное поле account_id'
        });
    }
    
    if (!LESTA_CONFIG.applicationId) {
        return res.status(400).json({ 
            success: false, 
            error: 'INVALID_APPLICATION_ID',
            message: 'Application ID не настроен'
        });
    }
    
    try {
        console.log('🚗 Запрос статистики по технике Lesta Games (tanks/stats):', { account_id, tank_id });
        
        const params = {
            application_id: LESTA_CONFIG.applicationId,
            account_id: account_id,
            fields: fields || 'all,mark_of_mastery,battle_life_time,last_battle_time',
            language: language || 'ru'
        };
        
        // Добавляем tank_id, если указан (для фильтрации по конкретному танку)
        if (tank_id) {
            params.tank_id = tank_id;
        }
        
        // Добавляем access_token, если он есть
        if (LESTA_CONFIG.accessToken) {
            params.access_token = LESTA_CONFIG.accessToken;
        }
        
        // Используем endpoint /tanks/stats/ согласно документации:
        // "Статистика по технике игрока" — account_id обязателен, tank_id выступает как опциональный фильтр
        const response = await axios.get(`${LESTA_CONFIG.apiUrl}/tanks/stats/`, {
            params,
            timeout: 10000,
            validateStatus: function (status) {
                return status < 500; // Не выбрасывать ошибку для статусов < 500
            }
        });
        
        console.log('🚗 Ответ статистики по технике Lesta Games:', response.status, response.data?.status);
        
        // Проверяем, что ответ - это JSON, а не HTML
        if (typeof response.data === 'string' && response.data.startsWith('<!')) {
            console.error('❌ API вернул HTML вместо JSON.');
            return res.status(500).json({ 
                success: false, 
                error: 'INVALID_RESPONSE',
                message: 'Сервер вернул неверный формат данных.'
            });
        }
        
        if (response.data.status === 'ok' && response.data.data) {
            // Если указан tank_id, возвращаем данные по конкретному танку
            let result = response.data.data[account_id];
            if (tank_id && Array.isArray(result)) {
                result = result.find(tank => tank.tank_id === parseInt(tank_id)) || result;
            }
            res.json({ success: true, data: result });
        } else {
            res.status(404).json({ 
                success: false, 
                error: response.data.error?.code || 'UNKNOWN_ERROR',
                message: response.data.error?.message || 'Ошибка получения статистики по технике'
            });
        }
    } catch (error) {
        console.error('❌ Ошибка получения статистики по технике Lesta Games:', error.message);
        
        // Проверяем, если это ошибка парсинга JSON (HTML ответ)
        if (error.response && typeof error.response.data === 'string' && error.response.data.startsWith('<!')) {
            return res.status(500).json({ 
                success: false, 
                error: 'INVALID_RESPONSE',
                message: 'Сервер вернул HTML вместо JSON. Проверьте endpoint и параметры запроса.'
            });
        }
        
        const errorCode = error.response?.data?.error?.code || error.response?.status === 404 ? 'NOT_FOUND' : 'SOURCE_NOT_AVAILABLE';
        const errorMessage = error.response?.data?.error?.message || 'Источник данных не доступен';
        
        res.status(error.response?.status || 500).json({ 
            success: false, 
            error: errorCode,
            message: errorMessage
        });
    }
});

// API для получения списка техники Lesta Games
app.get('/api/lesta-vehicles', async (req, res) => {
    const { fields, language, nation, tank_id } = req.query;
    
    if (!LESTA_CONFIG.applicationId) {
        return res.status(400).json({ 
            success: false, 
            error: 'INVALID_APPLICATION_ID',
            message: 'Application ID не настроен'
        });
    }
    
    try {
        console.log('🚗 Запрос списка техники Lesta Games');
        
        const params = {
            application_id: LESTA_CONFIG.applicationId,
            fields: fields || 'tank_id,name,tier,type,nation,is_premium',
            language: language || 'ru'
        };
        
        if (nation) params.nation = nation;
        if (tank_id) params.tank_id = tank_id;
        
        const response = await axios.get(`${LESTA_CONFIG.apiUrl}/encyclopedia/vehicles/`, {
            params,
            timeout: 10000
        });
        
        console.log('🚗 Ответ списка техники Lesta Games:', response.data);
        
        if (response.data.status === 'ok') {
            res.json({ success: true, data: response.data.data });
        } else {
            res.status(404).json({ 
                success: false, 
                error: response.data.error?.code || 'UNKNOWN_ERROR',
                message: response.data.error?.message || 'Ошибка получения списка техники'
            });
        }
    } catch (error) {
        console.error('❌ Ошибка получения списка техники Lesta Games:', error.response?.data || error.message);
        
        const errorCode = error.response?.data?.error?.code || 'SOURCE_NOT_AVAILABLE';
        const errorMessage = error.response?.data?.error?.message || 'Источник данных не доступен';
        
        res.status(500).json({ 
            success: false, 
            error: errorCode,
            message: errorMessage
        });
    }
});

// API для получения статистики по всей технике игрока
app.get('/api/lesta-player-tanks', async (req, res) => {
    const { account_id, language } = req.query;
    const searchQueryRaw = req.query.search || req.query.query || '';
    const searchQuery = typeof searchQueryRaw === 'string' ? searchQueryRaw.toLowerCase().trim() : '';

    const targetAccountId = String(account_id || LESTA_CONFIG.accountId || '');
    if (!targetAccountId) {
        return res.status(400).json({
            success: false,
            error: 'ACCOUNT_ID_NOT_SPECIFIED',
            message: 'Account ID не указан'
        });
    }

    try {
        const result = await fetchAccountTanksForAccount(targetAccountId, language || 'ru');
        if (result.error === 'NO_ACCOUNT') {
            return res.status(400).json({ success: false, error: 'INVALID_APPLICATION_ID', message: 'Application ID не настроен' });
        }
        if (result.error === 'STATS_HIDDEN') {
            return res.json({
                success: true,
                data: [],
                count: 0,
                code: 'STATS_HIDDEN',
                message: 'Lesta не отдаёт статистику по танкам для этого аккаунта. В настройках игры включите доступ к данным аккаунта или войдите через OAuth (/auth/lesta).'
            });
        }
        if (result.error) {
            return res.status(400).json({ success: false, error: result.error, message: result.message || 'Ошибка Lesta API' });
        }

        let tanks = result.tanks || [];
        if (searchQuery) {
            tanks = tanks.filter((tank) => (tank.name || '').toLowerCase().includes(searchQuery));
        }
        tanks.sort((a, b) => (b.statistics?.all?.battles || 0) - (a.statistics?.all?.battles || 0));

        scheduleLestaTankSnapshot(targetAccountId);

        res.json({ success: true, data: tanks, count: tanks.length });
    } catch (error) {
        console.error('❌ lesta-player-tanks:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            success: false,
            error: error.response?.data?.error?.code || 'SOURCE_NOT_AVAILABLE',
            message: error.response?.data?.error?.message || error.message || 'Ошибка загрузки техники'
        });
    }
});

app.get('/api/lesta-tank-period', async (req, res) => {
    const period = req.query.period || '7d';

    try {
        const state = await ensureLestaConfigFromState();
        const accountId = state?.lesta_account_id;
        if (!accountId) {
            return res.json({ success: true, hasData: false, changes: [], message: 'Привяжите аккаунт Lesta' });
        }

        const tankResult = await fetchAccountTanksForAccount(accountId);
        if (tankResult.hidden || tankResult.error === 'STATS_HIDDEN') {
            return res.json({
                success: true,
                hasData: false,
                hidden: true,
                changes: [],
                message: 'Статистика по танкам скрыта в Lesta'
            });
        }
        if (tankResult.error) {
            return res.status(400).json({ success: false, error: tankResult.error, message: tankResult.message });
        }

        const currentMap = tanksToSnapshotMap(tankResult.tanks);
        const reliableSince = Number(state.lesta_reliable_since) || 0;

        fetchTankSnapshotBaseline(period, accountId, reliableSince, (err, baselineRow) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Ошибка чтения снимков техники' });
            }

            if (!baselineRow) {
                insertLestaTankSnapshot(accountId, currentMap, () => {
                    res.json({
                        success: true,
                        hasData: false,
                        hasBaseline: false,
                        changes: [],
                        message: 'Базовый снимок сохранён. После боёв здесь появятся изменения по танкам.'
                    });
                });
                return;
            }

            const baselineMap = parseTankSnapshotMap(baselineRow);
            let changes = computeTankPeriodChanges(currentMap, baselineMap);
            let baselineAt = baselineRow.timestamp;

            const finish = () => {
                res.json({
                    success: true,
                    hasData: changes.length > 0,
                    hasBaseline: true,
                    baselineAt,
                    changes
                });
            };

            if (changes.length > 0) return finish();

            fetchNewestTankSnapshotInPeriod(period, accountId, reliableSince, (snapErr, newestRow) => {
                if (snapErr || !newestRow || newestRow.id === baselineRow.id) return finish();
                const newestMap = parseTankSnapshotMap(newestRow);
                const snapChanges = computeTankPeriodChanges(newestMap, baselineMap);
                if (snapChanges.length > 0) {
                    changes = snapChanges;
                    baselineAt = baselineRow.timestamp;
                }
                finish();
            });
        });
    } catch (error) {
        console.error('❌ lesta-tank-period:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API для продления токена Lesta Games
app.post('/api/lesta-prolongate', async (req, res) => {
    try {
        const prolonged = await prolongateLestaToken();
        if (prolonged) {
            res.json({ success: true, message: 'Токен успешно продлен' });
        } else {
            res.json({ success: false, error: 'Не удалось продлить токен' });
        }
    } catch (error) {
        console.error('❌ Ошибка продления токена:', error);
        res.json({ success: false, error: error.message });
    }
});

// API для тестирования получения статистики
app.get('/api/lesta-test-stats', async (req, res) => {
    try {
        console.log('🧪 Тестовый запрос статистики Lesta Games...');
        console.log('🔍 Текущая конфигурация:', {
            applicationId: LESTA_CONFIG.applicationId,
            accountId: LESTA_CONFIG.accountId,
            accessToken: LESTA_CONFIG.accessToken ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ'
        });
        
        const stats = await getLestaPlayerStats();
        if (stats) {
            res.json({ success: true, stats: stats, message: 'Статистика получена успешно' });
        } else {
            res.json({ success: false, error: 'Не удалось получить статистику', message: 'Проверьте логи сервера' });
        }
    } catch (error) {
        console.error('❌ Ошибка тестового запроса:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/lesta-sync', async (req, res) => {
    try {
        const stats = await getLestaPlayerStats();
        if (stats) {
            // Обновляем время последней синхронизации
            updateAppState({
                lesta_last_sync_time: Math.floor(Date.now() / 1000)
            }, (err) => {
                if (err) {
                    console.error('❌ Ошибка обновления времени синхронизации:', err);
                } else {
                    console.log('✅ Время последней синхронизации обновлено');
                }
            });

            // Логируем событие ручной синхронизации
            analytics.logEvent('lesta_manual_sync', {
                battles: stats.battles,
                frags: stats.frags,
                winRate: stats.winRate,
                fragsPerBattle: stats.fragsPerBattle
            });
            
            // Отправляем обновление состояния через WebSocket
            broadcastStateUpdate();
            
            res.json({ success: true, stats, message: 'Синхронизация выполнена' });
        } else {
            res.status(404).json({ success: false, error: 'Не удалось получить статистику' });
        }
    } catch (error) {
        console.error('❌ Ошибка ручной синхронизации Lesta Games:', error);
        res.status(500).json({ success: false, error: 'Ошибка синхронизации' });
    }
});


// API для статистики за период (как на BlitzStats — дельта счётчиков)
app.get('/api/lesta-period', (req, res) => {
    const period = req.query.period || '1d';
    const includeDaily = req.query.daily !== '0';

    getAppState((state) => {
        const current = getLestaCountersFromState(state);
        if (!current || !state.lesta_account_id) {
            return res.json({
                success: true,
                hasData: false,
                period,
                message: 'Привяжите аккаунт Lesta для отслеживания периодов'
            });
        }

        const reliableSince = Number(state.lesta_reliable_since) || 0;

        fetchLestaHistoryWindow(period, current.battles, reliableSince, (err, windowData) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Ошибка чтения истории' });
            }

            const baselineRow = windowData.anchorRow || (windowData.rows.length ? windowData.rows[0] : null);
            const baseline = baselineRow ? {
                battles: baselineRow.battles,
                frags: baselineRow.frags,
                wins: baselineRow.wins,
                losses: baselineRow.losses,
                damage_dealt: baselineRow.damage_dealt,
                xp: baselineRow.xp,
                at: baselineRow.timestamp
            } : null;

            const periodStats = computeLestaPeriodStatsFromRows(windowData.rows, current.battles);

            const finish = (daily) => {
                res.json({
                    success: true,
                    hasData: periodStats.battlesPlayed > 0,
                    period,
                    baselineAt: baseline ? baseline.at : null,
                    trackingSince: reliableSince > 0
                        ? new Date(reliableSince * 1000).toISOString()
                        : (baselineRow ? baselineRow.timestamp : null),
                    reliableSince: reliableSince > 0 ? reliableSince : null,
                    current,
                    baseline,
                    periodStats,
                    daily: daily || []
                });
            };

            if (!includeDaily) return finish([]);
            buildLestaDailyActivity(period === '1d' ? 7 : 14, current.battles, reliableSince, (dailyErr, daily) => {
                if (dailyErr) return finish([]);
                finish(daily);
            });
        });
    });
});

// API сессии — от ручного «Начать сессию» или за сегодня
app.get('/api/lesta-session', (req, res) => {
    getAppState((state) => {
        const current = getLestaCountersFromState(state);
        if (!current) {
            return res.json({ success: false, error: 'Нет данных Lesta' });
        }

        const hasManualSession = Number(state.lesta_session_started_at) > 0;
        const baseline = hasManualSession ? {
            battles: Number(state.lesta_session_baseline_battles) || 0,
            wins: Number(state.lesta_session_baseline_wins) || 0,
            losses: Number(state.lesta_session_baseline_losses) || 0,
            frags: Number(state.lesta_session_baseline_frags) || 0,
            damage_dealt: Number(state.lesta_session_baseline_damage) || 0,
            xp: Number(state.lesta_session_baseline_xp) || 0,
            startedAt: state.lesta_session_started_at
        } : null;

        if (hasManualSession && baseline) {
            return res.json({
                success: true,
                mode: 'manual',
                startedAt: baseline.startedAt,
                session: computeLestaPeriodDelta(baseline, current)
            });
        }

        const reliableSince = Number(state.lesta_reliable_since) || 0;

        fetchLestaHistoryWindow('1d', current.battles, reliableSince, (err, windowData) => {
            if (err || !windowData.rows.length) {
                return res.json({
                    success: true,
                    mode: 'today',
                    hasData: false,
                    session: null
                });
            }
            const session = computeLestaPeriodStatsFromRows(windowData.rows, current.battles);
            const baselineRow = windowData.anchorRow;
            res.json({
                success: true,
                mode: 'today',
                hasData: session.battlesPlayed > 0,
                baselineAt: baselineRow ? baselineRow.timestamp : null,
                session
            });
        });
    });
});

app.post('/api/lesta-session/start', (req, res) => {
    getAppState((state) => {
        if (!state || !state.lesta_account_id) {
            return res.status(400).json({ success: false, error: 'Сначала привяжите Lesta' });
        }
        const nowSec = Math.floor(Date.now() / 1000);
        updateAppState({
            lesta_session_started_at: nowSec,
            lesta_session_baseline_battles: state.lesta_last_battles || 0,
            lesta_session_baseline_wins: state.lesta_last_wins || 0,
            lesta_session_baseline_losses: state.lesta_last_losses || 0,
            lesta_session_baseline_frags: state.lesta_last_frags || 0,
            lesta_session_baseline_damage: state.lesta_last_damage_dealt || 0,
            lesta_session_baseline_xp: state.lesta_last_xp || 0
        }, (err) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, startedAt: nowSec });
        });
    });
});

app.post('/api/lesta-session/reset', (req, res) => {
    updateAppState({
        lesta_session_started_at: 0,
        lesta_session_baseline_battles: 0,
        lesta_session_baseline_wins: 0,
        lesta_session_baseline_losses: 0,
        lesta_session_baseline_frags: 0,
        lesta_session_baseline_damage: 0,
        lesta_session_baseline_xp: 0
    }, (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

// API для получения истории изменений статистики Lesta Games
app.get('/api/lesta-history', (req, res) => {
    const { period = '1d' } = req.query;
    
    let dateFilter = '';
    let params = [];
    
    switch (period) {
        case '1d':
            dateFilter = 'WHERE timestamp >= datetime("now", "-1 day")';
            break;
        case '7d':
            dateFilter = 'WHERE timestamp >= datetime("now", "-7 days")';
            break;
        case '30d':
            dateFilter = 'WHERE timestamp >= datetime("now", "-30 days")';
            break;
        case '180d':
            dateFilter = 'WHERE timestamp >= datetime("now", "-180 days")';
            break;
        case '365d':
            dateFilter = 'WHERE timestamp >= datetime("now", "-365 days")';
            break;
        default:
            dateFilter = 'WHERE timestamp >= datetime("now", "-1 day")';
    }
    
    const query = `
        SELECT 
            id,
            timestamp AS created_at,
            battles,
            frags,
            wins,
            losses,
            damage_dealt,
            xp,
            win_rate,
            frags_per_battle,
            avg_damage,
            avg_xp,
            frags_difference,
            auto_deducted
        FROM lesta_stats_history 
        ${dateFilter}
        ORDER BY timestamp DESC
        LIMIT 1000
    `;
    
    dbRead.all(query, params, (err, rows) => {
        if (err) {
            console.error('❌ Ошибка получения истории Lesta Games:', err);
            res.status(500).json({ success: false, error: 'Ошибка получения истории' });
        } else {
            const list = rows || [];
            getAppState((state) => {
                const refBattles = Number(state?.lesta_last_battles) || 0;
                const reliableSince = Number(state?.lesta_reliable_since) || 0;
                fetchLestaHistoryWindow(period, refBattles, reliableSince, (winErr, windowData) => {
                    const periodDelta = !winErr && windowData
                        ? computeLestaPeriodStatsFromRows(windowData.rows, refBattles)
                        : { battlesPlayed: 0, frags: 0, wins: 0 };
                    const daysForDaily = period === '30d' ? 30 : period === '7d' ? 7 : 14;
                    buildLestaDailyActivity(daysForDaily, refBattles, reliableSince, (dailyErr, daily) => {
                        const stats = {
                            total_records: list.length,
                            total_frags_gained: list.reduce((sum, row) => sum + (row.frags_difference || 0), 0),
                            total_frags_deducted: list.reduce((sum, row) => sum + (row.auto_deducted || 0), 0),
                            total_battles_played: periodDelta.battlesPlayed,
                            avg_frags_per_update: list.length > 0 ? (list.reduce((sum, row) => sum + (row.frags_difference || 0), 0) / list.length).toFixed(2) : 0,
                            period: period
                        };

                        res.json({
                            success: true,
                            history: list,
                            stats: stats,
                            daily: dailyErr ? [] : (daily || [])
                        });
                    });
                });
            });
        }
    });
});

// API для получения аналитики
app.get('/api/analytics/stats', (req, res) => {
    const { period = '7d' } = req.query;
    
    analytics.getStats(period, (err, stats) => {
        if (err) {
            console.error('❌ Ошибка получения статистики:', err);
            return res.status(500).json({ error: 'Ошибка получения статистики' });
        }
        
        res.json({ success: true, stats });
    });
});

// API для получения статистики по платформам
app.get('/api/analytics/platforms', (req, res) => {
    const { period = '7d' } = req.query;
    
    analytics.getPlatformStats(period, (err, stats) => {
        if (err) {
            console.error('❌ Ошибка получения статистики платформ:', err);
            return res.status(500).json({ error: 'Ошибка получения статистики платформ' });
        }
        
        res.json({ success: true, stats });
    });
});

// API для получения топ донатеров
app.get('/api/analytics/top-donors', (req, res) => {
    const { limit = 10 } = req.query;
    
    analytics.getTopDonors(parseInt(limit), (err, donors) => {
        if (err) {
            console.error('❌ Ошибка получения топ донатеров:', err);
            return res.status(500).json({ error: 'Ошибка получения топ донатеров' });
        }
        
        res.json({ success: true, donors });
    });
});

// API для получения активности по часам
app.get('/api/analytics/hourly', (req, res) => {
    analytics.getHourlyActivity((err, activity) => {
        if (err) {
            console.error('❌ Ошибка получения почасовой активности:', err);
            return res.status(500).json({ error: 'Ошибка получения почасовой активности' });
        }
        
        res.json({ success: true, activity });
    });
});

// API для получения событий аналитики
app.get('/api/analytics/events', (req, res) => {
    const { eventType, limit = 100 } = req.query;
    
    analytics.getEvents(eventType, parseInt(limit), (err, events) => {
        if (err) {
            console.error('❌ Ошибка получения событий:', err);
            return res.status(500).json({ error: 'Ошибка получения событий' });
        }
        
        res.json({ success: true, events });
    });
});

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

// Аналитика донатов - общая статистика
app.get('/api/donations-analytics', (req, res) => {
    console.log('📊 Запрос аналитики донатов...');
    
    // Получаем стартовое значение из app_state
    db.get('SELECT total_donated FROM app_state WHERE id = 1', (err, appState) => {
        if (err) {
            console.error('❌ Ошибка получения стартового значения:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        const startingAmount = Math.round(appState.total_donated || 0);
        
        const excludeName = 'Zhuzhu';
        const excludeNorm = normalizeUsername(excludeName);

        const queries = {
            // Общая статистика
            totalStats: `SELECT COUNT(*) as totalCount, SUM(amount) as totalAmount, AVG(amount) as avgAmount, MIN(amount) as minAmount, MAX(amount) as maxAmount 
                         FROM donations 
                         WHERE username != '${excludeName}' AND (normalized_username IS NULL OR normalized_username != '${excludeNorm}')`,
            
            // Статистика по часам дня
            hourlyStats: `SELECT 
                strftime('%H', datetime(created_at, 'localtime')) as hour,
                COUNT(*) as count,
                SUM(amount) as totalAmount,
                AVG(amount) as avgAmount
                FROM donations 
                WHERE username != '${excludeName}' AND (normalized_username IS NULL OR normalized_username != '${excludeNorm}')
                GROUP BY strftime('%H', datetime(created_at, 'localtime'))
                ORDER BY hour`,
            
            // Статистика по дням недели
            dailyStats: `SELECT 
                strftime('%w', datetime(created_at, 'localtime')) as dayOfWeek,
                COUNT(*) as count,
                SUM(amount) as totalAmount,
                AVG(amount) as avgAmount
                FROM donations 
                WHERE username != '${excludeName}' AND (normalized_username IS NULL OR normalized_username != '${excludeNorm}')
                GROUP BY strftime('%w', datetime(created_at, 'localtime'))
                ORDER BY dayOfWeek`,
            
            // Статистика по размерам донатов
            amountRanges: `SELECT 
                CASE 
                    WHEN amount < 100 THEN '0-99₽'
                    WHEN amount < 500 THEN '100-499₽'
                    WHEN amount < 1000 THEN '500-999₽'
                    WHEN amount < 2000 THEN '1000-1999₽'
                    ELSE '2000₽+'
                END as range,
                COUNT(*) as count,
                SUM(amount) as totalAmount
                FROM donations 
                WHERE username != '${excludeName}' AND (normalized_username IS NULL OR normalized_username != '${excludeNorm}')
                GROUP BY range
                ORDER BY MIN(amount)`,
            
            // Последние донаты
            recentDonations: `SELECT * FROM donations 
                              WHERE username != '${excludeName}' AND (normalized_username IS NULL OR normalized_username != '${excludeNorm}')
                              ORDER BY created_at DESC LIMIT 50`
        };
        
        const results = {};
        let completed = 0;
        const totalQueries = Object.keys(queries).length;
        
        Object.keys(queries).forEach(key => {
            db.all(queries[key], (err, rows) => {
                if (err) {
                    console.error(`❌ Ошибка запроса ${key}:`, err);
                    results[key] = { error: err.message };
                } else {
                    results[key] = rows;
                }
                
                completed++;
                if (completed === totalQueries) {
                    // Корректируем общую статистику с учетом стартового значения
                    if (results.totalStats && results.totalStats[0]) {
                        const stats = results.totalStats[0];
                        const donationsAmount = Math.round(stats.totalAmount || 0);
                        const donationsCount = stats.totalCount || 0;
                        
                        // Если стартовое значение больше суммы донатов, корректируем статистику
                        if (startingAmount > donationsAmount) {
                            results.totalStats[0].totalAmount = startingAmount;
                            results.totalStats[0].avgAmount = donationsCount > 0 ? 
                                (startingAmount / donationsCount) : startingAmount;
                            results.totalStats[0].minAmount = Math.min(stats.minAmount || startingAmount, startingAmount);
                            results.totalStats[0].maxAmount = Math.max(stats.maxAmount || startingAmount, startingAmount);
                        }
                        
                        results.startingAmount = startingAmount;
                        results.donationsAmount = donationsAmount;
                        results.donationsCount = donationsCount;
                    }
                    
                    console.log('✅ Аналитика донатов готова (с учетом стартового значения)');
                    res.json({ success: true, data: results });
                }
            });
        });
    });
});

// Аналитика донатов - временные интервалы таймера
app.get('/api/donations-timer-analysis', (req, res) => {
    console.log('⏰ Анализ донатов по времени таймера...');
    
    // Получаем данные о состоянии таймера и донатах
    const queries = {
        // Донаты с информацией о времени таймера (если есть связь)
        timerDonations: `SELECT 
            d.*,
            CASE 
                WHEN d.created_at >= datetime('now', '-1 hour') THEN 'Последний час'
                WHEN d.created_at >= datetime('now', '-6 hours') THEN 'Последние 6 часов'
                WHEN d.created_at >= datetime('now', '-24 hours') THEN 'Последние 24 часа'
                ELSE 'Старше суток'
            END as timeGroup
            FROM donations d
            ORDER BY d.created_at DESC`,
        
        // Статистика по времени суток
        timeOfDay: `SELECT 
            CASE 
                WHEN strftime('%H', datetime(created_at, 'localtime')) BETWEEN '06' AND '11' THEN 'Утро (6-11)'
                WHEN strftime('%H', datetime(created_at, 'localtime')) BETWEEN '12' AND '17' THEN 'День (12-17)'
                WHEN strftime('%H', datetime(created_at, 'localtime')) BETWEEN '18' AND '23' THEN 'Вечер (18-23)'
                ELSE 'Ночь (0-5)'
            END as timePeriod,
            COUNT(*) as count,
            SUM(amount) as totalAmount,
            AVG(amount) as avgAmount
            FROM donations 
            GROUP BY timePeriod
            ORDER BY totalAmount DESC`,
        
        // Топ донатеры
        topDonors: `SELECT 
            username,
            COUNT(*) as donationCount,
            SUM(amount) as totalDonated,
            AVG(amount) as avgDonation,
            MAX(amount) as maxDonation,
            MIN(created_at) as firstDonation,
            MAX(created_at) as lastDonation
            FROM donations 
            GROUP BY username 
            ORDER BY totalDonated DESC 
            LIMIT 20`
    };
    
    const results = {};
    let completed = 0;
    const totalQueries = Object.keys(queries).length;
    
    Object.keys(queries).forEach(key => {
        db.all(queries[key], (err, rows) => {
            if (err) {
                console.error(`❌ Ошибка запроса ${key}:`, err);
                results[key] = { error: err.message };
            } else {
                results[key] = rows;
            }
            
            completed++;
            if (completed === totalQueries) {
                console.log('✅ Анализ по времени таймера готов');
                res.json({ success: true, data: results });
            }
        });
    });
});

// Аналитика донатов - режимы таймера
app.get('/api/donations-mode-analysis', (req, res) => {
    console.log('🎮 Анализ донатов по режимам таймера...');
    
    // Получаем данные о режимах из app_state
    db.get('SELECT * FROM app_state WHERE id = 1', (err, appState) => {
        if (err) {
            console.error('❌ Ошибка получения состояния приложения:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        // Анализируем донаты с учетом режимов
        const queries = {
            // Общая статистика донатов
            donationStats: `SELECT 
                COUNT(*) as totalCount,
                SUM(amount) as totalAmount,
                AVG(amount) as avgAmount,
                MIN(amount) as minAmount,
                MAX(amount) as maxAmount,
                COUNT(DISTINCT username) as uniqueDonors
                FROM donations`,
            
            // Статистика по размерам донатов
            amountDistribution: `SELECT 
                CASE 
                    WHEN amount < 50 THEN '0-49₽'
                    WHEN amount < 100 THEN '50-99₽'
                    WHEN amount < 200 THEN '100-199₽'
                    WHEN amount < 500 THEN '200-499₽'
                    WHEN amount < 1000 THEN '500-999₽'
                    ELSE '1000₽+'
                END as range,
                COUNT(*) as count,
                SUM(amount) as totalAmount,
                ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM donations), 2) as percentage
                FROM donations 
                GROUP BY range
                ORDER BY MIN(amount)`,
            
            // Активность по дням
            dailyActivity: `SELECT 
                DATE(datetime(created_at, 'localtime')) as date,
                COUNT(*) as donationCount,
                SUM(amount) as totalAmount,
                COUNT(DISTINCT username) as uniqueDonors
                FROM donations 
                GROUP BY DATE(datetime(created_at, 'localtime'))
                ORDER BY date DESC
                LIMIT 30`
        };
        
        const results = { appState };
        let completed = 0;
        const totalQueries = Object.keys(queries).length;
        
        Object.keys(queries).forEach(key => {
            db.all(queries[key], (err, rows) => {
                if (err) {
                    console.error(`❌ Ошибка запроса ${key}:`, err);
                    results[key] = { error: err.message };
                } else {
                    results[key] = rows;
                }
                
                completed++;
                if (completed === totalQueries) {
                    console.log('✅ Анализ по режимам готов');
                    res.json({ success: true, data: results });
                }
            });
        });
    });
});

// Расширенная аналитика режимов таймера
app.get('/api/timer-modes-analytics', (req, res) => {
    console.log('🎮 Расширенная аналитика режимов таймера...');
    
    const queries = {
        // Статистика по времени таймера (когда больше всего донатов)
        timerTimeStats: `SELECT 
            CASE 
                WHEN timer_seconds = 0 THEN 'Таймер остановлен'
                WHEN timer_seconds < 60 THEN 'Менее 1 минуты'
                WHEN timer_seconds < 300 THEN '1-5 минут'
                WHEN timer_seconds < 600 THEN '5-10 минут'
                WHEN timer_seconds < 1800 THEN '10-30 минут'
                WHEN timer_seconds < 3600 THEN '30-60 минут'
                WHEN timer_seconds < 7200 THEN '1-2 часа'
                WHEN timer_seconds < 10800 THEN '2-3 часа'
                WHEN timer_seconds < 14400 THEN '3-4 часа'
                WHEN timer_seconds < 18000 THEN '4-5 часов'
                WHEN timer_seconds < 21600 THEN '5-6 часов'
                WHEN timer_seconds < 25200 THEN '6-7 часов'
                WHEN timer_seconds < 28800 THEN '7-8 часов'
                ELSE 'Более 8 часов'
            END as timeRange,
            COUNT(*) as donationCount,
            SUM(amount) as totalAmount,
            AVG(amount) as avgAmount,
            timer_mode,
            discount_active,
            slowdown_active,
            temperature_active
            FROM donations 
            WHERE timer_seconds IS NOT NULL
            GROUP BY timeRange, timer_mode, discount_active, slowdown_active, temperature_active
            ORDER BY totalAmount DESC`,
        
        // Статистика по последнему часу с интервалами 10 минут
        lastHourStats: `SELECT 
            CASE 
                WHEN timer_seconds >= 3600 THEN '60+ минут'
                WHEN timer_seconds >= 3300 THEN '55-60 минут'
                WHEN timer_seconds >= 3000 THEN '50-55 минут'
                WHEN timer_seconds >= 2700 THEN '45-50 минут'
                WHEN timer_seconds >= 2400 THEN '40-45 минут'
                WHEN timer_seconds >= 2100 THEN '35-40 минут'
                WHEN timer_seconds >= 1800 THEN '30-35 минут'
                WHEN timer_seconds >= 1500 THEN '25-30 минут'
                WHEN timer_seconds >= 1200 THEN '20-25 минут'
                WHEN timer_seconds >= 900 THEN '15-20 минут'
                WHEN timer_seconds >= 600 THEN '10-15 минут'
                WHEN timer_seconds >= 300 THEN '5-10 минут'
                WHEN timer_seconds >= 60 THEN '1-5 минут'
                WHEN timer_seconds > 0 THEN 'Менее 1 минуты'
                ELSE 'Таймер остановлен'
            END as timeRange,
            COUNT(*) as donationCount,
            SUM(amount) as totalAmount,
            AVG(amount) as avgAmount,
            timer_mode
            FROM donations 
            WHERE timer_seconds IS NOT NULL AND timer_seconds <= 3600
            GROUP BY timeRange, timer_mode
            ORDER BY timer_seconds DESC`,
        
        // Статистика по режимам таймера
        timerModesStats: `SELECT 
            CASE 
                WHEN timer_mode = 'mode1' THEN 'Фраг-трекер'
                WHEN timer_mode = 'mode2' THEN 'Таймер'
                WHEN timer_mode = 'mode3' THEN 'Кастомный трекер'
                WHEN timer_mode = 'normal' THEN 'Обычный режим'
                ELSE timer_mode
            END as modeName,
            timer_mode,
            COUNT(*) as donationCount,
            SUM(amount) as totalAmount,
            AVG(amount) as avgAmount,
            SUM(CASE WHEN discount_active = 1 THEN 1 ELSE 0 END) as discountDonations,
            SUM(CASE WHEN slowdown_active = 1 THEN 1 ELSE 0 END) as slowdownDonations,
            SUM(CASE WHEN temperature_active = 1 THEN 1 ELSE 0 END) as temperatureDonations
            FROM donations 
            WHERE timer_mode IS NOT NULL
            GROUP BY timer_mode
            ORDER BY totalAmount DESC`,
        
        // Статистика по режиму температуры
        temperatureStats: `SELECT 
            CASE 
                WHEN temperature_overheated = 1 THEN 'Достигнут перегрев (100%)'
                WHEN temperature_amount >= 75 THEN 'Высокая температура (75-99%)'
                WHEN temperature_amount >= 50 THEN 'Средняя температура (50-74%)'
                WHEN temperature_amount >= 25 THEN 'Низкая температура (25-49%)'
                WHEN temperature_amount > 0 THEN 'Начальная температура (1-24%)'
                ELSE 'Температура не активна'
            END as temperatureRange,
            COUNT(*) as donationCount,
            SUM(amount) as totalAmount,
            AVG(amount) as avgAmount,
            AVG(temperature_amount) as avgTemperature,
            AVG(temperature_target) as avgTarget,
            SUM(temperature_reward_minutes) as totalRewardMinutes
            FROM donations 
            WHERE temperature_active = 1
            GROUP BY temperatureRange
            ORDER BY avgTemperature DESC`,
        
        // Сессии режима температуры
        temperatureSessions: `SELECT 
            COUNT(*) as totalSessions,
            SUM(CASE WHEN overheated = 1 THEN 1 ELSE 0 END) as overheatedSessions,
            SUM(CASE WHEN overheated = 0 THEN 1 ELSE 0 END) as incompleteSessions,
            AVG(total_donated) as avgDonatedPerSession,
            AVG(max_temperature) as avgMaxTemperature,
            SUM(reward_minutes) as totalRewardMinutes,
            AVG(cooling_rate) as avgCoolingRate
            FROM temperature_sessions
            WHERE totalSessions > 0`,
        
        // Топ донатов по режимам
        topDonationsByMode: `SELECT 
            username,
            amount,
            timer_mode,
            discount_active,
            slowdown_active,
            temperature_active,
            temperature_amount,
            created_at
            FROM donations 
            WHERE timer_mode IS NOT NULL
            ORDER BY amount DESC 
            LIMIT 50`,
        
        // Статистика по скидкам
        discountStats: `SELECT 
            discount_percentage,
            COUNT(*) as donationCount,
            SUM(amount) as totalAmount,
            AVG(amount) as avgAmount
            FROM donations 
            WHERE discount_active = 1 AND discount_percentage > 0
            GROUP BY discount_percentage
            ORDER BY discount_percentage DESC`,
        
        // Статистика по замедлению
        slowdownStats: `SELECT 
            slowdown_factor,
            COUNT(*) as donationCount,
            SUM(amount) as totalAmount,
            AVG(amount) as avgAmount
            FROM donations 
            WHERE slowdown_active = 1 AND slowdown_factor > 0
            GROUP BY slowdown_factor
            ORDER BY slowdown_factor DESC`
    };
    
    const results = {};
    let completed = 0;
    const totalQueries = Object.keys(queries).length;
    
    Object.keys(queries).forEach(key => {
        db.all(queries[key], (err, rows) => {
            if (err) {
                console.error(`❌ Ошибка запроса ${key}:`, err);
                results[key] = { error: err.message };
            } else {
                results[key] = rows;
            }
            
            completed++;
            if (completed === totalQueries) {
                console.log('✅ Расширенная аналитика режимов таймера готова');
                res.json({ success: true, data: results });
            }
        });
    });
});

// API для группировки донатеров по нормализованным никам
app.get('/api/donors-grouped', (req, res) => {
    console.log('👥 Запрос группировки донатеров по никам...');
    
    const queries = {
        // Группировка по нормализованным никам
        groupedDonors: `SELECT 
            normalized_username,
            COUNT(*) as donationCount,
            SUM(amount) as totalAmount,
            AVG(amount) as avgAmount,
            MIN(amount) as minAmount,
            MAX(amount) as maxAmount,
            GROUP_CONCAT(DISTINCT username) as originalUsernames,
            MIN(created_at) as firstDonation,
            MAX(created_at) as lastDonation
            FROM donations 
            WHERE normalized_username != ''
            GROUP BY normalized_username
            ORDER BY totalAmount DESC`,
        
        // Статистика по вариациям ников
        usernameVariations: `SELECT 
            normalized_username,
            COUNT(DISTINCT username) as variationCount,
            GROUP_CONCAT(DISTINCT username) as variations,
            SUM(amount) as totalAmount
            FROM donations 
            WHERE normalized_username != ''
            GROUP BY normalized_username
            HAVING variationCount > 1
            ORDER BY variationCount DESC, totalAmount DESC`,
        
        // Топ донатеров с группировкой
        topGroupedDonors: `SELECT 
            normalized_username,
            COUNT(*) as donationCount,
            SUM(amount) as totalAmount,
            AVG(amount) as avgAmount,
            GROUP_CONCAT(DISTINCT username) as originalUsernames,
            MAX(amount) as maxDonation
            FROM donations 
            WHERE normalized_username != ''
            GROUP BY normalized_username
            ORDER BY totalAmount DESC
            LIMIT 50`,
        
        // Статистика по режимам для группированных донатеров
        donorsByModes: `SELECT 
            normalized_username,
            timer_mode,
            COUNT(*) as donationCount,
            SUM(amount) as totalAmount,
            AVG(amount) as avgAmount
            FROM donations 
            WHERE normalized_username != '' AND timer_mode IS NOT NULL
            GROUP BY normalized_username, timer_mode
            ORDER BY totalAmount DESC`,
        
        // Общая статистика группировки
        groupingStats: `SELECT 
            COUNT(DISTINCT username) as uniqueOriginalUsernames,
            COUNT(DISTINCT normalized_username) as uniqueNormalizedUsernames,
            COUNT(*) as totalDonations,
            SUM(amount) as totalAmount
            FROM donations 
            WHERE normalized_username != ''`
    };
    
    const results = {};
    let completed = 0;
    const totalQueries = Object.keys(queries).length;
    
    Object.keys(queries).forEach(key => {
        db.all(queries[key], (err, rows) => {
            if (err) {
                console.error(`❌ Ошибка запроса ${key}:`, err);
                results[key] = { error: err.message };
            } else {
                results[key] = rows;
            }
            
            completed++;
            if (completed === totalQueries) {
                console.log('✅ Группировка донатеров готова');
                res.json({ success: true, data: results });
            }
        });
    });
});

// Получить общую статистику донатов
app.get('/api/donations-stats', (req, res) => {
    // Читаем app_state как «источник истины» для суммы
    db.get('SELECT total_donated FROM app_state WHERE id = 1', (appErr, appState) => {
        const totalFromState = Math.round((appState && appState.total_donated) || 0);
        // Проверяем наличие таблицы donations
        db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name='donations'`, (tableErr, tables) => {
            if (tableErr || !tables || tables.length === 0) {
                if (tableErr) console.error('❌ Ошибка проверки таблицы donations:', tableErr);
                // Возвращаем сумму из состояния, даже если таблицы нет
                return res.json({ success: true, totalAmount: totalFromState, totalCount: 0 });
            }
            // Получаем статистику из таблицы donations (только для количества)
            db.get('SELECT COUNT(*) as totalCount FROM donations WHERE username != ? AND normalized_username != ?', ['Zhuzhu', normalizeUsername('Zhuzhu')], (err, stats) => {
                if (err) {
                    console.error('❌ Ошибка получения статистики донатов:', err);
                    return res.json({ success: true, totalAmount: totalFromState, totalCount: 0 });
                }
                const donationsCount = (stats && stats.totalCount) || 0;
                // ВАЖНО: Используем total_donated из app_state как единственный источник истины для суммы
                // Это гарантирует, что корректировки и ручные изменения отражаются в виджетах
                res.json({ success: true, totalAmount: totalFromState, totalCount: donationsCount });
            });
        });
    });
});

// Тестовый endpoint для диагностики малых донатеров
app.get('/api/donations-stats-small-donors-debug', (req, res) => {
    const excludeName = 'Zhuzhu';
    const excludeNorm = normalizeUsername(excludeName);
    const normalizedExpr = donationsHasNormalizedUsername ? "NULLIF(normalized_username, '')" : null;
    const groupExpression = normalizedExpr ? `COALESCE(${normalizedExpr}, username)` : 'username';
    
    // Получаем всех донатеров с их суммами
    db.all(`
        SELECT
            ${groupExpression} AS aggregated_username,
            SUM(amount) AS total_amount,
            COUNT(*) AS donation_count,
            SUM(COALESCE(time_earned, 0)) AS total_time
        FROM donations
        WHERE username IS NOT NULL 
          AND username != '' 
          AND username != ?
          AND (${normalizedExpr || "username"} IS NULL OR ${normalizedExpr || "username"} != ?)
        GROUP BY ${groupExpression}
        ORDER BY total_amount ASC
        LIMIT 50
    `, [excludeName, excludeNorm], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        
        const smallDonors = rows.filter(r => r.total_amount <= 2000);
        
        res.json({
            success: true,
            total_donors: rows.length,
            small_donors_count: smallDonors.length,
            small_donors: smallDonors,
            all_donors_sample: rows.slice(0, 10)
        });
    });
});

// Получить статистику по донатерам с общей суммой <= 2000₽
app.get('/api/donations-stats-small-donors', (req, res) => {
    try {
        const topDonorsCount = 10;
        const excludeName = 'Zhuzhu';
        const excludeNorm = normalizeUsername(excludeName);
        
        console.log(`📊 Запрос статистики донатеров (исключая топ-${topDonorsCount})`);
        
        // Используем тот же подход, что и в /api/donors
        const normalizedExpr = donationsHasNormalizedUsername ? "NULLIF(normalized_username, '')" : null;
        const groupExpression = normalizedExpr ? `COALESCE(${normalizedExpr}, username)` : 'username';
        
        // ПРОСТОЙ ПОДХОД: находим топ-10 донатеров, исключаем их, считаем остальных
        // Сначала находим топ-10 донатеров
        const findTopDonorsQuery = `
            SELECT
                ${groupExpression} AS aggregated_username,
                SUM(amount) AS total_amount
            FROM donations
            WHERE username IS NOT NULL 
              AND username != '' 
              AND username != ?
              AND (${normalizedExpr || "username"} IS NULL OR ${normalizedExpr || "username"} != ?)
            GROUP BY ${groupExpression}
            ORDER BY total_amount DESC
            LIMIT ?
        `;
        
        console.log(`📊 Поиск топ-${topDonorsCount} донатеров...`);
        console.log(`📊 SQL:`, findTopDonorsQuery);
        console.log(`📊 Параметры: [${excludeName}, ${excludeNorm}, ${topDonorsCount}]`);
        
        db.all(findTopDonorsQuery, [excludeName, excludeNorm, topDonorsCount], (topErr, topDonors) => {
            if (topErr) {
                console.error('❌ Ошибка поиска топ-донатеров:', topErr);
                return res.status(500).json({ 
                    success: false, 
                    error: topErr.message,
                    details: 'Ошибка при поиске топ-донатеров'
                });
            }
            
            if (!topDonors || topDonors.length === 0) {
                console.log('📊 Топ-донатеров не найдено, считаем всех');
                // Если нет топ-донатеров, считаем всех
                const allQuery = `
                    SELECT 
                        COUNT(*) as donation_count,
                        COALESCE(SUM(amount), 0) as total_amount,
                        COALESCE(SUM(COALESCE(time_earned, 0)), 0) as total_time_earned,
                        COUNT(DISTINCT ${groupExpression}) as unique_donors
                    FROM donations d
                    WHERE d.username IS NOT NULL 
                      AND d.username != '' 
                      AND d.username != ?
                      AND (${normalizedExpr || "d.username"} IS NULL OR ${normalizedExpr || "d.username"} != ?)
                `;
                
                db.get(allQuery, [excludeName, excludeNorm], (allErr, allStats) => {
                    if (allErr) {
                        console.error('❌ Ошибка получения статистики:', allErr);
                        return res.status(500).json({ success: false, error: allErr.message });
                    }
                    
                    const result = {
                        success: true,
                        donation_count: allStats?.donation_count || 0,
                        total_amount: Math.round(allStats?.total_amount || 0),
                        total_time_earned: allStats?.total_time_earned || 0,
                        unique_donors: allStats?.unique_donors || 0,
                        excluded_top_count: 0
                    };
                    
                    console.log(`✅ Статистика (все донатеры):`, result);
                    res.json(result);
                });
                return;
            }
            
            const topUsernames = topDonors.map(d => d.aggregated_username).filter(Boolean);
            console.log(`📊 Найдено ${topUsernames.length} топ-донатеров:`, topUsernames.slice(0, 5));
            console.log(`📊 Примеры сумм:`, topDonors.slice(0, 5).map(d => `${d.aggregated_username}: ${d.total_amount}₽`));
            
            if (topUsernames.length === 0) {
                console.log('⚠️ Список топ-донатеров пуст, считаем всех');
                // Если список пуст, считаем всех
                const allQuery = `
                    SELECT 
                        COUNT(*) as donation_count,
                        COALESCE(SUM(amount), 0) as total_amount,
                        COALESCE(SUM(COALESCE(time_earned, 0)), 0) as total_time_earned,
                        COUNT(DISTINCT ${groupExpression}) as unique_donors
                    FROM donations d
                    WHERE d.username IS NOT NULL 
                      AND d.username != '' 
                      AND d.username != ?
                      AND (${normalizedExpr || "d.username"} IS NULL OR ${normalizedExpr || "d.username"} != ?)
                `;
                
                db.get(allQuery, [excludeName, excludeNorm], (allErr, allStats) => {
                    if (allErr) {
                        console.error('❌ Ошибка получения статистики:', allErr);
                        return res.status(500).json({ success: false, error: allErr.message });
                    }
                    
                    const result = {
                        success: true,
                        donation_count: allStats?.donation_count || 0,
                        total_amount: Math.round(allStats?.total_amount || 0),
                        total_time_earned: allStats?.total_time_earned || 0,
                        unique_donors: allStats?.unique_donors || 0,
                        excluded_top_count: 0
                    };
                    
                    console.log(`✅ Статистика (все донатеры):`, result);
                    res.json(result);
                });
                return;
            }
            
            // Теперь считаем статистику по остальным донатерам
            const placeholders = topUsernames.map(() => '?').join(',');
            const statsQuery = `
                SELECT 
                    COUNT(*) as donation_count,
                    COALESCE(SUM(amount), 0) as total_amount,
                    COALESCE(SUM(COALESCE(time_earned, 0)), 0) as total_time_earned,
                    COUNT(DISTINCT ${groupExpression}) as unique_donors
                FROM donations d
                WHERE d.username IS NOT NULL 
                  AND d.username != '' 
                  AND d.username != ?
                  AND (${normalizedExpr || "d.username"} IS NULL OR ${normalizedExpr || "d.username"} != ?)
                  AND ${groupExpression} NOT IN (${placeholders})
            `;
            
            const statsParams = [excludeName, excludeNorm, ...topUsernames];
            
            console.log(`📊 Запрос статистики (исключая ${topUsernames.length} топ-донатеров)`);
            console.log(`📊 SQL:`, statsQuery.substring(0, 200) + '...');
            console.log(`📊 Параметров: ${statsParams.length}`);
            
            db.get(statsQuery, statsParams, (err, stats) => {
                if (err) {
                    console.error('❌ Ошибка получения статистики:', err);
                    console.error('   SQL:', statsQuery);
                    console.error('   Ошибка SQL:', err.message);
                    return res.status(500).json({ 
                        success: false, 
                        error: err.message,
                        details: 'Ошибка при подсчете статистики'
                    });
                }
                
                console.log(`📊 Результат запроса:`, stats);
                
                const result = {
                    success: true,
                    donation_count: stats?.donation_count || 0,
                    total_amount: Math.round(stats?.total_amount || 0),
                    total_time_earned: stats?.total_time_earned || 0,
                    unique_donors: stats?.unique_donors || 0,
                    excluded_top_count: topDonorsCount
                };
                
                console.log(`✅ Статистика донатеров (исключая топ-${topDonorsCount}):`);
                console.log(`   - Количество донатов: ${result.donation_count}`);
                console.log(`   - Общая сумма: ${result.total_amount}₽`);
                console.log(`   - Время в таймере: ${result.total_time_earned} сек (${Math.floor(result.total_time_earned / 60)} мин)`);
                console.log(`   - Уникальных донатеров: ${result.unique_donors}`);
                
                res.json(result);
            });
        });
    } catch (error) {
        console.error('❌ Критическая ошибка в /api/donations-stats-small-donors:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Неизвестная ошибка',
            details: 'Ошибка при обработке запроса'
        });
    }
});

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
    getLestaPlayerStats
};
const moduleConfig = {
    razblogEnabled: RAZBLOG_ENABLED,
    createRazblogirovkaGoldService,
    archiveDir: RAZBLOG_ARCHIVE_DIR
};
const modules = registerModules(app, moduleDeps, moduleConfig);
blitzModule = modules.blitz;
razblogModuleRef = modules.razblog;

function updateBlitzChallenge(amount, donation) {
    if (blitzModule) blitzModule.updateBlitzChallenge(amount, donation);
}

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
🔗 DonatePay Webhook: http://localhost:${port}/webhook/donatepay
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

    if (!VKPLAY_POLLING_ENABLED) {
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

    // Подключение к локальному Rutony Chat
    setTimeout(() => {
        console.log('🔌 Подключение к Rutony Chat...');
        startRutonyChat();
    }, 1500);
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

// In-memory mock state (replace with real storage/session later)
let youtubeIntegration = {
    connected: false,
    channel: null,
    liveTitle: null,
    chatEnabled: false,
    viewers: 0,
    likes: 0,
    tokens: null,
    liveChatId: null,
    nextPageToken: null,
    videoId: null,       // ручной override текущего стрима
    pollIntervalSec: 60, // базовый интервал опроса YouTube (секунды)
    lastPollTime: 0,     // последний успешный опрос videos.list/liveChat
    lastLiveDetectTime: 0 // последний авто-поиск активного live (чтобы не жечь квоту)
};

let vkplayIntegration = {
    connected: false,
    channel: null,
    liveTitle: null,
    chatEnabled: false,
    viewers: 0,
    likes: 0,
    tokens: null,
    expires_at: 0,
    channelUrl: null  // ВАЖНО: URL канала для API запросов
};

/** VK Play polling выключен по умолчанию — задайте VKPLAY_POLLING=1 чтобы включить */
const VKPLAY_POLLING_ENABLED = process.env.VKPLAY_POLLING === '1';

// Нормализация лайков VK Play: структура counters может отличаться, пробуем несколько вариантов
function getVKPlayLikesFromChannelInfo(channelInfo, previousLikes) {
    if (!channelInfo) return previousLikes || 0;
    const stream = channelInfo.stream || {};
    const streamCounters = stream.counters || {};
    const channelCounters = channelInfo.channel?.counters || {};
    const count = channelInfo.count || stream.count || channelInfo.data?.count || {};
    // VK Play API: reactions в stream.reactions — массив [{type:"heart",count:9}, ...]
    const reactionsObj = streamCounters.reactions || channelCounters.reactions || {};
    const reactionsArr = stream.reactions || streamCounters.reactions || channelCounters.reactions;

    const candidates = [
        streamCounters.likes,
        streamCounters.likes_count,
        streamCounters.like_count,
        channelCounters.likes,
        channelCounters.likes_count,
        channelCounters.like_count,
        count.likes,
        count.like_count,
        reactionsObj.likes,
        reactionsObj.like,
        reactionsObj.hearts,
        reactionsObj.heart
    ];

    let bestLikes = null;
    for (const v of candidates) {
        if (v == null) continue;
        const n = Number(v);
        if (Number.isNaN(n)) continue;
        if (bestLikes == null || n > bestLikes) bestLikes = n;
    }
    // stream.reactions = [{type:"heart",count:9}] — суммируем count по всем реакциям
    const arr = Array.isArray(reactionsArr) ? reactionsArr : (reactionsObj.items || reactionsObj.list || []);
    if (arr.length) {
        let sum = 0;
        for (const r of arr) {
            const c = r?.count ?? r?.value ?? r?.likes ?? r?.total;
            if (c != null) sum += Number(c) || 0;
        }
        if (bestLikes == null || sum > bestLikes) bestLikes = sum;
    }
    if (bestLikes != null) return bestLikes;
    return previousLikes || 0;
}

// Нормализация зрителей VK Play: пробуем разные пути в ответе API
function getVKPlayViewersFromChannelInfo(channelInfo) {
    if (!channelInfo) return 0;
    const stream = channelInfo.stream || {};
    const counters = stream.counters || {};
    const channelCounters = channelInfo.channel?.counters || {};
    const count = channelInfo.count || stream.count || channelInfo.data?.count || {};

    const candidates = [
        counters.viewers,
        counters.viewers_count,
        counters.viewer_count,
        counters.spectators,
        counters.spectator_count,
        count.viewers,
        count.viewers_count,
        count.views,
        stream.viewers,
        stream.viewers_count,
        stream.viewer_count,
        stream.spectators,
        channelCounters.viewers,
        channelCounters.viewers_count,
        channelCounters.spectators
    ];

    for (const v of candidates) {
        if (v != null) {
            const n = Number(v);
            if (!Number.isNaN(n)) return n;
        }
    }
    return 0;
}

// Rutony Chat (локальный) через WebSocket ws://localhost:8383
let rutonyIntegration = {
    connected: false,
    lastError: null
};

// Интеграция VK Play для чат-бота (отдельный аккаунт)
let vkplayBotIntegration = {
    connected: false,
    channel: null,
    channelUrl: null,
    tokens: null,
    expires_at: 0,
    userId: null,
    userNick: null
};

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
        // YouTube
        const yt = await loadIntegration('youtube');
        if (yt && yt.access_token) {
            youtubeIntegration = {
                connected: true,
                channel: yt.channel_name,
                liveTitle: yt.live_title,
                chatEnabled: !!yt.chat_enabled,
                viewers: yt.viewers_count || 0,
                likes: yt.likes_count || 0,
                tokens: {
                    access_token: yt.access_token,
                    refresh_token: yt.refresh_token
                },
                liveChatId: null,
                nextPageToken: null,
                videoId: yt.video_id || null,
                pollIntervalSec: yt.poll_interval_sec || 60,
                lastPollTime: 0,
                lastLiveDetectTime: 0
            };
            console.log('✅ YouTube интеграция загружена из БД');
        }

        const vkplay = await loadIntegration('vkplay');
        if (vkplay && vkplay.access_token) {
            vkplayIntegration = {
                connected: true,
                channel: vkplay.channel_name,
                liveTitle: vkplay.live_title,
                chatEnabled: !!vkplay.chat_enabled,
                viewers: vkplay.viewers_count || 0,
                likes: vkplay.likes_count || 0,
                tokens: {
                    access_token: vkplay.access_token,
                    refresh_token: vkplay.refresh_token
                },
                expires_at: vkplay.expires_at || 0,
                channelUrl: vkplay.channel_url
            };
            console.log('✅ VK Play интеграция загружена из БД:', {
                channel: vkplayIntegration.channel,
                channelUrl: vkplayIntegration.channelUrl,
                liveTitle: vkplayIntegration.liveTitle,
                connected: vkplayIntegration.connected
            });
            
            // Если channelUrl отсутствует, обновляем данные
            if (!vkplayIntegration.channelUrl && vkplayIntegration.tokens?.access_token && VKPLAY_POLLING_ENABLED) {
                console.log('🔄 channelUrl отсутствует, обновляем данные через API...');
                setTimeout(() => {
                    updateVKPlayData();
                }, 2000);
            }
        }

        // VK Play Bot
        const vkplayBot = await loadIntegration('vkplay_bot');
        if (vkplayBot && vkplayBot.access_token) {
            vkplayBotIntegration = {
                connected: true,
                channel: vkplayBot.channel_name,
                channelUrl: vkplayBot.channel_url,
                tokens: {
                    access_token: vkplayBot.access_token,
                    refresh_token: vkplayBot.refresh_token
                },
                expires_at: vkplayBot.expires_at || 0,
                userId: vkplayBot.user_id || null,
                userNick: vkplayBot.user_nick || null
            };
            console.log('✅ VK Play Bot интеграция загружена из БД:', {
                userNick: vkplayBotIntegration.userNick,
                userId: vkplayBotIntegration.userId,
                channelUrl: vkplayBotIntegration.channelUrl,
                connected: vkplayBotIntegration.connected
            });
        }
    } catch (error) {
        console.warn('⚠️ Ошибка загрузки интеграций:', error.message);
    }
}

// Status endpoints
app.get('/integrations/youtube/status', async (req, res) => {
    // Если YouTube подключен, но videoId еще не выбран — пробуем мягко автопривязать активный эфир
    try {
        if (youtubeIntegration.connected && youtubeIntegration.tokens && !youtubeIntegration.videoId) {
            const now = Date.now();
            const detectCooldownMs = 60 * 1000; // не чаще 1 раза в минуту
            if (!youtubeIntegration.lastLiveDetectTime || now - youtubeIntegration.lastLiveDetectTime >= detectCooldownMs) {
                const detected = await detectActiveYouTubeLive(youtubeIntegration.tokens, { allowSearchFallback: false });
                youtubeIntegration.lastLiveDetectTime = now;
                if (detected.videoId) {
                    youtubeIntegration.videoId = detected.videoId;
                    if (detected.snippet?.title) youtubeIntegration.liveTitle = detected.snippet.title;
                    if (!youtubeIntegration.channel && detected.snippet?.channelTitle) {
                        youtubeIntegration.channel = detected.snippet.channelTitle;
                    }
                    await saveIntegration('youtube', {
                        tokens: youtubeIntegration.tokens,
                        channel: youtubeIntegration.channel,
                        liveTitle: youtubeIntegration.liveTitle,
                        viewers: youtubeIntegration.viewers,
                        likes: youtubeIntegration.likes,
                        chatEnabled: youtubeIntegration.chatEnabled,
                        pollIntervalSec: youtubeIntegration.pollIntervalSec || 60
                    });
                }
            }
        }
    } catch (e) {
        console.warn('⚠️ YouTube status: ошибка автопривязки live:', e?.response?.data || e.message);
    }
    res.json(youtubeIntegration);
});

app.get('/integrations/vkplay/status', async (req, res) => {
    // Если channelUrl отсутствует, но есть токен - обновляем данные
    if (!vkplayIntegration.channelUrl && vkplayIntegration.connected && vkplayIntegration.tokens?.access_token) {
        console.log('🔄 channelUrl отсутствует, обновляем данные VK Play...');
        
        // Сначала пробуем загрузить из БД
        try {
            const vkplay = await loadIntegration('vkplay');
            if (vkplay && vkplay.channel_url) {
                vkplayIntegration.channelUrl = vkplay.channel_url;
                if (!vkplayIntegration.channel) vkplayIntegration.channel = vkplay.channel_name;
                if (!vkplayIntegration.liveTitle) vkplayIntegration.liveTitle = vkplay.live_title;
                console.log('✅ Данные загружены из БД:', { channelUrl: vkplayIntegration.channelUrl });
            }
        } catch (e) {
            console.warn('⚠️ Ошибка загрузки VK Play из БД:', e.message);
        }
        
        // Если все еще нет channelUrl, запрашиваем через API
        if (!vkplayIntegration.channelUrl && vkplayIntegration.tokens?.access_token) {
            try {
                console.log('📡 Запрашиваем данные пользователя через API...');
                // Пробуем оба варианта URL (api и apidev)
                let currentUser;
                try {
                    currentUser = await axios.get('https://api.live.vkvideo.ru/v1/current_user', {
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } catch (apiError) {
                    if (apiError?.response?.status === 404) {
                        console.log('⚠️ api.live.vkvideo.ru вернул 404, пробуем apidev.live.vkvideo.ru...');
                        currentUser = await axios.get('https://apidev.live.vkvideo.ru/v1/current_user', {
                            headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                        });
                    } else {
                        throw apiError;
                    }
                }
                
                const data = currentUser.data?.data;
                if (data && data.channel?.url) {
                    vkplayIntegration.channelUrl = data.channel.url;
                    console.log('✅ channelUrl получен из API:', vkplayIntegration.channelUrl);
                    
                    // Получаем данные канала
                    try {
                        let channelData;
                        try {
                            channelData = await axios.get('https://api.live.vkvideo.ru/v1/channel', {
                                params: { channel_url: vkplayIntegration.channelUrl },
                                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                            });
                        } catch (apiError) {
                            if (apiError?.response?.status === 404) {
                                console.log('⚠️ api.live.vkvideo.ru вернул 404 для channel, пробуем apidev...');
                                channelData = await axios.get('https://apidev.live.vkvideo.ru/v1/channel', {
                                    params: { channel_url: vkplayIntegration.channelUrl },
                                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                                });
                            } else {
                                throw apiError;
                            }
                        }
                        
                        const channelInfo = channelData.data?.data;
                        if (channelInfo) {
                            vkplayIntegration.channel = channelInfo.channel?.nick || vkplayIntegration.channelUrl;
                            vkplayIntegration.liveTitle = channelInfo.stream?.title || 'Нет активного стрима';
                            vkplayIntegration.viewers = getVKPlayViewersFromChannelInfo(channelInfo);
                            // Берем лайки из counters с учетом разных возможных полей
                            vkplayIntegration.likes = getVKPlayLikesFromChannelInfo(channelInfo, vkplayIntegration.likes);
                            vkplayIntegration.chatEnabled = !!channelInfo.channel?.web_socket_channels?.chat;
                            
                            // Сохраняем в БД
                            await saveIntegration('vkplay', {
                                tokens: vkplayIntegration.tokens,
                                expires_at: vkplayIntegration.expires_at,
                                channel: vkplayIntegration.channel,
                                channelUrl: vkplayIntegration.channelUrl,
                                liveTitle: vkplayIntegration.liveTitle,
                                viewers: vkplayIntegration.viewers,
                                likes: vkplayIntegration.likes,
                                chatEnabled: vkplayIntegration.chatEnabled
                            });
                            
                            console.log('✅ Данные канала обновлены:', {
                                channel: vkplayIntegration.channel,
                                liveTitle: vkplayIntegration.liveTitle
                            });
                        }
                    } catch (channelError) {
                        console.warn('⚠️ Ошибка получения данных канала:', channelError?.response?.data || channelError.message);
                    }
                }
            } catch (e) {
                console.error('❌ Ошибка получения данных пользователя:', e?.response?.data || e.message);
            }
        }
    }
    
  res.json(vkplayIntegration);
});

app.get('/integrations/rutony/status', (req, res) => {
    res.json({ connected: rutonyIntegration.connected, lastError: rutonyIntegration.lastError });
});

// API для получения чата
app.get('/api/chat/messages', (req, res) => {
    const { platform = 'vkplay', limit = 50 } = req.query;
    
    db.all(`SELECT * FROM chat_messages 
            WHERE platform = ? 
            ORDER BY created_at DESC 
            LIMIT ?`, [platform, limit], (err, rows) => {
        if (err) {
            console.error('Ошибка получения чата:', err);
            return res.status(500).json({ error: 'Ошибка получения чата' });
        }
        res.json({ messages: rows });
    });
});

// Статистика активности в чате
app.get('/api/chat/stats', (req, res) => {
    const { platform = 'all', period = 'all' } = req.query;

    const whereParts = [
        'username IS NOT NULL',
        'username != ""',
        "username != 'Gray_Body'" // исключаем технического/шумового пользователя
    ];
    const params = [];

    if (platform && platform !== 'all') {
        whereParts.push('platform = ?');
        params.push(platform);
    }

    if (period === 'week') {
        whereParts.push('created_at >= datetime("now", "-7 days")');
    } else if (period === 'month') {
        whereParts.push('created_at >= datetime("now", "-30 days")');
    }

    const where = whereParts.join(' AND ');

    // Для общей статистики агрегируем по username без разделения по платформам
    const sql = platform === 'all'
        ? `
            SELECT 
                'all' AS platform,
                username,
                COUNT(*) AS messages_count,
                MIN(created_at) AS first_message_at,
                MAX(created_at) AS last_message_at
            FROM chat_messages
            WHERE ${where}
            GROUP BY username
            ORDER BY messages_count DESC, last_message_at DESC
        `
        : `
            SELECT 
                platform,
                username,
                COUNT(*) AS messages_count,
                MIN(created_at) AS first_message_at,
                MAX(created_at) AS last_message_at
            FROM chat_messages
            WHERE ${where}
            GROUP BY username
            ORDER BY messages_count DESC, last_message_at DESC
        `;

    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error('Ошибка получения статистики чата:', err);
            return res.status(500).json({ error: 'Ошибка получения статистики чата' });
        }
        res.json({ stats: rows });
    });
});

// Ручной выбор текущего стрима YouTube по videoId/URL
app.post('/integrations/youtube/video-id', express.json(), (req, res) => {
    try {
        const raw = req.body?.videoId || req.body?.videoUrl || req.query.videoId || req.query.videoUrl;
        if (!raw || typeof raw !== 'string') {
            return res.status(400).json({ error: 'videoId or videoUrl is required' });
        }

        const input = raw.trim();
        let id = input;

        // Если это полная ссылка на YouTube — вытаскиваем videoId
        try {
            if (/^https?:\/\//i.test(input)) {
                const u = new URL(input);
                if (u.hostname.includes('youtube.com')) {
                    if (u.pathname === '/watch') {
                        id = u.searchParams.get('v') || '';
                    } else if (u.pathname.startsWith('/live/')) {
                        id = u.pathname.split('/live/')[1] || '';
                    } else if (u.pathname.startsWith('/shorts/')) {
                        id = u.pathname.split('/shorts/')[1] || '';
                    }
                } else if (u.hostname === 'youtu.be') {
                    id = u.pathname.replace('/', '') || '';
                }
            }
        } catch (_) {}

        // Чистим videoId
        id = (id || '').trim();
        if (!id) {
            return res.status(400).json({ error: 'Не удалось определить videoId из ссылки' });
        }

        youtubeIntegration.videoId = id;
        console.log('✅ Ручной выбор стрима YouTube, videoId =', id);
        res.json({ ok: true, videoId: id });
    } catch (e) {
        console.error('Ошибка установки YouTube videoId:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Настройка интервала опроса YouTube (в секундах)
app.post('/integrations/youtube/poll-interval', express.json(), async (req, res) => {
    if (!youtubeIntegration.connected || !youtubeIntegration.tokens) {
        return res.status(401).json({ error: 'YouTube не подключен' });
    }

    const raw = req.body?.intervalSec ?? req.query.intervalSec;
    const val = parseInt(raw, 10);
    if (!Number.isFinite(val) || val <= 0) {
        return res.status(400).json({ error: 'intervalSec must be a positive integer' });
    }

    // Ограничиваем разумный диапазон, чтобы не сжечь квоту моментально
    const clamped = Math.max(30, Math.min(val, 300)); // от 30 сек до 5 минут
    youtubeIntegration.pollIntervalSec = clamped;
    youtubeIntegration.lastPollTime = 0; // чтобы сразу сделать следующий опрос по новому интервалу

    try {
        await saveIntegration('youtube', {
            tokens: youtubeIntegration.tokens,
            channel: youtubeIntegration.channel,
            liveTitle: youtubeIntegration.liveTitle,
            viewers: youtubeIntegration.viewers,
            likes: youtubeIntegration.likes,
            chatEnabled: youtubeIntegration.chatEnabled,
            pollIntervalSec: youtubeIntegration.pollIntervalSec
        });
        res.json({ ok: true, pollIntervalSec: youtubeIntegration.pollIntervalSec });
    } catch (e) {
        console.warn('⚠️ Ошибка сохранения pollIntervalSec для YouTube:', e.message);
        res.status(500).json({ error: 'Ошибка сохранения настроек интервала' });
    }
});

// Поиск активного live-стрима YouTube.
// Используем совместимый запрос liveBroadcasts(mine=true) без broadcastStatus
// и фильтруем по lifeCycleStatus на нашей стороне.
async function detectActiveYouTubeLive(tokens, { allowSearchFallback = false } = {}) {
    let videoId = null;
    let snippet = null;
    let source = null;

    try {
        const live = await axios.get('https://www.googleapis.com/youtube/v3/liveBroadcasts', {
            params: {
                part: 'id,snippet,status',
                broadcastType: 'all',
                mine: true,
                maxResults: 50
            },
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });

        const items = (live.data?.items || []).filter(i => i?.id);
        const liveLike = items.filter(i => {
            const lc = String(i?.status?.lifeCycleStatus || '').toLowerCase();
            return lc === 'live' || lc === 'livestarting' || lc === 'testing';
        });
        const pool = liveLike.length ? liveLike : items;

        if (pool.length) {
            const selected = pool
                .slice()
                .sort((a, b) => {
                    const aTs = Date.parse(a?.snippet?.actualStartTime || a?.snippet?.scheduledStartTime || 0) || 0;
                    const bTs = Date.parse(b?.snippet?.actualStartTime || b?.snippet?.scheduledStartTime || 0) || 0;
                    return bTs - aTs;
                })[0];
            videoId = selected.id;
            snippet = selected.snippet || null;
            source = liveLike.length ? 'liveBroadcasts.mine.liveLike' : 'liveBroadcasts.mine.latest';
        }
    } catch (e) {
        console.warn('⚠️ YouTube detect: liveBroadcasts(mine) не сработал:', e?.response?.data || e.message);
    }

    // Fallback по search включаем только вручную (дороже по квоте).
    if (!videoId && allowSearchFallback) {
        try {
            const searchMine = await axios.get('https://www.googleapis.com/youtube/v3/search', {
                params: {
                    part: 'snippet',
                    type: 'video',
                    eventType: 'live',
                    forMine: true,
                    maxResults: 1,
                    order: 'date'
                },
                headers: { Authorization: `Bearer ${tokens.access_token}` }
            });
            const sItem = (searchMine.data?.items || [])[0];
            if (sItem?.id?.videoId) {
                videoId = sItem.id.videoId;
                snippet = sItem.snippet || null;
                source = 'search.forMine';
            }
        } catch (searchErr) {
            console.warn('⚠️ YouTube detect: search(forMine) не сработал:', searchErr?.response?.data || searchErr.message);
        }
    }

    return { videoId, snippet, source };
}

// Поиск текущего live-стрима YouTube по API (однократно по кнопке)
app.post('/integrations/youtube/find-live', async (req, res) => {
    if (!youtubeIntegration.connected || !youtubeIntegration.tokens) {
        return res.status(401).json({ error: 'YouTube не подключен' });
    }

    try {
        let videoId = null;
        let snippet = null;
        let liveDetails = null;
        let stats = null;
        const detected = await detectActiveYouTubeLive(youtubeIntegration.tokens, { allowSearchFallback: true });
        videoId = detected.videoId;
        snippet = detected.snippet;

        if (!videoId) {
            return res.status(404).json({ error: 'Активный live-стрим не найден. Убедитесь, что эфир запущен на YouTube.' });
        }

        // Получаем статистику, liveStreamingDetails и snippet по найденному видео
        try {
            const videoResp = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
                params: {
                    part: 'snippet,statistics,liveStreamingDetails',
                    id: videoId
                },
                headers: { Authorization: `Bearer ${youtubeIntegration.tokens.access_token}` }
            });
            const vItems = videoResp.data.items || [];
            const v = vItems[0];
            if (v) {
                snippet = snippet || v.snippet || null;
                stats = v.statistics || {};
                liveDetails = v.liveStreamingDetails || {};
            } else {
                console.warn('⚠️ YouTube find-live: videos.list не вернул данных для videoId =', videoId);
            }
        } catch (videoErr) {
            console.warn('⚠️ YouTube find-live: ошибка получения videos.snippet/statistics/liveStreamingDetails:', videoErr?.response?.data || videoErr.message);
        }

        // Обновляем интеграцию
        youtubeIntegration.videoId = videoId;
        if (snippet) {
            youtubeIntegration.liveTitle = snippet.title || youtubeIntegration.liveTitle || null;
            if (!youtubeIntegration.channel && snippet.channelTitle) {
                youtubeIntegration.channel = snippet.channelTitle;
            }
        }

        const chatId = liveDetails && liveDetails.activeLiveChatId ? liveDetails.activeLiveChatId : youtubeIntegration.liveChatId || null;
        youtubeIntegration.liveChatId = chatId;
        youtubeIntegration.chatEnabled = !!chatId;

        if (stats || liveDetails) {
            const likes = stats && stats.likeCount != null ? parseInt(stats.likeCount, 10) || 0 : (youtubeIntegration.likes || 0);
            const viewers = liveDetails && liveDetails.concurrentViewers != null
                ? parseInt(liveDetails.concurrentViewers, 10) || 0
                : (youtubeIntegration.viewers || 0);

            youtubeIntegration.likes = likes;
            youtubeIntegration.viewers = viewers;
        }

        await saveIntegration('youtube', {
            tokens: youtubeIntegration.tokens,
            channel: youtubeIntegration.channel,
            liveTitle: youtubeIntegration.liveTitle,
            viewers: youtubeIntegration.viewers,
            likes: youtubeIntegration.likes,
            chatEnabled: youtubeIntegration.chatEnabled
        });

        res.json({
            ok: true,
            source: detected.source || null,
            videoId,
            liveTitle: youtubeIntegration.liveTitle,
            channel: youtubeIntegration.channel,
            viewers: youtubeIntegration.viewers,
            likes: youtubeIntegration.likes,
            chatEnabled: youtubeIntegration.chatEnabled
        });
    } catch (e) {
        const status = e?.response?.status;
        if (status === 401) {
            console.warn('⚠️ YouTube find-live: токен истек или невалиден. Требуется повторная авторизация.');
            youtubeIntegration.connected = false;
            await saveIntegration('youtube', {
                tokens: youtubeIntegration.tokens,
                channel: youtubeIntegration.channel,
                liveTitle: youtubeIntegration.liveTitle,
                viewers: youtubeIntegration.viewers,
                likes: youtubeIntegration.likes,
                chatEnabled: false
            });
            return res.status(401).json({ error: 'Требуется повторная авторизация YouTube.' });
        }
        if (status === 403) {
            console.warn('⚠️ YouTube find-live: доступ запрещен. Проверьте права доступа приложения или квоту API.');
            return res.status(403).json({ error: 'Доступ к YouTube API запрещён (403).' });
        }

        console.warn('⚠️ YouTube find-live: общая ошибка:', e?.response?.data || e.message);
        res.status(500).json({ error: 'Ошибка поиска live-стрима YouTube' });
    }
});

// OAuth start stubs
app.get('/oauth/youtube/start', (req, res) => {
    const clientId = process.env.YT_CLIENT_ID;
    const redirectUri = process.env.YT_REDIRECT_URI || `http://localhost:${port}/oauth/youtube/callback`;
    if (!clientId) {
        return res.status(500).send('YouTube OAuth is not configured (YT_CLIENT_ID missing).');
    }
    const scope = [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/youtube.force-ssl'
    ].join(' ');
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + querystring.stringify({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        access_type: 'offline',
        include_granted_scopes: 'true',
        prompt: 'consent',
        scope
    });
    res.redirect(authUrl);
});

app.get('/oauth/youtube/callback', async (req, res) => {
    try {
        const code = req.query.code;
        if (!code) return res.status(400).send('Missing code');
        const clientId = process.env.YT_CLIENT_ID;
        const clientSecret = process.env.YT_CLIENT_SECRET;
        const redirectUri = process.env.YT_REDIRECT_URI || `http://localhost:${port}/oauth/youtube/callback`;
        if (!clientId || !clientSecret) {
            return res.status(500).send('YouTube OAuth is not configured (client id/secret).');
        }
        // Exchange code for token
        const tokenRes = await axios.post('https://oauth2.googleapis.com/token', querystring.stringify({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const tokens = tokenRes.data; // access_token, refresh_token, expires_in
        youtubeIntegration.connected = true;
        youtubeIntegration.tokens = tokens;

        // Fetch channel basic info
        try {
            const me = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
                params: { part: 'snippet,statistics', mine: true },
                headers: { Authorization: `Bearer ${tokens.access_token}` }
            });
            const item = me.data.items && me.data.items[0];
            if (item) {
                youtubeIntegration.channel = item.snippet.title;
            }
        } catch (e) {
            console.warn('YouTube channel fetch failed:', e?.response?.data || e.message);
        }

        // Try to get current live broadcast (title, liveChatId)
        try {
            const detected = await detectActiveYouTubeLive(tokens, { allowSearchFallback: false });
            if (detected.videoId) {
                youtubeIntegration.videoId = detected.videoId;
                youtubeIntegration.liveTitle = detected.snippet?.title || youtubeIntegration.liveTitle || null;
            } else {
                youtubeIntegration.liveTitle = youtubeIntegration.liveTitle || 'Нет активного стрима';
                youtubeIntegration.chatEnabled = false;
                youtubeIntegration.liveChatId = null;
            }
        } catch (e) {
            console.warn('YouTube liveBroadcasts fetch failed:', e?.response?.data || e.message);
        }

        // Save in DB
        try {
            await saveIntegration('youtube', {
                tokens: youtubeIntegration.tokens,
                channel: youtubeIntegration.channel,
                liveTitle: youtubeIntegration.liveTitle,
                viewers: youtubeIntegration.viewers,
                chatEnabled: youtubeIntegration.chatEnabled
            });
        } catch (e) {
            console.warn('⚠️ Не удалось сохранить интеграцию YouTube:', e.message);
        }

        // Redirect back to integrations page
        res.redirect('/stream-integrations.html');
    } catch (err) {
        console.error('YouTube OAuth callback error:', err?.response?.data || err.message);
        res.status(500).send('YouTube OAuth error');
    }
});

app.get('/oauth/vkplay/start', (req, res) => {
    const clientId = process.env.VKPLAY_CLIENT_ID;
    // ВАЖНО: redirect_uri должен ТОЧНО совпадать с тем, что указано в настройках приложения VK Play
    // Проверьте в настройках приложения: http://localhost:3000/oauth/vkplay/callback
    const redirectUri = process.env.VKPLAY_REDIRECT_URI || `http://localhost:${port}/oauth/vkplay/callback`;
    
    // Убираем возможные пробелы
    const cleanRedirectUri = redirectUri.trim();
    
    if (!clientId) return res.status(500).send('VK Play OAuth is not configured (VKPLAY_CLIENT_ID missing).');
    
    console.log('🔍 Проверка redirect_uri:');
    console.log('   Ожидается (из настроек приложения): http://localhost:3000/oauth/vkplay/callback');
    console.log('   Используется:', cleanRedirectUri);
    console.log('   Совпадает:', cleanRedirectUri === 'http://localhost:3000/oauth/vkplay/callback' ? '✅ ДА' : '❌ НЕТ');
    
    if (cleanRedirectUri !== 'http://localhost:3000/oauth/vkplay/callback') {
        console.error('⚠️ ВНИМАНИЕ: redirect_uri не совпадает с настройками приложения!');
        console.error('   Убедитесь, что в config.env указано:');
        console.error('   VKPLAY_REDIRECT_URI=http://localhost:3000/oauth/vkplay/callback');
        console.error('   Или что в настройках приложения VK Play указан правильный URL');
    }
    
    const state = Math.random().toString(36).slice(2);
    
    // Используем scope из рабочего примера TRULA-music + дополнительные для получения наград и ролей
    // https://auth.live.vkvideo.ru/app/oauth2/authorize?client_id=5d0wgtm144f3ojky&response_type=code&scope=channel:points:rewards,channel:points:rewards:demands,chat:message:send&redirect_uri=https://trula-music.ru/auth/vkpll/
    // Дополнительно добавляем:
    // - channel:points - для получения списка наград (GET /v1/channel_point/rewards требует channel:points)
    // - channel:roles - для получения списка ролей (GET /v1/channel_roles требует channel:roles)
    const scopes = [
        'channel:points',              // Получение списка наград (GET /v1/channel_point/rewards)
        'channel:points:rewards',       // Управление наградами за баллы канала
        'channel:points:rewards:demands', // Запросы наград за баллы канала
        'channel:roles',                // Управление ролями (GET /v1/channel_roles)
        'chat:message:send'           // Отправка сообщений в чат
    ].join(',');  // Через запятую, как указано в документации
    
    const params = {
        client_id: clientId,
        redirect_uri: cleanRedirectUri,  // Используем очищенный redirect_uri
        response_type: 'code',
        scope: scopes,  // Указываем scope согласно документации
        state
    };
    const authUrl = `https://auth.live.vkvideo.ru/app/oauth2/authorize?${querystring.stringify(params)}`;
    
    console.log('🔐 VK Play OAuth start →');
    console.log('   URL:', authUrl);
    console.log('   Параметры:', JSON.stringify(params, null, 2));
    console.log('   Запрашиваемые разрешения (scope):', params.scope);
    console.log('   - channel:points - Получение списка наград');
    console.log('   - channel:points:rewards - Управление наградами за баллы канала');
    console.log('   - channel:points:rewards:demands - Запросы наград за баллы канала');
    console.log('   - channel:roles - Управление ролями');
    console.log('   - chat:message:send - Отправка сообщений в чат');
    
    res.redirect(authUrl);
});

app.get('/oauth/vkplay/callback', async (req, res) => {
    try {
        const { code, state, error, error_description } = req.query;
        
        // Детальное логирование для отладки
        console.log('📥 VK Play OAuth callback получен:');
        console.log('   code:', code ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');
        console.log('   state:', state || 'ОТСУТСТВУЕТ');
        console.log('   error:', error || 'НЕТ');
        console.log('   error_description:', error_description || 'НЕТ');
        console.log('   Все query параметры:', JSON.stringify(req.query, null, 2));
        
        if (error) {
            console.error('❌ VK Play OAuth error:', error);
            console.error('   Описание:', error_description);
            console.error('   Все параметры:', req.query);
            
            // Если ошибка invalid_scope, это может означать:
            // 1. Приложение в VK Play настроено с неверными scope
            // 2. VK Play требует scope, но мы их не указали
            // 3. Названия scope неверны
            if (error === 'invalid_scope') {
                console.error('💡 Решение для invalid_scope:');
                console.error('   ⚠️  Ошибка invalid_scope возникает, даже когда scope не указаны в URL');
                console.error('   Это означает, что проблема в настройках приложения в VK Play');
                console.error('');
                console.error('   📋 Что нужно сделать:');
                console.error('   1. Откройте панель управления приложением VK Play');
                console.error('   2. Найдите раздел "Разрешения" или "Permissions" / "Scope"');
                console.error('   3. УДАЛИТЕ все указанные scope (оставьте пустым)');
                console.error('   4. Или убедитесь, что указаны только правильные scope:');
                console.error('      - channel:points');
                console.error('      - channel:points:rewards');
                console.error('      - channel:points:rewards:demands');
                console.error('      - channel:roles');
                console.error('      - channel:chat:write');
                console.error('   5. Сохраните настройки');
                console.error('   6. Попробуйте авторизоваться снова');
                console.error('');
                console.error('   🔄 Альтернативное решение:');
                console.error('   - Создайте новое приложение в VK Play');
                console.error('   - Не указывайте scope при создании приложения');
                console.error('   - Используйте новые client_id и client_secret');
            }
            
            return res.status(400).send(`VK Play OAuth error: ${error} ${error_description || ''}`);
        }
        if (!code) return res.status(400).send('Missing code');
        const clientId = process.env.VKPLAY_CLIENT_ID;
        const clientSecret = process.env.VKPLAY_CLIENT_SECRET;
        // ВАЖНО: redirect_uri должен ТОЧНО совпадать с тем, что указано в настройках приложения VK Play
        const redirectUri = process.env.VKPLAY_REDIRECT_URI || `http://localhost:${port}/oauth/vkplay/callback`;
        const cleanRedirectUri = redirectUri.trim();  // Убираем возможные пробелы
        
        if (!clientId || !clientSecret) return res.status(500).send('VK Play OAuth is not configured (client id/secret).');
        
        console.log('🔍 Проверка redirect_uri в callback:');
        console.log('   Ожидается (из настроек приложения): http://localhost:3000/oauth/vkplay/callback');
        console.log('   Используется:', cleanRedirectUri);
        console.log('   Совпадает:', cleanRedirectUri === 'http://localhost:3000/oauth/vkplay/callback' ? '✅ ДА' : '❌ НЕТ');
        
        if (cleanRedirectUri !== 'http://localhost:3000/oauth/vkplay/callback') {
            console.error('⚠️ ВНИМАНИЕ: redirect_uri не совпадает с настройками приложения!');
            console.error('   Это может быть причиной ошибки авторизации.');
        }

        // Проверяем правильность ключей
        console.log('🔍 Проверка ключей VK Play:');
        console.log('   Client ID:', clientId ? `${clientId.substring(0, 8)}...${clientId.substring(clientId.length - 4)}` : 'ОТСУТСТВУЕТ');
        console.log('   Client ID длина:', clientId?.length || 0);
        console.log('   Client Secret:', clientSecret ? `${clientSecret.substring(0, 8)}...${clientSecret.substring(clientSecret.length - 4)}` : 'ОТСУТСТВУЕТ');
        console.log('   Client Secret длина:', clientSecret?.length || 0);
        console.log('   Redirect URI:', cleanRedirectUri);
        console.log('   Code:', code ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');
        
        // ВАЖНО: Используем СЕКРЕТНЫЙ ключ приложения, НЕ публичный!
        // Публичный ключ приложения НЕ используется в OAuth CodeFlow
        if (!clientId || !clientSecret) {
            console.error('❌ Ошибка: Client ID или Client Secret отсутствуют');
            return res.status(500).send('VK Play OAuth is not configured (client id/secret).');
        }
        
        // Проверяем правильность Client Secret по первым символам
        const EXPECTED_CLIENT_ID = 'fw5rnkh3nd335l2l';
        const EXPECTED_CLIENT_SECRET_START = 'Ehw6AYlh'; // Первые 8 символов правильного секретного ключа
        const EXPECTED_CLIENT_SECRET_END = 'QokR'; // Последние 4 символа правильного секретного ключа
        
        if (clientId !== EXPECTED_CLIENT_ID) {
            console.error('❌ ОШИБКА: Client ID не совпадает с ожидаемым!');
            console.error('   Ожидается:', EXPECTED_CLIENT_ID);
            console.error('   Получено:', clientId);
        }
        
        if (clientSecret && clientSecret.length === 64) {
            const secretStart = clientSecret.substring(0, 8);
            const secretEnd = clientSecret.substring(clientSecret.length - 5);
            
            if (secretStart !== EXPECTED_CLIENT_SECRET_START || secretEnd !== EXPECTED_CLIENT_SECRET_END) {
                console.error('❌ ОШИБКА: Client Secret не совпадает с ожидаемым!');
                console.error('   Ожидается начало:', EXPECTED_CLIENT_SECRET_START);
                console.error('   Получено начало:', secretStart);
                console.error('   Ожидается конец:', EXPECTED_CLIENT_SECRET_END);
                console.error('   Получено конец:', secretEnd);
                console.error('');
                console.error('💡 Проверьте файл config.env:');
                console.error('   VKPLAY_CLIENT_SECRET должен быть: Ehw6AYlhTL2MocgL4kdvdc7Aus94sO4l9vozahaFl9CHktYm3M9Vv67f6Qo7QokR');
                console.error('   НЕ используйте публичный ключ приложения!');
            } else {
                console.log('✅ Client Secret проверен: начало и конец совпадают');
            }
        } else {
            console.warn('⚠️ ВНИМАНИЕ: Client Secret имеет неожиданную длину. Ожидается 64 символа.');
        }
        
        // Убираем возможные пробелы и переносы строк из ключей
        const cleanClientId = clientId.trim();
        const cleanClientSecret = clientSecret.trim();
        
        const basic = Buffer.from(`${cleanClientId}:${cleanClientSecret}`).toString('base64');
        console.log('🔄 Обмен кода на токен...');
        console.log('   Basic Auth (первые 20 символов):', basic.substring(0, 20) + '...');
        console.log('   Client ID (очищенный):', cleanClientId);
        console.log('   Client Secret (первые 12 символов):', cleanClientSecret.substring(0, 12) + '...');
        
        // Пробуем оба варианта URL для обмена токена
        // VK Play API может требовать client_id и client_secret в теле запроса
        let tokenRes;
        try {
            // Согласно документации: обмен кода на токен
            // POST https://api.live.vkvideo.ru/oauth/server/token
            // Тело: grant_type=authorization_code&code=...&redirect_uri=...
            // Заголовок: Authorization: Basic <base64(client_id:secret)>
            // НЕ передаем client_id и client_secret в теле запроса!
            const tokenData = querystring.stringify({
                grant_type: 'authorization_code',
                code,
                redirect_uri: cleanRedirectUri
            });
            
            console.log('📤 Отправка запроса на обмен кода на токен...');
            console.log('   URL: https://api.live.vkvideo.ru/oauth/server/token');
            console.log('   Метод: POST');
            console.log('   Headers: Authorization: Basic <base64(client_id:secret)>');
            console.log('   Body: grant_type=authorization_code&code=...&redirect_uri=...');
            
            tokenRes = await axios.post(
                'https://api.live.vkvideo.ru/oauth/server/token',
                tokenData,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Basic ${basic}`
                    }
                }
            );
            console.log('✅ Токен получен от api.live.vkvideo.ru');
        } catch (tokenError) {
            console.error('❌ Ошибка обмена кода на токен (метод 1: Basic Auth + параметры в теле):');
            console.error('   Status:', tokenError?.response?.status);
            console.error('   Data:', JSON.stringify(tokenError?.response?.data, null, 2));
            console.error('   Message:', tokenError.message);
            
            // Проверяем, не ошибка ли это из-за неправильных ключей
            if (tokenError?.response?.status === 401 || tokenError?.response?.status === 403) {
                console.error('');
                console.error('💡 Возможные причины ошибки 401/403:');
                console.error('   1. Неправильный Client ID или Client Secret');
                console.error('   2. Использован публичный ключ вместо секретного');
                console.error('   3. Ключи перепутаны местами');
                console.error('   4. Ключи содержат лишние пробелы или символы');
                console.error('');
                console.error('📋 Проверьте в config.env:');
                console.error('   VKPLAY_CLIENT_ID=fw5rnkh3nd335l2l');
                console.error('   VKPLAY_CLIENT_SECRET=Ehw6AYlhTL2MocgL4kdvdc7Aus94sO4l9vozahaFl9CHktYm3M9Vv67f6Qo7QokR');
                console.error('   НЕ используйте публичный ключ приложения!');
                console.error('');
                console.log('🔄 Пробуем метод 2: только Basic Auth (без параметров в теле)...');
                
                // Метод 2: Только Basic Auth (без client_id и client_secret в теле)
                try {
                    tokenRes = await axios.post(
                        'https://api.live.vkvideo.ru/oauth/server/token',
                        querystring.stringify({
                            grant_type: 'authorization_code',
                            code,
                            redirect_uri: cleanRedirectUri  // Используем очищенный redirect_uri
                        }),
                        {
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Authorization': `Basic ${basic}`
                            }
                        }
                    );
                    console.log('✅ Токен получен методом 2 (только Basic Auth)');
                } catch (method2Error) {
                    console.error('❌ Метод 2 тоже не сработал:');
                    console.error('   Status:', method2Error?.response?.status);
                    console.error('   Data:', JSON.stringify(method2Error?.response?.data, null, 2));
                    
                    // Метод 3: Пробуем apidev
                    if (method2Error?.response?.status === 404 || tokenError?.response?.status === 404) {
                        console.log('⚠️ Пробуем apidev.live.vkvideo.ru...');
                        try {
                            tokenRes = await axios.post(
                                'https://apidev.live.vkvideo.ru/oauth/server/token',
                                querystring.stringify({
                                    grant_type: 'authorization_code',
                                    code,
                                    redirect_uri: cleanRedirectUri
                                }),
                                {
                                    headers: {
                                        'Content-Type': 'application/x-www-form-urlencoded',
                                        'Authorization': `Basic ${basic}`
                                    }
                                }
                            );
                            console.log('✅ Токен получен от apidev.live.vkvideo.ru');
                        } catch (apidevError) {
                            console.error('❌ apidev.live.vkvideo.ru тоже вернул ошибку:');
                            console.error('   Status:', apidevError?.response?.status);
                            console.error('   Data:', JSON.stringify(apidevError?.response?.data, null, 2));
                            throw apidevError;
                        }
                    } else {
                        throw method2Error;
                    }
                }
            } else if (tokenError?.response?.status === 404) {
                console.log('⚠️ api.live.vkvideo.ru вернул 404 для token, пробуем apidev...');
                try {
                    tokenRes = await axios.post(
                        'https://apidev.live.vkvideo.ru/oauth/server/token',
                        querystring.stringify({
                            grant_type: 'authorization_code',
                            code,
                            redirect_uri: cleanRedirectUri
                        }),
                        {
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Authorization': `Basic ${basic}`
                            }
                        }
                    );
                    console.log('✅ Токен получен от apidev.live.vkvideo.ru');
                } catch (apidevError) {
                    console.error('❌ apidev.live.vkvideo.ru тоже вернул ошибку:');
                    console.error('   Status:', apidevError?.response?.status);
                    console.error('   Data:', JSON.stringify(apidevError?.response?.data, null, 2));
                    throw apidevError;
                }
            } else {
                throw tokenError;
            }
        }

        const tokens = tokenRes.data; // access_token, refresh_token, expires_in, token_type
        console.log('✅ Токен получен:', {
            access_token: tokens.access_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ',
            refresh_token: tokens.refresh_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ',
            expires_in: tokens.expires_in,
            token_type: tokens.token_type
        });
        
        const nowSec = Math.floor(Date.now() / 1000);
        vkplayIntegration.connected = true;
        vkplayIntegration.tokens = tokens;
        vkplayIntegration.expires_at = nowSec + (tokens.expires_in || 0);

        // Получим текущего пользователя/канал для статуса
        try {
            console.log('📡 Запрос данных пользователя через API...');
            let me;
            try {
                me = await axios.get('https://api.live.vkvideo.ru/v1/current_user', {
                    headers: { Authorization: `Bearer ${tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    console.log('⚠️ api.live.vkvideo.ru вернул 404, пробуем apidev.live.vkvideo.ru...');
                    me = await axios.get('https://apidev.live.vkvideo.ru/v1/current_user', {
                        headers: { Authorization: `Bearer ${tokens.access_token}` }
                    });
                } else {
                    throw apiError;
                }
            }
            
            const data = me.data && me.data.data;
            console.log('👤 Данные пользователя получены:', {
                hasData: !!data,
                channelUrl: data?.channel?.url,
                channelsCount: data?.channels?.length || 0
            });
            
            if (data) {
                const channelUrl = data.channel?.url || (data.channels && data.channels[0]?.url) || null;
                vkplayIntegration.channelUrl = channelUrl;
                console.log('✅ channelUrl установлен:', channelUrl);
                
                // Получим данные канала и активного стрима
                if (channelUrl) {
                    try {
                        console.log('📺 Запрос данных канала...');
                        let channelData;
                        try {
                            channelData = await axios.get('https://api.live.vkvideo.ru/v1/channel', {
                                params: { channel_url: channelUrl },
                                headers: { Authorization: `Bearer ${tokens.access_token}` }
                            });
                        } catch (apiError) {
                            if (apiError?.response?.status === 404) {
                                console.log('⚠️ api.live.vkvideo.ru вернул 404 для channel, пробуем apidev...');
                                channelData = await axios.get('https://apidev.live.vkvideo.ru/v1/channel', {
                                    params: { channel_url: channelUrl },
                                    headers: { Authorization: `Bearer ${tokens.access_token}` }
                                });
                            } else {
                                throw apiError;
                            }
                        }
                        
                        const channelInfo = channelData.data?.data;
                        if (channelInfo) {
                            vkplayIntegration.channel = channelInfo.channel?.nick || channelUrl;
                            vkplayIntegration.liveTitle = channelInfo.stream?.title || 'Нет активного стрима';
                            vkplayIntegration.viewers = getVKPlayViewersFromChannelInfo(channelInfo);
                            vkplayIntegration.likes = getVKPlayLikesFromChannelInfo(channelInfo, vkplayIntegration.likes);
                            vkplayIntegration.chatEnabled = !!channelInfo.channel?.web_socket_channels?.chat;
                            
                            console.log('✅ Данные канала получены:', {
                                channel: vkplayIntegration.channel,
                                liveTitle: vkplayIntegration.liveTitle,
                                viewers: vkplayIntegration.viewers,
                                likes: vkplayIntegration.likes,
                                chatEnabled: vkplayIntegration.chatEnabled
                            });
                            
                            // Сохраняем в БД
                            await saveIntegration('vkplay', {
                                tokens: tokens,
                                expires_at: vkplayIntegration.expires_at,
                                channel: vkplayIntegration.channel,
                                channelUrl: channelUrl,
                                liveTitle: vkplayIntegration.liveTitle,
                                viewers: vkplayIntegration.viewers,
                                likes: vkplayIntegration.likes,
                                chatEnabled: vkplayIntegration.chatEnabled
                            });
                            
                            console.log(`✅ VK Play авторизация завершена: ${vkplayIntegration.channel} | ${vkplayIntegration.liveTitle}`);
                            console.log(`✅ channelUrl сохранен в БД: ${channelUrl}`);
                        } else {
                            console.warn('⚠️ Данные канала не получены из ответа');
                        }
                    } catch (channelError) {
                        console.error('❌ Ошибка получения данных канала:');
                        console.error('   Status:', channelError?.response?.status);
                        console.error('   Data:', JSON.stringify(channelError?.response?.data, null, 2));
                        console.error('   Message:', channelError.message);
                    }
                } else {
                    console.warn('⚠️ channelUrl не найден в данных пользователя');
                    // Сохраняем хотя бы токены, даже если channelUrl не получен
                    await saveIntegration('vkplay', {
                        tokens: tokens,
                        expires_at: vkplayIntegration.expires_at,
                        channel: null,
                        channelUrl: null,
                        liveTitle: null,
                        viewers: 0,
                        chatEnabled: false
                    });
                    console.log('✅ Токены VK Play сохранены в БД (без channelUrl)');
                }
            } else {
                console.warn('⚠️ Данные пользователя не получены из ответа');
                // Сохраняем хотя бы токены
                await saveIntegration('vkplay', {
                    tokens: tokens,
                    expires_at: vkplayIntegration.expires_at,
                    channel: null,
                    channelUrl: null,
                    liveTitle: null,
                    viewers: 0,
                    chatEnabled: false
                });
                console.log('✅ Токены VK Play сохранены в БД (без данных пользователя)');
            }
        } catch (e) {
            console.error('❌ Ошибка получения данных пользователя:');
            console.error('   Status:', e?.response?.status);
            console.error('   Data:', JSON.stringify(e?.response?.data, null, 2));
            console.error('   Message:', e.message);
            // Сохраняем хотя бы токены, даже если произошла ошибка
            try {
                await saveIntegration('vkplay', {
                    tokens: tokens,
                    expires_at: vkplayIntegration.expires_at,
                    channel: null,
                    channelUrl: null,
                    liveTitle: null,
                    viewers: 0,
                    chatEnabled: false
                });
                console.log('✅ Токены VK Play сохранены в БД (после ошибки)');
            } catch (saveError) {
                console.error('❌ Ошибка сохранения токенов:', saveError);
            }
        }

        res.redirect('/stream-integrations.html');
    } catch (err) {
        console.error('VK Play OAuth callback error:', err?.response?.data || err.message);
        res.status(500).send('VK Play OAuth error');
    }
});

// Implicit Flow (клиентский) — альтернативный упрощенный вариант
app.get('/oauth/vkplay/start-implicit', (req, res) => {
    const clientId = process.env.VKPLAY_CLIENT_ID;
    const redirectUri = (process.env.HTTPS_ENABLED === 'true')
        ? (process.env.VKPLAY_REDIRECT_URI || `https://localhost:${process.env.HTTPS_PORT || 3443}/oauth-vkplay-implicit.html`)
        : `http://localhost:${port}/oauth-vkplay-implicit.html`;
    if (!clientId) return res.status(500).send('VK Play OAuth is not configured (VKPLAY_CLIENT_ID missing).');
    const state = Math.random().toString(36).slice(2);
    
    // Используем те же scope, что и в CodeFlow
    const scopes = [
        'channel:points',
        'channel:points:rewards',
        'channel:points:rewards:demands',
        'channel:roles',
        'chat:message:send'
    ].join(',');
    
    const params = {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'token',
        scope: scopes,
        state
    };
    
    const authUrl = `https://auth.live.vkvideo.ru/app/oauth2/authorize?${querystring.stringify(params)}`;
    console.log('🔐 VK Play OAuth start (implicit) →', authUrl);
    console.log('📋 Параметры авторизации:', params);
    console.log('💡 Запрашиваемые разрешения (scope):', params.scope);
    res.redirect(authUrl);
});

app.post('/oauth/vkplay/implicit', express.json(), async (req, res) => {
    try {
        const { access_token, token_type, expire_time } = req.body || {};
        if (!access_token) return res.status(400).json({ error: 'missing access_token' });
        vkplayIntegration.connected = true;
        vkplayIntegration.tokens = { access_token, token_type, expire_time };
        // Получим current_user для статуса
        try {
            const me = await axios.get('https://api.live.vkvideo.ru/v1/current_user', {
                headers: { Authorization: `Bearer ${access_token}` }
            });
            const data = me.data && me.data.data;
            if (data) {
                const channelUrl = data.channel?.url || (data.channels && data.channels[0]?.url) || null;
                vkplayIntegration.channel = channelUrl;
            }
        } catch (e) {
            console.warn('VK Play current_user (implicit) failed:', e?.response?.data || e.message);
        }
        res.json({ ok: true });
    } catch (e) {
        console.error('VK Play implicit store error:', e.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

// Отладка параметров VK Play OAuth
app.get('/oauth/vkplay/debug', (req, res) => {
    res.json({
        env: {
            VKPLAY_CLIENT_ID: !!process.env.VKPLAY_CLIENT_ID,
            VKPLAY_REDIRECT_URI: process.env.VKPLAY_REDIRECT_URI,
            HTTPS_ENABLED: process.env.HTTPS_ENABLED,
            HTTPS_PORT: process.env.HTTPS_PORT
        }
    });
});

// Logout stubs
app.post('/oauth/youtube/logout', (req, res) => {
    youtubeIntegration = { connected: false, channel: null, liveTitle: null, chatEnabled: false, viewers: 0, likes: 0, tokens: null, liveChatId: null, nextPageToken: null, videoId: null, pollIntervalSec: 60, lastPollTime: 0, lastLiveDetectTime: 0 };
    res.json({ ok: true });
});

app.post('/oauth/vkplay/logout', (req, res) => {
    vkplayIntegration = { connected: false, channel: null, liveTitle: null, chatEnabled: false, viewers: 0, tokens: null, expires_at: 0, channelUrl: null };
    res.json({ ok: true });
});

// ===================================
// VK Play Bot OAuth (отдельный аккаунт для чат-бота)
// ===================================

// Старт авторизации бота
app.get('/oauth/vkplay-bot/start', (req, res) => {
    const clientId = process.env.VKPLAY_BOT_CLIENT_ID;
    // ВАЖНО: redirect_uri должен ТОЧНО совпадать с тем, что указано в настройках приложения VK Play
    // Проверьте в настройках приложения: http://localhost:3000/oauth/vkplay-bot/callback
    const redirectUri = process.env.VKPLAY_BOT_REDIRECT_URI || `http://localhost:${port}/oauth/vkplay-bot/callback`;
    
    // Убираем возможные пробелы
    const cleanRedirectUri = redirectUri.trim();
    
    if (!clientId) {
        return res.status(500).send('VK Play Bot OAuth is not configured (VKPLAY_BOT_CLIENT_ID missing).');
    }
    
    // Проверяем правильность client_id
    const EXPECTED_BOT_CLIENT_ID = 'umv46nrqcxbvzxhz';
    if (clientId.trim() !== EXPECTED_BOT_CLIENT_ID) {
        console.error('❌ ОШИБКА: Client ID бота не совпадает!');
        console.error('   Ожидается:', EXPECTED_BOT_CLIENT_ID);
        console.error('   Получено:', clientId.trim());
        console.error('   Проверьте файл config.env');
    }
    
    console.log('🔍 Проверка параметров авторизации бота:');
    console.log('   Client ID:', clientId.trim() === EXPECTED_BOT_CLIENT_ID ? '✅ Правильный' : '❌ Неправильный');
    console.log('   Redirect URI (ожидается): http://localhost:3000/oauth/vkplay-bot/callback');
    console.log('   Redirect URI (используется):', cleanRedirectUri);
    console.log('   Совпадает:', cleanRedirectUri === 'http://localhost:3000/oauth/vkplay-bot/callback' ? '✅ ДА' : '❌ НЕТ');
    
    if (cleanRedirectUri !== 'http://localhost:3000/oauth/vkplay-bot/callback') {
        console.error('⚠️ ВНИМАНИЕ: redirect_uri не совпадает с настройками приложения!');
        console.error('   Убедитесь, что в config.env указано:');
        console.error('   VKPLAY_BOT_REDIRECT_URI=http://localhost:3000/oauth/vkplay-bot/callback');
        console.error('   Или что в настройках приложения VK Play "Xasya Bot" указан правильный URL');
        console.error('   URL должен быть ТОЧНО: http://localhost:3000/oauth/vkplay-bot/callback');
        console.error('   (без пробелов, без слеша в конце, каждый URL на отдельной строке)');
    }
    
    const state = Math.random().toString(36).slice(2);
    
    // Используем тот же подход, что и в обычной авторизации VK Play
    // Scope указываем через запятую, как в рабочем примере
    const scopes = [
        'channel:points',
        'channel:points:rewards',
        'channel:points:rewards:demands',
        'channel:roles',
        'chat:message:send'
    ].join(',');
    
    const params = {
        client_id: clientId.trim(),  // Убираем пробелы из client_id
        redirect_uri: cleanRedirectUri,  // Используем очищенный redirect_uri
        response_type: 'code',
        scope: scopes,  // Указываем scope как в обычной авторизации
        state
    };
    
    const authUrl = `https://auth.live.vkvideo.ru/app/oauth2/authorize?${querystring.stringify(params)}`;
    
    console.log('🤖 VK Play Bot OAuth start →');
    console.log('   URL:', authUrl);
    console.log('   Параметры:', JSON.stringify(params, null, 2));
    console.log('   Запрашиваемые разрешения (scope):', params.scope);
    console.log('   📋 Список scope:');
    console.log('      ✅ channel:points - Получение списка наград');
    console.log('      ✅ channel:points:rewards - Управление наградами за баллы канала');
    console.log('      ✅ channel:points:rewards:demands - Запросы наград за баллы канала');
    console.log('      ✅ channel:roles - Управление ролями');
    console.log('      ✅ chat:message:send - Отправка сообщений в чат (ОБЯЗАТЕЛЬНО для работы бота!)');
    console.log('');
    console.log('   ⚠️ ВАЖНО: Убедитесь, что в настройках приложения VK Play "Xasya Bot":');
    console.log('   1. Указан redirect_uri: http://localhost:3000/oauth/vkplay-bot/callback');
    console.log('   2. В разделе "Разрешения" (Permissions/Scope) включено разрешение:');
    console.log('      - chat:message:send (Отправка сообщений в чат)');
    console.log('   3. Или оставьте раздел "Разрешения" пустым - scope будут запрошены автоматически');
    
    res.redirect(authUrl);
});

// Callback для авторизации бота
app.get('/oauth/vkplay-bot/callback', async (req, res) => {
    try {
        const { code, state, error, error_description } = req.query;
        
        // Детальное логирование для отладки
        console.log('📥 VK Play Bot OAuth callback получен:');
        console.log('   code:', code ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');
        console.log('   state:', state || 'ОТСУТСТВУЕТ');
        console.log('   error:', error || 'НЕТ');
        console.log('   error_description:', error_description || 'НЕТ');
        console.log('   Все query параметры:', JSON.stringify(req.query, null, 2));
        
        if (error) {
            console.error('❌ VK Play Bot OAuth error:', error);
            console.error('   Описание:', error_description);
            console.error('   Все параметры:', req.query);
            
            // Если ошибка invalid_scope, это может означать:
            // 1. Приложение в VK Play настроено с неверными scope
            // 2. VK Play требует scope, но мы их не указали
            // 3. Названия scope неверны
            if (error === 'invalid_scope') {
                console.error('💡 Решение для invalid_scope:');
                console.error('   ⚠️  Ошибка invalid_scope возникает, даже когда scope не указаны в URL');
                console.error('   Это означает, что проблема в настройках приложения в VK Play');
                console.error('');
                console.error('   📋 Что нужно сделать:');
                console.error('   1. Откройте панель управления приложением VK Play "Xasya Bot"');
                console.error('   2. Найдите раздел "Разрешения" или "Permissions" / "Scope"');
                console.error('   3. УДАЛИТЕ все указанные scope (оставьте пустым)');
                console.error('   4. Или убедитесь, что указаны только правильные scope:');
                console.error('      - channel:points');
                console.error('      - channel:points:rewards');
                console.error('      - channel:points:rewards:demands');
                console.error('      - channel:roles');
                console.error('      - chat:message:send');
                console.error('   5. Сохраните настройки');
                console.error('   6. Попробуйте авторизоваться снова');
            }
            
            return res.status(400).send(`VK Play Bot OAuth error: ${error} ${error_description || ''}`);
        }
        if (!code) return res.status(400).send('Missing code');
        
        const clientId = process.env.VKPLAY_BOT_CLIENT_ID;
        const clientSecret = process.env.VKPLAY_BOT_CLIENT_SECRET;
        // ВАЖНО: redirect_uri должен ТОЧНО совпадать с тем, что указано в настройках приложения VK Play
        const redirectUri = process.env.VKPLAY_BOT_REDIRECT_URI || `http://localhost:${port}/oauth/vkplay-bot/callback`;
        const cleanRedirectUri = redirectUri.trim();  // Убираем возможные пробелы
        
        if (!clientId || !clientSecret) {
            return res.status(500).send('VK Play Bot OAuth is not configured (client id/secret).');
        }
        
        console.log('🔍 Проверка redirect_uri в callback для бота:');
        console.log('   Ожидается (из настроек приложения): http://localhost:3000/oauth/vkplay-bot/callback');
        console.log('   Используется:', cleanRedirectUri);
        console.log('   Совпадает:', cleanRedirectUri === 'http://localhost:3000/oauth/vkplay-bot/callback' ? '✅ ДА' : '❌ НЕТ');
        
        if (cleanRedirectUri !== 'http://localhost:3000/oauth/vkplay-bot/callback') {
            console.error('⚠️ ВНИМАНИЕ: redirect_uri не совпадает с настройками приложения!');
            console.error('   Это может быть причиной ошибки авторизации.');
        }

        // Проверяем правильность ключей
        console.log('🔍 Проверка ключей VK Play Bot:');
        console.log('   Client ID:', clientId ? `${clientId.substring(0, 8)}...${clientId.substring(clientId.length - 4)}` : 'ОТСУТСТВУЕТ');
        console.log('   Client ID длина:', clientId?.length || 0);
        console.log('   Client Secret:', clientSecret ? `${clientSecret.substring(0, 8)}...${clientSecret.substring(clientSecret.length - 4)}` : 'ОТСУТСТВУЕТ');
        console.log('   Client Secret длина:', clientSecret?.length || 0);
        console.log('   Redirect URI:', cleanRedirectUri);
        console.log('   Code:', code ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');
        
        // ВАЖНО: Используем СЕКРЕТНЫЙ ключ приложения, НЕ публичный!
        // Публичный ключ приложения НЕ используется в OAuth CodeFlow
        if (!clientId || !clientSecret) {
            console.error('❌ Ошибка: Client ID или Client Secret отсутствуют');
            return res.status(500).send('VK Play Bot OAuth is not configured (client id/secret).');
        }
        
        // Проверяем правильность Client Secret по первым символам
        const EXPECTED_BOT_CLIENT_ID = 'umv46nrqcxbvzxhz';
        const EXPECTED_BOT_CLIENT_SECRET_START = 'kMLoAl9w'; // Первые 8 символов правильного секретного ключа
        const EXPECTED_BOT_CLIENT_SECRET_END = 'Db71c'; // Последние 5 символов правильного секретного ключа
        
        if (clientId !== EXPECTED_BOT_CLIENT_ID) {
            console.error('❌ ОШИБКА: Client ID бота не совпадает с ожидаемым!');
            console.error('   Ожидается:', EXPECTED_BOT_CLIENT_ID);
            console.error('   Получено:', clientId);
        }
        
        if (clientSecret && clientSecret.length === 64) {
            const secretStart = clientSecret.substring(0, 8);
            const secretEnd = clientSecret.substring(clientSecret.length - 5);
            
            if (secretStart !== EXPECTED_BOT_CLIENT_SECRET_START || secretEnd !== EXPECTED_BOT_CLIENT_SECRET_END) {
                console.error('❌ ОШИБКА: Client Secret бота не совпадает с ожидаемым!');
                console.error('   Ожидается начало:', EXPECTED_BOT_CLIENT_SECRET_START);
                console.error('   Получено начало:', secretStart);
                console.error('   Ожидается конец:', EXPECTED_BOT_CLIENT_SECRET_END);
                console.error('   Получено конец:', secretEnd);
                console.error('');
                console.error('💡 Проверьте файл config.env:');
                console.error('   VKPLAY_BOT_CLIENT_SECRET должен быть: kMLoAl9wJyF5OIkX6hc0u5xJQDVrq8g3fgkLHziSgT62N5lm0eiYt2psJSgDb71c');
                console.error('   НЕ используйте публичный ключ приложения!');
            } else {
                console.log('✅ Client Secret бота проверен: начало и конец совпадают');
            }
        } else {
            console.warn('⚠️ ВНИМАНИЕ: Client Secret бота имеет неожиданную длину. Ожидается 64 символа.');
        }
        
        // Убираем возможные пробелы и переносы строк из ключей
        const cleanClientId = clientId.trim();
        const cleanClientSecret = clientSecret.trim();
        const basic = Buffer.from(`${cleanClientId}:${cleanClientSecret}`).toString('base64');
        
        // Обмен кода на токен
        let tokenRes;
        const tokenData = querystring.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: cleanRedirectUri
        });
        
        try {
            tokenRes = await axios.post(
                'https://api.live.vkvideo.ru/oauth/server/token',
                tokenData,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Basic ${basic}`
                    }
                }
            );
        } catch (tokenError) {
            console.error('❌ Ошибка обмена кода на токен для бота:');
            console.error('   Status:', tokenError?.response?.status);
            console.error('   Data:', JSON.stringify(tokenError?.response?.data, null, 2));
            console.error('   Message:', tokenError.message);
            
            if (tokenError?.response?.status === 400) {
                const errorData = tokenError?.response?.data;
                if (errorData?.error === 'invalid_grant') {
                    console.error('💡 Ошибка invalid_grant обычно означает:');
                    console.error('   1. Код авторизации уже использован или истек');
                    console.error('   2. redirect_uri не совпадает с тем, что был в запросе авторизации');
                    console.error('   3. Проверьте, что redirect_uri в настройках приложения точно совпадает');
                }
            }
            
            if (tokenError?.response?.status === 404) {
                try {
                    console.log('🔄 Пробуем apidev.live.vkvideo.ru...');
                    tokenRes = await axios.post(
                        'https://apidev.live.vkvideo.ru/oauth/server/token',
                        tokenData,
                        {
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Authorization': `Basic ${basic}`
                            }
                        }
                    );
                    console.log('✅ Токен получен от apidev.live.vkvideo.ru');
                } catch (error2) {
                    console.error('❌ apidev.live.vkvideo.ru тоже вернул ошибку:');
                    console.error('   Status:', error2?.response?.status);
                    console.error('   Data:', JSON.stringify(error2?.response?.data, null, 2));
                    return res.status(500).send(`Token exchange failed: ${error2?.response?.data?.error || error2.message}`);
                }
            } else {
                return res.status(500).send(`Token exchange failed: ${tokenError?.response?.data?.error || tokenError.message}`);
            }
        }
        
        const tokens = tokenRes.data; // access_token, refresh_token, expires_in, token_type
        console.log('✅ Токен получен для бота:', {
            access_token: tokens.access_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ',
            refresh_token: tokens.refresh_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ',
            expires_in: tokens.expires_in,
            token_type: tokens.token_type
        });
        console.log('   📋 Запрошенные scope включают:');
        console.log('      ✅ chat:message:send - Отправка сообщений в чат (ОБЯЗАТЕЛЬНО для работы бота!)');
        console.log('      ✅ channel:points, channel:points:rewards, channel:points:rewards:demands, channel:roles');
        console.log('   💡 Если бот не может отправлять сообщения, проверьте, что scope chat:message:send был одобрен при авторизации');
        
        const nowSec = Math.floor(Date.now() / 1000);
        
        vkplayBotIntegration.connected = true;
        vkplayBotIntegration.tokens = tokens;
        vkplayBotIntegration.expires_at = nowSec + (tokens.expires_in || 0);
        
        // Получаем информацию о боте
        try {
            let userResponse;
            try {
                userResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/current_user', {
                    headers: { Authorization: `Bearer ${tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    userResponse = await axios.get('https://api.live.vkvideo.ru/v1/current_user', {
                        headers: { Authorization: `Bearer ${tokens.access_token}` }
                    });
                } else {
                    throw apiError;
                }
            }
            
            const userData = userResponse.data?.data;
            if (userData) {
                vkplayBotIntegration.userId = userData.user?.id || null;
                vkplayBotIntegration.userNick = userData.user?.nick || null;
                const channelUrl = userData.channel?.url || (userData.channels && userData.channels[0]?.url) || null;
                vkplayBotIntegration.channelUrl = channelUrl;
                vkplayBotIntegration.channel = userData.user?.nick || channelUrl;
                
                console.log(`✅ VK Play Bot авторизация завершена: ${vkplayBotIntegration.userNick} (ID: ${vkplayBotIntegration.userId})`);
            }
        } catch (e) {
            console.warn('⚠️ Не удалось получить информацию о боте:', e?.response?.data || e.message);
        }
        
        // Сохраняем в БД (всегда, даже если не удалось получить данные пользователя)
        try {
            await saveIntegration('vkplay_bot', {
                tokens: vkplayBotIntegration.tokens,
                expires_at: vkplayBotIntegration.expires_at,
                channel: vkplayBotIntegration.channel,
                channelUrl: vkplayBotIntegration.channelUrl,
                userId: vkplayBotIntegration.userId,
                userNick: vkplayBotIntegration.userNick
            });
            console.log('✅ Токены VK Play Bot сохранены в БД');
        } catch (saveError) {
            console.error('❌ Ошибка сохранения токенов бота:', saveError);
        }
        
        // Redirect back to integrations page (как в обычном VK Play)
        res.redirect('/stream-integrations.html');
    } catch (error) {
        console.error('❌ Ошибка авторизации VK Play Bot:', error);
        res.status(500).send('Authorization failed');
    }
});

// Тестовый endpoint для проверки параметров авторизации бота
app.get('/oauth/vkplay-bot/test', (req, res) => {
    const clientId = process.env.VKPLAY_BOT_CLIENT_ID;
    const redirectUri = process.env.VKPLAY_BOT_REDIRECT_URI || `http://localhost:${port}/oauth/vkplay-bot/callback`;
    const cleanRedirectUri = redirectUri.trim();
    const cleanClientId = clientId ? clientId.trim() : null;
    
    const EXPECTED_BOT_CLIENT_ID = 'umv46nrqcxbvzxhz';
    const EXPECTED_REDIRECT_URI = 'http://localhost:3000/oauth/vkplay-bot/callback';
    
    const scopes = [
        'channel:points',
        'channel:points:rewards',
        'channel:points:rewards:demands',
        'channel:roles',
        'chat:message:send'
    ].join(',');
    
    const params = {
        client_id: cleanClientId,
        redirect_uri: cleanRedirectUri,
        response_type: 'code',
        scope: scopes,
        state: 'test123'
    };
    
    const authUrl = `https://auth.live.vkvideo.ru/app/oauth2/authorize?${querystring.stringify(params)}`;
    
    res.send(`
        <html>
            <head>
                <title>Тест авторизации VK Play Bot</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 20px; background: #0a0a14; color: #fff; }
                    .section { margin: 20px 0; padding: 15px; background: #1a1a2e; border-radius: 5px; }
                    .ok { color: #00ff00; }
                    .error { color: #ff0000; }
                    .warning { color: #ffaa00; }
                    pre { background: #000; padding: 10px; border-radius: 5px; overflow-x: auto; }
                    a { color: #00f0ff; }
                </style>
            </head>
            <body>
                <h1>🔍 Тест авторизации VK Play Bot</h1>
                
                <div class="section">
                    <h2>Проверка параметров:</h2>
                    <p><strong>Client ID:</strong> 
                        <span class="${cleanClientId === EXPECTED_BOT_CLIENT_ID ? 'ok' : 'error'}">
                            ${cleanClientId || 'ОТСУТСТВУЕТ'} 
                            ${cleanClientId === EXPECTED_BOT_CLIENT_ID ? '✅' : '❌'}
                        </span>
                    </p>
                    <p><strong>Ожидается:</strong> ${EXPECTED_BOT_CLIENT_ID}</p>
                    
                    <p><strong>Redirect URI:</strong> 
                        <span class="${cleanRedirectUri === EXPECTED_REDIRECT_URI ? 'ok' : 'error'}">
                            ${cleanRedirectUri || 'ОТСУТСТВУЕТ'} 
                            ${cleanRedirectUri === EXPECTED_REDIRECT_URI ? '✅' : '❌'}
                        </span>
                    </p>
                    <p><strong>Ожидается:</strong> ${EXPECTED_REDIRECT_URI}</p>
                </div>
                
                <div class="section">
                    <h2>Параметры запроса:</h2>
                    <pre>${JSON.stringify(params, null, 2)}</pre>
                </div>
                
                <div class="section">
                    <h2>URL авторизации:</h2>
                    <pre>${authUrl}</pre>
                    <p><a href="${authUrl}" target="_blank">🔗 Попробовать авторизацию</a></p>
                </div>
                
                <div class="section">
                    <h2>⚠️ Что проверить в настройках приложения VK Play "Xasya Bot":</h2>
                    <ol>
                        <li>Откройте панель управления приложением в VK Play</li>
                        <li>Найдите раздел "Список допустимых URL для редиректа"</li>
                        <li>Убедитесь, что указан ТОЧНО: <code>http://localhost:3000/oauth/vkplay-bot/callback</code></li>
                        <li>Каждый URL должен быть на отдельной строке (не через запятую)</li>
                        <li>Без пробелов в начале и конце</li>
                        <li>Без слеша в конце</li>
                    </ol>
                </div>
                
                <div class="section">
                    <h2>📋 Scope (разрешения):</h2>
                    <p>Запрашиваемые разрешения:</p>
                    <ul>
                        <li>channel:points</li>
                        <li>channel:points:rewards</li>
                        <li>channel:points:rewards:demands</li>
                        <li>channel:roles</li>
                        <li>chat:message:send</li>
                    </ul>
                    <p class="warning">⚠️ Если возникает ошибка, попробуйте убрать scope из настроек приложения или оставить их пустыми</p>
                </div>
            </body>
        </html>
    `);
});

// Статус бота
app.get('/integrations/vkplay-bot/status', (req, res) => {
    res.json({
        connected: vkplayBotIntegration.connected,
        channel: vkplayBotIntegration.channel,
        channelUrl: vkplayBotIntegration.channelUrl,
        userId: vkplayBotIntegration.userId,
        userNick: vkplayBotIntegration.userNick
    });
});

// Выход бота
app.post('/oauth/vkplay-bot/logout', async (req, res) => {
    try {
        // Удаляем данные из БД
        db.run('DELETE FROM stream_integrations WHERE platform = ?', ['vkplay_bot'], (err) => {
            if (err) {
                console.error('❌ Ошибка удаления данных бота из БД:', err);
            } else {
                console.log('✅ Данные VK Play Bot удалены из БД');
            }
        });
        
        // Очищаем в памяти
        vkplayBotIntegration = { connected: false, channel: null, channelUrl: null, tokens: null, expires_at: 0, userId: null, userNick: null };
        res.json({ ok: true });
    } catch (error) {
        console.error('❌ Ошибка при выходе бота:', error);
        res.status(500).json({ error: 'Logout failed' });
    }
});

// Сбор чата VK Play
async function collectVKPlayChat() {
    if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) return;
    
    try {
        let chatData;
        try {
            // Основной боевой API
            chatData = await axios.get('https://api.live.vkvideo.ru/v1/chat/messages', {
                params: { 
                    channel_url: vkplayIntegration.channelUrl,
                    limit: 50
                },
                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
            });
        } catch (apiError) {
            if (apiError?.response?.status === 404) {
                // Как и для current_user/channel — пробуем apidev, если боевой отдает 404
                console.log('⚠️ api.live.vkvideo.ru вернул 404 для chat/messages, пробуем apidev.live.vkvideo.ru...');
                chatData = await axios.get('https://apidev.live.vkvideo.ru/v1/chat/messages', {
                    params: { 
                        channel_url: vkplayIntegration.channelUrl,
                        limit: 50
                    },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } else {
                throw apiError;
            }
        }
        
        const messages = chatData.data?.data?.chat_messages || [];
        for (const msg of messages) {
            // Проверяем, есть ли уже такое сообщение
            db.get('SELECT id FROM chat_messages WHERE platform = ? AND user_id = ? AND message = ? AND created_at > datetime("now", "-5 minutes")', 
                ['vkplay', msg.author?.id, msg.parts?.[0]?.text?.content], (err, row) => {
                if (!err && !row) {
                    // Сохраняем новое сообщение
                    db.run(`INSERT INTO chat_messages (platform, channel_url, user_id, username, message, is_moderator, is_owner, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                        'vkplay',
                        vkplayIntegration.channelUrl,
                        msg.author?.id,
                        msg.author?.nick,
                        msg.parts?.[0]?.text?.content || '',
                        msg.author?.is_moderator ? 1 : 0,
                        msg.author?.is_owner ? 1 : 0,
                        new Date(msg.created_at * 1000).toISOString()
                    ]);
                }
            });
        }
    } catch (error) {
        console.warn('⚠️ Ошибка сбора чата VK Play:', error?.response?.data || error.message);
    }
}

// Подключение к Rutony Chat WebSocket и сбор чата
let rutonyWs = null;
let rutonyRetryTimeout = null;

function startRutonyChat() {
    try {
        if (rutonyWs) {
            try { rutonyWs.close(); } catch(_) {}
            rutonyWs = null;
        }
        const tryUrls = ['ws://localhost:8383', 'ws://127.0.0.1:8383', 'ws://localhost:8383/Chat'];
        let idx = 0;

        const connectNext = () => {
            const url = tryUrls[idx++ % tryUrls.length];
            const wsClient = new WebSocket(url);
            let opened = false;

            wsClient.on('open', () => {
                opened = true;
                rutonyWs = wsClient;
                rutonyIntegration.connected = true;
                rutonyIntegration.lastError = null;
                console.log(`✅ Подключено к Rutony Chat: ${url}`);
            });

            wsClient.on('message', (buf) => {
                try {
                    const text = buf.toString();
                    let data = null;
                    try { data = JSON.parse(text); } catch (_) { return; }

                    // Поддержка нескольких форматов
                    const type = data.type || data.Type || '';
                    const username = data.username || data.Username || data.user || 'User';
                    const messageText = data.text || data.Text || data.message || data.Message || '';
                    const isModerator = !!(data.is_moderator || data.IsModerator);
                    const isOwner = !!(data.is_owner || data.IsOwner);
                    const createdIso = (data.timestamp || data.Timestamp)
                        ? new Date(data.timestamp || data.Timestamp).toISOString()
                        : new Date().toISOString();

                    if (!messageText) return;

                    // Дедупликация за последние 5 минут
                    db.get('SELECT id FROM chat_messages WHERE platform = ? AND username = ? AND message = ? AND created_at > datetime("now", "-5 minutes")',
                        ['rutony', username, messageText], (err, row) => {
                        if (!err && !row) {
                            db.run(`INSERT INTO chat_messages (platform, channel_url, user_id, username, message, is_moderator, is_owner, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                                'rutony',
                                'rutony://local',
                                username,
                                username,
                                messageText,
                                isModerator ? 1 : 0,
                                isOwner ? 1 : 0,
                                createdIso
                            ]);
                        }
                    });
                } catch (e) {
                    console.warn('⚠️ Ошибка обработки сообщения Rutony:', e.message);
                }
            });

            wsClient.on('close', () => {
                rutonyIntegration.connected = false;
                if (rutonyRetryTimeout) clearTimeout(rutonyRetryTimeout);
                rutonyRetryTimeout = setTimeout(connectNext, 2000);
            });

            wsClient.on('error', (err) => {
                rutonyIntegration.connected = false;
                rutonyIntegration.lastError = err?.message || String(err);
                try { wsClient.close(); } catch(_) {}
                if (rutonyRetryTimeout) clearTimeout(rutonyRetryTimeout);
                rutonyRetryTimeout = setTimeout(connectNext, 1500);
            });
        };

        connectNext();
    } catch (e) {
        rutonyIntegration.connected = false;
        rutonyIntegration.lastError = e?.message || String(e);
        if (rutonyRetryTimeout) clearTimeout(rutonyRetryTimeout);
        rutonyRetryTimeout = setTimeout(startRutonyChat, 3000);
    }
}

// Сбор чата YouTube Live
async function collectYouTubeChat() {
    if (!youtubeIntegration.connected || !youtubeIntegration.tokens || !youtubeIntegration.liveChatId) return;
    try {
        const params = {
            part: 'snippet,authorDetails',
            liveChatId: youtubeIntegration.liveChatId,
            maxResults: 200
        };
        if (youtubeIntegration.nextPageToken) params.pageToken = youtubeIntegration.nextPageToken;

        const chat = await axios.get('https://www.googleapis.com/youtube/v3/liveChat/messages', {
            params,
            headers: { Authorization: `Bearer ${youtubeIntegration.tokens.access_token}` }
        });

        youtubeIntegration.nextPageToken = chat.data?.nextPageToken || null;
        const items = chat.data?.items || [];

        for (const it of items) {
            const sn = it.snippet || {};
            const ad = it.authorDetails || {};
            const text = sn.displayMessage || '';
            const publishedAt = sn.publishedAt ? new Date(sn.publishedAt).toISOString() : new Date().toISOString();

            // Deduplicate recent messages
            db.get('SELECT id FROM chat_messages WHERE platform = ? AND user_id = ? AND message = ? AND created_at > datetime("now", "-5 minutes")',
                ['youtube', ad.channelId || ad.channelUrl || ad.displayName || 'unknown', text], (err, row) => {
                if (!err && !row) {
                    db.run(`INSERT INTO chat_messages (platform, channel_url, user_id, username, message, is_moderator, is_owner, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                        'youtube',
                        youtubeIntegration.channel || 'youtube',
                        ad.channelId || ad.channelUrl || ad.displayName || 'unknown',
                        ad.displayName || 'YouTube User',
                        text,
                        ad.isChatModerator ? 1 : 0,
                        ad.isChatOwner ? 1 : 0,
                        publishedAt
                    ]);
                }
            });
        }
    } catch (e) {
        console.warn('⚠️ Ошибка сбора чата YouTube:', e?.response?.data || e.message);
    }
}

// Обновление данных YouTube (только по уже выбранному videoId) с настраиваемым интервалом опроса
async function updateYouTubeData() {
    if (!youtubeIntegration.connected || !youtubeIntegration.tokens) return;

    // Учитываем настраиваемый интервал опроса
    const now = Date.now();
    const intervalMs = (youtubeIntegration.pollIntervalSec || 60) * 1000;
    if (youtubeIntegration.lastPollTime && now - youtubeIntegration.lastPollTime < intervalMs) {
        return;
    }
    youtubeIntegration.lastPollTime = now;

    try {
        let videoId = youtubeIntegration.videoId || null;
        const detectCooldownMs = 5 * 60 * 1000; // раз в 5 минут синхронизируем active live

        // Если videoId не задан, или периодически для синхронизации, ищем active live.
        const shouldRedetect = !videoId || !youtubeIntegration.lastLiveDetectTime || (now - youtubeIntegration.lastLiveDetectTime >= detectCooldownMs);
        if (shouldRedetect) {
            const hadVideoIdBeforeDetect = !!videoId;
            const detected = await detectActiveYouTubeLive(youtubeIntegration.tokens, { allowSearchFallback: false });
            youtubeIntegration.lastLiveDetectTime = now;
            if (detected.videoId) {
                const switched = videoId && detected.videoId !== videoId;
                videoId = detected.videoId;
                youtubeIntegration.videoId = videoId;
                if (detected.snippet?.title) youtubeIntegration.liveTitle = detected.snippet.title;
                if (!youtubeIntegration.channel && detected.snippet?.channelTitle) {
                    youtubeIntegration.channel = detected.snippet.channelTitle;
                }
                if (switched) {
                    console.log(`🔄 YouTube: переключили активный эфир на более свежий (videoId=${videoId})`);
                } else if (!hadVideoIdBeforeDetect) {
                    console.log(`✅ YouTube: найден активный эфир автоматически (videoId=${videoId})`);
                }
            } else {
                if (!videoId) {
                    // Не нашли эфир и текущего videoId нет — выходим тихо
                    return;
                }
            }
        }

        let snippet = null;
        let liveDetails = null;
        let stats = null;

        // Получаем статистику, liveStreamingDetails и snippet по видео
        try {
            const videoResp = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
                params: {
                    part: 'snippet,statistics,liveStreamingDetails',
                    id: videoId
                },
                headers: { Authorization: `Bearer ${youtubeIntegration.tokens.access_token}` }
            });
            const vItems = videoResp.data.items || [];
            const v = vItems[0];
            if (v) {
                snippet = v.snippet || null;
                stats = v.statistics || {};
                liveDetails = v.liveStreamingDetails || {};
            } else {
                console.warn('⚠️ videos.list не вернул данных для videoId =', videoId);
            }
        } catch (videoErr) {
            console.warn('⚠️ Ошибка получения videos.snippet/statistics/liveStreamingDetails:', videoErr?.response?.data || videoErr.message);
        }

        if (snippet) {
            const newTitle = snippet.title || youtubeIntegration.liveTitle || null;
            youtubeIntegration.liveTitle = newTitle;
            if (!youtubeIntegration.channel && snippet.channelTitle) {
                youtubeIntegration.channel = snippet.channelTitle;
            }
        }

        // liveChatId берем из liveStreamingDetails.activeLiveChatId (надежнее, чем из liveBroadcasts)
        const chatId = liveDetails && liveDetails.activeLiveChatId ? liveDetails.activeLiveChatId : youtubeIntegration.liveChatId || null;
        youtubeIntegration.liveChatId = chatId;
        youtubeIntegration.chatEnabled = !!chatId;

        // Обновляем онлайн и лайки, если есть статистика
        if (stats || liveDetails) {
            const likes = stats && stats.likeCount != null ? parseInt(stats.likeCount, 10) || 0 : (youtubeIntegration.likes || 0);
            const viewers = liveDetails && liveDetails.concurrentViewers != null
                ? parseInt(liveDetails.concurrentViewers, 10) || 0
                : (youtubeIntegration.viewers || 0);

            youtubeIntegration.likes = likes;
            youtubeIntegration.viewers = viewers;
        }

        // Сохраняем обновленные данные в БД
        await saveIntegration('youtube', {
            tokens: youtubeIntegration.tokens,
            channel: youtubeIntegration.channel,
            liveTitle: youtubeIntegration.liveTitle,
            viewers: youtubeIntegration.viewers,
            likes: youtubeIntegration.likes,
            chatEnabled: youtubeIntegration.chatEnabled,
            pollIntervalSec: youtubeIntegration.pollIntervalSec || 60
        });

        // Собираем чат (если есть liveChatId)
        await collectYouTubeChat();
    } catch (e) {
        const status = e?.response?.status;
        if (status === 401) {
            console.warn('⚠️ YouTube API: Токен истек или невалиден. Требуется повторная авторизация.');
            youtubeIntegration.connected = false;
            await saveIntegration('youtube', {
                tokens: youtubeIntegration.tokens,
                channel: youtubeIntegration.channel,
                liveTitle: youtubeIntegration.liveTitle,
                viewers: youtubeIntegration.viewers,
                likes: youtubeIntegration.likes,
                chatEnabled: false,
                pollIntervalSec: youtubeIntegration.pollIntervalSec || 60
            });
        } else if (status === 403) {
            console.warn('⚠️ YouTube API: Доступ запрещен. Проверьте права доступа приложения.');
        } else {
            console.warn('⚠️ Ошибка обновления данных YouTube:', e?.response?.data || e.message);
        }
    }
}

// Автообновление данных VK Play
async function updateVKPlayData() {
    if (!VKPLAY_POLLING_ENABLED) return;
    if (!vkplayIntegration.connected || !vkplayIntegration.tokens) {
        return;
    }
    
    try {
        console.log('🔄 Обновление данных VK Play...');
        
        // Проверяем, не истек ли токен
        const now = Math.floor(Date.now() / 1000);
        if (now >= vkplayIntegration.expires_at - 60) { // обновляем за минуту до истечения
            console.log('🔄 Обновление токена VK Play...');
            // TODO: реализовать обновление токена через refresh_token
        }
        
        // Получаем данные канала (пробуем оба варианта URL)
        let currentUser;
        try {
            currentUser = await axios.get('https://api.live.vkvideo.ru/v1/current_user', {
                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
            });
        } catch (apiError) {
            if (apiError?.response?.status === 404) {
                console.log('⚠️ api.live.vkvideo.ru вернул 404, пробуем apidev.live.vkvideo.ru...');
                currentUser = await axios.get('https://apidev.live.vkvideo.ru/v1/current_user', {
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } else {
                throw apiError;
            }
        }
        
        console.log('👤 Данные пользователя:', currentUser.data?.data);
        
        const data = currentUser.data?.data;
        if (data && data.channel?.url) {
            let channelData;
            try {
                channelData = await axios.get('https://api.live.vkvideo.ru/v1/channel', {
                    params: { channel_url: data.channel.url },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    console.log('⚠️ api.live.vkvideo.ru вернул 404 для channel, пробуем apidev...');
                    channelData = await axios.get('https://apidev.live.vkvideo.ru/v1/channel', {
                        params: { channel_url: data.channel.url },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } else {
                    throw apiError;
                }
            }
            
            const channelInfo = channelData.data?.data;
            if (channelInfo) {
                const oldChannel = vkplayIntegration.channel;
                const oldTitle = vkplayIntegration.liveTitle;
                vkplayIntegration.channel = channelInfo.channel?.nick || data.channel.url;
                vkplayIntegration.liveTitle = channelInfo.stream?.title || 'Нет активного стрима';
                vkplayIntegration.viewers = getVKPlayViewersFromChannelInfo(channelInfo);
                vkplayIntegration.likes = getVKPlayLikesFromChannelInfo(channelInfo, vkplayIntegration.likes);
                vkplayIntegration.chatEnabled = !!channelInfo.channel?.web_socket_channels?.chat;
                vkplayIntegration.channelUrl = data.channel.url;
                
                // Сохраняем обновленные данные в БД
                await saveIntegration('vkplay', {
                    tokens: vkplayIntegration.tokens,
                    expires_at: vkplayIntegration.expires_at,
                    channel: vkplayIntegration.channel,
                    channelUrl: vkplayIntegration.channelUrl,
                    liveTitle: vkplayIntegration.liveTitle,
                    viewers: vkplayIntegration.viewers,
                    likes: vkplayIntegration.likes,
                    chatEnabled: vkplayIntegration.chatEnabled
                });
                
                console.log(`📺 VK Play обновлено:`);
                console.log(`   Канал: ${oldChannel} → ${vkplayIntegration.channel}`);
                console.log(`   Стрим: ${oldTitle} → ${vkplayIntegration.liveTitle}`);
                console.log(`   Зрители: ${vkplayIntegration.viewers}`);
                console.log(`   Лайки: ${vkplayIntegration.likes}`);
                console.log(`   Чат: ${vkplayIntegration.chatEnabled ? 'включен' : 'выключен'}`);
                
                // Подключаемся к WebSocket наград если еще не подключены
                // Пробуем оба варианта: channel_point_rewards и channel_points
                const rewardsChannel = channelInfo.channel?.web_socket_channels?.channel_point_rewards || 
                                      channelInfo.channel?.web_socket_channels?.channel_points;
                console.log('🔍 Проверка канала для наград:', {
                    channel_point_rewards: channelInfo.channel?.web_socket_channels?.channel_point_rewards,
                    channel_points: channelInfo.channel?.web_socket_channels?.channel_points,
                    allChannels: Object.keys(channelInfo.channel?.web_socket_channels || {}),
                    vkplayRewardsWs: !!vkplayRewardsWs,
                    rewardsChannel: rewardsChannel
                });
                if (!vkplayRewardsWs && rewardsChannel) {
                    console.log(`🔌 Найден канал для наград: ${rewardsChannel}`);
                    setTimeout(() => {
                        console.log('⏰ Вызов connectVKPlayRewardsWebSocket через setTimeout...');
                        connectVKPlayRewardsWebSocket();
                    }, 2000);
                } else if (!rewardsChannel) {
                    console.warn('⚠️ Канал для наград не найден в web_socket_channels');
                    console.warn('   Доступные каналы:', Object.keys(channelInfo.channel?.web_socket_channels || {}));
                } else if (vkplayRewardsWs) {
                    console.log('ℹ️ WebSocket для наград уже подключен');
                }
            } else {
                console.warn('⚠️ Не удалось получить данные канала');
            }
        } else {
            console.warn('⚠️ Нет данных канала в ответе пользователя');
        }
        
        // Собираем чат
        await collectVKPlayChat();
        
    } catch (error) {
        console.warn('⚠️ Ошибка обновления данных VK Play:', error?.response?.data || error.message);
        if (error.response?.status === 401) {
            console.warn('🔑 Токен истек, требуется повторная авторизация');
            vkplayIntegration.connected = false;
        }
    }
}

// Polling для проверки активированных наград (если WebSocket не работает)
let lastCheckedDemandId = 0;
async function checkVKPlayRewardActivations() {
    if (!VKPLAY_POLLING_ENABLED) return;
    if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
        return;
    }

    try {
        // Получаем список запросов наград (активированных наград)
        let demandsResponse;
        try {
            demandsResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_point/reward/demands', {
                params: {
                    channel_url: vkplayIntegration.channelUrl,
                    limit: 50,
                    offset: 0
                },
                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
            });
        } catch (apiError) {
            if (apiError?.response?.status === 404) {
                demandsResponse = await axios.get('https://api.live.vkvideo.ru/v1/channel_point/reward/demands', {
                    params: {
                        channel_url: vkplayIntegration.channelUrl,
                        limit: 50,
                        offset: 0
                    },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } else {
                throw apiError;
            }
        }

        const demands = demandsResponse.data?.data?.demands || [];
        if (process.env.DEBUG_VK === '1') {
            console.log(`🔍 Проверка активированных наград: найдено ${demands.length} запросов`);
        }
        
        // Обрабатываем все запросы (включая выполненные)
        for (const demand of demands) {
                    const rewardId = demand.reward?.id;
                    const userId = demand.user?.id;
                    const rewardName = demand.reward?.name || 'Неизвестная награда';
                    const userName = demand.user?.nick || null;
                    const demandStatus = demand.status || 'unknown';
                    const demandId = demand.id;

                    if (!rewardId || !userId) {
                        continue;
                    }

                    // Получаем ник пользователя из разных источников
                    let finalUserName = userName;
                    
                    // Пробуем получить ник из demand.user.nick
                    if (!finalUserName && demand.user?.nick) {
                        finalUserName = demand.user.nick.trim();
                        console.log(`✅ Ник получен из demand.user.nick: "${finalUserName}"`);
                    }
                    
                    // Если все еще нет ника, пытаемся получить через API
                    if (!finalUserName) {
                        console.log(`🔍 Получаем ник пользователя ${userId} через API...`);
                        const userInfo = await getUserInfo(userId);
                        if (userInfo && userInfo.nick) {
                            finalUserName = userInfo.nick.trim();
                            console.log(`✅ Ник пользователя ${userId} получен через API: "${finalUserName}"`);
                        } else {
                            console.warn(`⚠️ Не удалось получить ник пользователя ${userId} через API`);
                        }
                    }
                    
                    if (!finalUserName) {
                        console.warn(`⚠️ Ник пользователя ${userId} не получен ни из одного источника, будет использован ID`);
                    }

                    // Проверяем, есть ли уже запись в истории для этого demand (за последние 5 минут)
                    db.get(
                        'SELECT id FROM vkplay_role_history WHERE user_id = ? AND reward_id = ? AND created_at > datetime("now", "-5 minutes")',
                        [userId, rewardId],
                        async (err, existing) => {
                            if (err) {
                                console.error('❌ Ошибка проверки истории:', err);
                                return;
                            }

                            // Если запись уже есть, пропускаем
                            if (existing) {
                                console.log(`ℹ️ Запись уже есть в истории для demand ${demandId}, пропускаем`);
                                return;
                            }

                            console.log(`🎁 Обнаружена активация награды через polling: ${rewardName} пользователем ${userId} (${finalUserName || 'без ника'}), статус: ${demandStatus}, ID: ${demandId}`);

                            // Ищем связь награда-роль
                            db.get(
                                'SELECT * FROM vkplay_reward_roles WHERE reward_id = ? AND channel_url = ? AND enabled = 1',
                                [rewardId, vkplayIntegration.channelUrl],
                                async (err, row) => {
                                    if (err) {
                                        console.error('❌ Ошибка поиска связи награда-роль:', err);
                                        return;
                                    }

                                    if (!row) {
                                        console.warn(`⚠️ Связь награда-роль не найдена для rewardId=${rewardId}`);
                                        // Не сохраняем в историю, если нет связи (только награды со связками)
                                        return;
                                    }

                                    console.log(`✅ Найдена связь: ${row.reward_name} → ${row.role_name}`);
                                    
                                    // Если награда уже выполнена (status = 'accepted' или 'completed'), просто сохраняем в историю как "assigned"
                                    if (demandStatus === 'accepted' || demandStatus === 'completed' || demandStatus === 'done') {
                                        console.log(`ℹ️ Награда уже выполнена (статус: ${demandStatus}), сохраняем в историю как "assigned"`);
                                        await saveRoleHistory(userId, finalUserName, rewardId, rewardName, row.role_id, row.role_name, 'assigned', null);
                                        return;
                                    }

                                    // Если награда еще не обработана, пытаемся выдать роль
                                    const result = await assignRoleToUser(userId, row.role_id, row.reward_id, row.reward_name);
                                    if (result.success) {
                                        console.log(`✅ Роль ${row.role_name} успешно выдана пользователю ${userId}`);
                                    } else {
                                        console.log(`⚠️ Роль не выдана: ${result.reason || 'неизвестная причина'}`);
                                    }
                                }
                            );
                        }
                    );

            // Обновляем последний проверенный ID
            if (demandId > lastCheckedDemandId) {
                lastCheckedDemandId = demandId;
            }
        }
    } catch (error) {
        // Игнорируем ошибки polling (может быть 403 если нет прав)
        if (error?.response?.status !== 403) {
            console.warn('⚠️ Ошибка проверки активированных наград:', error?.response?.data || error.message);
        }
    }
}

// VK Play polling — выключено по умолчанию (VKPLAY_POLLING=1)
if (VKPLAY_POLLING_ENABLED) {
    setInterval(() => withApiQueue('vkplay', () => updateVKPlayData()), 5000);
    setInterval(() => withApiQueue('vkplay-rewards', () => checkVKPlayRewardActivations()), 10000);
}

// YouTube: таймер раз в 30 сек (реальный интервал опроса — pollIntervalSec; реже тикаем, чтобы не нагружать цикл)
setInterval(() => withApiQueue('youtube', () => updateYouTubeData()), 30000);

// =====================
// VK Play Rewards & Roles API
// =====================

// Получение списка ролей канала
app.get('/api/vkplay/roles', async (req, res) => {
    try {
        if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
            console.warn('⚠️ VK Play не подключен для получения ролей');
            return res.status(401).json({ error: 'VK Play не подключен' });
        }

        console.log('📋 Запрос ролей VK Play:');
        console.log('   Channel URL:', vkplayIntegration.channelUrl);
        console.log('   Access token:', vkplayIntegration.tokens.access_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');

        // Пробуем оба варианта URL (api и apidev)
        let response;
        try {
            response = await axios.get('https://api.live.vkvideo.ru/v1/channel_roles', {
                params: { channel_url: vkplayIntegration.channelUrl },
                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
            });
        } catch (apiError) {
            if (apiError?.response?.status === 404) {
                console.log('⚠️ api.live.vkvideo.ru вернул 404 для roles, пробуем apidev...');
                response = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_roles', {
                    params: { channel_url: vkplayIntegration.channelUrl },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } else {
                throw apiError;
            }
        }

        console.log('✅ Роли получены:', response.data?.data?.roles?.length || 0, 'ролей');
        res.json(response.data);
    } catch (error) {
        console.error('❌ Ошибка получения ролей:');
        console.error('   Status:', error?.response?.status);
        console.error('   Data:', JSON.stringify(error?.response?.data, null, 2));
        console.error('   Message:', error.message);
        res.status(error?.response?.status || 500).json({ 
            error: error?.response?.data || error.message 
        });
    }
});

// Получение списка наград канала
app.get('/api/vkplay/rewards', async (req, res) => {
    try {
        if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
            console.warn('⚠️ VK Play не подключен для получения наград');
            return res.status(401).json({ error: 'VK Play не подключен' });
        }

        console.log('🎁 Запрос наград VK Play:');
        console.log('   Channel URL:', vkplayIntegration.channelUrl);
        console.log('   Access token:', vkplayIntegration.tokens.access_token ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');

        // Пробуем оба варианта URL (api и apidev)
        let response;
        try {
            response = await axios.get('https://api.live.vkvideo.ru/v1/channel_point/rewards', {
                params: { channel_url: vkplayIntegration.channelUrl },
                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
            });
        } catch (apiError) {
            if (apiError?.response?.status === 404) {
                console.log('⚠️ api.live.vkvideo.ru вернул 404 для rewards, пробуем apidev...');
                response = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_point/rewards', {
                    params: { channel_url: vkplayIntegration.channelUrl },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } else {
                throw apiError;
            }
        }

        console.log('✅ Награды получены:', response.data?.data?.rewards?.length || 0, 'наград');
        res.json(response.data);
    } catch (error) {
        console.error('❌ Ошибка получения наград:');
        console.error('   Status:', error?.response?.status);
        console.error('   Data:', JSON.stringify(error?.response?.data, null, 2));
        console.error('   Message:', error.message);
        res.status(error?.response?.status || 500).json({ 
            error: error?.response?.data || error.message 
        });
    }
});

// Получение списка связей награда-роль
app.get('/api/vkplay/reward-roles', (req, res) => {
    if (!vkplayIntegration.connected || !vkplayIntegration.channelUrl) {
        return res.status(401).json({ error: 'VK Play не подключен' });
    }

    db.all(
        'SELECT * FROM vkplay_reward_roles WHERE channel_url = ? ORDER BY created_at DESC',
        [vkplayIntegration.channelUrl],
        (err, rows) => {
            if (err) {
                console.error('❌ Ошибка получения связей:', err);
                return res.status(500).json({ error: err.message });
            }
            res.json({ rewardRoles: rows });
        }
    );
});

// Сохранение/обновление связи награда-роль
app.post('/api/vkplay/reward-roles', express.json(), (req, res) => {
    try {
        const { reward_id, reward_name, role_id, role_name, enabled = true } = req.body;

        if (!reward_id || !role_id || !vkplayIntegration.channelUrl) {
            return res.status(400).json({ error: 'Не указаны обязательные параметры' });
        }

        db.run(
            `INSERT OR REPLACE INTO vkplay_reward_roles 
            (reward_id, reward_name, role_id, role_name, channel_url, enabled, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [reward_id, reward_name || '', role_id, role_name || '', vkplayIntegration.channelUrl, enabled ? 1 : 0],
            function(err) {
                if (err) {
                    console.error('❌ Ошибка сохранения связи:', err);
                    return res.status(500).json({ error: err.message });
                }
                res.json({ success: true, id: this.lastID });
            }
        );
    } catch (error) {
        console.error('❌ Ошибка обработки запроса:', error);
        res.status(500).json({ error: error.message });
    }
});

// Удаление связи награда-роль
app.delete('/api/vkplay/reward-roles/:id', (req, res) => {
    const { id } = req.params;

    db.run('DELETE FROM vkplay_reward_roles WHERE id = ?', [id], function(err) {
        if (err) {
            console.error('❌ Ошибка удаления связи:', err);
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true });
    });
});

// Получение истории выдачи ролей
app.get('/api/vkplay/role-history', (req, res) => {
    const { limit = 100, offset = 0, status = null } = req.query;

    const channelUrl = vkplayIntegration.channelUrl;
    if (!channelUrl) {
        console.warn('⚠️ channelUrl не установлен для истории ролей');
        return res.json({ history: [] });
    }

    // Возвращаем только награды со связками (где role_id не пустой)
    let query = 'SELECT * FROM vkplay_role_history WHERE channel_url = ? AND role_id != "" AND role_id IS NOT NULL';
    const params = [channelUrl];

    if (status && status !== 'all') {
        query += ' AND status = ?';
        params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    console.log('📜 Запрос истории ролей (только со связками):', { channelUrl, status, limit, offset });

    db.all(query, params, async (err, rows) => {
        if (err) {
            console.error('❌ Ошибка получения истории ролей:', err);
            return res.status(500).json({ error: err.message });
        }
        console.log(`✅ История ролей получена: ${rows?.length || 0} записей (только со связками)`);
        
        // Обновляем ники для записей, где их нет (с ограничением по времени)
        if (rows && rows.length > 0) {
            const updatePromises = [];
            const userIdsToUpdate = new Set(); // Кэш для избежания дублирования запросов
            
            for (const row of rows) {
                // Если у записи нет ника, пытаемся получить его
                if ((!row.user_nick || row.user_nick.trim() === '') && !userIdsToUpdate.has(row.user_id)) {
                    userIdsToUpdate.add(row.user_id);
                    
                    updatePromises.push(
                        getUserInfo(row.user_id).then(userInfo => {
                            if (userInfo && userInfo.nick && userInfo.nick.trim() !== '') {
                                const retrievedNick = userInfo.nick.trim();
                                console.log(`🔄 Обновляем ник для userId=${row.user_id}: "${retrievedNick}"`);
                                
                                // Обновляем в БД для всех записей с этим userId
                                return new Promise((resolve) => {
                                    db.run(
                                        'UPDATE vkplay_role_history SET user_nick = ? WHERE user_id = ? AND (user_nick IS NULL OR user_nick = "")',
                                        [retrievedNick, row.user_id],
                                        function(updateErr) {
                                            if (updateErr) {
                                                console.error(`❌ Ошибка обновления ника для userId=${row.user_id}:`, updateErr);
                                                resolve(null);
                                            } else {
                                                // Обновляем ник во всех строках с этим userId для текущего ответа
                                                rows.forEach(r => {
                                                    if (r.user_id === row.user_id && (!r.user_nick || r.user_nick.trim() === '')) {
                                                        r.user_nick = retrievedNick;
                                                    }
                                                });
                                                console.log(`✅ Ник "${retrievedNick}" обновлен для userId=${row.user_id} (обновлено ${this.changes} записей)`);
                                                resolve(retrievedNick);
                                            }
                                        }
                                    );
                                });
                            }
                            return null;
                        }).catch(err => {
                            console.warn(`⚠️ Не удалось получить ник для userId=${row.user_id}:`, err?.message || err);
                            return null;
                        })
                    );
                }
            }
            
            // Ждем обновления ников (но не блокируем ответ слишком долго - максимум 3 секунды)
            if (updatePromises.length > 0) {
                console.log(`🔄 Обновляем ники для ${updatePromises.length} уникальных пользователей...`);
                const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('timeout'), 3000));
                await Promise.race([Promise.allSettled(updatePromises), timeoutPromise]);
            }
        }
        
        // Логируем первые несколько записей для отладки
        if (rows && rows.length > 0) {
            console.log('📋 Примеры записей из истории:');
            rows.slice(0, 3).forEach((row, index) => {
                console.log(`   ${index + 1}. user_id: ${row.user_id}, user_nick: "${row.user_nick || 'NULL'}", reward: ${row.reward_name}, role: ${row.role_name}, status: ${row.status}`);
            });
        }
        
        res.json({ history: rows || [] });
    });
});

// Получение списка ролей пользователя
async function getUserRoles(userId) {
    try {
        if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
            return [];
        }

        let response;
        try {
            response = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_roles/user', {
                params: {
                    channel_url: vkplayIntegration.channelUrl,
                    user_id: userId
                },
                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
            });
        } catch (apiError) {
            if (apiError?.response?.status === 404) {
                try {
                    response = await axios.get('https://api.live.vkvideo.ru/v1/channel_roles/user', {
                        params: {
                            channel_url: vkplayIntegration.channelUrl,
                            user_id: userId
                        },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } catch (error2) {
                    // Если 404 - это может означать, что у пользователя просто нет ролей
                    if (error2?.response?.status === 404) {
                        console.log(`ℹ️ У пользователя ${userId} нет ролей (404)`);
                        return []; // Возвращаем пустой массив, а не null
                    }
                    throw error2;
                }
            } else {
                throw apiError;
            }
        }

        const roles = response.data?.data?.roles || [];
        console.log(`👤 Роли пользователя ${userId}:`, roles.map(r => r.name || r.id).join(', ') || 'нет ролей');
        return roles;
    } catch (error) {
        // Если ошибка 404 - у пользователя просто нет ролей
        if (error?.response?.status === 404) {
            console.log(`ℹ️ У пользователя ${userId} нет ролей (404)`);
            return []; // Возвращаем пустой массив
        }
        console.error('❌ Ошибка получения ролей пользователя:', error?.response?.status || error.message);
        return []; // Возвращаем пустой массив вместо null
    }
}

// Проверка наличия роли у пользователя
async function userHasRole(userId, roleId) {
    const roles = await getUserRoles(userId);
    if (!roles || roles.length === 0) return false;
    return roles.some(role => role.id === roleId);
}

// Отправка сообщения в чат VK Play
// useBot: true - отправить от имени бота, false - от основного аккаунта
async function sendChatMessage(message, userId = null, useBot = false) {
    try {
        // Выбираем интеграцию (бота или основной аккаунт)
        const integration = useBot ? vkplayBotIntegration : vkplayIntegration;
        const integrationName = useBot ? 'бот' : 'основной аккаунт';
        
        if (!integration.connected || !integration.tokens || !integration.channelUrl) {
            if (useBot) {
                console.warn('⚠️ VK Play Bot не подключен для отправки сообщения');
            } else {
                console.warn('⚠️ VK Play не подключен для отправки сообщения');
            }
            return false;
        }

        // Получаем информацию о пользователе для упоминания
        let userNick = null;
        if (userId) {
            try {
                const userInfo = await getUserInfo(userId);
                userNick = userInfo?.nick || null;
            } catch (e) {
                console.warn('⚠️ Не удалось получить информацию о пользователе:', e);
            }
        }

        // Получаем stream_id для отправки сообщения
        let streamId = null;
        try {
            let channelData;
            try {
                channelData = await axios.get('https://apidev.live.vkvideo.ru/v1/channel', {
                    params: { channel_url: integration.channelUrl },
                    headers: { Authorization: `Bearer ${integration.tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    channelData = await axios.get('https://api.live.vkvideo.ru/v1/channel', {
                        params: { channel_url: integration.channelUrl },
                        headers: { Authorization: `Bearer ${integration.tokens.access_token}` }
                    });
                } else {
                    throw apiError;
                }
            }
            
            streamId = channelData.data?.data?.stream?.id || null;
            if (!streamId) {
                console.warn('⚠️ Не удалось получить stream_id, сообщение может не отправиться');
            }
        } catch (e) {
            console.warn('⚠️ Ошибка получения stream_id:', e?.response?.data || e.message);
        }

        // Формируем сообщение согласно документации API
        const messageParts = [];
        
        // Если указан userId, добавляем упоминание в начале (даже если ник не получен)
        // Согласно документации, для mention нужен id, а nick опционален
        if (userId) {
            messageParts.push({
                mention: {
                    id: userId,
                    nick: userNick || ''  // Ник опционален, можно оставить пустым
                }
            });
            messageParts.push({
                text: {
                    content: ', ' + message
                }
            });
            console.log(`📝 Формируем сообщение с упоминанием пользователя: userId=${userId}, nick=${userNick || 'не получен'}`);
        } else {
            messageParts.push({
                text: {
                    content: message
                }
            });
            console.log('📝 Формируем сообщение без упоминания (userId не указан)');
        }

        // Отправляем сообщение в чат согласно документации: POST /v1/chat/message/send
        const requestBody = {
            parts: messageParts
        };
        
        const requestParams = {
            channel_url: integration.channelUrl
        };
        
        if (streamId) {
            requestParams.stream_id = streamId;
        }

        let response;
        try {
            response = await axios.post(
                'https://apidev.live.vkvideo.ru/v1/chat/message/send',
                requestBody,
                {
                    params: requestParams,
                    headers: { Authorization: `Bearer ${integration.tokens.access_token}` }
                }
            );
        } catch (apiError) {
            if (apiError?.response?.status === 404) {
                response = await axios.post(
                    'https://api.live.vkvideo.ru/v1/chat/message/send',
                    requestBody,
                    {
                        params: requestParams,
                        headers: { Authorization: `Bearer ${integration.tokens.access_token}` }
                    }
                );
            } else {
                throw apiError;
            }
        }

        console.log(`✅ Сообщение отправлено в чат от ${integrationName}: ${message}`);
        return true;
    } catch (error) {
        console.error(`❌ Ошибка отправки сообщения в чат от ${useBot ? 'бота' : 'основного аккаунта'}:`, error?.response?.data || error.message);
        // Если API для отправки сообщений недоступен, логируем предупреждение
        if (error.response?.status === 404 || error.response?.status === 501) {
            console.warn('⚠️ API для отправки сообщений в чат недоступен. Возможно, нужны дополнительные права доступа.');
        } else if (error.response?.status === 403) {
            console.warn('⚠️ Доступ запрещен. Проверьте права доступа (scope: chat:message:send)');
        }
        return false;
    }
}

// Отмена активации награды (возврат баллов)
async function cancelRewardActivation(rewardId, userId, rewardPrice) {
    try {
        if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
            console.warn('⚠️ VK Play не подключен для отмены награды');
            return false;
        }

        console.log(`🔄 Попытка отмены награды ${rewardId} для пользователя ${userId}...`);

        // Получаем список запросов наград (demands) - ищем активный запрос от этого пользователя
        let demandsResponse;
        try {
            demandsResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_point/reward/demands', {
                params: {
                    channel_url: vkplayIntegration.channelUrl,
                    limit: 100,
                    offset: 0
                },
                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
            });
        } catch (apiError) {
            if (apiError?.response?.status === 404) {
                demandsResponse = await axios.get('https://api.live.vkvideo.ru/v1/channel_point/reward/demands', {
                    params: {
                        channel_url: vkplayIntegration.channelUrl,
                        limit: 100,
                        offset: 0
                    },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } else {
                throw apiError;
            }
        }

        const demands = demandsResponse.data?.data?.demands || [];
        console.log(`🔍 Найдено ${demands.length} запросов наград, ищем запрос от пользователя ${userId} для награды ${rewardId}...`);

        // Ищем запрос от этого пользователя для этой награды (может быть pending, accepted, completed)
        const userDemand = demands.find(d => 
            d.user?.id === userId && 
            d.reward?.id === rewardId
        );

        if (!userDemand) {
            console.warn(`⚠️ Запрос награды не найден для userId=${userId}, rewardId=${rewardId}`);
            return false;
        }

        console.log(`✅ Найден запрос награды: ID=${userDemand.id}, статус=${userDemand.status}`);

        // Пытаемся отклонить запрос (это должно вернуть баллы)
        try {
            let rejectResponse;
            try {
                rejectResponse = await axios.post(
                    'https://apidev.live.vkvideo.ru/v1/channel_point/reward/demand/reject',
                    { demands: [{ id: userDemand.id }] },
                    {
                        params: { channel_url: vkplayIntegration.channelUrl },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    }
                );
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    rejectResponse = await axios.post(
                        'https://api.live.vkvideo.ru/v1/channel_point/reward/demand/reject',
                        { demands: [{ id: userDemand.id }] },
                        {
                            params: { channel_url: vkplayIntegration.channelUrl },
                            headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                        }
                    );
                } else {
                    throw apiError;
                }
            }

            console.log(`✅ Запрос награды отклонен (ID: ${userDemand.id}), баллы должны быть возвращены пользователю ${userId}`);
            return true;
        } catch (error) {
            console.error('❌ Ошибка при попытке отклонить запрос награды:', error?.response?.status, error?.response?.data || error.message);
            // Если ошибка 400 или 404, возможно запрос уже обработан
            if (error?.response?.status === 400 || error?.response?.status === 404) {
                console.warn(`⚠️ Запрос награды уже обработан или не может быть отклонен (статус: ${userDemand.status})`);
            }
            return false;
        }
    } catch (error) {
        console.error('❌ Ошибка отмены награды:', error?.response?.status, error?.response?.data || error.message);
        return false;
    }
}

// Получение информации о пользователе (ник)
async function getUserInfo(userId) {
    try {
        if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
            console.warn(`⚠️ VK Play не подключен, невозможно получить ник пользователя ${userId}`);
            return null;
        }

        // Метод 1: Пробуем получить информацию через chat/member
        let response;
        try {
            response = await axios.get('https://apidev.live.vkvideo.ru/v1/chat/member', {
                params: {
                    channel_url: vkplayIntegration.channelUrl,
                    user_id: userId
                },
                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
            });
            
            const user = response.data?.data?.user || response.data?.data?.member?.user || response.data?.user;
            if (user && user.nick && typeof user.nick === 'string' && user.nick.trim() !== '') {
                const nick = user.nick.trim();
                console.log(`✅ Получен ник пользователя ${userId} через chat/member: "${nick}"`);
                return { ...user, nick };
            }
        } catch (apiError) {
            if (apiError?.response?.status === 404) {
                try {
                    response = await axios.get('https://api.live.vkvideo.ru/v1/chat/member', {
                        params: {
                            channel_url: vkplayIntegration.channelUrl,
                            user_id: userId
                        },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                    
                    const user = response.data?.data?.user || response.data?.data?.member?.user || response.data?.user;
                    if (user && user.nick && typeof user.nick === 'string' && user.nick.trim() !== '') {
                        const nick = user.nick.trim();
                        console.log(`✅ Получен ник пользователя ${userId} через chat/member (основной API): "${nick}"`);
                        return { ...user, nick };
                    }
                } catch (error2) {
                    console.warn(`⚠️ Не удалось получить ник пользователя ${userId} через chat/member:`, error2?.response?.status || error2.message);
                }
            } else {
                console.warn(`⚠️ Ошибка получения ника пользователя ${userId} через chat/member:`, apiError?.response?.status || apiError.message);
            }
        }
        
        // Метод 2: Если API не сработал, пробуем получить ник из сохраненных сообщений чата
        try {
            const chatNick = await new Promise((resolve) => {
                db.get(
                    'SELECT username FROM chat_messages WHERE platform = ? AND user_id = ? AND username IS NOT NULL AND username != "" ORDER BY created_at DESC LIMIT 1',
                    ['vkplay', userId],
                    (err, row) => {
                        if (!err && row && row.username && row.username.trim() !== '') {
                            const nick = row.username.trim();
                            console.log(`✅ Получен ник пользователя ${userId} из сообщений чата: "${nick}"`);
                            resolve(nick);
                        } else {
                            resolve(null);
                        }
                    }
                );
            });
            
            if (chatNick) {
                return { nick: chatNick, id: userId };
            }
        } catch (dbError) {
            console.warn(`⚠️ Ошибка получения ника из БД для userId=${userId}:`, dbError);
        }

        // Метод 3: Пробуем получить через список участников чата (chat/members)
        try {
            let membersResponse;
            try {
                membersResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/chat/members', {
                    params: {
                        channel_url: vkplayIntegration.channelUrl,
                        limit: 200  // Максимум участников
                    },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } catch (apiError) {
                if (apiError?.response?.status === 404) {
                    membersResponse = await axios.get('https://api.live.vkvideo.ru/v1/chat/members', {
                        params: {
                            channel_url: vkplayIntegration.channelUrl,
                            limit: 200
                        },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                } else {
                    throw apiError;
                }
            }
            
            const users = membersResponse.data?.data?.users || [];
            const foundUser = users.find(u => u.id === userId);
            if (foundUser && foundUser.nick && typeof foundUser.nick === 'string' && foundUser.nick.trim() !== '') {
                const nick = foundUser.nick.trim();
                console.log(`✅ Получен ник пользователя ${userId} через chat/members: "${nick}"`);
                return { ...foundUser, nick };
            }
        } catch (membersError) {
            // Игнорируем ошибку, пробуем следующий метод
        }

        // Метод 4: Пробуем получить через список ролей пользователя (там может быть ник)
        try {
            const rolesResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_roles/user', {
                params: {
                    channel_url: vkplayIntegration.channelUrl,
                    user_id: userId
                },
                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
            });
            
            // В ответе может быть информация о пользователе
            const user = rolesResponse.data?.data?.user;
            if (user && user.nick && typeof user.nick === 'string' && user.nick.trim() !== '') {
                const nick = user.nick.trim();
                console.log(`✅ Получен ник пользователя ${userId} через channel_roles/user: "${nick}"`);
                return { ...user, nick };
            }
        } catch (rolesError) {
            if (rolesError?.response?.status === 404) {
                try {
                    const rolesResponse2 = await axios.get('https://api.live.vkvideo.ru/v1/channel_roles/user', {
                        params: {
                            channel_url: vkplayIntegration.channelUrl,
                            user_id: userId
                        },
                        headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                    });
                    
                    const user = rolesResponse2.data?.data?.user;
                    if (user && user.nick && typeof user.nick === 'string' && user.nick.trim() !== '') {
                        const nick = user.nick.trim();
                        console.log(`✅ Получен ник пользователя ${userId} через channel_roles/user (основной API): "${nick}"`);
                        return { ...user, nick };
                    }
                } catch (error3) {
                    // Игнорируем ошибку
                }
            }
        }

        console.warn(`⚠️ Ник пользователя ${userId} не найден ни одним методом`);
        return null;
    } catch (error) {
        console.warn(`⚠️ Ошибка получения информации о пользователе ${userId}:`, error?.response?.status || error.message);
        return null;
    }
}

// Сохранение истории выдачи роли
// Если userNick не передан, пытаемся получить его перед сохранением
async function saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, roleName, status, reason = null) {
    const channelUrl = vkplayIntegration.channelUrl;
    if (!channelUrl) {
        console.error('❌ channelUrl не установлен, невозможно сохранить историю');
        return;
    }

    // Убеждаемся, что userNick - это строка или null, а не undefined
    let finalUserNick = userNick && typeof userNick === 'string' && userNick.trim() !== '' ? userNick.trim() : null;
    
    // Если ник не передан, пытаемся получить его перед сохранением
    if (!finalUserNick && userId) {
        try {
            const userInfo = await getUserInfo(userId);
            if (userInfo && userInfo.nick && userInfo.nick.trim() !== '') {
                finalUserNick = userInfo.nick.trim();
                console.log(`✅ Ник получен перед сохранением истории для userId=${userId}: "${finalUserNick}"`);
            }
        } catch (err) {
            console.warn(`⚠️ Не удалось получить ник для userId=${userId} перед сохранением истории:`, err?.message || err);
        }
    }
    
    console.log(`📝 Сохранение истории роли:`, {
        userId,
        userNick_original: userNick,
        userNick_final: finalUserNick || 'NULL',
        rewardId,
        rewardName,
        roleId,
        roleName,
        status,
        reason,
        channelUrl
    });

    db.run(
        `INSERT INTO vkplay_role_history 
        (user_id, user_nick, reward_id, reward_name, role_id, role_name, status, reason, channel_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, finalUserNick, rewardId, rewardName, roleId, roleName, status, reason, channelUrl],
        function(err) {
            if (err) {
                console.error('❌ Ошибка сохранения истории роли:', err);
            } else {
                const historyId = this.lastID;
                console.log(`✅ История роли сохранена (ID: ${historyId}): ${status} для пользователя ${userId} (${finalUserNick || 'без ника'}), награда: ${rewardName}, роль: ${roleName}`);
                
                // Если ник не был сохранен, пытаемся получить его асинхронно и обновить запись
                if (!finalUserNick && userId) {
                    console.log(`⚠️ Ник не был сохранен для userId=${userId}, пытаемся получить через getUserInfo...`);
                    getUserInfo(userId).then(userInfo => {
                        if (userInfo && userInfo.nick && userInfo.nick.trim() !== '') {
                            const retrievedNick = userInfo.nick.trim();
                            console.log(`✅ Ник получен для userId=${userId}: ${retrievedNick}, обновляем запись ID=${historyId} в БД...`);
                            // Обновляем запись в БД с полученным ником
                            db.run(
                                'UPDATE vkplay_role_history SET user_nick = ? WHERE id = ?',
                                [retrievedNick, historyId],
                                function(updateErr) {
                                    if (updateErr) {
                                        console.error('❌ Ошибка обновления ника в истории:', updateErr);
                                    } else {
                                        console.log(`✅ Ник "${retrievedNick}" обновлен в истории для userId=${userId} (ID записи: ${historyId})`);
                                        // Отправляем обновление через WebSocket
                                        if (wss && wss.clients) {
                                            const message = JSON.stringify({
                                                type: 'VKPLAY_ROLE_HISTORY_UPDATE',
                                                data: { userId, userNick: retrievedNick }
                                            });
                                            wss.clients.forEach((client) => {
                                                if (client.readyState === WebSocket.OPEN) {
                                                    try {
                                                        client.send(message);
                                                    } catch (error) {
                                                        console.error('❌ Ошибка отправки обновления ника:', error);
                                                    }
                                                }
                                            });
                                        }
                                    }
                                }
                            );
                        } else {
                            console.warn(`⚠️ Не удалось получить ник для userId=${userId} через getUserInfo`);
                        }
                    }).catch(err => {
                        console.error(`❌ Ошибка получения ника для userId=${userId}:`, err);
                    });
                }
                
                // Отправляем обновление через WebSocket всем подключенным клиентам
                if (wss && wss.clients) {
                    const message = JSON.stringify({
                        type: 'VKPLAY_ROLE_HISTORY_UPDATE',
                        data: {
                            id: this.lastID,
                            userId,
                            userNick: finalUserNick,
                            rewardId,
                            rewardName,
                            roleId,
                            roleName,
                            status,
                            reason,
                            timestamp: new Date().toISOString()
                        }
                    });
                    
                    let sentCount = 0;
                    wss.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            try {
                                client.send(message);
                                sentCount++;
                            } catch (error) {
                                console.error('❌ Ошибка отправки WebSocket сообщения:', error);
                            }
                        }
                    });
                    if (sentCount > 0) {
                        console.log(`📤 Отправлено обновление истории через WebSocket ${sentCount} клиентам`);
                    }
                } else {
                    console.warn('⚠️ WebSocket сервер не доступен для отправки обновления истории');
                }
            }
        }
    );
}

// Выдача роли пользователю с проверкой
async function assignRoleToUser(userId, roleId, rewardId, rewardName) {
    try {
        if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
            console.warn('⚠️ VK Play не подключен для выдачи роли');
            return { success: false, reason: 'not_connected' };
        }

        // Получаем информацию о пользователе (ник)
        let userNick = null;
        const userInfo = await getUserInfo(userId);
        if (userInfo && userInfo.nick) {
            userNick = userInfo.nick;
            console.log(`✅ Ник пользователя ${userId} получен в assignRoleToUser: ${userNick}`);
        } else {
            console.warn(`⚠️ Не удалось получить ник пользователя ${userId} в assignRoleToUser`);
        }

        // Получаем имя роли из базы данных
        return new Promise((resolve) => {
            db.get(
                'SELECT role_name FROM vkplay_reward_roles WHERE reward_id = ? AND channel_url = ?',
                [rewardId, vkplayIntegration.channelUrl],
                async (err, row) => {
                    const finalRoleName = row?.role_name || rewardName;

                    // Проверяем, есть ли уже эта роль у пользователя
                    const hasRole = await userHasRole(userId, roleId);
                    if (hasRole) {
                        console.log(`⚠️ У пользователя ${userId} уже есть роль ${roleId}`);
                        
                        // СНАЧАЛА сохраняем в историю, что роль уже есть
                        await saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'rejected', 'Роль уже есть у пользователя');
                        console.log(`✅ Запись в истории сохранена: роль уже есть у пользователя ${userId}`);
                        
                        // Затем получаем информацию о награде для получения цены
                        let rewardsResponse;
                        try {
                            rewardsResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/channel_point/rewards', {
                                params: { channel_url: vkplayIntegration.channelUrl },
                                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                            });
                        } catch (apiError) {
                            if (apiError?.response?.status === 404) {
                                rewardsResponse = await axios.get('https://api.live.vkvideo.ru/v1/channel_point/rewards', {
                                    params: { channel_url: vkplayIntegration.channelUrl },
                                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                                });
                            } else {
                                throw apiError;
                            }
                        }

                        const reward = rewardsResponse.data?.data?.rewards?.find(r => r.id === rewardId);
                        const rewardPrice = reward?.price || 0;

                        // Отменяем активацию награды (возвращаем баллы)
                        console.log(`🔄 Отмена награды ${rewardId} для пользователя ${userId}...`);
                        const cancelResult = await cancelRewardActivation(rewardId, userId, rewardPrice);
                        if (cancelResult) {
                            console.log(`✅ Награда отменена, баллы возвращены пользователю ${userId}`);
                        } else {
                            console.warn(`⚠️ Не удалось отменить награду для пользователя ${userId} (возможно, награда уже обработана)`);
                        }

                        // Отправляем сообщение в чат от имени бота (если подключен) или основного аккаунта
                        // Упоминаем пользователя по userId, чтобы он получил уведомление
                        const message = `у вас уже есть роль "${finalRoleName}", баллы возвращены`;
                        console.log(`📨 Отправляем сообщение пользователю ${userId} (${userNick || 'ник не получен'}): "${message}"`);
                        let sent = false;
                        if (vkplayBotIntegration.connected) {
                            sent = await sendChatMessage(message, userId, true);
                        }
                        if (!sent) {
                            await sendChatMessage(message, userId, false);
                        }

                        resolve({ success: false, reason: 'already_has_role', message: 'Роль уже есть, баллы возвращены' });
                        return;
                    }

                    try {
                        // Получаем текущие роли пользователя, чтобы не потерять существующие
                        const currentRoles = await getUserRoles(userId);
                        const currentRoleIds = currentRoles.map(r => r.id);
                        
                        console.log(`📋 Текущие роли пользователя ${userId}:`, currentRoleIds.length > 0 ? currentRoleIds.join(', ') : 'нет ролей');
                        
                        // Проверяем, есть ли уже эта роль
                        if (currentRoleIds.includes(roleId)) {
                            console.log(`ℹ️ У пользователя ${userId} уже есть роль ${finalRoleName}, пропускаем выдачу`);
                            // Сохраняем в историю как "assigned" (роль уже была)
                            await saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'assigned', 'Роль уже была у пользователя');
                            
                            // Отправляем сообщение в чат от имени бота (если подключен) или основного аккаунта
                            // Упоминаем пользователя по userId, чтобы он получил уведомление
                            const message = `у вас уже есть роль "${finalRoleName}"`;
                            console.log(`📨 Отправляем сообщение пользователю ${userId} (${userNick || 'ник не получен'}): "${message}"`);
                            let sent = false;
                            if (vkplayBotIntegration.connected) {
                                sent = await sendChatMessage(message, userId, true);
                            }
                            if (!sent) {
                                await sendChatMessage(message, userId, false);
                            }
                            
                            resolve({ success: true, reason: 'already_has_role' });
                            return;
                        }

                        // Добавляем новую роль к существующим
                        const rolesToSet = [...currentRoleIds, roleId].map(id => ({ id }));
                        console.log(`🎯 Выдаем роли пользователю ${userId}:`, rolesToSet.map(r => r.id).join(', '));

                        // Выдаем роль (вместе с существующими)
                        let response;
                        let apiError = null;
                        try {
                            response = await axios.post(
                                'https://apidev.live.vkvideo.ru/v1/channel_roles/user/set',
                                { roles: rolesToSet },
                                {
                                    params: {
                                        channel_url: vkplayIntegration.channelUrl,
                                        user_id: userId
                                    },
                                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                                }
                            );
                            console.log(`✅ Роль успешно выдана через apidev API`);
                        } catch (error1) {
                            apiError = error1;
                            if (error1?.response?.status === 404 || error1?.response?.status === 502) {
                                // Fallback на основной API
                                try {
                                    response = await axios.post(
                                        'https://api.live.vkvideo.ru/v1/channel_roles/user/set',
                                        { roles: rolesToSet },
                                        {
                                            params: {
                                                channel_url: vkplayIntegration.channelUrl,
                                                user_id: userId
                                            },
                                            headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                                        }
                                    );
                                    console.log(`✅ Роль успешно выдана через основной API`);
                                    apiError = null; // Успешно получили ответ
                                } catch (error2) {
                                    // Если и основной API вернул ошибку, проверяем статус
                                    if (error2?.response?.status === 404 || error2?.response?.status === 502) {
                                        // 404 или 502 - временная ошибка сервера, но роль может быть выдана
                                        // Проверяем, выдалась ли роль
                                        console.log(`⚠️ Ошибка ${error2?.response?.status} при выдаче роли, проверяем через 2 секунды...`);
                                        setTimeout(async () => {
                                            const rolesAfter = await getUserRoles(userId);
                                            if (rolesAfter && rolesAfter.some(r => r.id === roleId)) {
                                                console.log(`✅ Роль ${finalRoleName} выдана пользователю ${userId} (проверено после ${error2?.response?.status})`);
                                                await saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'assigned', null);
                                                
                                                // Отправляем сообщение в чат от имени бота (если подключен) или основного аккаунта
                                                const message = `вам выдана роль "${finalRoleName}"`;
                                                let sent = false;
                                                if (vkplayBotIntegration.connected) {
                                                    sent = await sendChatMessage(message, userId, true);
                                                }
                                                if (!sent) {
                                                    await sendChatMessage(message, userId, false);
                                                }
                                            } else {
                                                console.error(`❌ Роль не выдана после ${error2?.response?.status} ошибки`);
                                                await saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'error', `Ошибка ${error2?.response?.status}: роль не выдана`);
                                            }
                                        }, 2000);
                                        resolve({ success: false, reason: 'error', error: `Ошибка ${error2?.response?.status}: проверяем выдачу роли` });
                                        return;
                                    }
                                    throw error2;
                                }
                            } else {
                                throw error1;
                            }
                        }

                        // Если получили успешный ответ
                        if (response && !apiError) {
                            console.log(`✅ Роль ${finalRoleName} выдана пользователю ${userId} (${userNick || 'без ника'})`);
                            
                            // Проверяем, что роль действительно выдана
                            setTimeout(async () => {
                                const rolesAfter = await getUserRoles(userId);
                                if (rolesAfter && rolesAfter.some(r => r.id === roleId)) {
                                    console.log(`✅ Роль ${finalRoleName} подтверждена у пользователя ${userId}`);
                                } else {
                                    console.warn(`⚠️ Роль ${finalRoleName} не найдена у пользователя ${userId} после выдачи`);
                                }
                            }, 1000);
                            
                            // Сохраняем в историю
                            await saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'assigned', null);
                            
                            // Отправляем сообщение в чат от имени бота (если подключен) или основного аккаунта
                            // Упоминаем пользователя по userId, чтобы он получил уведомление
                            const message = `вам выдана роль "${finalRoleName}"`;
                            console.log(`📨 Отправляем сообщение пользователю ${userId} (${userNick || 'ник не получен'}): "${message}"`);
                            let sent = false;
                            if (vkplayBotIntegration.connected) {
                                sent = await sendChatMessage(message, userId, true);
                            }
                            if (!sent) {
                                await sendChatMessage(message, userId, false);
                            }
                            
                            resolve({ success: true });
                        }
                    } catch (error) {
                        console.error('❌ Ошибка выдачи роли:', error?.response?.status || error.message);
                        // Проверяем, может роль все-таки выдалась (например, при 404 или 502)
                        if (error?.response?.status === 404 || error?.response?.status === 502) {
                            setTimeout(async () => {
                                const rolesAfter = await getUserRoles(userId);
                                if (rolesAfter && rolesAfter.some(r => r.id === roleId)) {
                                    console.log(`✅ Роль ${finalRoleName} выдана пользователю ${userId} (проверено после ${error?.response?.status})`);
                                    saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'assigned', null);
                                    
                                    // Отправляем сообщение в чат от имени бота (если подключен) или основного аккаунта
                                    // Упоминаем пользователя по userId, чтобы он получил уведомление
                                    const message = `вам выдана роль "${finalRoleName}"`;
                                    console.log(`📨 Отправляем сообщение пользователю ${userId} (${userNick || 'ник не получен'}): "${message}"`);
                                    let sent = false;
                                    if (vkplayBotIntegration.connected) {
                                        sent = await sendChatMessage(message, userId, true);
                                    }
                                    if (!sent) {
                                        await sendChatMessage(message, userId, false);
                                    }
                                } else {
                                    await saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'error', error.message);
                                }
                            }, 2000);
                            resolve({ success: false, reason: 'error', error: error.message });
                        } else {
                            saveRoleHistory(userId, userNick, rewardId, rewardName, roleId, finalRoleName, 'error', error.message);
                            resolve({ success: false, reason: 'error', error: error.message });
                        }
                    }
                }
            );
        });
    } catch (error) {
        console.error('❌ Ошибка выдачи роли:', error?.response?.data || error.message);
        return { success: false, reason: 'error', error: error.message };
    }
}

// Получение токена для WebSocket подписки
async function getWebSocketToken(channels = 'channel_point_rewards') {
    try {
        if (!vkplayIntegration.connected || !vkplayIntegration.tokens) {
            return null;
        }

        let response;
        try {
            response = await axios.get('https://apidev.live.vkvideo.ru/v1/websocket/subscription_token', {
                params: { channels },
                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
            });
        } catch (apiError) {
            if (apiError?.response?.status === 404) {
                response = await axios.get('https://api.live.vkvideo.ru/v1/websocket/subscription_token', {
                    params: { channels },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } else {
                throw apiError;
            }
        }

        const token = response.data?.data?.channel_tokens?.[0]?.token || null;
        if (token) {
            console.log(`✅ WebSocket токен получен для каналов: ${channels}`);
        } else {
            console.warn(`⚠️ WebSocket токен не получен для каналов: ${channels}`);
            console.warn('   Ответ API:', JSON.stringify(response.data, null, 2));
        }
        return token;
    } catch (error) {
        console.error('❌ Ошибка получения WebSocket токена:', error?.response?.data || error.message);
        return null;
    }
}

// WebSocket подключение для получения событий наград
let vkplayRewardsWs = null;
let vkplayRewardsWsReconnectTimeout = null;

async function connectVKPlayRewardsWebSocket() {
    if (!VKPLAY_POLLING_ENABLED) return;
    if (!vkplayIntegration.connected || !vkplayIntegration.tokens || !vkplayIntegration.channelUrl) {
        return;
    }

    try {
        // Получаем токен для подписки
        // Пробуем оба варианта: channel_point_rewards и channel_points
        let wsToken = await getWebSocketToken('channel_point_rewards');
        if (!wsToken) {
            console.log('⚠️ Не удалось получить токен для channel_point_rewards, пробуем channel_points...');
            wsToken = await getWebSocketToken('channel_points');
        }
        if (!wsToken) {
            console.warn('⚠️ Не удалось получить WebSocket токен для наград (ни channel_point_rewards, ни channel_points)');
            return;
        }

        // Получаем WebSocket URL из данных канала
        let channelData;
        try {
            channelData = await axios.get('https://apidev.live.vkvideo.ru/v1/channel', {
                params: { channel_url: vkplayIntegration.channelUrl },
                headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
            });
        } catch (apiError) {
            if (apiError?.response?.status === 404) {
                channelData = await axios.get('https://api.live.vkvideo.ru/v1/channel', {
                    params: { channel_url: vkplayIntegration.channelUrl },
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
            } else {
                throw apiError;
            }
        }
        
        // Пробуем оба варианта: channel_point_rewards и channel_points
        const webSocketChannels = channelData.data?.data?.channel?.web_socket_channels || {};
        const rewardsChannel = webSocketChannels.channel_point_rewards || webSocketChannels.channel_points;
        
        if (!rewardsChannel) {
            console.warn('⚠️ WebSocket канал для наград не доступен');
            console.warn('   Доступные каналы:', Object.keys(webSocketChannels));
            return;
        }
        
        console.log(`✅ Найден канал для наград: ${rewardsChannel}`);
        
        // Подключаемся к WebSocket через Centrifugo
        // Согласно документации, нужно использовать pubsub-dev.live.vkvideo.ru или pubsub.live.vkvideo.ru
        // И подключиться через Centrifugo протокол
        const wsUrl = `wss://pubsub-dev.live.vkvideo.ru/connection/websocket?format=json&cf_protocol_version=v2`;
        
        if (vkplayRewardsWs) {
            try { vkplayRewardsWs.close(); } catch(_) {}
        }

        console.log(`🔌 Подключение к WebSocket: ${wsUrl}`);
        console.log(`🔌 Подключение к WebSocket: ${wsUrl}`);
        vkplayRewardsWs = new WebSocket(wsUrl);

        vkplayRewardsWs.on('open', async () => {
            console.log('✅ WebSocket для наград VK Play подключен');
            
            // Получаем токен для подключения к pubsub
            try {
                const pubsubTokenResponse = await axios.get('https://apidev.live.vkvideo.ru/v1/websocket/token', {
                    headers: { Authorization: `Bearer ${vkplayIntegration.tokens.access_token}` }
                });
                
                const pubsubToken = pubsubTokenResponse.data?.data?.token;
                if (!pubsubToken) {
                    console.error('❌ Не удалось получить токен для pubsub');
                    return;
                }

                // Отправляем команду подключения с токеном
                const connectMessage = {
                    id: 1,
                    method: 'connect',
                    params: {
                        token: pubsubToken
                    }
                };
                
                vkplayRewardsWs.send(JSON.stringify(connectMessage));
                console.log('📤 Отправлена команда подключения к Centrifugo');
            } catch (error) {
                console.error('❌ Ошибка получения токена pubsub:', error?.response?.data || error.message);
            }
        });

        vkplayRewardsWs.on('message', async (data) => {
            try {
                const rawMessage = data.toString();
                console.log('📨 Получено WebSocket сообщение (raw):', rawMessage);
                
                let message;
                try {
                    message = JSON.parse(rawMessage);
                } catch (parseError) {
                    console.error('❌ Ошибка парсинга JSON:', parseError);
                    console.error('   Сырые данные:', rawMessage);
                    return;
                }

                console.log('📨 Событие награды VK Play (parsed):', JSON.stringify(message, null, 2));

                // Проверяем различные форматы сообщений Centrifugo
                let rewardId = null;
                let userId = null;
                let rewardName = null;
                let userName = null;

                // Формат 1: Прямые поля
                if (message.reward?.id) rewardId = message.reward.id;
                if (message.user?.id) userId = message.user.id;
                if (message.reward?.name) rewardName = message.reward.name;
                if (message.user?.nick) userName = message.user.nick;

                // Формат 2: Вложенные в data
                if (!rewardId && message.data?.reward?.id) rewardId = message.data.reward.id;
                if (!userId && message.data?.user?.id) userId = message.data.user.id;
                if (!rewardName && message.data?.reward?.name) rewardName = message.data.reward.name;
                if (!userName && message.data?.user?.nick) userName = message.data.user.nick;

                // Формат 3: Centrifugo публикация (result.data)
                if (!rewardId && message.result?.data?.reward?.id) rewardId = message.result.data.reward.id;
                if (!userId && message.result?.data?.user?.id) userId = message.result.data.user.id;
                if (!rewardName && message.result?.data?.reward?.name) rewardName = message.result.data.reward.name;
                if (!userName && message.result?.data?.user?.nick) userName = message.result.data.user.nick;

                // Формат 4: В публикации (publication.data)
                if (!rewardId && message.publication?.data?.reward?.id) rewardId = message.publication.data.reward.id;
                if (!userId && message.publication?.data?.user?.id) userId = message.publication.data.user.id;
                if (!rewardName && message.publication?.data?.reward?.name) rewardName = message.publication.data.reward.name;
                if (!userName && message.publication?.data?.user?.nick) userName = message.publication.data.user.nick;

                // Проверяем тип события
                const eventType = message.type || message.event || message.result?.data?.type || message.publication?.data?.type;
                console.log(`🔍 Тип события: ${eventType}, rewardId: ${rewardId}, userId: ${userId}`);

                // Обрабатываем активацию награды
                if (eventType === 'reward_activated' || eventType === 'channel_point_reward_activated' || 
                    message.type === 'reward_activated' || message.event === 'reward_activated' ||
                    (rewardId && userId)) {
                    
                    if (!rewardId || !userId) {
                        console.warn('⚠️ Не удалось извлечь rewardId или userId из сообщения');
                        console.warn('   Структура сообщения:', JSON.stringify(message, null, 2));
                        return;
                    }

                    console.log(`🎁 Обработка активации награды: rewardId=${rewardId}, userId=${userId}, rewardName=${rewardName || 'неизвестно'}`);

                    // Ищем связь награда-роль
                    db.get(
                        'SELECT * FROM vkplay_reward_roles WHERE reward_id = ? AND channel_url = ? AND enabled = 1',
                        [rewardId, vkplayIntegration.channelUrl],
                        async (err, row) => {
                            if (err) {
                                console.error('❌ Ошибка поиска связи награда-роль:', err);
                                return;
                            }

                            // Получаем ник пользователя, если его нет в сообщении
                            let finalUserName = userName;
                            if (finalUserName && typeof finalUserName === 'string' && finalUserName.trim() !== '') {
                                finalUserName = finalUserName.trim();
                                console.log(`✅ Ник пользователя ${userId} получен из WebSocket события: "${finalUserName}"`);
                            } else {
                                console.log(`🔍 Ник не найден в WebSocket событии для userId=${userId}, пытаемся получить через API...`);
                                const userInfo = await getUserInfo(userId);
                                finalUserName = userInfo?.nick || null;
                                if (finalUserName) {
                                    console.log(`✅ Ник пользователя ${userId} получен через API: "${finalUserName}"`);
                                } else {
                                    console.warn(`⚠️ Не удалось получить ник пользователя ${userId} ни из WebSocket события, ни через API`);
                                }
                            }

                            if (!row) {
                                console.warn(`⚠️ Связь награда-роль не найдена для rewardId=${rewardId}, channelUrl=${vkplayIntegration.channelUrl}`);
                                // Сохраняем в историю как "не найдена связь"
                                await saveRoleHistory(userId, finalUserName, rewardId, rewardName || 'Неизвестная награда', '', '', 'error', 'Связь награда-роль не найдена');
                                return;
                            }

                            console.log(`✅ Найдена связь: ${row.reward_name} → ${row.role_name}`);
                            console.log(`🎁 Награда ${row.reward_name} активирована пользователем ${userId} (${finalUserName || 'без ника'}), выдаем роль ${row.role_name}`);
                            
                            const result = await assignRoleToUser(userId, row.role_id, row.reward_id, row.reward_name);
                            if (result.success) {
                                console.log(`✅ Роль ${row.role_name} успешно выдана пользователю ${userId}`);
                            } else {
                                console.log(`⚠️ Роль не выдана: ${result.reason || 'неизвестная причина'}`);
                            }
                        }
                    );
                } else {
                    console.log(`ℹ️ Игнорируем событие типа: ${eventType}`);
                }
            } catch (error) {
                console.error('❌ Ошибка обработки WebSocket сообщения:', error);
                console.error('   Stack:', error.stack);
            }
        });

        vkplayRewardsWs.on('error', (error) => {
            console.error('❌ Ошибка WebSocket наград:', error);
        });

        vkplayRewardsWs.on('close', () => {
            console.log('⚠️ WebSocket для наград VK Play отключен, переподключение через 10 секунд...');
            vkplayRewardsWsReconnectTimeout = setTimeout(connectVKPlayRewardsWebSocket, 10000);
        });

    } catch (error) {
        console.error('❌ Ошибка подключения WebSocket для наград:', error);
        vkplayRewardsWsReconnectTimeout = setTimeout(connectVKPlayRewardsWebSocket, 10000);
    }
}

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
        if (!memoryAppStateLoaded || !memoryAppState) return;
        updateAppState(
            { timer_seconds: memoryAppState.timer_seconds },
            (err) => {
                if (err) console.error('❌ Ошибка сохранения таймера в БД:', err);
            }
        );
    }, TIMER_DB_FLUSH_MS);
}

function updateTimer() {
    if (!memoryAppStateLoaded || !memoryAppState) return;
    const state = memoryAppState;

    // Тикаем в памяти; в SQLite пишем раз в 10 с, чтобы не блокировать чтения
    if (!state.timer_paused && state.timer_seconds > 0) {
        const newSeconds = Math.max(0, (state.timer_seconds || 0) - 1);
        if (newSeconds !== state.timer_seconds) {
            state.timer_seconds = newSeconds;
            scheduleTimerDbFlush();
        }
    }
}

// API для достижений донатеров
app.get('/api/donor-achievements', (req, res) => {
    // Используем GROUP BY для предотвращения дублирования
    db.all(`SELECT da.id, da.normalized_username, da.username, da.total_time_seconds, da.total_time_minutes,
                   da.current_tier_id, da.last_donation_id, da.last_donation_time, da.created_at, da.updated_at,
                   dat.name as tier_name, dat.icon as tier_icon, dat.color as tier_color, dat.custom_icon_url as tier_custom_icon_url
            FROM donor_achievements da
            LEFT JOIN donor_achievement_tiers dat ON da.current_tier_id = dat.id
            GROUP BY da.normalized_username
            ORDER BY da.total_time_minutes DESC`, (err, achievements) => {
        if (err) {
            console.error('❌ Ошибка получения достижений:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, achievements: achievements || [] });
    });
});

app.get('/api/donor-achievements/:username', (req, res) => {
    const normalizedUsername = normalizeUsername(req.params.username);
    if (!normalizedUsername) {
        return res.status(400).json({ success: false, error: 'Invalid username' });
    }
    
    db.get(`SELECT da.*, dat.name as tier_name, dat.icon as tier_icon, dat.color as tier_color, dat.description as tier_description
            FROM donor_achievements da
            LEFT JOIN donor_achievement_tiers dat ON da.current_tier_id = dat.id
            WHERE da.normalized_username = ?`, [normalizedUsername], (err, achievement) => {
        if (err) {
            console.error('❌ Ошибка получения достижения:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        if (!achievement) {
            return res.status(404).json({ success: false, error: 'Achievement not found' });
        }
        res.json({ success: true, achievement });
    });
});

app.get('/api/donor-achievement-tiers', (req, res) => {
    // Используем DISTINCT и GROUP BY для гарантированного удаления дубликатов
    db.all(`
        SELECT DISTINCT 
            id, name, min_minutes, max_minutes, icon, custom_icon_url, 
            color, description, sort_order, created_at, updated_at
        FROM donor_achievement_tiers 
        WHERE id IN (
            SELECT MIN(id) 
            FROM donor_achievement_tiers 
            GROUP BY sort_order
        )
        ORDER BY sort_order ASC
    `, (err, tiers) => {
        if (err) {
            console.error('❌ Ошибка получения уровней:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        // Дополнительная фильтрация на случай если все еще есть дубликаты
        const uniqueTiers = [];
        const seenIds = new Set();
        const seenSortOrders = new Set();
        
        (tiers || []).forEach(tier => {
            // Проверяем и по id, и по sort_order
            if (tier.id && !seenIds.has(tier.id) && tier.sort_order !== null && !seenSortOrders.has(tier.sort_order)) {
                seenIds.add(tier.id);
                seenSortOrders.add(tier.sort_order);
                uniqueTiers.push(tier);
            }
        });
        
        console.log(`📊 Загружено уровней: ${tiers?.length || 0}, уникальных: ${uniqueTiers.length}`);
        
        res.json({ success: true, tiers: uniqueTiers });
    });
});

app.put('/api/donor-achievement-tiers/:id', (req, res) => {
    const tierId = parseInt(req.params.id);
    const { name, min_minutes, max_minutes, icon, color, description } = req.body;
    
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (min_minutes !== undefined) updates.min_minutes = min_minutes;
    if (max_minutes !== undefined) updates.max_minutes = max_minutes === '' ? null : max_minutes;
    if (icon !== undefined) updates.icon = icon;
    if (color !== undefined) updates.color = color;
    if (description !== undefined) updates.description = description;
    
    const fields = Object.keys(updates);
    if (fields.length === 0) {
        return res.status(400).json({ success: false, error: 'No fields to update' });
    }
    
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => updates[f]);
    values.push(tierId);
    
    db.run(`UPDATE donor_achievement_tiers SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        values, function(err) {
            if (err) {
                console.error('❌ Ошибка обновления уровня:', err);
                return res.status(500).json({ success: false, error: err.message });
            }
            res.json({ success: true, message: 'Tier updated successfully' });
        });
});

// API для загрузки значка достижения
app.post('/api/donor-achievement-tiers/:id/upload-icon', (req, res) => {
    const tierId = parseInt(req.params.id);
    if (!tierId) {
        return res.status(400).json({ success: false, error: 'Invalid tier ID' });
    }
    
    // Проверяем наличие изображения в base64
    const { imageData } = req.body;
    if (!imageData || !imageData.startsWith('data:image/')) {
        return res.status(400).json({ success: false, error: 'Invalid image data' });
    }
    
    // Создаем директорию для значков если её нет
    const iconsDir = path.join(__dirname, 'public', 'uploads', 'achievement-icons');
    if (!fs.existsSync(iconsDir)) {
        fs.mkdirSync(iconsDir, { recursive: true });
    }
    
    // Извлекаем данные изображения
    const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) {
        return res.status(400).json({ success: false, error: 'Invalid image format' });
    }
    
    const imageType = matches[1];
    const imageBuffer = Buffer.from(matches[2], 'base64');
    
    // Сохраняем файл
    const filename = `tier_${tierId}_${Date.now()}.${imageType}`;
    const filepath = path.join(iconsDir, filename);
    
    fs.writeFile(filepath, imageBuffer, (err) => {
        if (err) {
            console.error('❌ Ошибка сохранения значка:', err);
            return res.status(500).json({ success: false, error: 'Failed to save icon' });
        }
        
        // Обновляем URL в базе данных
        const iconUrl = `/uploads/achievement-icons/${filename}`;
        db.run(`UPDATE donor_achievement_tiers SET custom_icon_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [iconUrl, tierId], (updateErr) => {
                if (updateErr) {
                    console.error('❌ Ошибка обновления URL значка:', updateErr);
                    // Удаляем файл если не удалось обновить БД
                    try { fs.unlinkSync(filepath); } catch(e) {}
                    return res.status(500).json({ success: false, error: 'Failed to update database' });
                }
                res.json({ success: true, iconUrl: iconUrl });
            });
    });
});

// API для удаления значка достижения
app.delete('/api/donor-achievement-tiers/:id/icon', (req, res) => {
    const tierId = parseInt(req.params.id);
    if (!tierId) {
        return res.status(400).json({ success: false, error: 'Invalid tier ID' });
    }
    
    // Получаем текущий URL значка
    db.get('SELECT custom_icon_url FROM donor_achievement_tiers WHERE id = ?', [tierId], (err, tier) => {
        if (err) {
            console.error('❌ Ошибка получения значка:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        if (!tier || !tier.custom_icon_url) {
            return res.status(404).json({ success: false, error: 'Icon not found' });
        }
        
        // Удаляем файл
        const filepath = path.join(__dirname, 'public', tier.custom_icon_url);
        if (fs.existsSync(filepath)) {
            try {
                fs.unlinkSync(filepath);
            } catch (unlinkErr) {
                console.error('❌ Ошибка удаления файла:', unlinkErr);
            }
        }
        
        // Обновляем БД
        db.run('UPDATE donor_achievement_tiers SET custom_icon_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [tierId], (updateErr) => {
                if (updateErr) {
                    console.error('❌ Ошибка удаления значка из БД:', updateErr);
                    return res.status(500).json({ success: false, error: 'Failed to update database' });
                }
                res.json({ success: true, message: 'Icon deleted successfully' });
            });
    });
});

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
    if (memoryAppStateLoaded && memoryAppState) {
        db.run(
            'UPDATE app_state SET timer_seconds = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
            [memoryAppState.timer_seconds],
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
