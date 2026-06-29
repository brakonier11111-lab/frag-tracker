@echo off
chcp 65001 >nul
echo 🔄 Инициализация базы данных...
node init-db-quick.js
if %errorlevel% equ 0 (
    echo.
    echo ✅ База данных успешно инициализирована!
    echo.
) else (
    echo.
    echo ❌ Ошибка инициализации!
    echo.
)
pause






