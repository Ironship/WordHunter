# Byte-safe bump 1.0.13-rc.5 -> 1.0.13 for the WordHunter stable release branch.
# Run from the repo root on the release/1.0.13 branch.
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLD = "1.0.13-rc.5"
NEW = "1.0.13"
OLD_CODE = "101001305"
NEW_CODE = "101001399"
RELEASE_DATE = "2026-08-17"

replaced: list[str] = []
missed: list[str] = []


def byte_replace(path: str, pairs: list[tuple[str, str]]) -> None:
    target = ROOT / path
    if not target.exists():
        missed.append(path)
        return
    data = target.read_bytes()
    count = 0
    for old, new in pairs:
        occurrences = data.count(old.encode())
        count += occurrences
        data = data.replace(old.encode(), new.encode())
    if count:
        replaced.append(f"{path} ({count})")
    else:
        missed.append(path)
    target.write_bytes(data)


def bump_json_locale(path: str, whats_new: str) -> None:
    target = ROOT / path
    with target.open(encoding="utf-8") as handle:
        document = json.load(handle)
    document["help"]["version"] = NEW
    document["help"]["whatsNew"] = whats_new
    with target.open("w", encoding="utf-8", newline="") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    replaced.append(f"{path} (version, whatsNew)")


# 1. Core manifests.
byte_replace("src-tauri/tauri.conf.json", [(f'"version": "{OLD}"', f'"version": "{NEW}"')])
byte_replace("src-tauri/Cargo.toml", [(f'version = "{OLD}"', f'version = "{NEW}"')])
byte_replace("src-tauri/Cargo.lock", [(f'version = "{OLD}"', f'version = "{NEW}"')])
byte_replace(
    "src-tauri/tauri.android.conf.json",
    [(f'"versionCode": {OLD_CODE}', f'"versionCode": {NEW_CODE}')],
)

# 2. Localized version and release summary.
whats = {
    "en": f"{NEW} adds searchable AI model discovery, fixes image selection and flashcard refresh on Android, saves AI explanations, shuffles review queues, compresses uploads, and improves backend reliability.",
    "pl": f"{NEW} dodaje wyszukiwarkę modeli AI, naprawia wybór i odświeżanie obrazów w fiszkach na Androidzie, zapisuje wyjaśnienia AI, losuje kolejki powtórek, kompresuje zdjęcia i poprawia niezawodność backendu.",
    "de": f"{NEW} ergänzt eine durchsuchbare KI-Modellsuche, behebt Bildauswahl und Kartenaktualisierung auf Android, speichert KI-Erklärungen, mischt Wiederholungen, komprimiert Bilder und verbessert die Backend-Stabilität.",
    "es": f"{NEW} añade búsqueda de modelos de IA, corrige la selección y actualización de imágenes en tarjetas Android, guarda explicaciones de IA, baraja repasos, comprime imágenes y mejora la fiabilidad del backend.",
    "fr": f"{NEW} ajoute la recherche de modèles IA, corrige la sélection et l’actualisation des images sur les cartes Android, enregistre les explications IA, mélange les révisions, compresse les images et fiabilise le backend.",
    "it": f"{NEW} aggiunge la ricerca dei modelli IA, corregge selezione e aggiornamento delle immagini nelle schede Android, salva le spiegazioni IA, mescola i ripassi, comprime le immagini e migliora l’affidabilità del backend.",
    "ja": f"{NEW} は検索可能なAIモデル一覧を追加し、Androidカードの画像選択と更新を修正します。AI解説の保存、復習順のシャッフル、画像圧縮、バックエンドの安定性も改善しました。",
    "ru": f"{NEW} добавляет поиск моделей ИИ, исправляет выбор и обновление изображений в карточках Android, сохраняет ИИ-объяснения, перемешивает повторения, сжимает изображения и повышает надёжность сервера.",
    "uk": f"{NEW} додає пошук моделей ШІ, виправляє вибір і оновлення зображень у картках Android, зберігає ШІ-пояснення, перемішує повторення, стискає зображення та підвищує надійність сервера.",
    "zh": f"{NEW} 新增可搜索的 AI 模型列表，修复 Android 卡片的图片选择与刷新，保存 AI 解释，随机排列复习队列，压缩图片，并提升后端稳定性。",
}
for locale, text in whats.items():
    bump_json_locale(f"src/web/i18n/{locale}.json", text)

# 3. Licenses and packaging.
byte_replace("THIRD-PARTY-LICENSES.html", [(f"word-hunter {OLD}", f"word-hunter {NEW}")])
byte_replace("snap/snapcraft.yaml", [(OLD, NEW)])

