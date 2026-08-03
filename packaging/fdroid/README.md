# Word Hunter Pocket on F-Droid

This directory tracks the F-Droid submission of the Android build, Word Hunter
Pocket (`com.wordhunter.pocket`).

## Status

- **Request For Packaging**: [F-Droid RFP #4109](https://gitlab.com/fdroid/rfp/-/work_items/4109) — open.
- The F-Droid issuebot already checked the upstream repo (labels `git-url`,
  `in-github-releases`); no maintainer feedback is outstanding.
- The app is **not yet listed** in the F-Droid catalog.
- The RFP checklist is complete except **"Donated to F-Droid"** — F-Droid asks
  upstream authors to donate to the F-Droid project before a listing is
  packaged. See [How to donate](#how-to-donate).

`com.wordhunter.pocket.yml` contains the proposed fdroiddata metadata and a
first-pass build recipe for the F-Droid build server. The recipe mirrors the
release flow of `scripts/build.bat apk` (frontend pinned, Tauri Android project
generated, Rust library built with the NDK, Gradle assemble). It has not been
verified on the F-Droid build server yet and will likely need iteration with
the F-Droid maintainers.

## How to update the request

Keep the RFP issue in sync with releases. When a new stable version is out,
edit the issue description and post a short upstream-update comment, for
example:

```
Upstream update: the current stable release is Word Hunter Pocket 1.0.9
(tag WordHunter1.0.9), Android versionCode 100000909. The tagged source,
Fastlane changelog, APK and validation AAB are available at
https://github.com/Ironship/WordHunter/releases/tag/WordHunter1.0.9.
```

## How to donate

The RFP checkbox asks for a donation to the **F-Droid project** (not to app
authors). Recommended options from [f-droid.org/donate](https://f-droid.org/en/donate/):

1. [Liberapay — F-Droid-Data](https://liberapay.com/F-Droid-Data/donate) (SEPA
   direct debit / bank transfer, EU).
2. [Open Collective — F-Droid](https://opencollective.com/f-droid/donate)
   (credit card / PayPal / ACH, USD).
3. [Open Collective — F-Droid-Euro](https://opencollective.com/f-droid-euro)
   (credit card / bank transfer, EUR) — also covers direct IBAN transfers.
4. [GitHub Sponsors — F-Droid](https://github.com/sponsors/f-droid).

A one-time gift of a few euros is sufficient to tick the checkbox; recurring
donations are what keeps F-Droid sustainable.

## Next steps to get listed

1. Tick the **"Donated to F-Droid"** box in the RFP after donating.
2. Submit an MR to [fdroid/fdroiddata](https://gitlab.com/fdroid/fdroiddata)
   with `com.wordhunter.pocket.yml` as `metadata/com.wordhunter.pocket.yml`,
   following the [contribution guideline](https://gitlab.com/fdroid/fdroiddata/-/blob/master/CONTRIBUTING.md).
3. Iterate on the build recipe with the F-Droid build server until the APK
   builds from the tagged source, then publish the release.
