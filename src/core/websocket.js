'use strict';

const WebSocket = require('ws');

/**
 * Реестр WebSocket-клиентов + broadcast — вынос из server.js, семантика 1:1.
 * Обработчик wss.on('connection') остаётся в server.js и вызывает
 * addClient/removeClient; всё остальное общается через broadcastToClients.
 */
function createWebSocketHub() {
    let clients = [];

    function addClient(ws) {
        clients.push(ws);
    }

    function removeClient(ws) {
        clients = clients.filter(client => client !== ws);
    }

    /** Живой список клиентов (для адресных рассылок, напр. SLOWDOWN_START_RANDOM) */
    function getClients() {
        return clients;
    }

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

    return { addClient, removeClient, getClients, broadcastToClients };
}

module.exports = { createWebSocketHub };
