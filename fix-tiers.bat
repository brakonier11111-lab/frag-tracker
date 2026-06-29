@echo off
chcp 65001 >nul
echo Исправление дубликатов уровней достижений...
echo.
node fix-duplicate-tiers.js
pause

