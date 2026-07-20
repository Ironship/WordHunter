# Word Hunter AUR package

This directory prepares the unofficial `wordhunter-bin` package for the Arch
User Repository. It installs the verified upstream AppImage contents under
`/opt/wordhunter` and exposes `wordhunter` in `/usr/bin`; it does not require
FUSE at install time or at runtime.

The application is `AGPL-3.0-or-later`. `LICENSE` covers only these AUR
packaging files under `0BSD`, as recommended by the AUR submission guidance.

## Validation

The `AUR package validation` GitHub Actions workflow starts from a
digest-pinned official Arch Linux `base-devel` container. It:

1. regenerates `.SRCINFO` and requires an exact match;
2. downloads the stable AppImage and verifies its pinned SHA-256;
3. builds the package as an unprivileged user with `makepkg`;
4. inspects the package with `namcap`, `bsdtar`, and `pacman`;
5. installs it in the disposable CI container and checks the desktop metadata,
   bundled OCR runner, bundled Syncthing executable, and dynamic libraries;
6. starts the installed application under Xvfb and requires it to remain alive
   until the smoke-test timeout; and
7. removes the package and checks that its public launchers are gone.

No Arch packages or build tools need to be installed on a contributor's local
machine for this repository validation.

## Before publishing to AUR

Publishing is intentionally manual and is not performed by this repository:

1. Recheck that neither the official Arch repositories nor AUR already contain
   `wordhunter` or `wordhunter-bin`.
2. Review every packaging file and the successful CI log. AUR automation does
   not replace maintainer review, and the maintainer remains responsible for
   every update.
3. Create an AUR account, add a dedicated SSH public key, and clone
   `ssh://aur@aur.archlinux.org/wordhunter-bin.git`.
4. Copy `PKGBUILD`, `.SRCINFO`, and `LICENSE` into that AUR repository. AUR
   accepts pushes only to its `master` branch.
5. Commit with the intended maintainer identity and push only after a final
   manual review.

The current AUR submission rules do not prescribe an AI-assistance trailer.
The files were prepared with AI assistance, so the publishing maintainer should
still read and understand them and disclose that assistance wherever their own
review policy requires it.
