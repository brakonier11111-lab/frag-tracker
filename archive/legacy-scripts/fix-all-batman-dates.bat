@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Проверка и исправление дат всех донатов Бетмен...
node fix-all-batman-dates.js
pause










