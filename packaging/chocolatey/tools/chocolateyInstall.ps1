$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'wordhunter'
  fileType       = 'exe'
  url64bit       = 'https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.10/Word.Hunter.Setup.exe'
  checksum64     = '45cd4ffe825362bdf36f44b479f9eb91d8ee23b44b5218cfdd109c12dc4acb02'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
