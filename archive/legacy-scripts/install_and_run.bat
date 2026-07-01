@echo off
title Frag Tracker - Install and Run
cd /d "%~dp0"

echo ===============================================
echo    FRAG-TRACKER - INSTALL AND RUN
echo ===============================================
echo.

echo [1/4] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do echo OK: Node.js %%i
echo.

echo [2/4] Installing dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)
echo OK: Dependencies installed
echo.

echo [3/4] Database init...
call node init-db.js
if errorlevel 1 (
    echo ERROR: init-db.js failed
    pause
    exit /b 1
)
echo OK: Database ready
echo.

echo [4/4] Stopping old server on port 3000...
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%p >nul 2>&1
)
timeout /t 2 /nobreak >nul
echo.

echo Starting server...
echo ===============================================
echo   Panel:  http://localhost:3000
echo   Widget: http://localhost:3000/widget
echo   DA auth: http://localhost:3000/auth/donationalerts
echo ===============================================
echo.

call npm start
pause
