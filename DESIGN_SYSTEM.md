# 🎨 Современная дизайн-система Frag Tracker

## Обзор

Этот документ описывает современную дизайн-систему для приложения Frag Tracker, созданную для улучшения UX, консистентности и скорости разработки.

## 🎯 Цели

1. **Единообразие** - все компоненты следуют единым правилам дизайна
2. **Современность** - использование актуальных паттернов и техник
3. **Удобство** - интуитивный и понятный интерфейс
4. **Красота** - визуально привлекательный дизайн
5. **Производительность** - оптимизированные стили и анимации

## 🎨 Цветовая палитра

### Неоновые цвета
- **Красный**: `#ff003c` - для опасных действий и ошибок
- **Синий**: `#00f0ff` - основной акцентный цвет
- **Фиолетовый**: `#b300ff` - для активных элементов
- **Зеленый**: `#00ff47` - для успешных действий
- **Желтый**: `#ffff00` - для предупреждений

### Градиенты
- **Primary**: `linear-gradient(135deg, #667eea 0%, #764ba2 100%)`
- **Success**: `linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)`
- **Danger**: `linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%)`
- **Warning**: `linear-gradient(135deg, #fa709a 0%, #fee140 100%)`

## 🧩 Компоненты

### Кнопки
```html
<button class="btn btn-primary">Основная кнопка</button>
<button class="btn btn-success">Успех</button>
<button class="btn btn-danger">Опасность</button>
<button class="btn btn-warning">Предупреждение</button>
<button class="btn btn-ghost">Прозрачная</button>
```

### Карточки
```html
<div class="card">
    <div class="card-header">
        <h3 class="card-title">Заголовок</h3>
        <p class="card-subtitle">Подзаголовок</p>
    </div>
    <div class="card-body">
        Содержимое карточки
    </div>
    <div class="card-footer">
        <button class="btn btn-primary">Действие</button>
    </div>
</div>
```

### Формы
```html
<div class="form-group">
    <label class="form-label">Название поля</label>
    <input type="text" class="form-input" placeholder="Введите значение">
</div>
```

### Навигация
Используйте компонент `navbar.html`:
```html
<!-- В начале body -->
<div id="navbar-placeholder"></div>
<script>
    fetch('/components/navbar.html')
        .then(r => r.text())
        .then(html => {
            document.getElementById('navbar-placeholder').innerHTML = html;
        });
</script>
```

## 📐 Сетки

```html
<div class="grid grid-2">
    <div class="card">Элемент 1</div>
    <div class="card">Элемент 2</div>
</div>

<div class="grid grid-3">
    <!-- 3 колонки -->
</div>

<div class="grid grid-4">
    <!-- 4 колонки -->
</div>
```

## 🎭 Анимации

- **Плавные переходы**: все интерактивные элементы имеют плавные переходы
- **Hover эффекты**: поднятие карточек и кнопок при наведении
- **Ripple эффект**: на кнопках при клике
- **Fade in/out**: для модальных окон и уведомлений

## 📱 Адаптивность

Дизайн-система полностью адаптивна:
- **Desktop**: полная функциональность
- **Tablet**: адаптация сеток и навигации
- **Mobile**: вертикальная навигация, одна колонка

## 🚀 Использование

### Подключение в HTML

```html
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Страница</title>
    <link rel="stylesheet" href="/styles/design-system.css">
</head>
<body>
    <!-- Навигация -->
    <div id="navbar-placeholder"></div>
    <script>
        fetch('/components/navbar.html')
            .then(r => r.text())
            .then(html => {
                document.getElementById('navbar-placeholder').innerHTML = html;
            });
    </script>
    
    <!-- Контент -->
    <div class="container">
        <h1>Заголовок страницы</h1>
        <div class="grid grid-2">
            <div class="card">
                <!-- Содержимое -->
            </div>
        </div>
    </div>
</body>
</html>
```

## 🔄 Миграция существующих страниц

1. Подключите `design-system.css`
2. Замените встроенные стили на классы из дизайн-системы
3. Используйте компоненты (navbar, cards, buttons)
4. Удалите дублирующийся CSS код

## 📚 Дополнительные ресурсы

- [CSS Variables](https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties)
- [Glass Morphism](https://css-tricks.com/glassmorphism-in-css/)
- [Modern CSS Techniques](https://moderncss.dev/)
