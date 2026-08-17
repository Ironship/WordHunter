# Byte-safe bump 1.0.13-rc.1 -> 1.0.13-rc.3 for the WordHunter release branch.
# Run from the repo root on the release/1.0.13-rc.3 branch.
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLD = "1.0.13-rc.2"
NEW = "1.0.13-rc.3"
OLD_CODE = "101001302"
NEW_CODE = "101001303"

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
    "en": f"{NEW} fixes the Android backend crash after ~a minute of reading: the app's local server could silently die (every book open then showed 'No text source found' and AI explanations failed).",
    "pl": f"{NEW} naprawia awarię zaplecza na Androidzie po ~minucie czytania: lokalny serwer apki mógł cicho znikać (każde otwarcie książki pokazywało 'No text source found', a wyjaśnienia AI nie działały).",
    "de": f"{NEW} behebt den Absturz des Android-Backends nach etwa einer Minute Lesen: Der lokale Server der App konnte stillschweigend sterben (jedes Buch zeigte danach 'No text source found' und KI-Erklärungen schlugen fehl).",
    "es": f"{NEW} corrige la caída del backend de Android tras ~un minuto de lectura: el servidor local de la app podía morir en silencio (cada libro mostraba 'No text source found' y las explicaciones de IA fallaban).",
    "fr": f"{NEW} corrige la panne du backend Android après ~une minute de lecture : le serveur local de l'app pouvait mourir en silence (chaque livre affichait alors « No text source found » et les explications IA échouaient).",
    "it": f"{NEW} corregge il crash del backend Android dopo ~un minuto di lettura: il server locale dell'app poteva morire in silenzio (ogni libro mostrava 'No text source found' e le spiegazioni IA fallivano).",
    "ja": f"{NEW} はAndroidで約1分間読んだ後にバックエンドが落ちる問題を修正しました：アプリ内サーバーが静かに停止することがあり（その後どの本も「No text source found」と表示され、AI解説も失敗）、これを解消しました。",
    "ru": f"{NEW} исправляет падение бэкенда на Android после ~минуты чтения: локальный сервер приложения мог тихо умирать (каждая книга показывала 'No text source found', а ИИ-объяснения не работали).",
    "uk": f"{NEW} виправляє падіння бекенду на Android після ~хвилини читання: локальний сервер застосунку міг тихо зникати (кожна книга показувала 'No text source found', а ШІ-пояснення не працювали).",
    "zh": f"{NEW} 修复了 Android 阅读约一分钟后后端崩溃的问题：应用内服务器可能悄然停止（此后打开任何书籍都显示“No text source found”，AI 解释也失败）。",
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
src = ROOT / "fastlane/metadata/android/en-US/changelogs/101001302.txt"
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

Third release candidate of the 1.0.13 line.

## Changes since 1.0.13-rc.2

- **Android backend died mid-session** — the listener socket carried a
  60 s read timeout; on Android the kernel honors that on listen sockets,
  so after ~a minute of idle reading `accept()` failed and the server
  thread dropped the listener. Every book open then showed
  \"No text source found\" and AI explanations failed. The timeout is
  removed (per-connection slow-loris deadlines remain in the vendored
  accept path) (`#259`).

## Verification

- Rust suite 290/290 (incl. the new `listener_carries_no_socket_timeout`
  regression test); `scripts/validate.sh` - \"Validation complete.\"
- On-device: the #259 build boots on a Pixel 9 Pro XL / Android 16
  (\"backend ready on 127.0.0.1:38619\" via logcat).
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
