@echo off
echo ✏️ Ручное редактирование статистики
echo.
echo 📊 Вы можете изменить количество боев, фрагов и боев без фрагов
echo.
echo ⚠️  ВНИМАНИЕ: Это действие перезапишет существующую статистику!
echo.
echo 🔧 Для изменения значений отредактируйте файл edit-stats-manually.js
echo    Настройте параметры:
echo    - newTotalBattles = количество боев
echo    - newTotalFrags = количество фрагов  
echo    - newBattlesWithoutFrags = количество боев без фрагов
echo.
pause

echo.
echo 🔄 Запуск редактирования статистики...
node edit-stats-manually.js

echo.
echo ✅ Редактирование завершено!
echo.
echo 🎯 Система теперь отслеживает изменения от новых значений
echo.
pause

