import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
const actions = readFileSync(new URL("../../dist/web/js/sync-actions.js", import.meta.url), "utf8");
const transfer = readFileSync(new URL("../../src-tauri/src/store/transfer.rs", import.meta.url), "utf8");
const locales = ["pl", "en", "de", "es", "fr", "it", "uk", "ru", "ja"];

describe("manual transfer tab", () => {
  it("replaces navigation sync with export and exposes all transfer actions", () => {
    assert.match(html, /data-view="export"/);
    assert.match(html, /id="export-view"/);
    assert.match(html, /id="export-transfer-all"/);
    assert.match(html, /id="export-transfer-words"/);
    assert.match(html, /id="import-transfer"/);
    assert.doesNotMatch(html, /data-view="sync"/);
  });

  it("uses native streamed files on Android and backend file pickers on desktop", () => {
    assert.match(actions, /saveExportFile/);
    assert.match(actions, /chooseImportPackage/);
    assert.match(actions, /\/__store\/export_transfer/);
    assert.match(actions, /\/__store\/import_transfer/);
  });

  it("stores timestamps in YAML and packages book assets with path validation", () => {
    assert.match(transfer, /manifest\.yaml/);
    assert.match(transfer, /words\/.*\.yaml/);
    assert.match(transfer, /book\.yaml/);
    assert.match(transfer, /\/images/);
    assert.match(transfer, /record_time\(saved\).*>=.*record_time\(&incoming\)/s);
    assert.match(transfer, /validated_archive_name/);
  });

  for (const locale of locales) {
    it(`${locale} contains transfer labels`, () => {
      const messages = JSON.parse(readFileSync(new URL(`../../src/web/i18n/${locale}.json`, import.meta.url), "utf8"));
      assert.ok(messages.nav.export);
      assert.ok(messages.transfer.exportAll);
      assert.ok(messages.transfer.import);
      assert.ok(messages.toast.transferImported);
    });
  }
});
