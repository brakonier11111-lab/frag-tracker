@echo off
title Frag-tracker - Stop server
cd /d "%~dp0"

echo ========================================
echo    FRAG-TRACKER - STOP SERVER
echo ========================================
echo.

echo Stopping processes on port 3000...
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo Killing PID %%p
    taskkill /f /pid %%p >nul 2>&1
)

echo.
echo Done. Port 3000 should be free.
echo.
pause
