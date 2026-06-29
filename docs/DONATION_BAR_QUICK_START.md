# 🚀 Быстрый старт: Кастомные полоски донатов

## 📦 Что включено

Система полосок донатов с гибкой кастомизацией включает:

1. **donation-bar-customizable.html** - Интерактивный редактор с настройками
2. **donation-bar-obs.html** - Версия для OBS с URL параметрами
3. **donation-bar-themes.html** - Галерея готовых тем
4. **DONATION_BAR_CUSTOMIZATION_GUIDE.md** - Полное руководство

---

## ⚡ Быстрый запуск

### Шаг 1: Выбор готовой темы
1. Откройте `http://localhost:3000/donation-bar-themes.html`
2. Выберите понравившуюся тему
3. Нажмите "Получить ссылку"
4. Скопируйте URL

### Шаг 2: Добавление в OBS
1. В OBS добавьте **Browser Source**
2. Вставьте скопированный URL
3. Установите размеры из рекомендаций
4. Готово! ✓

---

## 🎨 Создание своей темы

### Вариант 1: Визуальный редактор
1. Откройте `http://localhost:3000/donation-bar-customizable.html`
2. Нажмите ⚙️ **Настройки**
3. Настройте все параметры визуально
4. Нажмите **Сохранить настройки**

### Вариант 2: URL параметры
Создайте свой URL с параметрами:
```
http://localhost:3000/donation-bar-obs.html?orientation=horizontal&fillColor=667eea&height=40
```

---

## 🔧 Основные параметры

| Параметр | Описание | Пример |
|----------|----------|--------|
| `orientation` | Ориентация | `horizontal`, `vertical`, `circular` |
| `style` | Стиль | `default`, `minimal`, `neon`, `rainbow` |
| `fillColor` | Цвет | `667eea` (без #) |
| `height` | Высота | `40` |

Полный список параметров смотрите в [DONATION_BAR_CUSTOMIZATION_GUIDE.md](DONATION_BAR_CUSTOMIZATION_GUIDE.md)

---

## 🎯 Популярные варианты использования

### Горизонтальная полоска вверху/внизу экрана
```
?orientation=horizontal&fillColor=667eea&height=40
```
**Размеры OBS:** 800x150px

### Вертикальная полоска сбоку
```
?orientation=vertical&fillColor=4CAF50&height=50
```
**Размеры OBS:** 150x600px

### Круговая диаграмма в углу
```
?orientation=circular&fillColor=667eea&showPercentage=true
```
**Размеры OBS:** 350x400px

### Компактная полоска в углу
```
?orientation=corner-tr&style=minimal&showTitle=false
```
**Размеры OBS:** 350x150px

---

## 🎨 Готовые цветовые схемы

### Классическая синяя
```
fillColor=667eea&glowColor=667eea&borderColor=667eea
```

### Неоновая фиолетовая
```
fillColor=ff00ff&glowColor=ff00ff&borderColor=ff00ff&style=neon
```

### Золотая VIP
```
fillColor=FFD700&glowColor=FFD700&borderColor=FFA500
```

### Зеленая природная
```
fillColor=4CAF50&glowColor=81C784&borderColor=2E7D32
```

### Огненная красная
```
fillColor=ff6b6b&glowColor=ee5a24&borderColor=c0392b
```

---

## 📱 Рекомендации по размерам

### Для 1920x1080 (Full HD)

**Горизонтальная:**
- Маленькая: 600x120px
- Средняя: 800x150px  ← Рекомендуется
- Большая: 1000x180px

**Вертикальная:**
- Маленькая: 120x400px
- Средняя: 150x600px  ← Рекомендуется
- Большая: 180x800px

**Круговая:**
- Маленькая: 250x300px
- Средняя: 350x400px  ← Рекомендуется
- Большая: 450x500px

---

## 💡 Полезные комбинации настроек

### Минимум информации
```
?showTitle=false&showStartEnd=false&showParticles=false
```

### Максимум эффектов
```
?style=neon&showParticles=true&animSpeed=2
```

### Для слабых ПК (оптимизация)
```
?style=minimal&showParticles=false&animSpeed=0.5
```

### Для привлечения внимания
```
?style=rainbow&animSpeed=2&height=50
```

---

## 🔗 Полезные ссылки

- **Галерея тем:** [http://localhost:3000/donation-bar-themes.html](http://localhost:3000/donation-bar-themes.html)
- **Редактор:** [http://localhost:3000/donation-bar-customizable.html](http://localhost:3000/donation-bar-customizable.html)
- **Полное руководство:** [DONATION_BAR_CUSTOMIZATION_GUIDE.md](DONATION_BAR_CUSTOMIZATION_GUIDE.md)

---

## 🎬 Примеры для разных игр

### CS:GO / Valorant
```
?fillColor=ff6b6b&glowColor=ee5a24&style=neon&animSpeed=1.5
```

### Minecraft
```
?fillColor=4CAF50&glowColor=81C784&style=minimal
```

### Cyberpunk 2077
```
?fillColor=00ffff&glowColor=ff00ff&style=neon&font=Orbitron
```

### Just Chatting
```
?fillColor=667eea&style=default&animSpeed=0.8
```

---

## 🐛 Решение проблем

### Виджет не отображается
- Проверьте, что сервер запущен
- Обновите источник в OBS (Ctrl+R)
- Проверьте правильность URL

### Анимация тормозит
- Используйте `style=minimal`
- Добавьте `showParticles=false`
- Уменьшите `animSpeed=0.5`

### Неправильные цвета
- Убедитесь, что HEX код без символа #
- Используйте только символы 0-9, A-F
- Пример: `fillColor=667eea` ✓ не `fillColor=#667eea` ✗

---

## 📞 Дополнительная помощь

Если возникли вопросы:
1. Изучите полное руководство: [DONATION_BAR_CUSTOMIZATION_GUIDE.md](DONATION_BAR_CUSTOMIZATION_GUIDE.md)
2. Попробуйте готовые темы: [donation-bar-themes.html](http://localhost:3000/donation-bar-themes.html)
3. Используйте визуальный редактор: [donation-bar-customizable.html](http://localhost:3000/donation-bar-customizable.html)

---

**Удачных стримов! 🎮📺**






