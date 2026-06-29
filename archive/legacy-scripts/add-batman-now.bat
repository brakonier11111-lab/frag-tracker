@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Добавление Бетмен в топ донатеров...
node add-batman-direct.js
if %errorlevel% equ 0 (
    echo.
    echo Готово! Бетмен добавлен в топ.
    echo Обновите виджет в OBS или перезагрузите страницу.
) else (
    echo.
    echo Ошибка при добавлении. Проверьте, что сервер запущен.
)
pause










