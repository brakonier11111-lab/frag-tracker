require('dotenv').config({ path: './config.env' });

const config = {
    // Server
    port: process.env.PORT || 3000,
    env: process.env.NODE_ENV || 'development',
    
    // Database
    database: {
        path: './frag_tracker.db',
        verbose: process.env.NODE_ENV === 'development'
    },
    
    // DonationAlerts
    donationAlerts: {
        clientId: process.env.DA_CLIENT_ID || '',
        clientSecret: process.env.DA_CLIENT_SECRET || '',
        redirectUri: process.env.DA_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/callback`,
        apiUrl: 'https://www.donationalerts.com/api/v1'
    },
    
    // DonatePay
    donatePay: {
        apiKey: process.env.DP_API_KEY || '',
        apiUrl: 'https://donatepay.ru/api/v1',
        webhookSecret: process.env.DP_WEBHOOK_SECRET || '',
        centrifugoUrl: 'wss://centrifugo.donatepay.ru:443/connection/websocket',
        socketTokenUrl: 'https://donatepay.ru/api/v2/socket/token'
    },
    
    // Lesta Games
    lesta: {
        applicationId: process.env.LESTA_APPLICATION_ID || 'da7874d5a895ff241d8b55e271c03ff3',
        apiUrl: 'https://papi.tanksblitz.ru/wotb',
        openIdUrl: 'https://api.tanki.su/wot/auth/login/'
    },
    
    // YouTube OAuth
    youtube: {
        clientId: process.env.YT_CLIENT_ID || '',
        clientSecret: process.env.YT_CLIENT_SECRET || '',
        redirectUri: process.env.YT_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/oauth/youtube/callback`
    },
    
    // VK Play OAuth
    vkplay: {
        clientId: process.env.VKPLAY_CLIENT_ID || '',
        clientSecret: process.env.VKPLAY_CLIENT_SECRET || '',
        redirectUri: process.env.VKPLAY_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/oauth/vkplay/callback`
    },
    
    // Polling
    polling: {
        baseDelayMs: 5000,
        minDelayMs: 3000,
        maxDelayMs: 30000
    },
    
    // Security
    security: {
        rateLimitWindowMs: 15 * 60 * 1000, // 15 minutes
        rateLimitMax: 100 // requests per window
    },
    
    // Logging
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        fileEnabled: true,
        consoleEnabled: true
    }
};

module.exports = config;







