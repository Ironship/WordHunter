# Nix packaging

This directory stages the Word Hunter 1.0.6 expression intended for a future
central `NixOS/nixpkgs` pull request. It is not a separate Nix channel and it
does not claim that Word Hunter is already available from `nixpkgs`.

## Pinned input

The package consumes the stable upstream x86_64 AppImage:

- URL: <https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.6/WordHunter-1.0.6-x86_64.AppImage>
- SHA-256: `01194b3a0855cfd4c76e67977b4bd2eb4aa233c393cbdaf17b7a9a9bd009db3f`
- Nix SRI hash: `sha256-ARlLOghVz9THbmeXe0vS60qiM8OTy9rxe3qam9AJ2z8=`
- supported platform: `x86_64-linux`

`package.nix` follows the current unstable
[`appimageTools` API](https://nixos.org/manual/nixpkgs/unstable/#sec-pkgs-appimageTools):
it uses `extract` with `postExtract`, then passes the modified tree to
`wrapAppImage`. This is required because the upstream AppImage contains a
Syncthing executable.

The expression removes only `usr/bin/syncthing` from the extracted AppImage.
It preserves the upstream `SYNCTHING-LICENSE.txt` and
`SYNCTHING-AUTHORS.txt` legal notices, adds the `nixpkgs` `syncthing` package
to the FHS environment, and sets
`WORDHUNTER_SYNCTHING` to `lib.getExe syncthing`. The desktop launcher and
AppStream metadata are installed under canonical IDs and point to the public
`wordhunter` executable.

Because this expression wraps upstream native binaries, its metadata declares
`sourceProvenance = [ binaryNativeCode ]` explicitly.

## CI validation

`.github/workflows/nix-validation.yml` installs Nix only on a disposable GitHub
Actions runner. It pins both the installer action and the exact `nixpkgs`
revision used for evaluation and building. The workflow:

1. evaluates package metadata and the Syncthing override;
2. builds the package and the modified AppImage tree;
3. proves that bundled `usr/bin/syncthing` is absent while its legal notices
   remain;
4. validates the desktop and AppStream files;
5. runs the OCR helper and the `nixpkgs` Syncthing executable;
6. starts the GUI under Xvfb and requires it to remain alive until the smoke
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
4. repeat the Syncthing, OCR, desktop, AppStream, and source-hash assertions
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
