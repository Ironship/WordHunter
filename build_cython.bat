@echo off
setlocal EnableExtensions
cd /d "%~dp0"

call :find_python
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%

call :load_msvc
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%

%PYTHON_CMD% -m pip install --upgrade pip setuptools wheel cython pyinstaller
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%

%PYTHON_CMD% -m pip install --upgrade -r src\requirements.txt
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%

%PYTHON_CMD% build_cython.py
exit /b %ERRORLEVEL%

:find_python
where py >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=py -3"
    py -3 -c "import sys" >nul 2>nul
    if not errorlevel 1 exit /b 0
)

where python >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=python"
    python -c "import sys" >nul 2>nul
    if not errorlevel 1 exit /b 0
)

echo Python 3 was not found. Install Python for Windows and add it to PATH.
exit /b 1

:load_msvc
where cl >nul 2>nul
if not errorlevel 1 exit /b 0

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%I"
    if defined VSINSTALL (
        if exist "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" (
            call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat"
            exit /b 0
        )
    )
)

for %%P in (
    "%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
    "%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    "%ProgramFiles%\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
    "%ProgramFiles%\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
) do (
    if exist "%%~P" (
        call "%%~P"
        exit /b 0
    )
)

echo MSVC compiler was not found.
echo.
echo You are building the Windows .exe with Cython, so Windows needs the
echo Microsoft C++ compiler. Install one of these:
echo.
echo   Option 1: Visual Studio Build Tools 2022
echo     Choose workload: Desktop development with C++
echo     Link: https://visualstudio.microsoft.com/visual-cpp-build-tools/
echo.
echo   Option 2: winget, from an Administrator terminal
echo     winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
echo.
where winget >nul 2>nul
if not errorlevel 1 (
    choice /C YN /N /M "Install Visual Studio Build Tools now with winget? [Y/N]: "
    if errorlevel 2 goto :skip_winget_install
    winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    echo.
    echo After installation open a NEW CMD/PowerShell window and run:
    echo   cd /d %~dp0
    echo   build_cython.bat
    exit /b 1
)

:skip_winget_install
echo After installation open a NEW CMD/PowerShell window and run:
echo   cd /d %~dp0
echo   build_cython.bat
echo.
echo If you only want the Linux/WSL build, run:
echo   build.bat linux
exit /b 1
