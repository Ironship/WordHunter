@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "TARGET=%~1"
if "%TARGET%"=="" goto :menu

if /I "%TARGET%"=="help" goto :help
if /I "%TARGET%"=="-h" goto :help
if /I "%TARGET%"=="--help" goto :help

if /I "%TARGET%"=="windows" goto :windows
if /I "%TARGET%"=="win" goto :windows
if /I "%TARGET%"=="exe" goto :windows
if /I "%TARGET%"=="cython" goto :windows

if /I "%TARGET%"=="linux" goto :linux
if /I "%TARGET%"=="wsl" goto :linux

echo Unknown build target: %TARGET%
echo.
goto :help

:menu
echo Word Hunter build
echo.
echo   W  Windows .exe with Cython
echo   L  Linux executable through WSL
echo   Q  Quit
echo.
choice /C WLQ /N /M "Choose target [W/L/Q]: "
if errorlevel 3 exit /b 0
if errorlevel 2 goto :linux
if errorlevel 1 goto :windows
exit /b 0

:windows
call "%~dp0build_cython.bat"
exit /b %ERRORLEVEL%

:linux
call "%~dp0build_linux_wsl.bat"
exit /b %ERRORLEVEL%

:help
echo Usage:
echo   build.bat windows   build output\Word.Hunter.exe using Cython
echo   build.bat linux     build output\Word.Hunter.Linux using WSL
echo.
echo In PowerShell run:
echo   .\build.bat
echo.
echo In CMD run:
echo   build.bat
exit /b 0
