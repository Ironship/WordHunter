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
$OutputAndroidDebugApk = Join-Path $Outputs "Word.Hunter.Pocket.debug.apk"
$OutputAndroidEmulatorDebugApk = Join-Path $Outputs "Word.Hunter.Pocket.emulator.debug.apk"
$OutputAndroidReleaseAab = Join-Path $Outputs "Word.Hunter.Pocket.release.aab"
$RequiredTauriCliVersion = "2.11.4"

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

function Invoke-WithCmakeBuildParallelLimit([scriptblock]$Action) {
    $previousParallel = $env:CMAKE_BUILD_PARALLEL_LEVEL
    if (-not $previousParallel) {
        $env:CMAKE_BUILD_PARALLEL_LEVEL = "1"
    }
    try {
        & $Action
    } finally {
        if ($previousParallel) {
            $env:CMAKE_BUILD_PARALLEL_LEVEL = $previousParallel
        } else {
            Remove-Item Env:\CMAKE_BUILD_PARALLEL_LEVEL -ErrorAction SilentlyContinue
        }
    }
}

function Ensure-Cargo {
    if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
        Fail "Cargo/Rust was not found. Install Rust from https://rustup.rs/ and open a new PowerShell window."
    }
}

function Ensure-TauriCli {
    Ensure-Cargo
    $versionOutput = & cargo.exe tauri --version 2>&1
    $versionExitCode = $LASTEXITCODE
    $versionText = [string]($versionOutput | Select-Object -First 1)
    if ($versionExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($versionText)) {
        Fail @"
Tauri CLI was not found.

Install it with:
  cargo install tauri-cli --version $RequiredTauriCliVersion --locked
"@
    }
    $installedVersion = ($versionText -split "\s+" | Select-Object -Last 1)
    if ($installedVersion -ne $RequiredTauriCliVersion) {
        Fail @"
Tauri CLI $RequiredTauriCliVersion is required, but found: $versionText

Install it with:
  cargo install tauri-cli --version $RequiredTauriCliVersion --locked
"@
    }
}

function Add-PathEntry([string]$Path) {
    if ($Path -and (Test-Path -LiteralPath $Path)) {
        $parts = $env:Path -split ";"
        if ($parts -notcontains $Path) {
            $env:Path = "$Path;$env:Path"
        }
    }
}

function Ensure-Java {
    if ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
        Add-PathEntry (Join-Path $env:JAVA_HOME "bin")
        return
    }

    $jdk = $null
    $adoptiumRoot = Join-Path $env:ProgramFiles "Eclipse Adoptium"
    if (Test-Path -LiteralPath $adoptiumRoot) {
        $jdk = Get-ChildItem -LiteralPath $adoptiumRoot -Directory -Filter "jdk-*" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            Select-Object -First 1
    }

    if (-not $jdk) {
        Fail @"
Java JDK was not found.

Install Temurin JDK 17+ or set JAVA_HOME, then retry:
  winget install EclipseAdoptium.Temurin.17.JDK
"@
    }

    $env:JAVA_HOME = $jdk.FullName
    Add-PathEntry (Join-Path $env:JAVA_HOME "bin")
}

function Ensure-AndroidSdk {
    $sdk = $env:ANDROID_HOME
    if (-not $sdk) {
        $sdk = $env:ANDROID_SDK_ROOT
    }
    if (-not $sdk) {
        $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
    }
    if (-not (Test-Path -LiteralPath $sdk)) {
        Fail @"
Android SDK was not found.

Install Android command line tools, then set ANDROID_HOME or use the default:
  $sdk
"@
    }

    $env:ANDROID_HOME = $sdk
    $env:ANDROID_SDK_ROOT = $sdk
    Add-PathEntry (Join-Path $sdk "platform-tools")
    Add-PathEntry (Join-Path $sdk "cmdline-tools\latest\bin")
    return $sdk
}

function Ensure-AndroidNdk([string]$Sdk) {
    if ($env:NDK_HOME -and (Test-Path -LiteralPath $env:NDK_HOME)) {
        return $env:NDK_HOME
    }

    $ndkRoot = Join-Path $Sdk "ndk"
    $ndk = Get-ChildItem -LiteralPath $ndkRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if (-not $ndk) {
        Fail @"
Android NDK was not found.

Install it with Android sdkmanager, for example:
  sdkmanager `"ndk;27.0.12077973`"
"@
    }

    $env:NDK_HOME = $ndk.FullName
    return $env:NDK_HOME
}

