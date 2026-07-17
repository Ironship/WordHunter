# Snap package

Word Hunter's Snap recipe repackages the already validated Linux Debian
artifact. It does not rebuild the application and it does not wrap the
AppImage. The pinned input for version 1.0.6 is:

- URL: `https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.6/word-hunter_1.0.6_amd64.deb`
- size: `54,036,708` bytes
- SHA-256: `774eda03b1904ee7c3ebe793c31a21f5b842543835c5267a513711383278b4b5`

Snapcraft's `dump` plugin supports a remote Debian package as `source-type:
deb`, and `source-checksum` verifies it before unpacking. This keeps the Snap
payload tied to the public release that users can audit independently.

## Runtime design

The recipe targets AMD64 on `core22`, matching the Ubuntu 22.04 baseline used
to produce the Debian artifact. It uses `confinement: strict` and the stable
GNOME extension. The extension supplies the normal GTK desktop, settings,
graphics, Wayland/X11, and mount-observation integration. Word Hunter adds only
the interfaces required by its own features:

- `network` for online dictionaries, model downloads, and Syncthing peers;
- `network-bind` for Word Hunter's local server and the embedded Syncthing
  process;
- `browser-support` for the sandboxed WebKitGTK web content used by Tauri;
- `audio-playback` for text-to-speech and media playback;
- `home` for books, subtitles, exports, and user-selected sync folders under
  the non-hidden part of the home directory;
- `removable-media` for optional files under `/media`, `/run/media`, and
  `/mnt`.

`removable-media` does not normally auto-connect. A user who needs it must run:

```sh
sudo snap connect word-hunter:removable-media
```

The public Debian package expects distro-provided WebKitGTK 4.1, GStreamer,
libxdo, and D-Bus session tools. These are staged into the Snap from the core22
archive. On core22, the `dbus` package supplies both `dbus-daemon` and
`dbus-run-session`; `dbus-x11` only supplies the X11 launcher and is not enough
for the private session used by the GUI smoke test. The core22 Syncthing package
is too old for the `generate --home` command used by Word Hunter, so the recipe
instead downloads the same upstream Syncthing 2.1.0 archive as the validated
AppImage and verifies its pinned SHA-256.
`WORDHUNTER_SYNCTHING` points Word Hunter at that staged
`$SNAP/usr/bin/syncthing`, so binary discovery does not depend on the host
`PATH`. The WebKitGTK 4.1 layout follows Tauri's official Snapcraft example.

Snap confinement remaps the application home directory. Word Hunter's config,
learning data, downloaded translation models, and Syncthing state therefore
stay in the Snap-specific user data area. The OCR runtime and its bundled
models remain read-only inside the Snap. Files selected elsewhere in the
user's home or on removable media remain subject to the declared interface
connections.

## CI validation

`.github/workflows/snap-validation.yml` is build-only. On an Ubuntu 22.04
GitHub-hosted runner it:

1. builds the Snap with the official Snapcraft build action, pinned to its
   immutable commit, on the Snapcraft `9.x/stable` track;
2. uploads the resulting `.snap` as a workflow artifact;
3. unpacks it and checks its metadata, application binary, desktop entry,
   icons, OCR runtime/models, WebKitGTK runtime, Syncthing version, and the
   Syncthing configuration-generation command used by Word Hunter;
4. installs it with `--dangerous` only inside the disposable CI runner and
   verifies that the GUI remains alive under Xvfb for the smoke-test window.
   GitHub-hosted runners cannot move their agent service into a Snap app cgroup,
   so the GUI is launched through `snap run --shell`, which still enters the
   app's confined environment and executes its command chain. The private D-Bus
   session is created only after entering that environment.

No workflow publishes to the Snap Store and no store credentials are read.

## Publication gate

Publishing remains blocked until the maintainer:

1. signs in with Ubuntu One and reserves the `word-hunter` name (or updates the
   recipe to the reserved name);
2. manually tests imports, TTS, model downloads, OCR, and Syncthing under
   strict confinement on a supported desktop;
3. reviews any AppArmor denials, especially external sync folders and
   speech-service integration;
4. creates narrowly scoped Snap Store credentials only after that review.

Store publication should be added as a separate, approval-gated workflow. Do
not add `snapcore/action-publish` or `SNAPCRAFT_STORE_CREDENTIALS` to the build
validation workflow.

## References

- [Tauri Snapcraft distribution guide](https://v2.tauri.app/distribute/snapcraft/)
- [Snapcraft GNOME extension](https://documentation.ubuntu.com/snapcraft/latest/reference/extensions/gnome-extension/)
- [Snapcraft dump plugin and remote Debian sources](https://documentation.ubuntu.com/snapcraft/latest/how-to/crafting/include-local-files-and-remote-resources/)
- [Snap confinement](https://documentation.ubuntu.com/security/security-features/privilege-restriction/snap-confinement/)
- [Snap interfaces](https://snapcraft.io/docs/reference/interfaces/)
- [Official Snapcraft build action](https://github.com/snapcore/action-build)
