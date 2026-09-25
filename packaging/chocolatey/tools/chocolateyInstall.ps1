$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'wordhunter'
  fileType       = 'exe'
  url64bit       = 'https://github.com/Ironship/WordHunter/releases/download/WordHunter1.1.1/Word.Hunter.Setup.exe'
  checksum64     = 'b7bc0e1712b43fc8f6304876ae4b2aed5e64986d411e1203cb6565aa628b7ad3'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
