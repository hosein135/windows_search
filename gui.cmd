@echo off
REM Launch the Electron GUI. Double-click this file, or run:  gui.cmd

setlocal
cd /d "%~dp0"

bun run start
set "EXIT_CODE=%ERRORLEVEL%"

if %EXIT_CODE% neq 0 (
    echo.
    echo [gui.cmd] exited with code %EXIT_CODE%.
    pause
)

exit /b %EXIT_CODE%
