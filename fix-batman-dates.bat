@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Обновление дат донатов Бетмен...
node fix-batman-dates.js
pause










