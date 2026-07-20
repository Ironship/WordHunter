<p align="center">
  <img src="src/web/favicon.svg" width="128" alt="Word Hunter logo">
</p>

<h1 align="center">Word Hunter</h1>

<p align="center">
  <strong>Read real texts. Save words with context. Review them on your terms.</strong>
</p>

<p align="center">
  <a href="https://ironship.github.io/WordHunter-site/">Website</a> ·
  <a href="#download-and-install">Download</a> ·
  <a href="#first-5-minutes">First 5 minutes</a> ·
  <a href="#feature-tour">Feature tour</a> ·
  <a href="#sync-and-backups">Sync and backups</a>
</p>

Word Hunter is a local-first reader and vocabulary trainer for Windows, macOS,
Linux, and Android. The Android app is called **Word Hunter Pocket**.

The project is built around one idea: read real texts, click words you want to
learn, keep the context, and review them later without losing control of your
data.

> [!TIP]
> New here? Install the current stable release, open a text, and click an
> unfamiliar word. No account or cloud setup is required.

## Download and install

The recommended version for new users is
**[Word Hunter 1.0.7.1](https://github.com/Ironship/WordHunter/releases/tag/WordHunter1.0.7.1)**.
Choose your platform below. All direct downloads come from the official GitHub
Release.

Version 1.0.7.1 is a hotfix for Reader and text-to-speech regressions found in
1.0.7.

| Platform | Recommended download | Other supported option |
| --- | --- | --- |
| **Windows** | [Installer (`.exe`)](https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.7.1/Word.Hunter.Setup.exe) | [Portable ZIP](https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.7.1/Word.Hunter.portable.zip) |
| **Android** | [Word Hunter Pocket APK](https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.7.1/Word.Hunter.Pocket.debug.apk) | Android may ask you to allow installation from your browser or file manager. |
| **macOS** | [Apple Silicon DMG](https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.7.1/WordHunter-1.0.7.1-aarch64.dmg) | Intel Macs and iOS are not supported. |
| **Linux** | [Flatpak bundle](https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.7.1/WordHunter.flatpak) | [AppImage](https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.7.1/WordHunter-1.0.7.1-x86_64.AppImage) · [DEB](https://github.com/Ironship/WordHunter/releases/download/WordHunter1.0.7.1/word-hunter_1.0.7.1_amd64.deb) · [Homebrew tap](https://github.com/Ironship/homebrew-wordhunter) |

<details>
<summary><strong>Command-line installation</strong></summary>

```powershell
# Windows — Scoop
scoop bucket add wordhunter https://github.com/Ironship/scoop-wordhunter
scoop install wordhunter/wordhunter
```

```bash
# Linux x86_64 — project-maintained Homebrew tap
brew install --cask Ironship/wordhunter/wordhunter

# Linux — install a downloaded Flatpak bundle
flatpak install --user ./WordHunter.flatpak

# Linux — run a downloaded AppImage
chmod +x WordHunter-1.0.7.1-x86_64.AppImage
./WordHunter-1.0.7.1-x86_64.AppImage

# Debian/Ubuntu — install the downloaded DEB
sudo apt install ./word-hunter_1.0.7.1_amd64.deb
```

</details>

<details>
<summary><strong>First launch on macOS</strong></summary>

The DMG is signed ad hoc and is not notarized with an Apple Developer ID:

1. Open the DMG and drag **Word Hunter** to **Applications**.
2. Try to open Word Hunter once.
3. Open **System Settings → Privacy & Security**.
4. In **Security**, choose **Open Anyway** and confirm the launch.

</details>

## First 5 minutes

1. Choose the language you are learning. Each language gets its own library and
   vocabulary profile.
2. Add something to read: paste text, import a file, open a public-domain book,
   or add a supported URL.
3. Click or tap an unfamiliar word. Save its status, translation, note, or
   example sentence in the word panel.
4. Continue reading. Your saved words remain highlighted in context.
5. Open **Word Base** to manage vocabulary or **Flashcards** to review due words.

You can start locally and configure sync later. Before testing sync or moving
data between devices, create a JSON backup from the app.

## Why Word Hunter

- Read pasted text, PDFs, EPUB files, subtitles, URLs, and built-in books.
- Keep vocabulary status, translation, notes, examples, and source context in
  one record.
- Review with spaced repetition, pronunciation, keyboard shortcuts, and TTS.
- Use OCR and PDF text layers locally in desktop packages.
- Read and review on Android with the Pocket interface.
- Optionally synchronize books, vocabulary, settings, and progress through a
  folder you choose.

## Your data stays yours

- No account is required.
- Books, vocabulary, progress, and settings are stored locally.
- Sync is optional and uses a folder selected by you.
- Online requests happen only when you use an online feature such as catalog
  discovery, dictionary links, translation, or online speech.

## Release status

- **Stable:** [1.0.7.1](https://github.com/Ironship/WordHunter/releases/tag/WordHunter1.0.7.1) — hotfix for 1.0.7

<details>
<summary><strong>Upgrading an older installation</strong></summary>

- Versions older than `1.0.0` predate the current storage and sync compatibility
  baseline. Export a JSON backup before upgrading.
- If Android reports an incompatible signature when moving from an early 1.0.7
  test APK, export a backup before uninstalling.
  Uninstalling an Android app clears its local app data.

</details>

## Supported learning languages

Word Hunter keeps a separate library and vocabulary profile for each learning
language:

<table>
  <tr>
    <td><img src="src/web/flags/en.svg" width="24" alt="English flag"> English</td>
    <td><img src="src/web/flags/de.svg" width="24" alt="German flag"> German</td>
    <td><img src="src/web/flags/es.svg" width="24" alt="Spanish flag"> Spanish</td>
  </tr>
  <tr>
    <td><img src="src/web/flags/it.svg" width="24" alt="Italian flag"> Italian</td>
    <td><img src="src/web/flags/fr.svg" width="24" alt="French flag"> French</td>
    <td><img src="src/web/flags/pl.svg" width="24" alt="Polish flag"> Polish</td>
  </tr>
  <tr>
    <td><img src="src/web/flags/uk.svg" width="24" alt="Ukrainian flag"> Ukrainian</td>
    <td><img src="src/web/flags/ru.svg" width="24" alt="Russian flag"> Russian</td>
    <td><img src="src/web/flags/ja.svg" width="24" alt="Japanese flag"> Japanese</td>
  </tr>
  <tr>
    <td><img src="src/web/flags/zh.svg" width="24" alt="Chinese flag"> Chinese (Simplified)</td>
    <td><img src="src/web/flags/la.svg" width="24" alt="Latin flag artwork"> Latin</td>
    <td><img src="src/web/flags/grc.svg" width="24" alt="Ancient Greek flag artwork"> Ancient Greek</td>
  </tr>
  <tr>
    <td><img src="src/web/flags/other.svg" width="24" alt="Neutral globe icon"> Other</td>
    <td colspan="2">A custom-language profile with configurable source and target translation codes.</td>
  </tr>
</table>

Translation, TTS, catalog, and offline-model availability can vary by language
and provider. The named languages include built-in original stories and A1-B2
course books; the Other profile has none. Set its source and target language
codes under Translator & Dictionary settings before using automatic translation.

## Feature tour

### Themes

Settings offers Familiar, Alternative familiar, and Word Hunter Classic themes.
Familiar is the default and uses a cool blue palette. Alternative familiar uses
aubergine and orange. Both follow the system light/dark preference; Classic
preserves the previous Word Hunter appearance and also provides explicit light
and dark variants. Existing theme preferences are migrated without changing
books, vocabulary, or reading progress.

### Library, Import, and OCR

The library collects imported texts, public-domain books, OCR/PDF entries, and
reading progress in one place. Desktop keeps the full import workflow visible,
including pasted text, ebooks, subtitles, and scanned PDF/OCR imports.
Desktop packages use the bundled local OCR runtime and models; users do not need
to install an OCR engine or language pack. Pocket uses Android's application and
PDF capabilities locally. Documents are not sent to a new remote OCR service.
OCR can be cancelled, and recognized page text can be corrected while reading
without replacing the original PDF or page overlay.

Encrypted, corrupt, unsupported, or empty PDFs can still be rejected. A damaged
desktop package with a missing OCR runner or model reports that packaging/runtime
problem instead of silently returning an incomplete OCR result.

<img src="docs/screenshots/pc-library.png" width="860" alt="Word Hunter desktop library with import panel">

Word Hunter Pocket shows the same kind of library in a phone layout. Pocket is
optimized for reading and review on Android, with a compact card list, large
touch targets, collapsible search filters, and a side import drawer for lighter
mobile imports.

<img src="docs/screenshots/pocket-library.png" width="300" alt="Word Hunter Pocket library">

### Reader, Highlighting, and Word Panel

The reader highlights vocabulary by status directly in the text. Clicking a word
opens the word panel with status buttons, translation, notes, context, dictionary
actions, TTS, image hints, and in-text review controls.

<img src="docs/screenshots/pc-reader.png" width="860" alt="Word Hunter desktop reader with highlighted words and word panel">

Pocket keeps the same reading model, but changes the shape for mobile: bottom
navigation, touch selection, a compact toolbar, and a bottom sheet-style word
panel.

<img src="docs/screenshots/pocket-reader.png" width="300" alt="Word Hunter Pocket reader with word panel">

### Word Base

Every saved word keeps its status, translation, example sentence, review data,
and source context. The word base is the maintenance view for searching,
filtering, editing, exporting, and cleaning vocabulary.

<img src="docs/screenshots/pc-word-base.png" width="860" alt="Word Hunter vocabulary list with statuses, translations, examples, and actions">

### Flashcards and SRS

Flashcards use the same vocabulary records as the reader. Word Hunter supports
spaced repetition, due queues, review history, pronunciation, dictionary
actions, reverse cards, and rating buttons.

<img src="docs/screenshots/pc-flashcards.png" width="860" alt="Word Hunter desktop flashcard review with SRS queue">

Pocket keeps flashcard review usable on a phone, with the card, answer controls,
review heatmap, and queue adapted to the narrow screen.

<img src="docs/screenshots/pocket-flashcards.png" width="300" alt="Word Hunter Pocket flashcard review">

### Graphs and Progress

The graphs view turns vocabulary history into visible progress: total cards, due
reviews, mature cards, active review cards, heatmap activity, and vocabulary
growth levels.

<img src="docs/screenshots/pc-graphs.png" width="860" alt="Word Hunter desktop graphs with vocabulary progress and heatmap">

The same progress view is available in Pocket, so review activity and vocabulary
growth remain visible away from the desktop.

<img src="docs/screenshots/pocket-graphs.png" width="300" alt="Word Hunter Pocket graphs with vocabulary progress and heatmap">

### Desktop and Pocket Sync

Word Hunter is local-first. Desktop and Android can share custom texts, user
books, vocabulary, settings, progress, and imported reading materials through a
user-selected sync folder. The screenshots below show a shared demo library with
vocabulary progress rendered on desktop and Pocket.

| Desktop | Pocket |
| --- | --- |
| <img src="docs/screenshots/pc-library.png" width="420" alt="Word Hunter desktop library with synchronized learning data"> | <img src="docs/screenshots/pocket-library.png" width="220" alt="Word Hunter Pocket library with synchronized learning data"> |

Pocket intentionally keeps heavy import work lighter than desktop. Larger
conversion and OCR work is best done on desktop, then moved to Pocket through
sync.

## Sync and backups

Word Hunter does not require an account or a central server. The app stores data
locally and can copy changes through a folder chosen by the user. Windows,
Flatpak, and AppImage builds bundle Syncthing 2.1.0 as a separate MPL-2.0
executable. The Debian package uses the distribution-provided `syncthing`
dependency and deliberately leaves `/usr/bin/syncthing` untouched. Android
shares a folder with a separately installed Syncthing client.

- Desktop can use a local data folder and an optional sync folder.
- Android keeps local data inside the app and lets the user pick a separate sync
  folder.
- Sync transfers books, vocabulary, settings, progress, and imported reading
  materials.
- Deleted books and words stay deleted after sync instead of returning from an
  older device copy.
- Concurrent changes to the same record are retained as visible conflicts rather
  than being silently discarded; the Settings sync panel allows the retained
  version to be reviewed and resolved.
- Cloud folders can be delayed. When using Google Drive or similar providers,
  use a dedicated Word Hunter folder and wait until cloud upload/download is
  complete before opening another device.
- Full backup export is useful before testing new sync setups.

## For contributors

End users do not need any of the tools below. This section is for contributors
who want to validate or package the application from source.

### Requirements

- Rust `1.88` or newer with Cargo.
- Node.js `22` or newer for frontend and packaging validation tests.
- npm dependencies installed with `npm ci` for CSS checks and the TypeScript build.
- Tauri 2 native prerequisites for the desktop platform being built.
- PowerShell when using the bundled `scripts\build.bat` helper on Windows.
- Android SDK, NDK, and JDK for Android Pocket builds.
- Apple Silicon macOS for the DMG build.
- Python 3 and `curl` when refreshing or checking Flatpak Cargo sources.
- OCR runtime/model assets only when preparing desktop OCR support.

### Common commands

Install the pinned validation dependencies after checkout:

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

Then run the full repository gate:

```bash
./scripts/validate.sh
```

It runs `git diff --check`, JSON/i18n parsing, Stylelint, a deterministic
TypeScript frontend build and type check, frontend tests against `dist/web`, Flatpak
`cargo-sources.json` drift detection, Rust formatting, Rust tests for the main
Tauri crate and OCR runner, and blocking `cargo clippy` checks by default.

```powershell
.\scripts\build.bat test         # run shared, desktop, and Android frontend tests
.\scripts\build.bat installer    # build outputs\Word.Hunter.Setup.exe
.\scripts\build.bat portable     # build outputs\Word.Hunter.portable.zip
.\scripts\build.bat apk          # build APK; WH_ANDROID_* signs an update-compatible package
.\scripts\build.bat aab          # build outputs\Word.Hunter.Pocket.release.aab
.\scripts\build.bat play         # build signed Google Play AAB
.\scripts\build.bat ocr-runtime  # prepare bundled native PaddleOCR runtime
```

On Apple Silicon macOS, build and validate the DMG with:

```bash
./scripts/build-macos.sh
```

It writes `outputs/WordHunter-<version>-aarch64.dmg`. The current recipe
uses an ad-hoc signature, so macOS may require approval in Privacy & Security
after download. A Developer ID certificate and notarization are still required
for a warning-free public install.

Rust backend tests can also be run directly:

```powershell
npm run build:frontend
cargo test --manifest-path src-tauri\Cargo.toml
```

Android Pocket release builds derive `versionName` and monotonic `versionCode`
from stable or `-rc.N` SemVer values in `src-tauri/tauri.conf.json`. Stable
builds sort after every release candidate for the same version; see
`docs/release-validation.md` before changing the release version scheme.

### Flatpak

Linux Flatpak packaging is available through `flatpak-builder`:

```bash
./scripts/build-flatpak.sh
./scripts/install-flatpak-local.sh
```

The script installs missing Flatpak SDK dependencies from Flathub when needed,
builds the manifest in `com.wordhunter.app.yml`, and writes
`outputs/WordHunter.flatpak`. Install from the generated local repo for desktop
testing so software stores can read the local AppStream metadata and icons.
Word Hunter uses the GNOME Flatpak runtime because Tauri depends on
GTK/WebKitGTK; on KDE Plasma the script also installs the Breeze GTK theme
extension when needed so the GTK/WebKit window follows KDE
styling. The Flatpak disables WebKitGTK's DMABUF renderer to avoid known
Wayland renderer crashes on some KDE/Mesa setups while still keeping Wayland
enabled. After changing `src-tauri/Cargo.lock`, refresh the vendored Cargo source
list with:

```bash
./scripts/update-flatpak-cargo-sources.sh
```

To check for drift without rewriting the file, run:

```bash
./scripts/update-flatpak-cargo-sources.sh --check
```

The build script writes distributable files to `outputs/`. That directory is
generated output, not source.

## Repository layout

- `src/web/` - shared frontend application code.
- `dist/web/` - generated, untracked browser JavaScript and copied web assets.
- `src/web/js/reader/` - focused reader session, rendering, word navigation, PDF
  page text, and OCR correction modules.
- `src/web/platforms/` - platform-specific frontend styling and behavior.
- `src-tauri/` - Tauri 2 Rust backend, commands, OCR/import logic, and platform
  config.
- `src-tauri/platforms/android/` - Android-specific backend boundary.
- `frontend-tests/` - Node-based frontend and platform tests.
- `docs/` - public documentation and screenshots.
- `.cargo/` - Cargo configuration used by the workspace.
- `scripts/build.bat` - Windows convenience entrypoint for tests and release artifacts.

## Technology and third-party licenses

Word Hunter uses a Rust backend and a shared HTML/CSS/TypeScript interface in a
Tauri 2 shell. Windows uses WebView2, Linux uses WebKitGTK/GTK, and Pocket uses
Android System WebView. Desktop translation and OCR can use CTranslate2,
SentencePiece, PaddleOCR through ONNX Runtime, PDFium, and platform execution
providers. OCR uses DirectML on Windows and WebGPU/Vulkan on Linux, with a safe
CPU fallback. Windows, Flatpak, and AppImage sync use the separately bundled
Syncthing executable, while the Debian package uses the distribution-provided
`syncthing` dependency. The Flatpak routes file dialogs through XDG Desktop
Portal and can use the active GTK theme extension, so KDE sessions receive
their portal dialogs and the matching Breeze GTK styling when that extension
is installed.

Word Hunter data is stored as local record files and JSON snapshots; the current
application does not use SQLite. The built-in scheduler is Word Hunter's own
implementation inspired by published SM-2 and FSRS concepts, not the official
FSRS library or the proprietary SuperMemo application.

The shared WebView UI is an explicit architecture choice for feature and
accessibility parity across desktop and Pocket. TypeScript owns DOM rendering and
latency-sensitive interaction state. Rust owns storage merge/recovery, parsing,
local HTTP validation, and desktop OCR, while the Android adapter owns SAF and
platform PDF boundaries. CPU-heavy frontend statistics use workers and explicit
caches instead of moving DOM work across the bridge.

The project license is in `LICENSE`. Principal native components, model sources,
service integrations, exact source links, and redistribution terms are listed in
`THIRD-PARTY-NOTICES.md`. Full license texts for the locked Rust dependency
graphs are generated into `THIRD-PARTY-LICENSES.html` and
`OCR-THIRD-PARTY-LICENSES.html`; all four files are included in release packages.
After changing either Rust lockfile, install `cargo-about` and refresh the
reports with `./scripts/update-third-party-licenses.sh`.

## License

Word Hunter is licensed under `AGPL-3.0-or-later`.

Closed-source commercial derivative use requires a separate written commercial
license. See `COMMERCIAL-LICENSE.md` for details.

## Development note

Much of the frontend was developed with AI assistance. I am not a frontend
developer; Word Hunter grew from scripts I had used for years into an app I use
every day. The goal is to keep it free, useful, and independent of mandatory
cloud accounts or paid services. Feedback, bug reports, and contributions are
welcome.
