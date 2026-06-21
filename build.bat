@echo off
setlocal EnableExtensions
set "BUILD_SCRIPT=%~f0"
set "BUILD_TARGETS=%*"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$content = Get-Content -Raw -LiteralPath $env:BUILD_SCRIPT; $marker = '# POWERSHELL_PAYLOAD'; $payload = $content.Substring($content.LastIndexOf($marker) + $marker.Length); & ([scriptblock]::Create($payload))"
exit /b %ERRORLEVEL%

# POWERSHELL_PAYLOAD
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $env:BUILD_SCRIPT
$Outputs = Join-Path $Root "outputs"
$RustManifest = Join-Path $Root "src-tauri\Cargo.toml"
$RustExe = Join-Path $Root "src-tauri\target\release\word-hunter-rustified.exe"
$TauriBundleDir = Join-Path $Root "src-tauri\target\release\bundle\nsis"
$OcrRuntimeScript = Join-Path $Root "src-tauri\ocr-runtime\prepare-runtime.ps1"
$PortableDir = Join-Path $Outputs "Word.Hunter.portable"
$OutputPortable = Join-Path $PortableDir "Word.Hunter.portable.exe"
$OutputPortableZip = Join-Path $Outputs "Word.Hunter.portable.zip"
$OutputInstaller = Join-Path $Outputs "Word.Hunter.Setup.exe"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Note([string]$Message) {
    Write-Host "    $Message"
}

function Fail([string]$Message) {
    Write-Host ""
    Write-Host $Message -ForegroundColor Red
    exit 1
}

function Ensure-Directory([string]$Path) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Invoke-External([string]$File, [string[]]$Arguments) {
    $printable = @($File) + $Arguments
    Write-Host ("    $ " + ($printable -join " "))
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $File"
    }
}

function Ensure-Cargo {
    if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
        Fail "Cargo/Rust was not found. Install Rust from https://rustup.rs/ and open a new PowerShell window."
    }
}

function Ensure-TauriCli {
    Ensure-Cargo
    & cargo.exe tauri --version *> $null
    if ($LASTEXITCODE -ne 0) {
        Fail @"
Tauri CLI was not found.

Install it with:
  cargo install tauri-cli --locked
"@
    }
}

