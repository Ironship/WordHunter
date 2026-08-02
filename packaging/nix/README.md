# Nix packaging

This directory stages the Word Hunter 1.0.8 expression intended for a future
central `NixOS/nixpkgs` pull request. It is not a separate Nix channel and it
does not claim that Word Hunter is already available from `nixpkgs`.

## Pinned input

The package consumes the stable upstream x86_64 AppImage:

- URL: <https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.8/WordHunter-1.0.8-x86_64.AppImage>
- SHA-256: `052fd8f0f3d8c500807819dda96869ca50471ce969b31fdae6b8ddcd5b8b7bf5`
- Nix SRI hash: `sha256-BS/Y8PPYxQCAeBndqWhpylBHHOlpsx/a5rjdzVuLe/U=`
- supported platform: `x86_64-linux`

`package.nix` follows the current unstable
[`appimageTools` API](https://nixos.org/manual/nixpkgs/unstable/#sec-pkgs-appimageTools):
it extracts the AppImage, wraps its runtime, and installs canonical desktop
and AppStream metadata that point to the public `wordhunter` executable.

Because this expression wraps upstream native binaries, its metadata declares
`sourceProvenance = [ binaryNativeCode ]` explicitly.

## CI validation

`.github/workflows/nix-validation.yml` installs Nix only on a disposable GitHub
Actions runner. It pins both the installer action and the exact `nixpkgs`
revision used for evaluation and building. The workflow:

1. evaluates package metadata;
2. builds the package and the AppImage tree;
3. validates the desktop and AppStream files;
4. runs the OCR helper;
5. starts the GUI under Xvfb and requires it to remain alive until the smoke
   test timeout.

No Nix installation or package build is required on a Word Hunter maintainer's
workstation for this validation path. The Ubuntu 24.04 runner's AppArmor policy
normally blocks the unprivileged user namespace used by the final Bubblewrap
launcher. The GUI step temporarily relaxes that host-only setting and restores
its previous value on exit; the package and its runtime dependencies remain
unchanged.

## Conditions for a central nixpkgs pull request

Before opening the upstream PR:

1. rebase the expression onto current `NixOS/nixpkgs` `master` and place it at
   `pkgs/by-name/wo/wordhunter/package.nix`;
2. add the responsible maintainer to
   `maintainers/maintainer-list.nix` in a separate commit, then add that
   maintainer to `meta.maintainers`;
3. run `nixfmt`, `nixpkgs-vet`, the relevant evaluation checks, a clean
   `x86_64-linux` build, and an interactive GUI test;
4. repeat the OCR, desktop, AppStream, and source-hash assertions
   against the exact revision submitted;
5. confirm that all redistributed AppImage components and preserved notices
   satisfy the current nixpkgs licensing review;
6. use the current
   [nixpkgs contribution process](https://github.com/NixOS/nixpkgs/blob/master/CONTRIBUTING.md)
   and new-package pull-request template.

After central acceptance, users should be able to run the package as
`nix run nixpkgs#wordhunter`. Until then, project documentation must describe
Nix support as prepared or under review, not available in nixpkgs.

## Assistance disclosure

Assisted-by: OpenAI Codex (GPT-5)
