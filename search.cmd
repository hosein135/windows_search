@echo off
REM One launcher for the search app:
REM   search.cmd                         open the window
REM   search.cmd علی --source mellat     print matches
REM   search.cmd setup                   install Python, Tk, and DuckDB

setlocal
cd /d "%~dp0"
chcp 65001 >nul

if /I "%~1"=="setup" goto setup

if not exist ".venv\Scripts\python.exe" (
    echo Run search.cmd setup first.
    pause
    exit /b 1
)

if "%~1"=="" goto window

".venv\Scripts\python.exe" -u -m searchapp search %*
exit /b %ERRORLEVEL%

:window
".venv\Scripts\python.exe" -u -m searchapp
set "EXIT_CODE=%ERRORLEVEL%"
if not %EXIT_CODE%==0 (
    echo.
    echo search.cmd exited with code %EXIT_CODE%.
    pause
)
exit /b %EXIT_CODE%

:setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not %EXIT_CODE%==0 (
    echo search.cmd setup failed with code %EXIT_CODE%.
) else (
    echo search.cmd setup finished.
)
pause
exit /b %EXIT_CODE%
