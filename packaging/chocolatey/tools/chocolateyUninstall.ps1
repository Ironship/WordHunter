$ErrorActionPreference = 'Stop'

$packageName = 'wordhunter'
[array]$uninstallKeys = Get-UninstallRegistryKey -SoftwareName 'Word Hunter*'

if ($uninstallKeys.Count -eq 0) {
  Write-Warning 'Word Hunter is not registered in Programs and Features; no native uninstall was run.'
  return
}

foreach ($uninstallKey in $uninstallKeys) {
  $uninstallCommand = $uninstallKey.UninstallString

  if (-not $uninstallCommand) {
    Write-Warning "The uninstall entry '$($uninstallKey.DisplayName)' has no uninstall command."
    continue
  }

  if ($uninstallCommand -match '^\s*"([^"]+)"') {
    $uninstaller = $matches[1]
  } else {
    $uninstaller = ($uninstallCommand -split '\s+', 2)[0]
  }

  $packageArgs = @{
    packageName    = $packageName
    fileType       = 'exe'
    silentArgs     = '/S'
    file           = $uninstaller
    validExitCodes = @(0)
  }

  Uninstall-ChocolateyPackage @packageArgs
}
