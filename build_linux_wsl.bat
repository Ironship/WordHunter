@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where wsl.exe >nul 2>nul
if errorlevel 1 (
    echo WSL was not found.
    echo Install WSL, then run this again:
    echo   wsl --install
    exit /b 1
)

echo Building Linux/WSL executable from:
echo   %CD%
echo.
echo This runs inside WSL. Do not use /mnt/c paths in Windows CMD.
echo.

wsl.exe --cd "%CD%" bash -lc "bash build.sh"
exit /b %ERRORLEVEL%
