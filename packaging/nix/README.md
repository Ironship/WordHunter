# Nix packaging

This directory stages the Word Hunter expression proposed to `NixOS/nixpkgs`
in [NixOS/nixpkgs#543250](https://github.com/NixOS/nixpkgs/pull/543250). It is
not a separate Nix channel and it does not claim that Word Hunter is already
available from `nixpkgs`.

## Pinned input

The package consumes the x86_64 AppImage of the latest stable release. Its
version and Nix SRI hash live only in `package.nix`, where
`node scripts/release.mjs pin-stores <version>` updates them after a release is
published. The supported platform is `x86_64-linux`.

`package.nix` follows the current unstable
[`appimageTools` API](https://nixos.org/manual/nixpkgs/unstable/#sec-pkgs-appimageTools):
it extracts the AppImage, wraps its runtime, and installs canonical desktop
and AppStream metadata that point to the public `wordhunter` executable.

Because this expression wraps upstream native binaries, its metadata declares
`sourceProvenance = [ binaryNativeCode ]` explicitly.

## CI validation

`.github/workflows/packaging-validation.yml` (job `nix`) installs Nix only on a disposable GitHub
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
