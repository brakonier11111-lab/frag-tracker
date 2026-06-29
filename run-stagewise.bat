@echo off
setlocal

REM Launch Stagewise CLI from project root
cd /d "%~dp0"

REM Ensure npm is available
where npm >nul 2>&1
if errorlevel 1 (
  echo npm is not installed or not in PATH.
  exit /b 1
)

REM Run local Stagewise (devDependency). Extra args are passed through.
call npm run stagewise -- %*

endlocal


