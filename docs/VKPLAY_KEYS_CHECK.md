
# Проверка ключей VK Play OAuth

## Важно: Правильные ключи для OAuth

В OAuth CodeFlow используются **только два ключа**:

1. **Client ID** = `ID приложения` = `as34hljtetqhik1e`
2. **Client Secret** = `Секретный ключ приложения` = `ohaLCOsNaDlwEaCKEBqsgboD6qDqG6fZUI7FwfQAVyCpy05fJf7CjCLWsCOfl45Y`

**Публичный ключ приложения НЕ используется в OAuth!**

## Проверка config.env

Убедитесь, что в файле `config.env` указаны правильные ключи:

```env
VKPLAY_CLIENT_ID=as34hljtetqhik1e
VKPLAY_CLIENT_SECRET=ohaLCOsNaDlwEaCKEBqsgboD6qDqG6fZUI7FwfQAVyCpy05fJf7CjCLWsCOfl45Y
VKPLAY_REDIRECT_URI=http://localhost:3000/oauth/vkplay/callback
```

## Частые ошибки:

1. **Использован публичный ключ вместо секретного**
   - ❌ Неправильно: `VKPLAY_CLIENT_SECRET=kzpVDOsyINi2PXAlTNFo1fqth5QNDpftcqOZ3D2jcTUYD4zD8Pfm41GbEmjavLQ6`
   - ✅ Правильно: `VKPLAY_CLIENT_SECRET=ohaLCOsNaDlwEaCKEBqsgboD6qDqG6fZUI7FwfQAVyCpy05fJf7CjCLWsCOfl45Y`

2. **Ключи перепутаны местами**
   - ❌ Неправильно: `VKPLAY_CLIENT_ID=ohaLCOsNaDlwEaCKEBqsgboD6qDqG6fZUI7FwfQAVyCpy05fJf7CjCLWsCOfl45Y`
   - ✅ Правильно: `VKPLAY_CLIENT_ID=as34hljtetqhik1e`

3. **Лишние пробелы или символы**
   - ❌ Неправильно: `VKPLAY_CLIENT_ID= as34hljtetqhik1e ` (пробелы)
   - ✅ Правильно: `VKPLAY_CLIENT_ID=as34hljtetqhik1e` (без пробелов)

4. **Кавычки вокруг значений**
   - ❌ Неправильно: `VKPLAY_CLIENT_ID="as34hljtetqhik1e"`
   - ✅ Правильно: `VKPLAY_CLIENT_ID=as34hljtetqhik1e` (без кавычек)

## Как проверить:

1. Откройте файл `config.env`
2. Проверьте, что:
   - `VKPLAY_CLIENT_ID=as34hljtetqhik1e` (ID приложения)
   - `VKPLAY_CLIENT_SECRET=ohaLCOsNaDlwEaCKEBqsgboD6qDqG6fZUI7FwfQAVyCpy05fJf7CjCLWsCOfl45Y` (Секретный ключ)
3. Убедитесь, что нет лишних пробелов, кавычек или символов
4. Перезапустите сервер
5. Попробуйте авторизоваться снова

## Логирование

При авторизации в логах сервера будет выведено:
- Длина Client ID и Client Secret
- Первые и последние символы ключей (для проверки без раскрытия полных ключей)
- Предупреждение, если Client Secret слишком короткий

Если видите ошибку 401 или 403, проверьте ключи в `config.env`.
