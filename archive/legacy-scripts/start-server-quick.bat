@echo off
title Frag-tracker - Quick start
cd /d "%~dp0"

echo Stopping old server on port 3000...
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%p >nul 2>&1
)
timeout /t 2 /nobreak >nul

echo Starting http://localhost:3000
echo.
set DONATION_POLLING=1
node server.js
pause
