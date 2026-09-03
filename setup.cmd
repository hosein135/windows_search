@echo off
REM Launcher for setup.ps1 - runs it as Administrator with execution policy bypass.
REM Double-click this file, or run from a terminal:  setup.cmd

setlocal

set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%setup.ps1"

if not exist "%PS1%" (
    echo [setup.cmd] ERROR: setup.ps1 not found in:
    echo   %SCRIPT_DIR%
    pause
    exit /b 1
)

REM Relaunch elevated (setup.ps1 requires -RunAsAdministrator)
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
    exit /b
)

REM Already elevated - run the PowerShell script
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*

echo.
echo ============================================================
echo  setup.ps1 has finished. Press any key to close this window.
echo ============================================================
pause >nul
