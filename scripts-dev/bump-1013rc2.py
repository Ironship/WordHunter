# Byte-safe bump 1.0.13-rc.1 -> 1.0.13-rc.2 for the WordHunter release branch.
# Run from the repo root on the release/1.0.13-rc.2 branch.
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLD = "1.0.13-rc.1"
NEW = "1.0.13-rc.2"
OLD_CODE = "101001301"
NEW_CODE = "101001302"

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
byte_replace("src-tauri/Cargo.lock", [(f'version = "{OLD}"', f'version = "{NEW}"')])
byte_replace("src-tauri/tauri.android.conf.json", [(f'"versionCode": {OLD_CODE}', f'"versionCode": {NEW_CODE}')])

# 2. i18n x10
whats = {
    "en": f"{NEW} keeps the reader controls on a single row (the search button moved to the top right) and fixes the AI settings: the API-key field now appears when AI explanations are enabled.",
    "pl": f"{NEW} utrzymuje przyciski czytnika w jednym rzędzie (lupa przeniesiona na górę po prawej) i naprawia ustawienia AI: pole klucza API pokazuje się teraz po włączeniu wyjaśnień AI.",
    "de": f"{NEW} hält die Reader-Steuerung in einer Zeile (die Suche wanderte nach oben rechts) und behebt die KI-Einstellungen: Das API-Schlüssel-Feld erscheint jetzt, wenn KI-Erklärungen aktiviert sind.",
    "es": f"{NEW} mantiene los controles del lector en una sola fila (la búsqueda se movió arriba a la derecha) y corrige los ajustes de IA: el campo de clave API aparece ahora al activar las explicaciones de IA.",
    "fr": f"{NEW} garde les commandes du lecteur sur une seule ligne (la recherche déplacée en haut à droite) et corrige les réglages IA : le champ de clé API apparaît désormais quand les explications IA sont activées.",
    "it": f"{NEW} mantiene i controlli del lettore su una sola riga (la ricerca spostata in alto a destra) e corregge le impostazioni IA: il campo chiave API ora appare quando le spiegazioni IA sono attive.",
    "ja": f"{NEW} はリーダーの操作ボタンを1行にまとめ（検索ボタンを右上に移動）、AI設定を修正しました：AI解説を有効にするとAPIキー欄が表示されるようになりました。",
    "ru": f"{NEW} оставляет элементы управления читалкой в одном ряду (поиск перенесён вверх вправо) и исправляет настройки ИИ: поле ключа API теперь появляется при включении ИИ-объяснений.",
    "uk": f"{NEW} утримує елементи керування читалкою в одному ряду (пошук перенесено вгору праворуч) і виправляє налаштування ШІ: поле ключа API тепер з'являється після ввімкнення ШІ-пояснень.",
    "zh": f"{NEW} 将阅读器控制按钮保持为一行（搜索按钮移到右上角），并修复了 AI 设置：启用 AI 解释后，API 密钥输入框现在会显示。",
}
for loc, text in whats.items():
    bump_json_locale(f"src/web/i18n/{loc}.json", [(f'"version": "{OLD}"', f'"version": "{NEW}"')], text)

# 3. Licenses + packaging
byte_replace("THIRD-PARTY-LICENSES.html", [(f"word-hunter {OLD}", f"word-hunter {NEW}")])
byte_replace("packaging/linux/debian-changelog", [(OLD, NEW)])
byte_replace("packaging/linux/com.wordhunter.app.metainfo.xml", [(OLD, NEW)])
byte_replace("flatpak/com.wordhunter.app.metainfo.xml", [(OLD, NEW)])
byte_replace("snap/snapcraft.yaml", [(OLD, NEW)])

# 4. Test pins
byte_replace(
    "frontend-tests/shared/android-artifact-inspection.test.js",
    [(OLD, NEW), (OLD_CODE, NEW_CODE)],
)
byte_replace(
    "frontend-tests/shared/android-version-script.test.js",
    [(OLD, NEW), (OLD_CODE, NEW_CODE)],
)

# 5. Fastlane changelog for the new versionCode
src = ROOT / "fastlane/metadata/android/en-US/changelogs/101001301.txt"
dst = ROOT / f"fastlane/metadata/android/en-US/changelogs/{NEW_CODE}.txt"
if src.exists():
    dst.write_bytes(src.read_bytes().replace(OLD.encode(), NEW.encode()))
    replaced.append(str(dst.relative_to(ROOT)))
else:
    dst.write_text(f"Word Hunter {NEW}\n\nReader single-row controls and AI settings fix.\n", encoding="utf-8")
    replaced.append(str(dst.relative_to(ROOT)))

# 6. Release doc
release_md = ROOT / f"docs/releases/{NEW}.md"
release_md.parent.mkdir(parents=True, exist_ok=True)
release_md.write_text(
    f"""# Word Hunter {NEW}

Second release candidate of the 1.0.13 line.

## Changes since 1.0.13-rc.1

- **Reader: single-row control bar on Pocket** — the search (lupa) button
  now floats at the top-right of the reader; six controls fill the bottom
  grid in one row instead of wrapping to two (`#257`).
- **AI settings: the API-key field never appeared** — preferences.ts
  toggled a stale row id, so the key input stayed hidden on every platform
  and AI explanations could not be configured. Fixed (`#258`).

## Verification

- Frontend suite 648/648; Rust suite 289/289; tsc clean.
- Android: 1.0.13-rc.1 boots on a Pixel 9 Pro XL / Android 16 (on-device
  proof via adb; the rc.2 line is the same build with the two fixes above).
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
