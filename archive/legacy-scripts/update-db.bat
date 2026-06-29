@echo off
chcp 65001 >nul
echo 🔄 Обновление базы данных...
echo.

node update-database.js

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✅ Обновление завершено успешно!
) else (
    echo.
    echo ❌ Ошибка при обновлении базы данных
    pause
)

