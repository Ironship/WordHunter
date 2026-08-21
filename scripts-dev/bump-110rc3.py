import json, re, os, shutil, sys

ROOT = r"C:\Users\Oleg\WordHunter-research"
OLD = "1.1.0-rc.1"
NEW = "1.1.0-rc.3"
OLD_CODE = "101100001"
NEW_CODE = "101100003"

changed = []

def byte_replace(path, pairs):
    with open(path, "rb") as f:
        data = f.read()
    orig = data
    for old, new in pairs:
        data = data.replace(old.encode(), new.encode())
    if data != orig:
        with open(path, "wb") as f:
            f.write(data)
        changed.append(path)

# 1. Core manifests
byte_replace(os.path.join(ROOT, "src-tauri", "tauri.conf.json"), [(OLD, NEW)])
byte_replace(os.path.join(ROOT, "src-tauri", "Cargo.toml"), [(OLD, NEW)])
byte_replace(os.path.join(ROOT, "src-tauri", "Cargo.lock"), [(f'name = "word-hunter"\nversion = "{OLD}"', f'name = "word-hunter"\nversion = "{NEW}"')])
byte_replace(os.path.join(ROOT, "src-tauri", "tauri.android.conf.json"), [(OLD_CODE, NEW_CODE)])

# 2. i18n x10: help.version + help.whatsNew (byte replace preserves CRLF)
for loc in ["de","en","es","fr","it","ja","pl","ru","uk","zh"]:
    p = os.path.join(ROOT, "src", "web", "i18n", f"{loc}.json")
    # parse check first
    with open(p, encoding="utf-8-sig") as f:
        d = json.load(f)
    assert OLD in d["help"]["version"], (loc, d["help"]["version"])
    byte_replace(p, [(OLD, NEW)])
    with open(p, encoding="utf-8-sig") as f:
        json.load(f)  # still parses

# 3. snapcraft.yaml: version + source URL
byte_replace(os.path.join(ROOT, "snap", "snapcraft.yaml"), [(OLD, NEW)])

# 4. metainfo x2: add new release entry above the rc.1 one (tilde form)
for rel in ["packaging/linux/com.wordhunter.app.metainfo.xml", "flatpak/com.wordhunter.app.metainfo.xml"]:
    p = os.path.join(ROOT, *rel.split("/"))
    with open(p, encoding="utf-8") as f:
        content = f.read()
    anchor = '    <release version="1.1.0~rc.1" date="2026-08-20" type="development">'
    new_entry = ('    <release version="1.1.0~rc.3" date="2026-08-21" type="development">\n'
                 '      <url>https://github.com/Ironship/WordHunter/releases/tag/WordHunter1.1.0-rc.3</url>\n'
                 '    </release>\n')
    assert anchor in content, rel
    content = content.replace(anchor, new_entry + anchor, 1)
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    changed.append(p)

# 5. Test pins
byte_replace(os.path.join(ROOT, "frontend-tests", "shared", "android-artifact-inspection.test.js"),
             [('"1.1.0-rc.1"', f'"{NEW}"'), ("101100001", NEW_CODE)])
byte_replace(os.path.join(ROOT, "frontend-tests", "shared", "android-version-script.test.js"),
             [('"1.1.0-rc.1"', f'"{NEW}"'), ("101100001", NEW_CODE)])

# 6. Fastlane changelog for the new versionCode
src_ch = os.path.join(ROOT, "fastlane", "metadata", "android", "en-US", "changelogs", f"{OLD_CODE}.txt")
dst_ch = os.path.join(ROOT, "fastlane", "metadata", "android", "en-US", "changelogs", f"{NEW_CODE}.txt")
with open(src_ch, encoding="utf-8") as f:
    ch = f.read()
with open(dst_ch, "w", encoding="utf-8", newline="") as f:
    f.write(ch.replace(OLD, NEW))
changed.append(dst_ch)

# 7. THIRD-PARTY-LICENSES.html: bump ONLY the version string (Windows regen diverges — do not regenerate)
lp = os.path.join(ROOT, "THIRD-PARTY-LICENSES.html")
with open(lp, "rb") as f:
    lic = f.read()
n = lic.count(f"word-hunter {OLD}".encode())
assert n >= 1, "license report version string not found"
lic = lic.replace(f"word-hunter {OLD}".encode(), f"word-hunter {NEW}".encode())
with open(lp, "wb") as f:
    f.write(lic)
changed.append(lp)

print("CHANGED:")
for c in changed:
    print(" ", os.path.relpath(c, ROOT))

# Sanity checks
with open(os.path.join(ROOT, "src-tauri", "Cargo.lock"), encoding="utf-8") as f:
    lock = f.read()
cnt = lock.count(f'version = "{NEW}"')
print(f"Cargo.lock occurrences of new version: {cnt} (must be 1)")
assert cnt == 1
