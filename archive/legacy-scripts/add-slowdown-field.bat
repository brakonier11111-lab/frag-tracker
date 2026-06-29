@echo off
chcp 65001 >nul
echo 🔄 Добавление поля slowdown_random_settings в БД...
node add-slowdown-settings-field.js
if %errorlevel% equ 0 (
    echo.
    echo ✅ Поле успешно добавлено или уже существует!
    echo.
    echo ⚠️ Перезапустите сервер, чтобы изменения вступили в силу!
    echo.
) else (
    echo.
    echo ❌ Ошибка!
    echo.
)
pause