function Get-AndroidRustTarget([string]$Target) {
    switch ($Target) {
        "aarch64" { return "aarch64-linux-android" }
        "x86_64" { return "x86_64-linux-android" }
        default { Fail "Unsupported Android target for build.bat: $Target" }
    }
}

function Ensure-AndroidRustTarget([string]$Target) {
    $installed = & rustup.exe target list --installed 2>$null
    if ($LASTEXITCODE -ne 0) {
        Fail "rustup was not found. Install Rust with rustup so the Android target can be installed."
    }
    if ($installed -notcontains $Target) {
        Invoke-External "rustup.exe" @("target", "add", $Target)
    }
}

function Ensure-AndroidToolchain([string]$RustTarget = "aarch64-linux-android") {
    Ensure-TauriCli
    Ensure-Java
    $sdk = Ensure-AndroidSdk
    Ensure-AndroidNdk $sdk | Out-Null
    Ensure-AndroidRustTarget $RustTarget
}

function Ensure-AndroidProject {
    $gradle = Join-Path $Root "src-tauri\gen\android\gradlew.bat"
    if (Test-Path -LiteralPath $gradle) {
        return
    }

    Write-Step "Initializing Tauri Android project"
    Invoke-External "cargo.exe" @("tauri", "android", "init", "--ci", "--skip-targets-install")
}

function Sync-AndroidLauncherIcons {
    $sourceIcon = Join-Path $Root "src\assets\icon-256.png"
    if (-not (Test-Path -LiteralPath $sourceIcon)) {
        Fail "Android launcher source icon was not found: $sourceIcon"
    }
    $backgroundColor = "#1f4a3a"
    $backgroundXml = @"
<?xml version="1.0" encoding="utf-8"?>
<resources>
  <color name="ic_launcher_background">$backgroundColor</color>
</resources>
"@
    $backgroundPath = Join-Path $Root "src-tauri\gen\android\app\src\main\res\values\ic_launcher_background.xml"
    if (Test-Path -LiteralPath (Split-Path -Parent $backgroundPath)) {
        Set-Content -LiteralPath $backgroundPath -Value $backgroundXml -NoNewline
    }

    Add-Type -AssemblyName System.Drawing
    $source = [System.Drawing.Image]::FromFile($sourceIcon)
    try {
        $sizes = @{
            "mipmap-mdpi" = 48
            "mipmap-hdpi" = 72
            "mipmap-xhdpi" = 96
            "mipmap-xxhdpi" = 144
            "mipmap-xxxhdpi" = 192
        }

        foreach ($density in $sizes.Keys) {
            $dir = Join-Path $Root "src-tauri\gen\android\app\src\main\res\$density"
            if (-not (Test-Path -LiteralPath $dir)) {
                continue
            }

            foreach ($name in @("ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png")) {
                $target = Join-Path $dir $name
                $size = $sizes[$density]
                $bitmap = New-Object System.Drawing.Bitmap($size, $size)
                try {
                    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
                    try {
                        $graphics.Clear([System.Drawing.Color]::Transparent)
                        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
                        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                        $scale = if ($name -eq "ic_launcher_foreground.png") { 0.78 } else { 1.0 }
                        $drawSize = [int][Math]::Round($size * $scale)
                        $offset = [int][Math]::Floor(($size - $drawSize) / 2)
                        $graphics.DrawImage($source, $offset, $offset, $drawSize, $drawSize)
                    } finally {
                        $graphics.Dispose()
                    }
                    $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
                } finally {
                    $bitmap.Dispose()
                }
            }
        }
    } finally {
        $source.Dispose()
    }
}

