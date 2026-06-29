@echo off
chcp 65001 >nul
title Frag Tracker — Сборка установщика
cd /d "%~dp0"

echo ===============================================
echo   FRAG TRACKER — СБОРКА .EXE
echo ===============================================
echo.

echo [1/2] Установка зависимостей...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

echo.
echo [2/2] Сборка установщика Windows...
call npm run build:desktop
if errorlevel 1 (
    echo ERROR: build failed
    pause
    exit /b 1
)

echo.
echo Готово! Установщик в папке dist\
explorer dist
pause
