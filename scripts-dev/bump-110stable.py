# Byte-safe bump 1.1.0-rc.11 -> 1.1.0 for the WordHunter stable release.
# Run from the repo root on main.
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLD = "1.1.0-rc.11"
NEW = "1.1.0"
OLD_CODE = "101100011"
NEW_CODE = "101100099"
RELEASE_DATE = "2026-08-29"

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
    "en": f"{NEW} imports German quest vocabulary from World of Warcraft together with its encounter history, lets you edit saved words, improves the reader and flashcards, and starts noticeably faster with large libraries.",
    "pl": f"{NEW} importuje niemieckie słownictwo z questów World of Warcraft razem z historią spotkań, pozwala edytować zapisane słowa, ulepsza czytnik i fiszki oraz zauważalnie szybciej startuje przy dużych bibliotekach.",
    "de": f"{NEW} importiert deutschen Questwortschatz aus World of Warcraft samt Begegnungsverlauf, macht gespeicherte Wörter bearbeitbar, verbessert Leser und Karteikarten und startet bei großen Bibliotheken deutlich schneller.",
    "es": f"{NEW} importa vocabulario alemán de las misiones de World of Warcraft con su historial de apariciones, permite editar las palabras guardadas, mejora el lector y las tarjetas, y arranca mucho más rápido con bibliotecas grandes.",
    "fr": f"{NEW} importe le vocabulaire allemand des quêtes de World of Warcraft avec son historique de rencontres, permet de modifier les mots enregistrés, améliore le lecteur et les cartes, et démarre nettement plus vite avec de grandes bibliothèques.",
    "it": f"{NEW} importa il lessico tedesco delle missioni di World of Warcraft con lo storico degli incontri, consente di modificare le parole salvate, migliora lettore e schede e si avvia molto più in fretta con librerie grandi.",
    "ja": f"{NEW} は World of Warcraft のクエストからドイツ語の語彙を出現履歴ごと取り込み、保存した単語を編集できるようにし、リーダーとフラッシュカードを改善し、大きなライブラリでの起動を大幅に速くしました。",
    "ru": f"{NEW} импортирует немецкую лексику из заданий World of Warcraft вместе с историей встреч, позволяет редактировать сохранённые слова, улучшает читалку и карточки и заметно быстрее запускается с большими библиотеками.",
    "uk": f"{NEW} імпортує німецьку лексику із завдань World of Warcraft разом з історією зустрічей, дозволяє редагувати збережені слова, покращує читалку та картки й помітно швидше запускається з великими бібліотеками.",
    "zh": f"{NEW} 可从《魔兽世界》任务导入德语词汇及其出现记录，支持编辑已保存的单词，改进了阅读器和记忆卡，并在大型书库下启动明显更快。",
}
for locale, text in whats.items():
    bump_json_locale(f"src/web/i18n/{locale}.json", text)

# 3. Licenses and packaging.
byte_replace("THIRD-PARTY-LICENSES.html", [(f"word-hunter {OLD}", f"word-hunter {NEW}")])
# Both the `version:` line and the release DEB URL. The `source-checksum` is
# deliberately left alone: the 1.1.0 asset does not exist until the release is
# published, so that hash lands in a follow-up commit.
byte_replace("snap/snapcraft.yaml", [(OLD, NEW)])

metainfo = ROOT / "packaging/linux/com.wordhunter.app.metainfo.xml"
metainfo_data = metainfo.read_text(encoding="utf-8")
release_anchor = "  <releases>\n"
# No type="development": this is the stable, and AppStream would otherwise
# present it to Flathub as a prerelease.
stable_entry = f"""  <releases>
    <release version=\"{NEW}\" date=\"{RELEASE_DATE}\">
      <description>
        <ul>
          <li>Imports German quest vocabulary from World of Warcraft, with encounter history and a suggestion when a word may be ready for Known.</li>
          <li>Adds editable saved words, shuffled review sessions, separable-verb masking on cards, dyslexia-friendly reader fonts, and bold and italic in the book editor.</li>
          <li>Starts and saves markedly faster on large libraries, and keeps image text recognition from being cut off while it is still running.</li>
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

  * Import German quest vocabulary from World of Warcraft, with encounter history.
  * Editable saved words, shuffled reviews, separable-verb masking, dyslexia-friendly reader fonts.
  * Faster start and save on large libraries; image text recognition is no longer cut off mid-run.

 -- Word Hunter maintainers <maintainers@wordhunter.app>  Sat, 29 Aug 2026 20:00:00 +0200

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

Import German quest vocabulary from World of Warcraft with its encounter
history, edit saved words, shuffle today's cards, read with dyslexia-friendly
fonts, and start noticeably faster with a large library.
""",
    encoding="utf-8",
)
replaced.append(str(fastlane.relative_to(ROOT)))

# 6. Stable release notes are written by hand in docs/releases/1.1.0.md.
if not (ROOT / f"docs/releases/{NEW}.md").exists():
    missed.append(f"docs/releases/{NEW}.md")

print("REPLACED:")
for item in replaced:
    print(" ", item)
if missed:
    print("MISSED:")
    for item in missed:
        print(" ", item)
    raise SystemExit(1)
print("done")
