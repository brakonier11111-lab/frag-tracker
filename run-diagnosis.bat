@echo off
chcp 65001 > nul
title Диагностика DonationAlerts
echo ===============================================
echo    ДИАГНОСТИКА DONATIONALERTS
echo ===============================================
echo.

set DA_CLIENT_ID=16225
set DA_CLIENT_SECRET=0VJ2dMRax8cJrQqAYQJ7dLnFCMPKOFZdjCHkU4Lw

echo 🔍 Запуск диагностики...
echo.

node diagnose-donation-alerts.js

echo.
echo ===============================================
echo    ДИАГНОСТИКА ЗАВЕРШЕНА
echo ===============================================
echo.
echo 📋 Следующие шаги:
echo 1. Откройте http://localhost:3000/admin
echo 2. Нажмите "НАСТРОИТЬ DA" для OAuth авторизации
echo 3. После авторизации нажмите "ТЕСТ DA"
echo 4. Проверьте логи сервера
echo.
pause

