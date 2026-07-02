$ErrorActionPreference = "Stop"

$WindowsRuntimeDllNames = @("libstdc++-6.dll", "libgcc_s_seh-1.dll", "libwinpthread-1.dll")

function Add-UniqueWindowsRuntimePath([System.Collections.Generic.List[string]]$Paths, [string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }
    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path)
    } catch {
        return
    }
    foreach ($existing in $Paths) {
        if ($existing -ieq $fullPath) {
            return
        }
    }
    $Paths.Add($fullPath) | Out-Null
}

function Get-WindowsRuntimeRustSysroot {
    $rustc = Get-Command rustc.exe -ErrorAction SilentlyContinue
    if (-not $rustc) {
        return ""
    }

    $output = & $rustc.Source --print sysroot 2>$null
    if ($LASTEXITCODE -ne 0) {
        return ""
    }
    return ([string]($output | Select-Object -First 1)).Trim()
}

function Get-WindowsRuntimeSearchDirs([string[]]$ExtraSearchDirs = @()) {
    $dirs = New-Object "System.Collections.Generic.List[string]"

    foreach ($entry in $ExtraSearchDirs) {
        Add-UniqueWindowsRuntimePath $dirs $entry
    }

    foreach ($toolName in @("cargo.exe", "rustc.exe")) {
        $tool = Get-Command $toolName -ErrorAction SilentlyContinue
        if ($tool) {
            Add-UniqueWindowsRuntimePath $dirs (Split-Path -Parent $tool.Source)
        }
    }

    $sysroot = Get-WindowsRuntimeRustSysroot
    if ($sysroot) {
        Add-UniqueWindowsRuntimePath $dirs (Join-Path $sysroot "bin")
        Add-UniqueWindowsRuntimePath $dirs (Join-Path $sysroot "lib\rustlib\x86_64-pc-windows-gnu\bin")
    }

    foreach ($entry in ($env:Path -split ";")) {
        Add-UniqueWindowsRuntimePath $dirs $entry
    }

    $systemDrive = if ($env:SystemDrive) { $env:SystemDrive } else { "C:" }
    foreach ($entry in @(
        "$systemDrive\msys64\ucrt64\bin",
        "$systemDrive\msys64\mingw64\bin",
        "$systemDrive\msys64\clang64\bin"
    )) {
        Add-UniqueWindowsRuntimePath $dirs $entry
    }

    return @($dirs | Where-Object { Test-Path -LiteralPath $_ })
}

function Find-WindowsRuntimeDll([string]$Name, [string[]]$ExtraSearchDirs = @()) {
    foreach ($dir in Get-WindowsRuntimeSearchDirs $ExtraSearchDirs) {
        $candidate = Join-Path $dir $Name
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    foreach ($dir in $ExtraSearchDirs) {
        if (-not (Test-Path -LiteralPath $dir)) {
            continue
        }
        $nestedCandidate = Get-ChildItem -LiteralPath $dir -Recurse -File -Filter $Name -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($nestedCandidate) {
            return $nestedCandidate.FullName
        }
    }
    return $null
}

function Add-ImportedWindowsRuntimeDll([hashtable]$Imports, [string]$Name) {
    if ($Name -match "^[A-Za-z0-9_.+\-]+\.dll$") {
        $Imports[$Name.ToLowerInvariant()] = $Name
    }
}

function Get-ImportedWindowsRuntimeDllNames([string]$ExePath) {
    $imports = @{}

    $dumpbin = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
    if ($dumpbin) {
        $lines = & $dumpbin.Source /DEPENDENTS $ExePath 2>$null
        foreach ($line in $lines) {
            Add-ImportedWindowsRuntimeDll $imports $line.Trim()
        }
        if ($imports.Count -gt 0) {
            return @($imports.Values)
        }
    }

    foreach ($toolName in @("llvm-objdump.exe", "objdump.exe")) {
        $tool = Get-Command $toolName -ErrorAction SilentlyContinue
        if (-not $tool) {
            continue
        }
        $lines = & $tool.Source -p $ExePath 2>$null
        foreach ($line in $lines) {
            if ($line -match "DLL Name:\s*(?<name>[A-Za-z0-9_.+\-]+\.dll)") {
                Add-ImportedWindowsRuntimeDll $imports $Matches["name"]
            }
        }
        if ($imports.Count -gt 0) {
            return @($imports.Values)
        }
    }

    $bytes = [System.IO.File]::ReadAllBytes($ExePath)
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    foreach ($match in [regex]::Matches($text, "[A-Za-z0-9_.+\-]+\.dll")) {
        Add-ImportedWindowsRuntimeDll $imports $match.Value
    }
    return @($imports.Values)
}

function Ensure-WindowsRuntimeDirectory([string]$Path) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Copy-RequiredWindowsRuntimeDlls(
    [string]$ExecutablePath,
    [string]$DestinationDir,
    [string[]]$ExtraSearchDirs = @()
) {
    if (-not (Test-Path -LiteralPath $ExecutablePath)) {
        throw "Executable was not found: $ExecutablePath"
    }

    Ensure-WindowsRuntimeDirectory $DestinationDir

    $required = @{}
    foreach ($dll in Get-ImportedWindowsRuntimeDllNames $ExecutablePath) {
        if ($WindowsRuntimeDllNames -contains $dll.ToLowerInvariant()) {
            $required[$dll.ToLowerInvariant()] = $dll
        }
    }

    $copied = New-Object "System.Collections.Generic.List[string]"
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($dll in @($required.Values)) {
            $destination = Join-Path $DestinationDir $dll
            if (-not (Test-Path -LiteralPath $destination)) {
                $source = Find-WindowsRuntimeDll $dll $ExtraSearchDirs
                if ($source) {
                    Copy-Item -LiteralPath $source -Destination $destination -Force
                    $copied.Add($dll) | Out-Null
                    $changed = $true
                }
            }
        }

        foreach ($dll in @($required.Values)) {
            $bundledDll = Join-Path $DestinationDir $dll
            if (-not (Test-Path -LiteralPath $bundledDll)) {
                continue
            }
            foreach ($importedDll in Get-ImportedWindowsRuntimeDllNames $bundledDll) {
                if ($WindowsRuntimeDllNames -contains $importedDll.ToLowerInvariant()) {
                    $required[$importedDll.ToLowerInvariant()] = $importedDll
                }
            }
        }
    }

    $missing = @()
    foreach ($dll in @($required.Values)) {
        if (-not (Test-Path -LiteralPath (Join-Path $DestinationDir $dll))) {
            $missing += $dll
        }
    }

    if ($missing.Count -gt 0) {
        throw @"
The executable imports these GNU runtime DLLs, but they were not found:
  $($missing -join "`n  ")

Install MSYS2/MinGW-w64 or build with an MSVC Rust target, then rerun the Windows package build.
Do not publish Windows artifacts until these DLLs are present next to the executable that imports them.
"@
    }

    return @($required.Values)
}