function Prepare-AndroidProject {
    Write-Step "Preparing Android project"

    $androidApp = Join-Path $Root "src-tauri\gen\android\app"
    $activitySource = Join-Path $Root "src-tauri\platforms\android\MainActivity.kt"
    $activityTarget = Join-Path $androidApp "src\main\java\com\wordhunter\pocket\MainActivity.kt"
    $manifestSource = Join-Path $Root "src-tauri\platforms\android\AndroidManifest.xml"
    $manifestTarget = Join-Path $androidApp "src\main\AndroidManifest.xml"
    if (-not (Test-Path -LiteralPath $activitySource)) {
        Fail "Android MainActivity source was not found: $activitySource"
    }
    if (-not (Test-Path -LiteralPath $manifestSource)) {
        Fail "Android manifest source was not found: $manifestSource"
    }
    Copy-Item -LiteralPath $activitySource -Destination $activityTarget -Force
    Copy-Item -LiteralPath $manifestSource -Destination $manifestTarget -Force
    Remove-Item -LiteralPath (Join-Path $androidApp "src\main\assets\ocr-runtime") -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $androidApp "src\main\res\xml\file_paths.xml") -Force -ErrorAction SilentlyContinue
    $valuesDir = Join-Path $androidApp "src\main\res\values"
    $nightValuesDir = Join-Path $androidApp "src\main\res\values-night"
    Ensure-Directory $valuesDir
    Ensure-Directory $nightValuesDir
    $themeXml = @"
<resources>
    <style name="Theme.word_hunter" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="android:windowBackground">#0d1114</item>
        <item name="android:statusBarColor">#0d1114</item>
        <item name="android:navigationBarColor">#071724</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:windowLightNavigationBar">false</item>
    </style>
</resources>
"@
    Set-Content -LiteralPath (Join-Path $valuesDir "themes.xml") -Value $themeXml -NoNewline
    Set-Content -LiteralPath (Join-Path $nightValuesDir "themes.xml") -Value $themeXml -NoNewline

    $gradle = Join-Path $androidApp "build.gradle.kts"
    $gradleText = Get-Content -Raw -LiteralPath $gradle
    if ($gradleText -notmatch "androidx\.documentfile:documentfile:") {
        $dependency = '    implementation("androidx.documentfile:documentfile:1.0.1")'
        $gradleText = $gradleText -replace '(\s+implementation\("androidx\.activity:activity-ktx:[^"]+"\))', "`$1`r`n$dependency"
        Set-Content -LiteralPath $gradle -Value $gradleText -NoNewline
    }

    Sync-AndroidLauncherIcons
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

function Build-Portable([switch]$SkipRuntime, [switch]$SkipRustBuild) {
    Write-Step "Building portable package"
    Ensure-Cargo

    Enable-MSVC
    Ensure-Directory $Outputs
    if (-not $SkipRuntime) {
        Build-OcrRuntime
    }

    if (-not $SkipRustBuild) {
        Invoke-WithCmakeBuildParallelLimit {
            Invoke-External "cargo.exe" @("build", "--release", "--manifest-path", $RustManifest)
        }
    }

    if (-not (Test-Path -LiteralPath $RustExe)) {
        Fail "Rust build finished, but expected exe was not found: $RustExe"
    }

    Ensure-Directory $PortableDir
    Copy-Item -LiteralPath $RustExe -Destination $OutputPortable -Force
    $portableOcrRuntime = Join-Path $PortableDir "ocr-runtime"
    Remove-Item -LiteralPath $portableOcrRuntime -Recurse -Force -ErrorAction SilentlyContinue
    Ensure-Directory $portableOcrRuntime
    foreach ($runtimeDir in @("bin", "models")) {
        Copy-Item -LiteralPath (Join-Path $Root "src-tauri\ocr-runtime\$runtimeDir") -Destination $portableOcrRuntime -Recurse -Force
    }
    Compress-Archive -Path (Join-Path $PortableDir "*") -DestinationPath $OutputPortableZip -Force
    Write-Host ""
    Write-Host "Done: $OutputPortableZip" -ForegroundColor Green
}

