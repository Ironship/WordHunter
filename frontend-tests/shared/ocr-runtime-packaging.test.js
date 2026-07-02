import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("OCR runtime packaging", () => {
  it("bundles GNU runtime DLLs required by Windows executables", () => {
    const runtimeScript = readFileSync(new URL("../../scripts/windows-runtime.ps1", import.meta.url), "utf8");
    const buildScript = readFileSync(new URL("../../scripts/build.bat", import.meta.url), "utf8");
    const ocrScript = readFileSync(new URL("../../src-tauri/ocr-runtime/prepare-runtime.ps1", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../../src-tauri/ocr-runtime/README.md", import.meta.url), "utf8");

    assert.match(runtimeScript, /Get-ImportedWindowsRuntimeDllNames/);
    assert.match(runtimeScript, /Copy-RequiredWindowsRuntimeDlls/);
    assert.match(runtimeScript, /libstdc\+\+-6\.dll/);
    assert.match(runtimeScript, /libgcc_s_seh-1\.dll/);
    assert.match(runtimeScript, /libwinpthread-1\.dll/);
    assert.match(runtimeScript, /Do not publish Windows artifacts until these DLLs are present/);
    assert.match(buildScript, /Copy-AppRuntimeDlls \$RustExe \$PortableDir/);
    assert.match(buildScript, /New-WindowsRuntimeTauriConfig/);
    assert.match(buildScript, /--config/);
    assert.match(buildScript, /target\/release\/\$dll/);
    assert.match(buildScript, /Assert-ArchiveContainsRuntimeDlls \$OutputPortableZip \$portableRuntimeDlls/);
    assert.match(buildScript, /Assert-ArchiveContainsRuntimeDlls \$OutputInstaller \$installerRuntimeDlls/);
    assert.match(buildScript, /Assert-NsisScriptsContainRuntimeDlls/);
    assert.match(ocrScript, /Copy-RequiredWindowsRuntimeDlls/);
    assert.match(readme, /bin\\libstdc\+\+-6\.dll/);
    assert.match(readme, /Word\.Hunter\.portable\.exe/);
  });

  it("bundles the Linux OCR runtime in the Flatpak manifest", () => {
    const manifest = readFileSync(new URL("../../com.wordhunter.app.yml", import.meta.url), "utf8");

    assert.match(manifest, /ORT_LIB_LOCATION: .*flatpak-onnxruntime/);
    assert.match(manifest, /cargo --offline build --release --manifest-path src-tauri\/ocr-runner\/Cargo\.toml/);
    assert.match(manifest, /wordhunter-paddleocr \/app\/bin\/ocr-runtime\/bin\/wordhunter-paddleocr/);
    assert.match(manifest, /flatpak-pdfium\/libpdfium\.so \/app\/bin\/ocr-runtime\/bin\/libpdfium\.so/);
    assert.match(manifest, /src-tauri\/target\/flatpak-ocr-models\/\*\.onnx/);
    assert.match(manifest, /x86_64-unknown-linux-gnu\.tgz/);
    assert.match(manifest, /pdfium-linux-x64\.tgz/);
    assert.match(manifest, /Paddle\.OCR\.V5\.zip/);
  });
});
