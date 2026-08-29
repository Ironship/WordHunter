$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'wordhunter'
  fileType       = 'exe'
  url64bit       = 'https://github.com/Ironship/WordHunter/releases/download/WordHunter1.1.0/Word.Hunter.Setup.exe'
  checksum64     = 'f74549a2b4b6a0af423c9eb4a1046e383f8b31040357bae6a85a2c1b6fc9480e'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
