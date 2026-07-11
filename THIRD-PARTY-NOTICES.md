# Word Hunter Third-Party Notices

This document describes the principal third-party technologies used or
distributed by Word Hunter 1.0.3. Word Hunter itself is licensed under
AGPL-3.0-or-later; the complete license is distributed as `LICENSE`.

The exact Rust dependency license texts generated from the locked dependency
graphs are distributed as:

- `THIRD-PARTY-LICENSES.html` for the main application.
- `OCR-THIRD-PARTY-LICENSES.html` for the OCR helper.

The corresponding source for this release, including build instructions and
lockfiles, is available at:

https://github.com/Ironship/WordHunter/tree/WordHunter1.0.3

## Application Platform

| Technology | Use | License / terms | Source |
| --- | --- | --- | --- |
| Rust | Application backend and native libraries | Apache-2.0 OR MIT | https://www.rust-lang.org/ |
| Tauri 2 | Desktop and Android application shell | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| HTML, CSS, JavaScript | Shared user interface | Web standards; Word Hunter code is AGPL-3.0-or-later | https://github.com/Ironship/WordHunter |
| AndroidX and Material Components | Android application integration and controls | Apache-2.0 | https://source.android.com/ and https://github.com/material-components/material-components-android |
| Microsoft Edge WebView2 | Windows system WebView and loader | Microsoft Edge WebView2 SDK license; loader sources use the repository's stated license | https://github.com/MicrosoftEdge/WebView2Samples and https://developer.microsoft.com/microsoft-edge/webview2/ |
| WebKitGTK and GTK | Linux system WebView and desktop toolkit | LGPL-2.1-or-later for the principal libraries; supplied by the system or Flatpak runtime | https://webkitgtk.org/ and https://www.gtk.org/ |
| Android System WebView | Android WebView runtime | Supplied by the Android system | https://developer.android.com/reference/android/webkit/WebView |
| Inter | Optional interface font loaded from Google Fonts | SIL Open Font License 1.1; copyright Rasmus Andersson | https://github.com/rsms/inter |

## Translation, PDF, and OCR

| Component | Version / source | License / terms |
| --- | --- | --- |
| CTranslate2 | 4.6.0, https://github.com/OpenNMT/CTranslate2/tree/v4.6.0 | MIT |
| ctranslate2-rs bindings | Locked Rust packages and local patches | MIT; exact package notices are in `THIRD-PARTY-LICENSES.html` |
| SentencePiece | 0.2.0 source used by `sentencepiece-sys` | Apache-2.0 |
| paddle-ocr-rs | 0.6.1, https://github.com/mg-chao/paddle-ocr-rs | Apache-2.0 |
| PaddleOCR | Model architecture and upstream project, https://github.com/PaddlePaddle/PaddleOCR | Apache-2.0 |
| PP-OCR ONNX model files | Pinned archive `Paddle.OCR.V5.zip` from the paddle-ocr-rs release page | Distributed with attribution to paddle-ocr-rs and PaddleOCR. The exact archive checksum is recorded in the build scripts and Flatpak manifest. |
| ONNX Runtime | 1.22.0 | MIT; upstream third-party notices: https://github.com/microsoft/onnxruntime/blob/v1.22.0/ThirdPartyNotices.txt |
| Dawn WebGPU runtime | bundled with ONNX Runtime 1.22.0 WebGPU | BSD-3-Clause; https://dawn.googlesource.com/dawn/+/refs/heads/main/LICENSE |
| PDFium | Chromium build 7920 from pdfium-binaries | BSD-3-Clause for PDFium plus licenses of its bundled third-party components; source notice: https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE |
| DirectML | Windows OCR execution provider | Microsoft Software License Terms for DirectML; https://www.nuget.org/packages/Microsoft.AI.DirectML/1.15.4/license |

The model and native-runtime URLs and SHA-256 checksums used for release builds
are pinned in `src-tauri/ocr-runtime/prepare-runtime.ps1` and
`com.wordhunter.app.yml`.

## Synchronization

Syncthing 2.1.0 is distributed as a separate executable next to Word Hunter on
Windows and under `/app/bin` in the Flatpak. Syncthing is licensed under
MPL-2.0. Its corresponding source is available at:

https://github.com/syncthing/syncthing/tree/v2.1.0

Word Hunter communicates with Syncthing through its local HTTP API. Syncthing
is not linked into the Word Hunter executable.

## Windows Compiler Runtimes

Windows packages can contain runtime DLLs required by the compiler used for the
release build. GNU/MinGW runtime libraries retain their upstream licenses and
runtime exceptions. Microsoft Visual C++ runtime libraries are redistributed
under the Microsoft Visual Studio licensing terms. The packaging script copies
only DLLs imported by the produced executables and validates their presence.

## Online Services and Data Sources

Word Hunter can contact Project Gutenberg/Gutendex, MediaWiki APIs (including
Wikipedia and Wikisource), YouGlish, DeepL, Google Translate endpoints, or a
user-configured local LM Studio server when the user invokes the related
feature. These services are not distributed as part of Word Hunter and remain
subject to their own terms and content licenses.

## Scheduling Algorithms

The application contains its own scheduling code inspired by published SM-2
and FSRS concepts. It does not bundle the proprietary SuperMemo application or
the official FSRS library.

## Reporting Omissions

If an attribution or license notice is incomplete, report it at:

https://github.com/Ironship/WordHunter/issues