function Enable-MSVC {
    Write-Step "Loading MSVC compiler"
    if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
        Write-Note "MSVC compiler is already available."
        return
    }

    $vcvars = $null
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $vswhere) {
        $install = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($install) {
            $candidate = Join-Path $install "VC\Auxiliary\Build\vcvars64.bat"
            if (Test-Path -LiteralPath $candidate) {
                $vcvars = $candidate
            }
        }
    }

    if (-not $vcvars) {
        $candidates = @(
            "$env:ProgramFiles\Microsoft Visual Studio\2026\Community\VC\Auxiliary\Build\vcvars64.bat",
            "$env:ProgramFiles\Microsoft Visual Studio\2026\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
            "$env:ProgramFiles\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
            "$env:ProgramFiles\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
            "$env:ProgramFiles\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat",
            "$env:ProgramFiles\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
        )
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath $candidate) {
                $vcvars = $candidate
                break
            }
        }
    }

    if (-not $vcvars) {
        Fail @"
MSVC compiler was not found.

Install Visual Studio Build Tools with workload:
  Desktop development with C++
"@
    }

    Write-Note "Using $vcvars"
    $envOutput = cmd.exe /c "`"$vcvars`" >nul && set"
    foreach ($line in $envOutput) {
        $parts = $line -split "=", 2
        if ($parts.Count -eq 2) {
            Set-Item -Path ("Env:" + $parts[0]) -Value $parts[1]
        }
    }
}

function Build-Portable {
    Write-Step "Building portable package"
    Ensure-Cargo

    Enable-MSVC
    Ensure-Directory $Outputs
    Build-OcrRuntime

    $previousParallel = $env:CMAKE_BUILD_PARALLEL_LEVEL
    if (-not $previousParallel) {
        $env:CMAKE_BUILD_PARALLEL_LEVEL = "1"
    }
    try {
        Invoke-External "cargo.exe" @("build", "--release", "--manifest-path", $RustManifest)
    } finally {
        if ($previousParallel) {
            $env:CMAKE_BUILD_PARALLEL_LEVEL = $previousParallel
        } else {
            Remove-Item Env:\CMAKE_BUILD_PARALLEL_LEVEL -ErrorAction SilentlyContinue
        }
    }

    if (-not (Test-Path -LiteralPath $RustExe)) {
        Fail "Rust build finished, but expected exe was not found: $RustExe"
    }

    Ensure-Directory $PortableDir
    Copy-Item -LiteralPath $RustExe -Destination $OutputPortable -Force
    Copy-Item -LiteralPath (Join-Path $Root "src-tauri\ocr-runtime") -Destination $PortableDir -Recurse -Force
    Compress-Archive -Path (Join-Path $PortableDir "*") -DestinationPath $OutputPortableZip -Force
    Write-Host ""
    Write-Host "Done: $OutputPortableZip" -ForegroundColor Green
}

function Build-Installer {
    Write-Step "Building Windows installer"
    Ensure-Cargo
    Enable-MSVC
    Ensure-Directory $Outputs
    Build-OcrRuntime
    Ensure-TauriCli

    $previousParallel = $env:CMAKE_BUILD_PARALLEL_LEVEL
    if (-not $previousParallel) {
        $env:CMAKE_BUILD_PARALLEL_LEVEL = "1"
    }
    try {
        Push-Location -LiteralPath (Join-Path $Root "src-tauri")
        try {
            Invoke-External "cargo.exe" @("tauri", "build")
        } finally {
            Pop-Location
        }
    } finally {
        if ($previousParallel) {
            $env:CMAKE_BUILD_PARALLEL_LEVEL = $previousParallel
        } else {
            Remove-Item Env:\CMAKE_BUILD_PARALLEL_LEVEL -ErrorAction SilentlyContinue
        }
    }

    $installer = Get-ChildItem -LiteralPath $TauriBundleDir -Filter "*.exe" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $installer) {
        Fail "Tauri build finished, but no NSIS installer was found in: $TauriBundleDir"
    }

    Copy-Item -LiteralPath $installer.FullName -Destination $OutputInstaller -Force
    Write-Host ""
    Write-Host "Done: $OutputInstaller" -ForegroundColor Green
}

function Build-OcrRuntime {
    Write-Step "Preparing native PaddleOCR runtime"
    if (-not (Test-Path -LiteralPath $OcrRuntimeScript)) {
        Fail "OCR runtime preparation script was not found: $OcrRuntimeScript"
    }
    Invoke-External "powershell.exe" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $OcrRuntimeScript)
}

function Build-Flatpak {
    Write-Step "Flatpak"
    Fail @"
Flatpak is now part of the Rust/Tauri port and must be finished on Linux/WSL.
The old Flatpak path was removed intentionally.
"@
}

function Build-Dmg {
    Write-Step "macOS dmg"
    Fail @"
DMG cannot be built on Windows.
Build the Rust/Tauri macOS bundle on macOS or a macOS CI runner.
"@
}

function Show-Usage {
    Write-Host "Word Hunter Rustified build"
    Write-Host ""
    Write-Host "Usage from PowerShell:"
    Write-Host "  .\build.bat              build portable ZIP and Setup installer"
    Write-Host "  .\build.bat all          build portable ZIP and Setup installer"
    Write-Host "  .\build.bat installer    build outputs\Word.Hunter.Setup.exe"
    Write-Host "  .\build.bat portable     build outputs\Word.Hunter.portable.zip"
    Write-Host "  .\build.bat ocr-runtime  prepare bundled native PaddleOCR runtime"
    Write-Host "  .\build.bat exe          build outputs\Word.Hunter.portable.zip"
    Write-Host "  .\build.bat rust         build outputs\Word.Hunter.portable.zip"
    Write-Host "  .\build.bat flatpak      Rust/Tauri Flatpak is not wired on Windows yet"
    Write-Host "  .\build.bat dmg          macOS-only"
}

try {
    Set-Location -LiteralPath $Root
    Ensure-Directory $Outputs

    $targets = @()
    if ($env:BUILD_TARGETS) {
        $targets = $env:BUILD_TARGETS -split "\s+" | Where-Object { $_ }
    }
    if ($targets.Count -eq 0) {
        $targets = @("all")
    }

    foreach ($rawTarget in $targets) {
        $target = $rawTarget.ToLowerInvariant()
        switch ($target) {
            "all" { Build-Portable; Build-Installer }
            "windows" { Build-Installer }
            "win" { Build-Installer }
            "installer" { Build-Installer }
            "setup" { Build-Installer }
            "nsis" { Build-Installer }
            "ocr" { Build-OcrRuntime }
            "ocr-runtime" { Build-OcrRuntime }
            "paddleocr" { Build-OcrRuntime }
            "portable" { Build-Portable }
            "exe" { Build-Portable }
            "rust" { Build-Portable }
            "tauri" { Build-Installer }
            "rustified" { Build-Portable }
            "flatpak" { Build-Flatpak }
            "linux" { Build-Flatpak }
            "wsl" { Build-Flatpak }
            "mac" { Build-Dmg }
            "macos" { Build-Dmg }
            "dmg" { Build-Dmg }
            "help" { Show-Usage }
            "-h" { Show-Usage }
            "--help" { Show-Usage }
            default {
                Show-Usage
                Fail "Unknown build target: $rawTarget"
            }
        }
    }
} catch {
    Fail $_.Exception.Message
}
