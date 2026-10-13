@echo off
REM Search from the command line. Example:  search.cmd علی --source mellat

setlocal
cd /d "%~dp0"
chcp 65001 >nul

if not exist ".venv\Scripts\python.exe" (
    echo Run setup.cmd first.
    exit /b 1
)

".venv\Scripts\python.exe" -u -m searchapp search %*
exit /b %ERRORLEVEL%
