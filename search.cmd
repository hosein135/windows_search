@echo off
REM Launcher for search.ps1. Same shape as hosein135/recorder run.cmd:
REM powershell.exe is loaded by full path, because it is often missing from PATH.
REM Double-click this file, or run:  search.cmd
REM   search.cmd                         open the window
REM   search.cmd NAME --source mellat    print matches
REM   search.cmd setup                   install Python and DuckDB, then stop

setlocal

set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%search.ps1"

if not exist "%PS1%" (
    echo [search.cmd] ERROR: search.ps1 not found in:
    echo   %SCRIPT_DIR%
    pause
    exit /b 1
)

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" (
    echo [search.cmd] ERROR: powershell.exe was not found.
    echo   Expected:
    echo   %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
    pause
    exit /b 1
)

if exist "%SystemRoot%\System32\chcp.com" "%SystemRoot%\System32\chcp.com" 65001 >nul

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo ============================================================
echo search.ps1 has finished. Press any key to close this window.
echo ============================================================
pause >nul
exit /b %EXIT_CODE%
