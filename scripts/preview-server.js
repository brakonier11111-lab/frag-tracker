'use strict';
/**
 * Безопасный запуск сервера для превью UI-правок: копия БД во временной
 * папке, отдельный порт. Никогда не трогает боевую БД/порт 3000.
 */
process.env.PORT = process.env.PORT || '3993';
process.env.FRAG_USER_DATA = process.env.FRAG_USER_DATA || '/tmp/frag-preview-userdata';
process.env.NODE_ENV = 'test';
require('../server.js');
