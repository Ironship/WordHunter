# Byte-safe bump 1.0.12 -> 1.0.13-rc.1 for the WordHunter release branch.
# Run from the repo root on the release/1.0.13-rc.1 branch.
# usage: python3 scripts-dev/bump-1013rc1.py
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLD = "1.0.12"
NEW = "1.0.13-rc.1"
OLD_CODE = "101001299"
NEW_CODE = "101001301"

replaced = []
missed = []

def byte_replace(path, pairs):
    p = ROOT / path
    if not p.exists():
        missed.append(str(path))
        return
    data = p.read_bytes()
    count = 0
    for old, new in pairs:
        n = data.count(old.encode())
        count += n
        data = data.replace(old.encode(), new.encode())
    if count:
        replaced.append(f"{path} ({count})")
    p.write_bytes(data)

def bump_json_locale(path, version_pairs, whats_new):
    """help.version via byte replace; help.whatsNew via json round-trip (escaping)."""
    p = ROOT / path
    data = p.read_bytes()
    for old, new in version_pairs:
        data = data.replace(old.encode(), new.encode())
    p.write_bytes(data)
    with p.open(encoding="utf-8") as fh:
        doc = json.load(fh)
    if "help" in doc and "whatsNew" in doc["help"]:
        doc["help"]["whatsNew"] = whats_new
        with p.open("w", encoding="utf-8", newline="") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        replaced.append(f"{path} (whatsNew)")

# 1. Core manifests
byte_replace("src-tauri/tauri.conf.json", [(f'"version": "{OLD}"', f'"version": "{NEW}"')])
byte_replace("src-tauri/Cargo.toml", [(f'version = "{OLD}"', f'version = "{NEW}"')])
byte_replace("src-tauri/Cargo.lock", [(f'version = "{OLD}"', f'version = "{NEW}"')])  # verified: exactly 1 hit (root package)
byte_replace("src-tauri/tauri.android.conf.json", [(f'"versionCode": {OLD_CODE}', f'"versionCode": {NEW_CODE}')])

# 2. i18n x10 (version + translated whatsNew)
whats = {
    "en": f"{NEW} fixes the Android app, which crashed at launch: the data folder is now resolved correctly. Source links in the library and reader now open through the native browser, and the review-card voice buttons are easier to tap.",
    "pl": f"{NEW} naprawia aplikację na Androidzie, która wyłączała się przy starcie: folder danych jest teraz poprawnie ustalany. Linki źródłowe w bibliotece i czytniku otwierają się w natywnej przeglądarce, a przyciski odtwarzania na kartach powtórek są większe.",
    "de": f"{NEW} behebt den Absturz der Android-App beim Start: Der Datenordner wird jetzt korrekt ermittelt. Quelllinks in Bibliothek und Reader öffnen sich im nativen Browser, und die Vorlesen-Schaltflächen auf den Wiederholungskarten sind größer.",
    "es": f"{NEW} corrige la aplicación de Android, que se cerraba al iniciarse: la carpeta de datos ahora se resuelve correctamente. Los enlaces de origen en la biblioteca y el lector se abren en el navegador nativo, y los botones de voz de las tarjetas de repaso son más grandes.",
    "fr": f"{NEW} corrige l'application Android qui plantait au démarrage : le dossier de données est désormais résolu correctement. Les liens sources de la bibliothèque et du lecteur s'ouvrent dans le navigateur natif, et les boutons vocaux des cartes de révision sont plus grands.",
    "it": f"{NEW} corregge l'app Android che si chiudeva all'avvio: la cartella dei dati ora viene risolta correttamente. I link alle fonti in libreria e nel lettore si aprono nel browser nativo e i pulsanti vocali delle schede di ripasso sono più grandi.",
    "ja": f"{NEW} は起動時にクラッシュしていたAndroidアプリを修正します。データフォルダーが正しく解決されるようになりました。ライブラリとリーダーの出典リンクはネイティブブラウザーで開き、復習カードの音声ボタンが大きくなりました。",
    "ru": f"{NEW} исправляет приложение для Android, которое аварийно завершалось при запуске: папка данных теперь определяется правильно. Ссылки на источники в библиотеке и читалке открываются в системном браузере, а кнопки озвучивания на карточках повторения стали крупнее.",
    "uk": f"{NEW} виправляє додаток для Android, який завершувався під час запуску: папку даних тепер визначається правильно. Посилання на джерела в бібліотеці та читалці відкриваються в системному браузері, а кнопки озвучення на картках повторення стали більшими.",
    "zh": f"{NEW} 修复了 Android 应用启动即崩溃的问题：数据文件夹现已正确解析。书库和阅读器中的来源链接改由系统浏览器打开，复习卡片上的朗读按钮也变得更易点按。",
}
for loc, text in whats.items():
    bump_json_locale(f"src/web/i18n/{loc}.json", [(f'"version": "{OLD}"', f'"version": "{NEW}"')], text)

