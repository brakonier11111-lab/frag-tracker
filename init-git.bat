@echo off
echo Initializing Git repository...
git init
if %errorlevel% equ 0 (
    echo.
    echo Git repository initialized successfully!
    echo.
    echo Next steps:
    echo 1. Add files: git add .
    echo 2. Make first commit: git commit -m "Initial commit"
    echo 3. (Optional) Add remote: git remote add origin <your-repo-url>
) else (
    echo.
    echo Error: Git is not installed or not in PATH
    echo Please install Git from https://git-scm.com/
)
pause
