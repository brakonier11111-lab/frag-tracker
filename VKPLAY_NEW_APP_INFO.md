# Информация о новом приложении VK Play Live

## Данные приложения

- **Название:** Xasya New
- **ID приложения (Client ID):** `fw5rnkh3nd335l2l`
- **Секретный ключ приложения (Client Secret):** `Ehw6AYlhTL2MocgL4kdvdc7Aus94sO4l9vozahaFl9CHktYm3M9Vv67f6Qo7QokR`
- **Публичный ключ приложения:** `HhXGcBfnUO1ad4EfTTV45Yi3U0zVGKOt5tAekgCEbrvXHWkBoOWSb3FEtmaJsWQI` (НЕ используется в OAuth)

## Настройки OAuth

### Redirect URIs (в настройках приложения):
```
http://localhost:3000/oauth/vkplay/callback
http://localhost:3000/oauth-vkplay-implicit.html
```

### Запрашиваемые разрешения (Scopes):
- `channel:points` - Получение баланса баллов и списка наград
- `channel:points:rewards` - Управление наградами за баллы канала
- `channel:points:rewards:demands` - Запросы наград за баллы канала
- `channel:roles` - Управление ролями канала
- `chat:message:send` - Отправка сообщений в чат

## API Endpoints

### Точка входа:
- **Основной:** `https://apidev.live.vkvideo.ru/`

### OAuth:
- **Авторизация:** `https://auth.live.vkvideo.ru/app/oauth2/authorize`
- **Обмен кода на токен:** `https://api.live.vkvideo.ru/oauth/server/token`
- **Обновление токена:** `https://api.live.vkvideo.ru/oauth/server/token`
- **Отзыв токена:** `https://api.live.vkvideo.ru/oauth/server/revoke`

### Основные методы:
- **Текущий пользователь:** `GET /v1/current_user`
- **Информация о канале:** `GET /v1/channel?channel_url={url}`
- **Список наград:** `GET /v1/channel_point/rewards?channel_url={url}`
- **Список ролей:** `GET /v1/channel_roles?channel_url={url}`
- **Назначение роли:** `POST /v1/channel_roles/user/set?channel_url={url}&user_id={id}`
- **Отправка сообщения:** `POST /v1/chat/message/send?channel_url={url}&stream_id={id}`
- **WebSocket токен:** `GET /v1/websocket/subscription_token?channels={channels}`

## Формат авторизации

### CodeFlow (обмен кода на токен):
```http
POST https://api.live.vkvideo.ru/oauth/server/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic <base64(client_id:secret)>

grant_type=authorization_code
&code={code}
&redirect_uri={redirect_uri}
```

**ВАЖНО:** НЕ передавать `client_id` и `client_secret` в теле запроса!

### Вызов методов API:
```http
GET https://apidev.live.vkvideo.ru/v1/{method}
Authorization: Bearer {access_token}
```

## Обновление config.env

```env
VKPLAY_CLIENT_ID=fw5rnkh3nd335l2l
VKPLAY_CLIENT_SECRET=Ehw6AYlhTL2MocgL4kdvdc7Aus94sO4l9vozahaFl9CHktYm3M9Vv67f6Qo7QokR
VKPLAY_REDIRECT_URI=http://localhost:3000/oauth/vkplay/callback
```

## Проверка после настройки

1. Перезапустите сервер
2. Откройте `http://localhost:3000/stream-integrations.html`
3. Нажмите "Подключить VK Play"
4. Проверьте логи сервера - должны быть сообщения о проверке ключей
5. После авторизации проверьте статус: `http://localhost:3000/integrations/vkplay/status`