# 3. Licenses + packaging
byte_replace("THIRD-PARTY-LICENSES.html", [(f"word-hunter {OLD}", f"word-hunter {NEW}")])
byte_replace("packaging/linux/debian-changelog", [(OLD, NEW)])
byte_replace("packaging/linux/com.wordhunter.app.metainfo.xml", [(OLD, NEW)])
byte_replace("flatpak/com.wordhunter.app.metainfo.xml", [(OLD, NEW)])  # byte-identical mirror (repo-validation test)
byte_replace("snap/snapcraft.yaml", [(OLD, NEW)])
byte_replace("packaging/scoop/wordhunter.json", [(OLD, NEW)])  # version field only; URL+hash stay stale until the stable pipeline

# 4. Test pins (version + derived code). Order matters: the synthetic
# fixtures embed "1.0.12-rc.1", so the longer string must be replaced
# first or the blanket replace would produce "1.0.13-rc.1-rc.1".
byte_replace(
    "frontend-tests/shared/android-artifact-inspection.test.js",
    [("1.0.12-rc.1", NEW), (OLD, NEW), (OLD_CODE, NEW_CODE)],
)
byte_replace(
    "frontend-tests/shared/android-version-script.test.js",
    [("1.0.12-rc.1", NEW), (OLD, NEW), (OLD_CODE, NEW_CODE)],
)

# 5. Fastlane changelog for the new versionCode
src = ROOT / "fastlane/metadata/android/en-US/changelogs/101001299.txt"
dst = ROOT / f"fastlane/metadata/android/en-US/changelogs/{NEW_CODE}.txt"
if src.exists():
    dst.write_bytes(src.read_bytes().replace(OLD.encode(), NEW.encode()))
    replaced.append(str(dst.relative_to(ROOT)))
else:
    dst.write_text(f"Word Hunter {NEW}\n\nAndroid startup fix and touch-target improvements.\n", encoding="utf-8")
    replaced.append(str(dst.relative_to(ROOT)))

# 6. Release doc
release_md = ROOT / f"docs/releases/{NEW}.md"
release_md.parent.mkdir(parents=True, exist_ok=True)
release_md.write_text(
    f"""# Word Hunter {NEW}

Release candidate fixing the Android launch crash plus the full-Android-audit
follow-ups.

## Fixes

- **Android: app crashed at launch** (`could not locate user data directory`).
  The data-dir resolver ignored the `APPDATA` value the Android setup provides
  from tauri's app data dir and fell through to the XDG/HOME path, which does
  not exist in Android app processes. The resolver now honors `APPDATA` on
  Android (`#254`); Linux/macOS keep the XDG-first behavior.
- **Library: the Gutenberg card link was dead on Android** — `target=_blank`
  is a no-op in the webview. The link now routes through the native bridge
  first, with the server fallback on desktop (`#255`).
- **Reader: the source link showed a false "open failed" toast on Android**
  while the browser actually opened. The native bridge now runs first (`#255`).
- **Review card: the voice buttons were 24-28 px wide on Pocket** — below the
  44 px touch target. Bumped in the Pocket stylesheet (`#255`).

## Verification

- On-device proof (Pixel 9 Pro XL / Android 16, adb): the app starts, the
  backend binds 127.0.0.1:38619, the process stays alive, and the embedded
  frontend serves `HTTP 200` on `/index.html`.
- Rust suite 289/289; frontend suite 646/646; tsc clean.
""",
    encoding="utf-8",
)
replaced.append(str(release_md.relative_to(ROOT)))

print("REPLACED:")
for line in replaced:
    print(" ", line)
if missed:
    print("MISSED (did not exist):")
    for line in missed:
        print(" ", line)
print("done")
