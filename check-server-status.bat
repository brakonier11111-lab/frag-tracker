@echo off
chcp 65001 > nul
title Проверка статуса сервера
color 0B
echo.
echo ===============================================
echo    ПРОВЕРКА СТАТУСА СЕРВЕРА
echo ===============================================
echo.

echo 🔍 Проверка доступности сервера на localhost:3000...
echo.

cd "C:\Users\ixacy\Downloads\TTTEST — копия"
node check-server-status.js

echo.
echo ===============================================
echo    ПРОВЕРКА ЗАВЕРШЕНА
echo ===============================================
echo.
pause

