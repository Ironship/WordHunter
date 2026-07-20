@echo off
setlocal EnableExtensions
set "BUILD_SCRIPT=%~f0"
set "BUILD_TARGETS=%*"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$content = Get-Content -Raw -LiteralPath $env:BUILD_SCRIPT; $marker = '# POWERSHELL_PAYLOAD'; $payload = $content.Substring($content.LastIndexOf($marker) + $marker.Length); & ([scriptblock]::Create($payload))"
exit /b %ERRORLEVEL%

# POWERSHELL_PAYLOAD
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $env:BUILD_SCRIPT
$Root = Split-Path -Parent $ScriptDir
$Outputs = Join-Path $Root "outputs"
$RustManifest = Join-Path $Root "src-tauri\Cargo.toml"
$WindowsRustTarget = "x86_64-pc-windows-msvc"
$RustExe = Join-Path $Root "src-tauri\target\$WindowsRustTarget\release\word-hunter-rustified.exe"
$TauriBundleDir = Join-Path $Root "src-tauri\target\$WindowsRustTarget\release\bundle\nsis"
$OcrRuntimeScript = Join-Path $Root "src-tauri\ocr-runtime\prepare-runtime.ps1"
$PortableDir = Join-Path $Outputs "Word.Hunter.portable"
$OutputPortable = Join-Path $PortableDir "Word.Hunter.portable.exe"
$OutputPortableZip = Join-Path $Outputs "Word.Hunter.portable.zip"
$OutputInstaller = Join-Path $Outputs "Word.Hunter.Setup.exe"
$OutputAndroidDebugApk = Join-Path $Outputs "Word.Hunter.Pocket.debug.apk"
$OutputAndroidEmulatorDebugApk = Join-Path $Outputs "Word.Hunter.Pocket.emulator.debug.apk"
$OutputAndroidReleaseAab = Join-Path $Outputs "Word.Hunter.Pocket.release.aab"
$RequiredTauriCliVersion = "2.11.4"
$WindowsRuntimeScript = Join-Path $Root "scripts\windows-runtime.ps1"
$LicenseFile = Join-Path $Root "LICENSE"
$ThirdPartyNotices = Join-Path $Root "THIRD-PARTY-NOTICES.md"
$ThirdPartyLicenses = Join-Path $Root "THIRD-PARTY-LICENSES.html"
$OcrThirdPartyLicenses = Join-Path $Root "OCR-THIRD-PARTY-LICENSES.html"
$SyncthingVersion = "2.1.0"
$SyncthingArchive = "syncthing-windows-amd64-v$SyncthingVersion.zip"
$SyncthingSha256 = "33DA7C8371F4A70DCF7E5F9136D71DBF5EA280D06BB99DB0D1E979B14C324DEB"
$SyncthingDir = Join-Path $Root "src-tauri\syncthing"
$SyncthingExe = Join-Path $SyncthingDir "syncthing.exe"
$SyncthingLicense = Join-Path $SyncthingDir "SYNCTHING-LICENSE.txt"
$SyncthingAuthors = Join-Path $SyncthingDir "SYNCTHING-AUTHORS.txt"
$script:FrontendBuilt = $false

. $WindowsRuntimeScript

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
    return (Get-Sha256Hex $Path) -eq $ExpectedHash.ToUpperInvariant()
}

