$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RuntimeDir = Split-Path -Parent $PSCommandPath
$SrcTauriDir = Split-Path -Parent $RuntimeDir
$RepoRoot = Split-Path -Parent $SrcTauriDir
$BinDir = Join-Path $RuntimeDir "bin"
$ModelsDir = Join-Path $RuntimeDir "models"
$CacheDir = Join-Path $SrcTauriDir "target\ocr-runtime-cache"
$RunnerManifest = Join-Path $SrcTauriDir "ocr-runner\Cargo.toml"
$WindowsRustTarget = "x86_64-pc-windows-msvc"
$RunnerTargetDir = Join-Path $SrcTauriDir "ocr-runner\target\$WindowsRustTarget\release"
$RunnerExe = Join-Path $RunnerTargetDir "wordhunter-paddleocr.exe"
$RuntimeRunnerExe = Join-Path $BinDir "wordhunter-paddleocr.exe"
$WindowsRuntimeScript = Join-Path $RepoRoot "scripts\windows-runtime.ps1"

. $WindowsRuntimeScript

$PaddleModelsUrl = "https://github.com/mg-chao/paddle-ocr-rs/releases/download/onnx_models/Paddle.OCR.V5.zip"
$PaddleModelsSha256 = "2FA4055B10DC4E9C1433444FE29F8D5ACCA2FCCC0A0E86B3313CAA5CC9E56B7A"
$PdfiumUrl = "https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F7920/pdfium-win-x64.tgz"
$PdfiumSha256 = "BF25149815B34B00042F48A886653D469C817529DD9CCCABB4B509B6465A9526"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Note([string]$Message) {
    Write-Host "    $Message"
}

function Ensure-Directory([string]$Path) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Ensure-Cargo {
    if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
        throw "Cargo/Rust was not found. Install Rust from https://rustup.rs/ and open a new PowerShell window."
    }
}

function Get-Sha256Hex([string]$Path) {
    if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
    }

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($sha256.ComputeHash($stream)) -replace "-", "").ToUpperInvariant()
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Test-Sha256([string]$Path, [string]$ExpectedHash) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    $actual = Get-Sha256Hex $Path
    return $actual -eq $ExpectedHash.ToUpperInvariant()
}

function Download-File([string]$Url, [string]$Destination, [string]$Sha256 = "") {
    if ([string]::IsNullOrWhiteSpace($Sha256)) {
        throw "SHA256 checksum is required for $Url"
    }
    if ($Sha256 -and (Test-Sha256 $Destination $Sha256)) {
        Write-Note "Using cached $(Split-Path -Leaf $Destination)"
        return
    }

    Write-Note "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -ErrorAction Stop

    if (-not (Test-Sha256 $Destination $Sha256)) {
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        throw "SHA256 mismatch for $Destination"
    }
}

function Expand-PackageFresh([string]$PackagePath) {
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("wordhunter-ocr-" + [Guid]::NewGuid().ToString("N"))
    Ensure-Directory $temp
    $name = (Split-Path -Leaf $PackagePath).ToLowerInvariant()
    if ($name.EndsWith(".zip")) {
        Expand-Archive -LiteralPath $PackagePath -DestinationPath $temp -Force
    } elseif ($name.EndsWith(".tgz") -or $name.EndsWith(".tar.gz")) {
        if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
            throw "tar.exe was not found; it is required to extract $PackagePath"
        }
        & tar.exe -xzf $PackagePath -C $temp
        if ($LASTEXITCODE -ne 0) {
            throw "tar.exe failed with exit code $LASTEXITCODE while extracting $PackagePath"
        }
    } else {
        throw "Unsupported package format: $PackagePath"
    }
    return $temp
}

