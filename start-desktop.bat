@echo off
chcp 65001 >nul
title Frag Tracker Desktop
cd /d "%~dp0"

echo ===============================================
echo   FRAG TRACKER - DESKTOP
echo ===============================================
echo.

if not exist "node_modules\electron" (
    echo Installing Electron...
    call npm install
    if errorlevel 1 (
        echo ERROR: npm install failed
        pause
        exit /b 1
    )
)

echo Freeing port 3000 if busy...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000.*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo Starting desktop app...
echo Server: http://localhost:3000
echo.

call npm run electron
if errorlevel 1 (
    echo.
    echo Startup failed. Check: %%APPDATA%%\Frag Tracker\startup.log
    pause
    exit /b 1
)
pause