function Download-File([string]$Url, [string]$Destination, [string]$Sha256) {
    if ([string]::IsNullOrWhiteSpace($Sha256)) {
        throw "SHA256 checksum is required for $Url"
    }
    if (Test-Sha256 $Destination $Sha256) {
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

function Set-RegexOnce([string]$Text, [string]$Pattern, [string]$Replacement, [string]$Description) {
    $matches = [regex]::Matches($Text, $Pattern)
    if ($matches.Count -eq 0) {
        Fail "Could not patch $Description because the expected Gradle regex did not match: $Pattern"
    }
    if ($matches.Count -gt 1) {
        Fail "Could not patch $Description because the expected Gradle regex matched $($matches.Count) times: $Pattern"
    }
    return [regex]::Replace($Text, $Pattern, $Replacement, 1)
}

function Assert-TextContains([string]$Text, [string]$Pattern, [string]$Description) {
    if ($Text -notmatch $Pattern) {
        Fail "$Description assertion failed after patching."
    }
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

function Ensure-FrontendBuild {
    if ($script:FrontendBuilt) {
        return
    }

    Write-Step "Building pinned TypeScript frontend"
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        Fail "Node.js was not found. Install Node.js 22+ so dist\web can be built."
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        Fail "npm was not found. Install it with Node.js 22+ so frontend dependencies can be restored."
    }

    $typescriptCompiler = Join-Path $Root "node_modules\typescript\bin\tsc"
    Push-Location -LiteralPath $Root
    try {
        if (-not (Test-Path -LiteralPath $typescriptCompiler)) {
            Invoke-External "npm.cmd" @("ci", "--ignore-scripts", "--no-audit", "--no-fund")
        }
        Invoke-External "npm.cmd" @("run", "build:frontend")
    } finally {
        Pop-Location
    }

    $script:FrontendBuilt = $true
}

function Get-PackagedWindowsRuntimeDllNames([string]$Directory) {
    if (-not (Test-Path -LiteralPath $Directory)) {
        return @()
    }
    return @(Get-ChildItem -LiteralPath $Directory -File -ErrorAction SilentlyContinue |
        Where-Object { $WindowsRuntimeDllNames -contains $_.Name.ToLowerInvariant() } |
        ForEach-Object { $_.Name })
}

function Copy-AppRuntimeDlls([string]$ExecutablePath, [string]$DestinationDir) {
    $exeDir = Split-Path -Parent $ExecutablePath
    $runtimeSearchDirs = @($exeDir, (Join-Path $exeDir "deps"))
    if ($env:VCToolsRedistDir) {
        $runtimeSearchDirs += $env:VCToolsRedistDir
    }
    $runtimeDlls = Copy-RequiredWindowsRuntimeDlls `
        -ExecutablePath $ExecutablePath `
        -DestinationDir $DestinationDir `
        -ExtraSearchDirs $runtimeSearchDirs

    foreach ($dll in Get-PackagedWindowsRuntimeDllNames $DestinationDir) {
        Write-Note "Bundled $dll"
    }
    return @($runtimeDlls)
}

function New-WindowsRuntimeTauriConfig([string[]]$RuntimeDlls, [string]$ExecutableDir) {
    if ($RuntimeDlls.Count -eq 0) {
        return ""
    }

    $resources = [ordered]@{
        "../src/assets/**/*" = "src/assets/"
        "ocr-runtime/bin/**/*" = "ocr-runtime/bin/"
        "ocr-runtime/models/**/*" = "ocr-runtime/models/"
        "syncthing/syncthing.exe" = "syncthing.exe"
        "syncthing/SYNCTHING-LICENSE.txt" = "SYNCTHING-LICENSE.txt"
        "syncthing/SYNCTHING-AUTHORS.txt" = "SYNCTHING-AUTHORS.txt"
        "../LICENSE" = "LICENSE"
        "../THIRD-PARTY-NOTICES.md" = "THIRD-PARTY-NOTICES.md"
        "../THIRD-PARTY-LICENSES.html" = "THIRD-PARTY-LICENSES.html"
        "../OCR-THIRD-PARTY-LICENSES.html" = "OCR-THIRD-PARTY-LICENSES.html"
    }
    foreach ($dll in $RuntimeDlls) {
        $resources["target/$WindowsRustTarget/release/$dll"] = $dll
    }

    $config = [ordered]@{
        bundle = [ordered]@{
            resources = $resources
        }
    }
    $configPath = Join-Path $ExecutableDir "wordhunter-runtime-tauri.conf.json"
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8
    return $configPath
}

function Assert-NsisScriptsContainRuntimeDlls([string]$ExecutableDir, [string[]]$RuntimeDlls) {
    if ($RuntimeDlls.Count -eq 0) {
        return
    }
    $nsisDir = Join-Path $ExecutableDir "nsis"
    if (-not (Test-Path -LiteralPath $nsisDir)) {
        Fail "Generated NSIS script directory was not found: $nsisDir"
    }

    $scripts = @(Get-ChildItem -LiteralPath $nsisDir -Recurse -File -Filter "installer.nsi" -ErrorAction SilentlyContinue)
    if ($scripts.Count -eq 0) {
        Fail "Generated installer.nsi was not found below: $nsisDir"
    }

    $content = ($scripts | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName }) -join "`n"
    foreach ($dll in $RuntimeDlls) {
        if ($content -notmatch [regex]::Escape($dll)) {
            Fail "Generated NSIS script is missing bundled runtime DLL: $dll"
        }
    }
}

function Assert-ArchiveContainsRuntimeDlls([string]$ArchivePath, [string[]]$RuntimeDlls) {
    if ($RuntimeDlls.Count -eq 0) {
        return
    }
    $sevenZip = Get-Command 7z.exe -ErrorAction SilentlyContinue
    if (-not $sevenZip) {
        $sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
    }
    if (-not $sevenZip) {
        Fail "7-Zip is required to inspect $ArchivePath. Refusing to produce an unvalidated release artifact."
    }

    $listing = & $sevenZip.Source l $ArchivePath
    if ($LASTEXITCODE -ne 0) {
        Fail "7-Zip could not inspect $ArchivePath (exit code $LASTEXITCODE)."
    }
    foreach ($dll in $RuntimeDlls) {
        if (-not ($listing -match [regex]::Escape($dll))) {
            Fail "$ArchivePath is missing bundled runtime DLL: $dll"
        }
    }
}

function Assert-ArchiveContainsFile([string]$ArchivePath, [string]$ExpectedFile) {
    $sevenZip = Get-Command 7z.exe -ErrorAction SilentlyContinue
    if (-not $sevenZip) {
        $sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
    }
    if (-not $sevenZip) {
        Fail "7-Zip is required to inspect $ArchivePath. Refusing to produce an unvalidated release artifact."
    }

    $listing = & $sevenZip.Source l $ArchivePath
    if ($LASTEXITCODE -ne 0) {
        Fail "7-Zip could not inspect $ArchivePath (exit code $LASTEXITCODE)."
    }
    if (-not ($listing -match [regex]::Escape($ExpectedFile))) {
        Fail "$ArchivePath is missing required file: $ExpectedFile"
    }
}

function Download-Syncthing {
    if ((Test-Path -LiteralPath $SyncthingExe) -and
        (Test-Path -LiteralPath $SyncthingLicense) -and
        (Test-Path -LiteralPath $SyncthingAuthors)) {
        return
    }
    Write-Step "Downloading Syncthing for Windows"
    Ensure-Directory $SyncthingDir
    $url = "https://github.com/syncthing/syncthing/releases/download/v$SyncthingVersion/$SyncthingArchive"
    $zip = Join-Path $SyncthingDir $SyncthingArchive
    Download-File $url $zip $SyncthingSha256
    Expand-Archive -LiteralPath $zip -DestinationPath $SyncthingDir -Force
    $subDir = Join-Path $SyncthingDir "syncthing-windows-amd64-v$SyncthingVersion"
    if (-not (Test-Path -LiteralPath $subDir)) {
        Fail "Syncthing archive did not contain the expected directory: $subDir"
    }
    $downloadedExe = Join-Path $subDir "syncthing.exe"
    if (-not (Test-Path -LiteralPath $downloadedExe)) {
        Fail "Syncthing archive did not contain syncthing.exe"
    }
    foreach ($requiredFile in @("LICENSE.txt", "AUTHORS.txt")) {
        if (-not (Test-Path -LiteralPath (Join-Path $subDir $requiredFile))) {
            Fail "Syncthing archive did not contain $requiredFile"
        }
    }
    Move-Item -LiteralPath $downloadedExe -Destination $SyncthingExe -Force
    Copy-Item -LiteralPath (Join-Path $subDir "LICENSE.txt") -Destination $SyncthingLicense -Force
    Copy-Item -LiteralPath (Join-Path $subDir "AUTHORS.txt") -Destination $SyncthingAuthors -Force
    Remove-Item -LiteralPath $subDir -Recurse -Force
    Remove-Item -LiteralPath $zip -Force
    Write-Host "Syncthing downloaded to $SyncthingExe" -ForegroundColor Green
}

function Ensure-Cargo {
    if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
        Fail "Cargo/Rust was not found. Install Rust from https://rustup.rs/ and open a new PowerShell window."
    }
}

function Ensure-WindowsRustTarget {
    $installed = & rustup.exe target list --installed 2>$null
    if ($LASTEXITCODE -ne 0) {
        Fail "rustup was not found. Install Rust with rustup so the Windows MSVC target can be verified."
    }
    if ($installed -notcontains $WindowsRustTarget) {
        Invoke-External "rustup.exe" @("target", "add", $WindowsRustTarget)
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
        default { Fail "Unsupported Android target for scripts\build.bat: $Target" }
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

function Get-AndroidVersionInfo {
    $config = Get-Content -Raw -LiteralPath (Join-Path $Root "src-tauri\tauri.conf.json") | ConvertFrom-Json
    $version = [string]$config.version
    $match = [regex]::Match($version, '^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$')
    if (-not $match.Success) {
        Fail "src-tauri\tauri.conf.json version must use MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-rc.N: $version"
    }

    $major = [int64]$match.Groups[1].Value
    $minor = [int64]$match.Groups[2].Value
    $patch = [int64]$match.Groups[3].Value
    if ($minor -gt 999 -or $patch -gt 999) {
        Fail "Android versionCode formula requires MINOR and PATCH to be below 1000: $version"
    }

    $baseCode = ($major * 1000000) + ($minor * 1000) + $patch
    $releaseOrdinal = 99
    if ($match.Groups[4].Success) {
        $releaseOrdinal = [int64]$match.Groups[4].Value
        if ($releaseOrdinal -lt 1 -or $releaseOrdinal -gt 98) {
            Fail "Android release-candidate ordinal must be between 1 and 98: $version"
        }
    }
    $code = ($baseCode * 100) + $releaseOrdinal
    if ($code -le 0 -or $code -gt 2100000000) {
        Fail "Android versionCode must be between 1 and 2100000000, calculated $code from $version"
    }

    [pscustomobject]@{
        Source = $version
        Name = $version
        Code = $code
    }
}

function Set-AndroidGradleVersion([string]$GradleText, [object]$VersionInfo) {
    $GradleText = Set-RegexOnce `
        $GradleText `
        '(?m)^(\s*)versionCode\s*=\s*.+$' `
        ('${1}versionCode = ' + $VersionInfo.Code) `
        "Android versionCode"
    $GradleText = Set-RegexOnce `
        $GradleText `
        '(?m)^(\s*)versionName\s*=\s*.+$' `
        ('${1}versionName = "' + $VersionInfo.Name + '"') `
        "Android versionName"

    Assert-TextContains $GradleText ('(?m)^\s*versionCode\s*=\s*' + $VersionInfo.Code + '\s*$') "Android versionCode"
    Assert-TextContains $GradleText ('(?m)^\s*versionName\s*=\s*"' + [regex]::Escape($VersionInfo.Name) + '"\s*$') "Android versionName"
    Write-Note "Android versionName $($VersionInfo.Name), versionCode $($VersionInfo.Code) from $($VersionInfo.Source)"
    return $GradleText
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
    </style>
</resources>
"@
    Set-Content -LiteralPath (Join-Path $valuesDir "themes.xml") -Value $themeXml -NoNewline
    Set-Content -LiteralPath (Join-Path $nightValuesDir "themes.xml") -Value $themeXml -NoNewline

    $gradle = Join-Path $androidApp "build.gradle.kts"
    $gradleText = Get-Content -Raw -LiteralPath $gradle
    $gradleText = Set-AndroidGradleVersion $gradleText (Get-AndroidVersionInfo)
    if ($gradleText -notmatch "androidx\.documentfile:documentfile:") {
        $dependency = '    implementation("androidx.documentfile:documentfile:1.0.1")'
        $gradleText = Set-RegexOnce `
            $gradleText `
            '(\s+implementation\("androidx\.activity:activity-ktx:[^"]+"\))' `
            ('${1}' + "`r`n" + $dependency) `
            "Android documentfile dependency"
    }
    Assert-TextContains $gradleText 'implementation\("androidx\.documentfile:documentfile:1\.0\.1"\)' "Android documentfile dependency"
    Set-Content -LiteralPath $gradle -Value $gradleText -NoNewline

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
    Ensure-FrontendBuild
    Ensure-Cargo
    Ensure-WindowsRustTarget
    Download-Syncthing

    Enable-MSVC
    Ensure-Directory $Outputs
    if (-not $SkipRuntime) {
        Build-OcrRuntime
    }

    if (-not $SkipRustBuild) {
        Invoke-WithCmakeBuildParallelLimit {
            Invoke-External "cargo.exe" @("build", "--release", "--target", $WindowsRustTarget, "--manifest-path", $RustManifest)
        }
    }

    if (-not (Test-Path -LiteralPath $RustExe)) {
        Fail "Rust build finished, but expected exe was not found: $RustExe"
    }

    Remove-Item -LiteralPath $PortableDir -Recurse -Force -ErrorAction SilentlyContinue
    Ensure-Directory $PortableDir
    Copy-Item -LiteralPath $RustExe -Destination $OutputPortable -Force
    Copy-Item -LiteralPath $SyncthingExe -Destination (Join-Path $PortableDir "syncthing.exe") -Force
    Copy-Item -LiteralPath $SyncthingLicense -Destination $PortableDir -Force
    Copy-Item -LiteralPath $SyncthingAuthors -Destination $PortableDir -Force
    foreach ($legalFile in @($LicenseFile, $ThirdPartyNotices, $ThirdPartyLicenses, $OcrThirdPartyLicenses)) {
        Copy-Item -LiteralPath $legalFile -Destination $PortableDir -Force
    }
    $portableRuntimeDlls = Copy-AppRuntimeDlls $RustExe $PortableDir
    $portableOcrRuntime = Join-Path $PortableDir "ocr-runtime"
    Remove-Item -LiteralPath $portableOcrRuntime -Recurse -Force -ErrorAction SilentlyContinue
    Ensure-Directory $portableOcrRuntime
    foreach ($runtimeDir in @("bin", "models")) {
        Copy-Item -LiteralPath (Join-Path $Root "src-tauri\ocr-runtime\$runtimeDir") -Destination $portableOcrRuntime -Recurse -Force
    }
    Compress-Archive -Path (Join-Path $PortableDir "*") -DestinationPath $OutputPortableZip -Force
    Assert-ArchiveContainsRuntimeDlls $OutputPortableZip $portableRuntimeDlls
    Assert-ArchiveContainsFile $OutputPortableZip "syncthing.exe"
    Assert-ArchiveContainsFile $OutputPortableZip "SYNCTHING-LICENSE.txt"
    Assert-ArchiveContainsFile $OutputPortableZip "SYNCTHING-AUTHORS.txt"
    Assert-ArchiveContainsFile $OutputPortableZip "LICENSE"
    Assert-ArchiveContainsFile $OutputPortableZip "THIRD-PARTY-NOTICES.md"
    Assert-ArchiveContainsFile $OutputPortableZip "THIRD-PARTY-LICENSES.html"
    Assert-ArchiveContainsFile $OutputPortableZip "OCR-THIRD-PARTY-LICENSES.html"
    Assert-ArchiveContainsFile $OutputPortableZip "wordhunter-paddleocr.exe"
    Assert-ArchiveContainsFile $OutputPortableZip "pdfium.dll"
    Write-Host ""
    Write-Host "Done: $OutputPortableZip" -ForegroundColor Green
}

function Build-Installer([switch]$SkipRuntime) {
    Write-Step "Building Windows installer"
    Ensure-FrontendBuild
    Ensure-Cargo
    Ensure-WindowsRustTarget
    Enable-MSVC
    Download-Syncthing
    Ensure-Directory $Outputs
    if (-not $SkipRuntime) {
        Build-OcrRuntime
    }
    Ensure-TauriCli

    Invoke-WithCmakeBuildParallelLimit {
        Invoke-External "cargo.exe" @("build", "--release", "--target", $WindowsRustTarget, "--manifest-path", $RustManifest)
    }
    if (-not (Test-Path -LiteralPath $RustExe)) {
        Fail "Rust build finished, but expected exe was not found: $RustExe"
    }
    $rustExeDir = Split-Path -Parent $RustExe
    $installerRuntimeDlls = Copy-AppRuntimeDlls $RustExe $rustExeDir
    $runtimeTauriConfig = New-WindowsRuntimeTauriConfig $installerRuntimeDlls $rustExeDir

    Invoke-WithCmakeBuildParallelLimit {
        Push-Location -LiteralPath (Join-Path $Root "src-tauri")
        try {
            $tauriArgs = @("tauri", "build", "--target", $WindowsRustTarget)
            if ($runtimeTauriConfig) {
                $tauriArgs += @("--config", $runtimeTauriConfig)
            }
            Invoke-External "cargo.exe" $tauriArgs
        } finally {
            Pop-Location
        }
    }
    Assert-NsisScriptsContainRuntimeDlls $rustExeDir $installerRuntimeDlls

    $installer = Get-ChildItem -LiteralPath $TauriBundleDir -Filter "*.exe" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $installer) {
        Fail "Tauri build finished, but no NSIS installer was found in: $TauriBundleDir"
    }

    Copy-Item -LiteralPath $installer.FullName -Destination $OutputInstaller -Force
    Assert-ArchiveContainsRuntimeDlls $OutputInstaller $installerRuntimeDlls
    Assert-ArchiveContainsFile $OutputInstaller "syncthing.exe"
    Assert-ArchiveContainsFile $OutputInstaller "SYNCTHING-LICENSE.txt"
    Assert-ArchiveContainsFile $OutputInstaller "SYNCTHING-AUTHORS.txt"
    Assert-ArchiveContainsFile $OutputInstaller "LICENSE"
    Assert-ArchiveContainsFile $OutputInstaller "THIRD-PARTY-NOTICES.md"
    Assert-ArchiveContainsFile $OutputInstaller "THIRD-PARTY-LICENSES.html"
    Assert-ArchiveContainsFile $OutputInstaller "OCR-THIRD-PARTY-LICENSES.html"
    Assert-ArchiveContainsFile $OutputInstaller "wordhunter-paddleocr.exe"
    Assert-ArchiveContainsFile $OutputInstaller "pdfium.dll"
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
    Ensure-FrontendBuild
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
    Sign-AndroidApk $OutputApk
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

function Get-AndroidApkSigner {
    $sdk = Ensure-AndroidSdk
    $signer = Get-ChildItem -LiteralPath (Join-Path $sdk "build-tools") -Directory -ErrorAction SilentlyContinue |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName "apksigner.bat" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if (-not $signer) {
        Fail "Android apksigner was not found below $sdk\build-tools."
    }
    return $signer
}

function Sign-AndroidApk([string]$OutputApk) {
    $signing = Get-AndroidSigningConfig
    if (-not $signing) {
        if ($env:WH_ANDROID_REQUIRE_SIGNING -eq "1") {
            Fail "Android APK signing is required, but WH_ANDROID_* signing variables are not configured."
        }
        Write-Note "APK uses the local Android debug key and cannot update official Pocket builds. Set WH_ANDROID_* to create an update-compatible APK."
        return
    }

    $apksigner = Get-AndroidApkSigner
    $signedApk = "$OutputApk.signed.tmp.apk"
    Remove-Item -LiteralPath $signedApk -Force -ErrorAction SilentlyContinue
    Write-Host "    $ apksigner sign --ks <WH_ANDROID_KEYSTORE> --ks-key-alias <WH_ANDROID_KEY_ALIAS> --ks-pass <hidden> --key-pass <hidden> --out $signedApk $OutputApk"
    & $apksigner sign --ks $signing.Keystore --ks-key-alias $signing.Alias `
        --ks-pass "pass:$($signing.StorePass)" --key-pass "pass:$($signing.KeyPass)" `
        --out $signedApk $OutputApk
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $signedApk -Force -ErrorAction SilentlyContinue
        throw "Android APK signing failed with exit code $LASTEXITCODE."
    }
    Move-Item -LiteralPath $signedApk -Destination $OutputApk -Force

    $verification = & $apksigner verify --verbose --print-certs $OutputApk 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Android APK signature verification failed with exit code $LASTEXITCODE."
    }
    $verification | Write-Host
    $actual = ([regex]::Match(($verification -join "`n"), '(?i)certificate SHA-256 digest:\s*([0-9a-f]{64})')).Groups[1].Value.ToLowerInvariant()
    $expected = ([string]$env:WH_ANDROID_EXPECTED_CERT_SHA256).Replace(":", "").Trim().ToLowerInvariant()
    if ($expected -and $actual -ne $expected) {
        Fail "Android APK signer mismatch: expected $expected, got $actual."
    }
    Write-Host "Signed with Android update key alias: $($signing.Alias)" -ForegroundColor Green
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
    Ensure-FrontendBuild
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
    Ensure-FrontendBuild
    Write-Step "Frontend shared tests"
    Invoke-External "node.exe" @("--experimental-vm-modules", "--test", "frontend-tests\shared\*.test.js")
}

function Test-FrontendAndroid {
    Ensure-FrontendBuild
    Write-Step "Frontend Android tests"
    Invoke-External "node.exe" @("--experimental-vm-modules", "--test", "frontend-tests\android\*.test.js")
}

function Test-FrontendDesktop {
    Ensure-FrontendBuild
    Write-Step "Frontend desktop tests"
    Invoke-External "node.exe" @("--experimental-vm-modules", "--test", "frontend-tests\desktop\*.test.js")
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
    Write-Host "  .\scripts\build.bat              build portable ZIP and Setup installer"
    Write-Host "  .\scripts\build.bat all          build portable ZIP and Setup installer"
    Write-Host "  .\scripts\build.bat installer    build outputs\Word.Hunter.Setup.exe"
    Write-Host "  .\scripts\build.bat portable     build outputs\Word.Hunter.portable.zip"
    Write-Host "  .\scripts\build.bat apk          build outputs\Word.Hunter.Pocket.debug.apk; signs if WH_ANDROID_* env vars are set"
    Write-Host "  .\scripts\build.bat apk-emulator build outputs\Word.Hunter.Pocket.emulator.debug.apk"
    Write-Host "  .\scripts\build.bat aab          build outputs\Word.Hunter.Pocket.release.aab; signs if WH_ANDROID_* env vars are set"
    Write-Host "  .\scripts\build.bat play         build signed Google Play AAB; requires WH_ANDROID_* env vars"
    Write-Host "  .\scripts\build.bat test         run shared, desktop, and Android frontend tests"
    Write-Host "  .\scripts\build.bat test-shared  run shared frontend tests"
    Write-Host "  .\scripts\build.bat test-desktop run desktop frontend tests"
    Write-Host "  .\scripts\build.bat test-android run Android frontend tests"
    Write-Host "  .\scripts\build.bat ocr-runtime  prepare bundled native PaddleOCR runtime"
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
