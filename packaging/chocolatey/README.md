# Chocolatey package maintenance

This directory contains the Chocolatey Community Repository package source for
Word Hunter. It wraps the official 64-bit NSIS installer; the installer itself
is downloaded from the immutable GitHub release URL and is not embedded in the
NuGet package.

## Current package

- Package ID: `wordhunter`
- Application version: `1.0.6`
- Installer: `Word.Hunter.Setup.exe`
- Silent install and uninstall switch: `/S`
- Installer SHA-256:
  `0624ba3974992e383d2fa094fdd6918278b81af58f3c70985a47b411c895a530`

## Updating for a release

1. Publish the final GitHub release and confirm that the installer URL is
   immutable and publicly accessible.
2. Update the version and release-specific metadata in `wordhunter.nuspec`.
3. Update the URL and SHA-256 in `tools/chocolateyInstall.ps1`.
4. Mirror the same URL and checksum in `tools/VERIFICATION.txt`.
5. Let the repository's GitHub Actions workflow pack and test the package on a
   disposable Windows runner. Do not install or test it on a maintainer's
   workstation.
6. After the CI artifact passes install, upgrade, and uninstall verification,
   submit it with an API key belonging to the package maintainer:

   `choco push wordhunter.<version>.nupkg --source https://push.chocolatey.org/ --api-key $env:CHOCOLATEY_API_KEY`

Chocolatey requires a Community Repository account and API key for submission.
Keep the key in GitHub Actions secrets; never commit it.

## Moderation notes

Chocolatey validates package metadata, verifies silent installation and
uninstallation, and scans the upstream binary before a new package version can
be approved. Word Hunter's current NSIS installer is not Authenticode-signed.
Chocolatey does not document code signing as a universal package requirement,
but an unsigned executable can produce trust warnings or additional scanner and
moderator scrutiny. Signing future installers is recommended before treating
this channel as production-ready.

Official references:

- https://docs.chocolatey.org/en-us/create/create-packages/
- https://docs.chocolatey.org/en-us/create/functions/install-chocolateypackage/
- https://docs.chocolatey.org/en-us/community-repository/moderation/
