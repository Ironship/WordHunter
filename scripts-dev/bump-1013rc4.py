# Byte-safe bump 1.0.13-rc.3 -> 1.0.13-rc.4 for the WordHunter release branch.
# Run from the repo root on the release/1.0.13-rc.4 branch.
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLD = "1.0.13-rc.3"
NEW = "1.0.13-rc.4"
OLD_CODE = "101001303"
NEW_CODE = "101001304"

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
    "en": f"{NEW} fixes Android image adding (tapping a suggestion now saves it), saves flashcard AI explanations to the word note, shuffles the daily review queue, and compresses oversized image uploads.",
    "pl": f"{NEW} naprawia dodawanie obrazów na Androidzie (tap w propozycję zapisuje obraz), zapisuje wyjaśnienia AI z fiszek do notatki słowa, losuje kolejkę powtórek dnia i kompresuje duże zdjęcia.",
    "de": f"{NEW} behebt das Hinzufügen von Bildern auf Android (Tippen auf einen Vorschlag speichert das Bild), speichert KI-Erklärungen von Karteikarten in der Wortnotiz, mischt die Tageswiederholungen und komprimiert große Bilder.",
    "es": f"{NEW} corrige la adición de imágenes en Android (tocar una sugerencia guarda la imagen), guarda las explicaciones de IA de las tarjetas en la nota de la palabra, baraja la cola diaria y comprime imágenes grandes.",
    "fr": f"{NEW} corrige l'ajout d'images sur Android (toucher une suggestion enregistre l'image), enregistre les explications IA des cartes dans la note du mot, mélange la file du jour et compresse les grandes images.",
    "it": f"{NEW} corregge l'aggiunta di immagini su Android (toccare un suggerimento salva l'immagine), salva le spiegazioni IA delle flashcard nella nota della parola, mescola la coda giornaliera e comprime le immagini grandi.",
    "ja": f"{NEW} はAndroidでの画像追加を修正し（候補をタップすると保存されます）、フラッシュカードのAI解説を単語メモに保存、毎日の復習キューをシャッフル、大きい画像を圧縮します。",
    "ru": f"{NEW} исправляет добавление изображений на Android (касание варианта сохраняет картинку), сохраняет ИИ-объяснения карточек в заметку слова, перемешивает дневную очередь и сжимает большие изображения.",
    "uk": f"{NEW} виправляє додавання зображень на Android (дотик до пропозиції зберігає картинку), зберігає ШІ-пояснення карток у нотатку слова, перемішує денну чергу та стискає великі зображення.",
    "zh": f"{NEW} 修复了 Android 添加图片的问题（点击建议即可保存），将卡片 AI 解释保存到单词笔记，打乱每日复习队列并压缩大图片。",
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
src = ROOT / f"fastlane/metadata/android/en-US/changelogs/{OLD_CODE}.txt"
dst = ROOT / f"fastlane/metadata/android/en-US/changelogs/{NEW_CODE}.txt"
if src.exists():
    data = src.read_bytes().replace(OLD.encode(), NEW.encode())
    # Replace the trailing "what changed" summary with the rc.4 copy.
    summary = (
        f"Word Hunter {NEW}\n\n"
        f"Android image adding fixed, flashcard AI explanations saved to the\n"
        f"word note, daily review queue shuffled, oversized uploads compressed.\n"
    ).encode()
    idx = data.find(b"\n\n")
    if idx != -1:
        data = summary
    dst.write_bytes(data)
    replaced.append(str(dst.relative_to(ROOT)))
else:
    dst.write_text(
        f"Word Hunter {NEW}\n\n"
        f"Android image adding fixed, flashcard AI explanations saved to the\n"
        f"word note, daily review queue shuffled, oversized uploads compressed.\n",
        encoding="utf-8",
    )
    replaced.append(str(dst.relative_to(ROOT)))

# 6. Release doc
release_md = ROOT / f"docs/releases/{NEW}.md"
release_md.parent.mkdir(parents=True, exist_ok=True)
release_md.write_text(
    f"""# Word Hunter {NEW}

Fourth release candidate of the 1.0.13 line.

## Changes since 1.0.13-rc.3

- **Adding an image to a word works on Android** — the flashcard swipe
  suppression ate taps on suggestion tiles within 400 ms after a deck
  swipe; interactive controls (including the upload tile) are now exempt,
  in the flashcards view AND in the reader word panel and text surface
  (`#262`, `#265`).
- **Flashcard AI explanations persist to the word note** — the shared
  append helper writes the finished explanation exactly like the reader
  does (dedupe, flush-before-write), and only reads the live note
  textarea while the reader view is actually open (`#261`, `#266`).
- **Daily review queue is shuffled** — the upcoming list follows the
  session's shuffled order instead of leaking the alphabetical deck
  order (`#263`).
- **Oversized image uploads are compressed** — uploads above ~300 KB
  are downscaled to 1024 px and re-encoded as JPEG before saving, so a
  camera photo no longer bloats every save payload (`#264`).
- **Backend survives transient accept errors** — the vendored HTTP
  accept loop no longer kills the whole server on a transient socket
  error (`#267`).

## Verification

- Rust suite 290/290; frontend suites green on every fix PR; full audit
  of three layers (UI/platform/domain) by independent subagents before
  this RC; `scripts/validate.sh` - "Validation complete."
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