function Build-Installer([switch]$SkipRuntime) {
    Write-Step "Building Windows installer"
    Ensure-Cargo
    Enable-MSVC
    Ensure-Directory $Outputs
    if (-not $SkipRuntime) {
        Build-OcrRuntime
    }
    Ensure-TauriCli

    Invoke-WithCmakeBuildParallelLimit {
        Push-Location -LiteralPath (Join-Path $Root "src-tauri")
        try {
            Invoke-External "cargo.exe" @("tauri", "build")
        } finally {
            Pop-Location
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

function Build-AndroidApk([string]$Target = "aarch64", [string]$OutputApk = $OutputAndroidDebugApk) {
    Write-Step "Building Android debug APK"
    Ensure-Directory $Outputs
    Ensure-AndroidToolchain (Get-AndroidRustTarget $Target)
    Ensure-AndroidProject
    Prepare-AndroidProject

    Invoke-External "cargo.exe" @("tauri", "android", "build", "--debug", "--apk", "--target", $Target)

    $apkRoot = Join-Path $Root "src-tauri\gen\android\app\build\outputs\apk"
    $apk = Get-ChildItem -LiteralPath $apkRoot -Recurse -Filter "*.apk" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $apk) {
        Fail "Android build finished, but no APK was found in: $apkRoot"
    }

    Copy-Item -LiteralPath $apk.FullName -Destination $OutputApk -Force
    Write-Host ""
    Write-Host "Done: $OutputApk" -ForegroundColor Green
}

function Build-AndroidEmulatorApk {
    Build-AndroidApk "x86_64" $OutputAndroidEmulatorDebugApk
}

function Get-AndroidSigningConfig {
    $keystore = $env:WH_ANDROID_KEYSTORE
    $alias = $env:WH_ANDROID_KEY_ALIAS
    $storePass = $env:WH_ANDROID_KEYSTORE_PASSWORD
    $keyPass = $env:WH_ANDROID_KEY_PASSWORD
    if (-not $keyPass) {
        $keyPass = $storePass
    }

    $hasAnySigningValue = $keystore -or $alias -or $storePass -or $env:WH_ANDROID_KEY_PASSWORD
    if (-not $hasAnySigningValue) {
        return $null
    }

    $missing = @()
    if (-not $keystore) { $missing += "WH_ANDROID_KEYSTORE" }
    if (-not $alias) { $missing += "WH_ANDROID_KEY_ALIAS" }
    if (-not $storePass) { $missing += "WH_ANDROID_KEYSTORE_PASSWORD" }
    if ($missing.Count -gt 0) {
        Fail "Android signing is partially configured. Missing: $($missing -join ', ')"
    }
    if (-not (Test-Path -LiteralPath $keystore)) {
        Fail "Android keystore was not found: $keystore"
    }

    [pscustomobject]@{
        Keystore = $keystore
        Alias = $alias
        StorePass = $storePass
        KeyPass = $keyPass
    }
}

function Copy-OrSignAndroidAab([string]$InputAab, [string]$OutputAab, [switch]$RequireSigning) {
    $signing = Get-AndroidSigningConfig
    if (-not $signing) {
        if ($RequireSigning) {
            Fail @"
Android Play AAB must be signed.

Set these environment variables and retry:
  WH_ANDROID_KEYSTORE
  WH_ANDROID_KEY_ALIAS
  WH_ANDROID_KEYSTORE_PASSWORD
  WH_ANDROID_KEY_PASSWORD
"@
        }
        Copy-Item -LiteralPath $InputAab -Destination $OutputAab -Force
        Write-Host ""
        Write-Host "Done: $OutputAab" -ForegroundColor Green
        Write-Host "Unsigned AAB. For Google Play upload, set WH_ANDROID_KEYSTORE, WH_ANDROID_KEY_ALIAS, WH_ANDROID_KEYSTORE_PASSWORD and WH_ANDROID_KEY_PASSWORD." -ForegroundColor Yellow
        return
    }

    Ensure-Java
    if (-not (Get-Command jarsigner.exe -ErrorAction SilentlyContinue)) {
        Fail "jarsigner.exe was not found in JAVA_HOME. Install a full JDK, not only a JRE."
    }

    $signedAab = Join-Path $Outputs "Word.Hunter.Pocket.release.signed.tmp.aab"
    Remove-Item -LiteralPath $signedAab -Force -ErrorAction SilentlyContinue
    Write-Host "    $ jarsigner.exe -keystore <WH_ANDROID_KEYSTORE> -storepass <hidden> -keypass <hidden> -signedjar $signedAab $InputAab <WH_ANDROID_KEY_ALIAS>"
    & jarsigner.exe -keystore $signing.Keystore -storepass $signing.StorePass -keypass $signing.KeyPass -signedjar $signedAab $InputAab $signing.Alias
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: jarsigner.exe"
    }

    Copy-Item -LiteralPath $signedAab -Destination $OutputAab -Force
    Remove-Item -LiteralPath $signedAab -Force -ErrorAction SilentlyContinue
    Invoke-External "jarsigner.exe" @("-verify", "-certs", $OutputAab)
    Write-Host ""
    Write-Host "Done: $OutputAab" -ForegroundColor Green
    Write-Host "Signed with Android upload key alias: $($signing.Alias)" -ForegroundColor Green
}

function Build-AndroidReleaseAab([string]$Target = "aarch64", [string]$OutputAab = $OutputAndroidReleaseAab, [switch]$RequireSigning) {
    Write-Step "Building Android release AAB"
    Ensure-Directory $Outputs
    Ensure-AndroidToolchain (Get-AndroidRustTarget $Target)
    Ensure-AndroidProject
    Prepare-AndroidProject

    Invoke-External "cargo.exe" @("tauri", "android", "build", "--aab", "--target", $Target)

    $aabRoot = Join-Path $Root "src-tauri\gen\android\app\build\outputs\bundle"
    $aab = Get-ChildItem -LiteralPath $aabRoot -Recurse -Filter "*.aab" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $aab) {
        Fail "Android build finished, but no AAB was found in: $aabRoot"
    }

    Copy-OrSignAndroidAab $aab.FullName $OutputAab -RequireSigning:$RequireSigning
}

