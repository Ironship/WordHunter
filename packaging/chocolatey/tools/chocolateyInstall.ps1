$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'wordhunter'
  fileType       = 'exe'
  url64bit       = 'https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.10/Word.Hunter.Setup.exe'
  checksum64     = 'e7334e09e646ce445334e541cba3cf6b2d2ad2fbcce17f2bfea7d7190b342634'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
