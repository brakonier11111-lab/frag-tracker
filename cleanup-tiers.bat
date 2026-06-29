@echo off
chcp 65001 >nul
echo Очистка дубликатов уровней достижений...
echo.
node cleanup-duplicate-tiers.js
pause