function Test-FrontendShared {
    Write-Step "Frontend shared tests"
    Invoke-External "node.exe" @("--test", "frontend-tests\shared\*.test.js")
}

function Test-FrontendAndroid {
    Write-Step "Frontend Android tests"
    Invoke-External "node.exe" @("--test", "frontend-tests\android\*.test.js")
}

function Test-FrontendDesktop {
    Write-Step "Frontend desktop tests"
    Invoke-External "node.exe" @("--test", "frontend-tests\desktop\*.test.js")
}

function Test-Frontend {
    Test-FrontendShared
    Test-FrontendDesktop
    Test-FrontendAndroid
}

function Show-Usage {
    Write-Host "Word Hunter Rustified build"
    Write-Host ""
    Write-Host "Usage from PowerShell:"
    Write-Host "  .\build.bat              build portable ZIP and Setup installer"
    Write-Host "  .\build.bat all          build portable ZIP and Setup installer"
    Write-Host "  .\build.bat installer    build outputs\Word.Hunter.Setup.exe"
    Write-Host "  .\build.bat portable     build outputs\Word.Hunter.portable.zip"
    Write-Host "  .\build.bat apk          build outputs\Word.Hunter.Pocket.debug.apk"
    Write-Host "  .\build.bat apk-emulator build outputs\Word.Hunter.Pocket.emulator.debug.apk"
    Write-Host "  .\build.bat aab          build outputs\Word.Hunter.Pocket.release.aab; signs if WH_ANDROID_* env vars are set"
    Write-Host "  .\build.bat play         build signed Google Play AAB; requires WH_ANDROID_* env vars"
    Write-Host "  .\build.bat test         run shared, desktop, and Android frontend tests"
    Write-Host "  .\build.bat test-shared  run shared frontend tests"
    Write-Host "  .\build.bat test-desktop run desktop frontend tests"
    Write-Host "  .\build.bat test-android run Android frontend tests"
    Write-Host "  .\build.bat ocr-runtime  prepare bundled native PaddleOCR runtime"
}

try {
    Set-Location -LiteralPath $Root

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
            "all" { Build-OcrRuntime; Build-Installer -SkipRuntime; Build-Portable -SkipRuntime -SkipRustBuild }
            "installer" { Build-Installer }
            "ocr-runtime" { Build-OcrRuntime }
            "portable" { Build-Portable }
            "apk" { Build-AndroidApk }
            "apk-emulator" { Build-AndroidEmulatorApk }
            "aab" { Build-AndroidReleaseAab }
            "play" { Build-AndroidReleaseAab -RequireSigning }
            "test" { Test-Frontend }
            "test-shared" { Test-FrontendShared }
            "test-desktop" { Test-FrontendDesktop }
            "test-android" { Test-FrontendAndroid }
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
