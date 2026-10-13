@echo off
REM Create .venv and install DuckDB. Double-click this file, or run:  setup.cmd

setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if %EXIT_CODE% neq 0 (
    echo [setup.cmd] failed with code %EXIT_CODE%.
) else (
    echo [setup.cmd] finished.
)
pause
exit /b %EXIT_CODE%
