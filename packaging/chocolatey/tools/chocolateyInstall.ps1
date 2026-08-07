$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'wordhunter'
  fileType       = 'exe'
  url64bit       = 'https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.10/Word.Hunter.Setup.exe'
  checksum64     = '5677558e44c051ea7c5904767fda42471e0642f7b105715f3cbc3aa82c435c3b'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
