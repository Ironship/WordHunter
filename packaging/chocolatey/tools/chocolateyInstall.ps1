$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'wordhunter'
  fileType       = 'exe'
  url64bit       = 'https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.8/Word.Hunter.Setup.exe'
  checksum64     = '88a7ceffb161f1d50b19430a3d7cb55e409cc028f921c527dee09a09014e13dd'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
