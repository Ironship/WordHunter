import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectLinuxTree } from "../../scripts/inspect-artifact.mjs";

const linuxConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.linux-bundle.conf.json", import.meta.url), "utf8"),
);
const buildScript = readFileSync(
  new URL("../../scripts/build-linux-native.sh", import.meta.url),
  "utf8",
);

function createElf(machine = 62) {
  const value = Buffer.alloc(64);
  value.set([0x7f, 0x45, 0x4c, 0x46], 0);
  value[4] = 2;
  value[5] = 1;
  value.writeUInt16LE(machine, 18);
  return value;
}

function write(root, name, value = "fixture") {
  const path = join(root, ...name.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function writeExecutable(root, name, value) {
  write(root, name, value);
  chmodSync(join(root, ...name.split("/")), 0o755);
}

function createLinuxTree(root, format = "appimage") {
  const elf = createElf();
  for (const name of [
    "usr/bin/word-hunter-rustified",
    "usr/lib/word-hunter-rustified/ocr-runtime/bin/wordhunter-paddleocr",
    "usr/lib/word-hunter-rustified/ocr-runtime/bin/libpdfium.so",
    "usr/lib/word-hunter-rustified/ocr-runtime/bin/libwebgpu_dawn.so",
  ]) {
    writeExecutable(root, name, elf);
  }
  if (format === "appimage") {
    writeExecutable(root, "usr/bin/syncthing", elf);
    write(root, "apprun-hooks/linuxdeploy-plugin-gstreamer.sh", "export GST_PLUGIN_PATH_1_0=fixture\n");
    for (const plugin of ["libgstcoreelements.so", "libgstplayback.so", "libgstautodetect.so"]) {
      write(root, `usr/lib/gstreamer-1.0/${plugin}`, elf);
    }
  }
  for (const name of ["det.onnx", "rec.onnx", "cls.onnx"]) {
    write(root, `usr/lib/word-hunter-rustified/ocr-runtime/models/${name}`);
  }
  for (const name of [
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "THIRD-PARTY-LICENSES.html",
    "OCR-THIRD-PARTY-LICENSES.html",
    "SYNCTHING-LICENSE.txt",
    "SYNCTHING-AUTHORS.txt",
  ]) {
    write(root, `usr/lib/word-hunter-rustified/${name}`);
  }
  write(
    root,
    "usr/share/applications/Word Hunter.desktop",
    "[Desktop Entry]\nType=Application\nName=Word Hunter\nExec=word-hunter-rustified\nIcon=com.wordhunter.app\nTerminal=false\nCategories=Education;Languages;\nStartupWMClass=com.wordhunter.app\n",
  );
  write(
    root,
    "usr/share/metainfo/com.wordhunter.app.metainfo.xml",
    '<component type="desktop-application"><id>com.wordhunter.app</id><launchable type="desktop-id">Word Hunter.desktop</launchable></component>',
  );
  write(root, "usr/share/icons/hicolor/128x128/apps/com.wordhunter.app.png");
  if (format === "deb") {
    write(root, "usr/share/doc/word-hunter/copyright");
    write(root, "usr/share/doc/word-hunter/changelog.Debian.gz");
    write(
      root,
      "usr/share/lintian/overrides/word-hunter",
      ["freetype", "lcms2", "openjpeg"]
        .map((library) => `word-hunter: embedded-library ${library} usr/lib/*/ocr-runtime/bin/libpdfium.so`)
        .join("\n"),
    );
  }
}

describe("Linux native artifact inspection", () => {
  it("pins native packaging inputs and keeps Syncthing format-specific", () => {
    const bundle = linuxConfig.bundle;
    assert.deepEqual(bundle.targets, ["appimage", "deb"]);
    assert.equal(bundle.useLocalToolsDir, true);
    assert.equal(bundle.linux.appimage.bundleMediaFramework, true);
    assert.equal(bundle.linux.appimage.files["/usr/bin/syncthing"], "syncthing/syncthing");
    assert.equal(bundle.resources["syncthing/syncthing"], undefined);
    assert.ok(bundle.linux.deb.depends.includes("syncthing"));
    assert.ok(bundle.linux.deb.depends.includes("libc6 (>= 2.35)"));
    assert.equal(bundle.linux.deb.desktopTemplate, "../flatpak/com.wordhunter.app.desktop");
    assert.equal(bundle.linux.deb.files["/usr/bin/syncthing"], undefined);
    assert.equal(
      bundle.linux.deb.files["/usr/share/doc/word-hunter/copyright"],
      "../packaging/linux/debian-copyright",
    );
    assert.equal(
      bundle.linux.deb.files["/usr/share/doc/word-hunter/changelog.Debian.gz"],
      "target/.tauri/word-hunter-changelog.gz",
    );
    assert.equal(
      bundle.linux.deb.files["/usr/share/lintian/overrides/word-hunter"],
      "../packaging/linux/word-hunter.lintian-overrides",
    );

    for (const digest of [
      "f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f",
      "e762bea85c8eb0d4b3508d46e5c1f037f717d0f9303ae3b4aafc8b04991fa1ef",
      "06a56df39e65806170ebae570e593ea14ad9aecf97f668694c343f461482b4c4",
      "2a15ce9da8de6e20159e1ab27861a7a5ef8758c81a6278ba4ab30cefa1d74c9f",
      "992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3",
    ]) {
      assert.match(buildScript, new RegExp(digest));
    }
    assert.doesNotMatch(buildScript, /ORT_PREFER_DYNAMIC_LINK/);
    assert.match(buildScript, /extract_tgz "\$ort_archive" "\$ort_dir" 1/);
    assert.match(buildScript, /gzip -9 -n -c .*debian-changelog/);
    assert.match(buildScript, /CARGO_PROFILE_RELEASE_STRIP=symbols/);
    assert.match(buildScript, /release_version="\$\{package_version\/\+\/\.\}"/);
    assert.match(buildScript, /WordHunter-\$release_version-x86_64\.AppImage/);
    assert.match(buildScript, /word-hunter_\$\{release_version\}_amd64\.deb/);
  });

  it("accepts a complete x86_64 tree and rejects architecture drift", () => {
    const root = mkdtempSync(join(tmpdir(), "wordhunter-linux-tree-test-"));
    try {
      createLinuxTree(root);
      assert.doesNotThrow(() => inspectLinuxTree(root, "fixture", { format: "appimage" }));

      write(
        root,
        "usr/lib/word-hunter-rustified/ocr-runtime/bin/libpdfium.so",
        createElf(183),
      );
      assert.throws(
        () => inspectLinuxTree(root, "fixture", { format: "appimage" }),
        /wrong machine architecture/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a DEB tree with a system Syncthing dependency and rejects a bundled copy", () => {
    const root = mkdtempSync(join(tmpdir(), "wordhunter-linux-deb-tree-test-"));
    try {
      createLinuxTree(root, "deb");
      assert.doesNotThrow(() => inspectLinuxTree(root, "fixture", { format: "deb" }));

      writeExecutable(root, "usr/bin/syncthing", createElf());
      assert.throws(
        () => inspectLinuxTree(root, "fixture", { format: "deb" }),
        /Debian syncthing dependency/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a second desktop launcher", () => {
    const root = mkdtempSync(join(tmpdir(), "wordhunter-linux-desktop-test-"));
    try {
      createLinuxTree(root, "appimage");
      write(root, "usr/share/applications/com.wordhunter.app.desktop", "[Desktop Entry]\n");
      assert.throws(
        () => inspectLinuxTree(root, "fixture", { format: "appimage" }),
        /exactly the canonical/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