metainfo = ROOT / "packaging/linux/com.wordhunter.app.metainfo.xml"
metainfo_data = metainfo.read_text(encoding="utf-8")
release_anchor = "  <releases>\n"
stable_entry = f"""  <releases>
    <release version=\"{NEW}\" date=\"{RELEASE_DATE}\">
      <description>
        <ul>
          <li>Adds searchable model discovery for OpenAI-compatible AI services while preserving manual model entry.</li>
          <li>Fixes Android image selection and immediate flashcard refresh, with compressed uploads and refined Pocket controls.</li>
          <li>Improves flashcard AI-note persistence, shuffled review sessions, Android navigation, and backend resilience.</li>
        </ul>
      </description>
    </release>
"""
if stable_entry not in metainfo_data:
    if release_anchor not in metainfo_data:
        missed.append(str(metainfo.relative_to(ROOT)))
    else:
        metainfo_data = metainfo_data.replace(release_anchor, stable_entry, 1)
        metainfo.write_text(metainfo_data, encoding="utf-8", newline="")
        replaced.append(str(metainfo.relative_to(ROOT)))
flatpak_metainfo = ROOT / "flatpak/com.wordhunter.app.metainfo.xml"
flatpak_metainfo.write_bytes(metainfo.read_bytes())
replaced.append(str(flatpak_metainfo.relative_to(ROOT)))

debian = ROOT / "packaging/linux/debian-changelog"
debian_entry = f"""word-hunter ({NEW}) unstable; urgency=medium

  * Searchable AI model discovery for OpenAI-compatible services.
  * Reliable Android image selection, flashcard refresh, and compressed uploads.
  * Improved AI notes, review ordering, Android controls, and backend resilience.

 -- Word Hunter maintainers <maintainers@wordhunter.app>  Mon, 17 Aug 2026 23:51:13 +0200

"""
debian_data = debian.read_text(encoding="utf-8")
if not debian_data.startswith(f"word-hunter ({NEW}) "):
    debian.write_text(debian_entry + debian_data, encoding="utf-8", newline="")
    replaced.append(str(debian.relative_to(ROOT)))

# 4. Version-sensitive test pins.
byte_replace(
    "frontend-tests/shared/android-artifact-inspection.test.js",
    [(OLD, NEW), (OLD_CODE, NEW_CODE)],
)
byte_replace(
    "frontend-tests/shared/android-version-script.test.js",
    [(OLD, NEW), (OLD_CODE, NEW_CODE)],
)

# 5. Play Store changelog for the stable versionCode.
fastlane = ROOT / f"fastlane/metadata/android/en-US/changelogs/{NEW_CODE}.txt"
fastlane.write_text(
    f"""Word Hunter {NEW}

Searchable AI model discovery, reliable Android image selection and flashcard
refresh, saved AI explanations, shuffled reviews, compressed image uploads,
and stronger backend reliability.
""",
    encoding="utf-8",
)
replaced.append(str(fastlane.relative_to(ROOT)))

# 6. Stable release notes.
release_doc = ROOT / f"docs/releases/{NEW}.md"
release_doc.parent.mkdir(parents=True, exist_ok=True)
release_doc.write_text(
    f"""# Word Hunter {NEW}

Stable release of the 1.0.13 line.

## Highlights

- **Searchable AI model discovery** — fetch the catalog only after an explicit
  refresh, filter it locally with multiple terms, choose by touch or keyboard,
  or keep entering any model id manually. Authenticated requests do not follow
  redirects, use a 15-second wall-clock deadline, and cap responses at 1 MiB.
- **Reliable flashcard images on Android** — tapping a suggestion now refreshes
  the active card immediately and persists the image. Oversized uploads are
  downscaled and compressed; the Pocket remove control has a smaller 32 dp
  visual circle while retaining a 44 dp touch target.
- **Better flashcard sessions** — AI explanations persist to word notes, daily
  review queues are shuffled, and touch controls remain responsive after
  reader and deck swipes.
- **Android and backend reliability** — fixes app-data resolution at startup,
  native source-link opening, reader control layout, API-key settings, idle
  listener shutdowns, and transient accept errors.

## Privacy and configuration

AI features remain optional. Model discovery runs only when the user presses
Refresh models and sends the configured API key only to the configured
OpenAI-compatible endpoint. The model cache is scoped to the endpoint and does
not store the API key.

## Verification

- Full repository validation: `scripts/validate.sh` — `Validation complete.`
- Automated frontend coverage for model-list parsing, filtering, caching,
  explicit refresh, accessibility, and Android IME input.
- Pixel 9 Pro XL / Android 16: in-place install with preserved app data; image
  selection, image persistence, and Pocket control sizing tested.
""",
    encoding="utf-8",
)
replaced.append(str(release_doc.relative_to(ROOT)))

print("REPLACED:")
for item in replaced:
    print(" ", item)
if missed:
    print("MISSED:")
    for item in missed:
        print(" ", item)
    raise SystemExit(1)
print("done")
