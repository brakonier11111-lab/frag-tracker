'use strict';

/**
 * Только безопасная, изолированная часть Lesta Games интеграции: OAuth-вход,
 * статичные тестовые страницы и поиск игрока по нику. Сознательно НЕ включает
 * getLestaPlayerStats/getLestaCountersFromState/computeLestaPeriodDelta/
 * fetchLestaHistoryWindow/computeLestaPeriodStatsFromRows и startLestaAutoSync —
 * они остаются в server.js, так как:
 *  - уже переданы как deps в src/modules/blitz-challenge и src/modules/razblog;
 *  - startLestaAutoSync каждые 20с списывает фраги из режима 1 (донат-трекер) —
 *    это ядро трекера, а не отдельный виджет, трогать его отдельно от донат-логики
 *    слишком рискованно без отдельного, более осторожного разбора.
 *
 * LESTA_CONFIG остаётся в server.js и передаётся сюда ПО ССЫЛКЕ (deps.lestaConfig) —
 * и этот модуль, и оставшийся в server.js код мутируют один и тот же объект.
 */

const axios = require('axios');

function createLestaOAuthModule(deps) {
    const { lestaConfig, updateAppState, broadcastStateUpdate, startLestaAutoSync } = deps;
    const port = process.env.PORT || 3000;

    function registerPages(app) {
        app.get('/lesta-test', (req, res) => {
            res.sendFile(require('path').join(deps.appRoot, 'public', 'lesta-test.html'));
        });

        app.get('/lesta-api-test', (req, res) => {
            res.sendFile(require('path').join(deps.appRoot, 'public', 'lesta-api-test.html'));
        });

        app.get('/lesta-stats', (req, res) => {
            res.sendFile(require('path').join(deps.appRoot, 'public', 'lesta-stats.html'));
        });
    }

    function registerRoutes(app) {
        app.get('/auth/lesta', (req, res) => {
            if (!lestaConfig.applicationId) {
                return res.status(400).send(`
                    <h3 style="color: red;">Ошибка настройки</h3>
                    <p>Application ID Lesta Games не настроен. Настройте его в админке.</p>
                `);
            }

            // Согласно документации Lesta Games, используем правильный URL
            const redirectUri = `http://localhost:${port}/auth/lesta/callback`;
            // prompt=login — попытка показать форму входа, а не подставить сохранённую сессию Lesta
            const authUrl = `${lestaConfig.openIdUrl}?application_id=${lestaConfig.applicationId}&redirect_uri=${encodeURIComponent(redirectUri)}&prompt=login`;

            console.log('🔗 Авторизация Lesta Games:');
            console.log('   Application ID:', lestaConfig.applicationId);
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

                lestaConfig.accessToken = access_token || null;
                lestaConfig.accountId = account_id;
                lestaConfig.nickname = nickname || 'Неизвестный игрок';
                lestaConfig.tokenExpiresAt = expires_at ? parseInt(expires_at) : null;

                console.log('✅ Lesta Games OAuth успешно!');
                console.log('   Игрок:', lestaConfig.nickname);
                console.log('   Account ID:', lestaConfig.accountId);
                console.log('   Access Token:', lestaConfig.accessToken ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ');
                console.log('   Истекает:', expires_at ? new Date(expires_at * 1000).toLocaleString('ru-RU') : 'НЕ УКАЗАН');

                // Сохраняем только поля Lesta (не spread всего state — иначе дублируется updated_at в SQL)
                updateAppState({
                    lesta_access_token: lestaConfig.accessToken,
                    lesta_token_expires_at: lestaConfig.tokenExpiresAt,
                    lesta_account_id: lestaConfig.accountId,
                    lesta_nickname: lestaConfig.nickname
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
                        <strong>Игрок:</strong> ${lestaConfig.nickname}<br>
                        <strong>Account ID:</strong> ${lestaConfig.accountId}<br>
                        <strong>Access Token:</strong> ${lestaConfig.accessToken ? 'Получен' : 'Не получен'}<br>
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

        // API для поиска игрока Lesta Games по никнейму
        app.get('/api/lesta-search', async (req, res) => {
            const { nickname } = req.query;

            if (!nickname) {
                return res.status(400).json({ success: false, error: 'Никнейм не указан' });
            }

            if (!lestaConfig.applicationId) {
                return res.status(400).json({ success: false, error: 'Application ID не настроен' });
            }

            try {
                console.log('🔍 Поиск игрока Lesta Games:', nickname);

                const response = await axios.get(`${lestaConfig.apiUrl}/account/list/`, {
                    params: {
                        application_id: lestaConfig.applicationId,
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
    }

    return { registerPages, registerRoutes };
}

module.exports = { createLestaOAuthModule };
