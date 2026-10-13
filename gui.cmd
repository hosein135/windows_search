@echo off
REM Open the Tkinter search window. Double-click this file, or run:  gui.cmd

setlocal
cd /d "%~dp0"
chcp 65001 >nul

if not exist ".venv\Scripts\python.exe" (
    echo Run setup.cmd first.
    pause
    exit /b 1
)

".venv\Scripts\python.exe" -u -m searchapp
set "EXIT_CODE=%ERRORLEVEL%"

if %EXIT_CODE% neq 0 (
    echo.
    echo [gui.cmd] exited with code %EXIT_CODE%.
    pause
)

exit /b %EXIT_CODE%
