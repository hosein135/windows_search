@echo off
REM   search.cmd                         open the window
REM   search.cmd NAME --source mellat    print matches
REM   search.cmd setup                   reinstall Python, Tk, and DuckDB

setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%."
set "PY=%ROOT%.venv\Scripts\python.exe"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

if /I "%~1"=="setup" goto setup

if not exist "%PY%" (
    echo Python is not set up yet. Installing it now.
    call :install
    if not exist "%PY%" (
        echo.
        echo Setup failed. Python is still missing:
        echo   %PY%
        pause
        exit /b 1
    )
)

if "%~1"=="" goto window

"%PY%" -u -m searchapp search %*
exit /b %ERRORLEVEL%

:window
"%PY%" -u -m searchapp
set "EXIT_CODE=%ERRORLEVEL%"
if not %EXIT_CODE%==0 (
    echo.
    echo search.cmd exited with code %EXIT_CODE%.
    pause
)
exit /b %EXIT_CODE%

:setup
call :install
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not %EXIT_CODE%==0 (
    echo search.cmd setup failed with code %EXIT_CODE%.
) else (
    echo search.cmd setup finished.
)
pause
exit /b %EXIT_CODE%

:install
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%setup.ps1"
exit /b %ERRORLEVEL%
