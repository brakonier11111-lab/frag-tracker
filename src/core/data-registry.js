'use strict';
/**
 * Реестр источников данных для конструктора виджетов (public/widget-builder.html).
 *
 * Каждая запись описывает один "источник" (обычно = модуль), из которого можно
 * забиндить значение на элемент виджета: как получить снапшот при загрузке
 * (restEndpoint), как ловить live-обновления по WS (messageType + payloadPath),
 * и какие поля внутри полезны (fields — с точечными путями для вложенных объектов).
 *
 * Источники без messageType — REST/poll-only модули, рендерер конструктора
 * должен опрашивать их по таймеру вместо подписки на WS.
 *
 * ВАЖНО: сюда сознательно не включены da_access_token/lesta_access_token и другие
 * секреты, даже если они есть в STATE_UPDATE/app_state — виджеты их не должны видеть.
 */

const SOURCES = [
    {
        moduleId: 'app-state',
        label: 'Общее состояние (режимы 1-3, Lesta)',
        messageType: 'STATE_UPDATE',
        payloadPath: 'state',
        restEndpoint: '/api/state',
        fields: [
            { key: 'current_mode', label: 'Текущий режим', type: 'string' },
            { key: 'frags_needed', label: 'Фрагов нужно (реж.1)', type: 'number' },
            { key: 'frags_done', label: 'Фрагов сделано (реж.1)', type: 'number' },
            { key: 'current_balance', label: 'Текущий баланс (реж.1)', type: 'number' },
            { key: 'total_donated', label: 'Всего задонатили (реж.1)', type: 'number' },
            { key: 'timer_seconds', label: 'Секунд осталось (реж.2)', type: 'number' },
            { key: 'timer_paused', label: 'Таймер на паузе (реж.2)', type: 'boolean' },
            { key: 'custom_goal_name', label: 'Название кастомной цели (реж.3)', type: 'string' },
            { key: 'custom_units_needed', label: 'Юнитов нужно (реж.3)', type: 'number' },
            { key: 'custom_units_done', label: 'Юнитов сделано (реж.3)', type: 'number' },
            { key: 'lesta_nickname', label: 'Ник Lesta', type: 'string' },
            { key: 'lesta_last_battles', label: 'Боёв за сессию (Lesta)', type: 'number' },
            { key: 'lesta_last_frags', label: 'Фрагов за сессию (Lesta)', type: 'number' },
            { key: 'lesta_last_wins', label: 'Побед за сессию (Lesta)', type: 'number' },
            { key: 'lesta_last_win_rate', label: 'Винрейт за сессию (Lesta), %', type: 'number' },
            { key: 'lesta_last_damage_dealt', label: 'Урон за сессию (Lesta)', type: 'number' }
        ]
    },
    {
        moduleId: 'donation-driven-widget',
        label: 'Виджет «параметр от донатов»',
        messageType: 'DONATION_DRIVEN_UPDATE',
        payloadPath: 'widget',
        restEndpoint: '/api/donation-driven-widget',
        fields: [
            { key: 'name', label: 'Название', type: 'string' },
            { key: 'current_value', label: 'Текущее значение', type: 'number' },
            { key: 'start_value', label: 'Стартовое значение', type: 'number' },
            { key: 'cap_value', label: 'Максимум', type: 'number' },
            { key: 'unit_label', label: 'Единица измерения', type: 'string' },
            { key: 'lesta_session_active', label: 'Сессия Lesta активна', type: 'boolean' },
            { key: 'lesta_session_battles', label: 'Боёв за сессию', type: 'number' },
            { key: 'lesta_session_winrate', label: 'Винрейт за сессию, %', type: 'number' }
        ]
    },
    {
        moduleId: 'donation-widgets-goal',
        label: 'Донат-виджет: цель',
        messageType: 'DONATION_GOAL_UPDATE',
        payloadPath: 'goal',
        restEndpoint: '/api/donation-goal',
        fields: [
            { key: 'currentAmount', label: 'Собрано', type: 'number' },
            { key: 'targetAmount', label: 'Цель', type: 'number' },
            { key: 'title', label: 'Заголовок', type: 'string' }
        ]
    },
    {
        moduleId: 'donation-widgets-bar',
        label: 'Донат-виджет: полоса',
        messageType: 'DONATION_BAR_UPDATE',
        payloadPath: 'state',
        restEndpoint: '/api/donation-bar/state',
        fields: [
            { key: 'current_amount', label: 'Собрано', type: 'number' },
            { key: 'target_amount', label: 'Цель', type: 'number' },
            { key: 'title', label: 'Заголовок', type: 'string' }
        ]
    },
    {
        moduleId: 'battle-tracker',
        label: 'Битва «стример vs зритель»',
        messageType: 'BATTLE_UPDATE',
        payloadPath: 'battle',
        restEndpoint: '/api/battle/state',
        fields: [
            { key: 'active', label: 'Битва активна', type: 'boolean' },
            { key: 'myNickname', label: 'Ник стримера', type: 'string' },
            { key: 'opponentNickname', label: 'Ник зрителя', type: 'string' },
            { key: 'myScore', label: 'Счёт стримера', type: 'number' },
            { key: 'opponentScore', label: 'Счёт зрителя', type: 'number' },
            { key: 'myPct', label: 'Счёт стримера, %', type: 'number' },
            { key: 'opponentPct', label: 'Счёт зрителя, %', type: 'number' },
            { key: 'myTotals.frags', label: 'Фраги стримера', type: 'number' },
            { key: 'myTotals.damage', label: 'Урон стримера', type: 'number' },
            { key: 'opponentTotals.frags', label: 'Фраги зрителя', type: 'number' },
            { key: 'opponentTotals.damage', label: 'Урон зрителя', type: 'number' }
        ]
    },
    {
        moduleId: 'viewer-voting',
        label: 'Голосование зрителей',
        messageType: 'VOTING_UPDATE',
        payloadPath: 'poll',
        restEndpoint: '/api/voting/polls',
        fields: [
            { key: 'title', label: 'Название опроса', type: 'string' },
            { key: 'status', label: 'Статус', type: 'string' },
            { key: 'totalVotes', label: 'Всего голосов', type: 'number' },
            { key: 'options', label: 'Список вариантов (для списка/лидерборда)', type: 'array', itemFields: [
                { key: 'label', label: 'Название варианта' },
                { key: 'votes', label: 'Голосов' },
                { key: 'pct', label: '% голосов' }
            ] }
        ]
    },
    {
        moduleId: 'top-donors',
        label: 'Топ донатеров',
        messageType: 'TOP_DONORS_UPDATE',
        payloadPath: null,
        restEndpoint: '/api/top-donors',
        // Сообщение TOP_DONORS_UPDATE — просто сигнал "обнови данные", без полезной
        // нагрузки в себе (см. donations-crud/index.js:252) — поэтому на него нужно
        // не парсить payload, а перезапросить restEndpoint.
        refetchOnMessage: true,
        fields: [
            { key: 'donors', label: 'Список топ донатеров (для списка/лидерборда)', type: 'array', itemFields: [
                { key: 'normalized_username', label: 'Имя' },
                { key: 'total_amount', label: 'Сумма, ₽' },
                { key: 'donations_count', label: 'Кол-во донатов' }
            ] }
        ]
    },
    {
        moduleId: 'roulette',
        label: 'Рулетка',
        messageType: 'ROULETTE_UPDATE',
        payloadPath: 'state',
        restEndpoint: '/api/roulette/state',
        fields: [
            { key: 'current_amount', label: 'Текущая сумма', type: 'number' },
            { key: 'target_amount', label: 'Цель заполнения', type: 'number' },
            { key: 'is_active', label: 'Активна', type: 'boolean' },
            { key: 'text', label: 'Текст на полосе', type: 'string' }
        ]
    },
    {
        moduleId: 'blitz-challenge',
        label: 'Танки Блиц: челлендж',
        messageType: 'BLITZ_CHALLENGE_UPDATE',
        payloadPath: 'challenge',
        restEndpoint: '/api/blitz-challenge',
        fields: [
            { key: 'activeType', label: 'Активный тип челленджа', type: 'string' },
            { key: 'headerText', label: 'Заголовок', type: 'string' },
            { key: 'winrate.current', label: 'Винрейт: текущий', type: 'number' },
            { key: 'winrate.cap', label: 'Винрейт: цель', type: 'number' },
            { key: 'damage.current', label: 'Урон: текущий', type: 'number' },
            { key: 'damage.cap', label: 'Урон: цель', type: 'number' },
            { key: 'medals.totalEarned', label: 'Медалей получено', type: 'number' },
            { key: 'medals.totalRequired', label: 'Медалей нужно', type: 'number' }
        ]
    },
    {
        moduleId: 'razblog',
        label: 'РазБЛОГировка (золото)',
        messageType: 'RAZBLOGIROVKA_GOLD_UPDATE',
        payloadPath: 'data',
        restEndpoint: '/api/razblogirovka/gold-bank',
        fields: [
            { key: 'totalGold', label: 'Всего золота', type: 'number' }
        ]
    },
    {
        moduleId: 'subscriber-stats',
        label: 'Новые подписчики/фолловеры',
        messageType: 'SUBSCRIBER_STATS_UPDATE',
        payloadPath: null,
        restEndpoint: '/api/subscribers/stats',
        fields: [
            { key: 'today.twitch', label: 'Твич сегодня', type: 'number' },
            { key: 'today.youtube', label: 'YouTube сегодня', type: 'number' },
            { key: 'today.vkplay', label: 'VK Play сегодня', type: 'number' },
            { key: 'today.total', label: 'Всего сегодня', type: 'number' }
        ]
    },
    {
        moduleId: 'online-viewers',
        label: 'Онлайн зрителей',
        messageType: 'ONLINE_VIEWERS_UPDATE',
        payloadPath: null,
        restEndpoint: '/api/online-viewers',
        fields: [
            { key: 'twitch.viewers', label: 'Твич', type: 'number' },
            { key: 'youtube.viewers', label: 'YouTube', type: 'number' },
            { key: 'vkplay.viewers', label: 'VK Play', type: 'number' },
            { key: 'total', label: 'Всего', type: 'number' }
        ]
    },
    // Ниже — модули без собственной живой рассылки (только REST), рендерер
    // конструктора опрашивает их поллингом (см. public/widget/custom-renderer.html).
    {
        moduleId: 'chat-stats',
        label: 'Статистика чата',
        messageType: null,
        // payloadPath НЕ ставим в 'stats': ключ поля совпадает с ключом обёртки
        // REST-ответа, а fetchSnapshot() в рендерере уже сам разворачивает по нему —
        // если продублировать здесь, getByPath попытается найти .stats внутри уже
        // извлечённого массива и получит undefined. payloadPath используется только
        // когда обёртка (payloadPath) отличается от имени бинда-поля.
        payloadPath: null,
        restEndpoint: '/api/chat/stats',
        fields: [
            { key: 'stats', label: 'Активные в чате (для списка)', type: 'array', itemFields: [
                { key: 'username', label: 'Имя' },
                { key: 'messages_count', label: 'Сообщений' }
            ] }
        ]
    },
    {
        moduleId: 'donor-achievements',
        label: 'Достижения донатеров',
        messageType: null,
        payloadPath: null, // см. комментарий у chat-stats — поле и обёртка совпадают
        restEndpoint: '/api/donor-achievements',
        fields: [
            { key: 'achievements', label: 'Список достижений (для списка)', type: 'array', itemFields: [
                { key: 'normalized_username', label: 'Имя' },
                { key: 'tier_name', label: 'Тир' },
                { key: 'total_time_minutes', label: 'Минут задонатил' }
            ] }
        ]
    },
    {
        moduleId: 'replay-live',
        label: 'Реплей боя (live)',
        messageType: null,
        payloadPath: 'data',
        restEndpoint: '/api/replay-live',
        fields: [
            { key: 'status', label: 'Статус реплея', type: 'string' },
            { key: 'battleTimeLabel', label: 'Время боя', type: 'string' },
            { key: 'authorNickname', label: 'Ник игрока', type: 'string' },
            { key: 'live.damageDealt', label: 'Урон', type: 'number' },
            { key: 'live.hits', label: 'Попаданий', type: 'number' },
            { key: 'live.frags', label: 'Фраги', type: 'number' }
        ]
    },
    {
        moduleId: 'yandex-music',
        label: 'Яндекс.Музыка (сейчас играет)',
        messageType: null,
        payloadPath: 'data',
        restEndpoint: '/api/yandex-music/now-playing',
        fields: [
            { key: 'playing', label: 'Трек играет', type: 'boolean' },
            { key: 'title', label: 'Название трека', type: 'string' },
            { key: 'artist', label: 'Исполнитель', type: 'string' }
        ]
    }
];

function getDataRegistry() {
    return SOURCES;
}

module.exports = { getDataRegistry };