function Prepare-Models {
    $detModel = Join-Path $ModelsDir "ch_PP-OCRv5_mobile_det.onnx"
    $recModel = Join-Path $ModelsDir "ch_PP-OCRv5_rec_mobile_infer.onnx"
    $clsModel = Join-Path $ModelsDir "ch_ppocr_mobile_v2.0_cls_infer.onnx"
    if ((Test-Path -LiteralPath $detModel) -and
        (Test-Path -LiteralPath $recModel) -and
        (Test-Path -LiteralPath $clsModel)) {
        Write-Note "PaddleOCR ONNX models are already present."
        return
    }

    Write-Step "Preparing PaddleOCR ONNX models"
    $zip = Join-Path $CacheDir "Paddle.OCR.V5.zip"
    Download-File $PaddleModelsUrl $zip $PaddleModelsSha256
    $temp = Expand-PackageFresh $zip
    try {
        Get-ChildItem -LiteralPath $temp -Recurse -File |
            Where-Object { $_.Extension -in @(".onnx", ".txt") } |
            ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $ModelsDir $_.Name) -Force
            }
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Prepare-Pdfium {
    $pdfiumDll = Join-Path $BinDir "pdfium.dll"
    if (Test-Path -LiteralPath $pdfiumDll) {
        Write-Note "pdfium.dll is already present."
        return
    }

    Write-Step "Preparing PDF renderer"
    $package = Join-Path $CacheDir "pdfium-win-x64.tgz"
    Download-File $PdfiumUrl $package $PdfiumSha256
    $temp = Expand-PackageFresh $package
    try {
        $dll = Get-ChildItem -LiteralPath $temp -Recurse -File -Filter "pdfium.dll" |
            Select-Object -First 1
        if (-not $dll) {
            throw "pdfium.dll was not found in $package"
        }
        Copy-Item -LiteralPath $dll.FullName -Destination $pdfiumDll -Force
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Build-Runner {
    Write-Step "Building native PaddleOCR runner"
    Ensure-Cargo
    Push-Location -LiteralPath $RepoRoot
    try {
        & cargo.exe build --release --target $WindowsRustTarget --manifest-path $RunnerManifest
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $RunnerExe)) {
        throw "Runner build finished, but expected exe was not found: $RunnerExe"
    }
    Copy-Item -LiteralPath $RunnerExe -Destination $RuntimeRunnerExe -Force

    Get-ChildItem -LiteralPath $BinDir -File |
        Where-Object { $_.Name -notin @(".gitkeep", "pdfium.dll", "wordhunter-paddleocr.exe") } |
        Remove-Item -Force

    foreach ($pattern in @("DirectML.dll", "onnxruntime*.dll")) {
        Get-ChildItem -LiteralPath $RunnerTargetDir -Recurse -File -Filter $pattern |
            Sort-Object FullName -Unique |
            ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $BinDir $_.Name) -Force
            }
    }
    $runtimeSearchDirs = @($RunnerTargetDir, (Join-Path $RunnerTargetDir "deps"))
    if ($env:VCToolsRedistDir) {
        $runtimeSearchDirs += $env:VCToolsRedistDir
    }
    Copy-RequiredWindowsRuntimeDlls `
        -ExecutablePath $RuntimeRunnerExe `
        -DestinationDir $BinDir `
        -ExtraSearchDirs $runtimeSearchDirs | Out-Null
    $runtimeDlls = Get-ChildItem -LiteralPath $BinDir -File -Filter "*.dll" |
        Where-Object { $_.Name -ne "pdfium.dll" }
    if (-not $runtimeDlls) {
        Write-Note "No OCR runtime DLLs were copied; the runner will use statically linked or delayed-loaded ONNX Runtime components."
    } else {
        foreach ($dll in $runtimeDlls) {
            Write-Note "Bundled $($dll.Name)"
        }
    }
}

Ensure-Directory $BinDir
Ensure-Directory $ModelsDir
Ensure-Directory $CacheDir

Prepare-Models
Prepare-Pdfium
Build-Runner

Write-Host ""
Write-Host "Done: $RuntimeDir" -ForegroundColor Green
