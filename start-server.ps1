# Frag-tracker Server - Единый запуск
Write-Host ""
Write-Host "========================================"
Write-Host "   FRAG-TRACKER SERVER - ЕДИНЫЙ ЗАПУСК"
Write-Host "========================================"
Write-Host ""

# Проверяем Node.js
Write-Host "[1/6] Проверка Node.js..."
try {
    $nodeVersion = node --version
    Write-Host "OK: Node.js найден: $nodeVersion"
} catch {
    Write-Host "ОШИБКА: Node.js не найден! Установите Node.js с https://nodejs.org/"
    Read-Host "Нажмите Enter для выхода"
    exit 1
}

# Проверяем package.json
Write-Host ""
Write-Host "[2/6] Проверка package.json..."
if (-not (Test-Path "package.json")) {
    Write-Host "ОШИБКА: package.json не найден!"
    Read-Host "Нажмите Enter для выхода"
    exit 1
}
Write-Host "OK: package.json найден"

# Останавливаем существующие процессы
Write-Host ""
Write-Host "[3/6] Остановка существующих процессов..."
try {
    Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
    Write-Host "OK: Процессы Node.js остановлены"
} catch {
    Write-Host "INFO: Процессы Node.js не найдены"
}

# Устанавливаем зависимости
Write-Host ""
Write-Host "[4/6] Установка зависимостей..."
try {
    npm install
    Write-Host "OK: Зависимости установлены"
} catch {
    Write-Host "ОШИБКА: Ошибка установки зависимостей!"
    Read-Host "Нажмите Enter для выхода"
    exit 1
}

# Инициализируем базу данных
Write-Host ""
Write-Host "[5/6] Инициализация базы данных..."
if (Test-Path "init-database.js") {
    try {
        node init-database.js
        Write-Host "OK: База данных инициализирована"
    } catch {
        Write-Host "ОШИБКА: Ошибка инициализации БД!"
        Read-Host "Нажмите Enter для выхода"
        exit 1
    }
} else {
    Write-Host "ОШИБКА: init-database.js не найден!"
    Read-Host "Нажмите Enter для выхода"
    exit 1
}

# Запускаем сервер
Write-Host ""
Write-Host "[6/6] Запуск сервера..."
Write-Host ""
Write-Host "========================================"
Write-Host "   СЕРВЕР ЗАПУЩЕН УСПЕШНО!"
Write-Host "========================================"
Write-Host ""
Write-Host "Доступные страницы:"
Write-Host "   • Главная: http://localhost:3000"
Write-Host "   • Админ панель: http://localhost:3000/admin.html"
Write-Host "   • Аналитика: http://localhost:3000/donations-analytics.html"
Write-Host ""
Write-Host "Для остановки сервера нажмите Ctrl+C"
Write-Host ""

# Запускаем сервер
node server.js

Write-Host ""
Write-Host "========================================"
Write-Host "   СЕРВЕР ОСТАНОВЛЕН"
Write-Host "========================================"
Write-Host ""
Read-Host "Нажмите Enter для выхода"








