import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Issue #135 (bullets 3+4) static contracts:
//  - Linux external-URL opening must spawn a portal opener itself and reap
//    it with a bounded wait, so a non-zero exit status or a stalled opener
//    becomes an Err (open::that_detached never reads the exit status, and
//    open::that can block indefinitely on a broken portal).
//  - All three /__open_external call sites must surface a non-OK response
//    as an error toast instead of swallowing it with console.warn only.
//  - The Linux target must declare the rfd gtk3 fallback for environments
//    without an XDG desktop portal.

const handlers = readFileSync(new URL("../../src-tauri/src/handlers.rs", import.meta.url), "utf8");
const cargoToml = readFileSync(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8");
const sharedEvents = readFileSync(new URL("../../src/web/js/events/shared.ts", import.meta.url), "utf8");
const readerRenderer = readFileSync(new URL("../../src/web/js/reader/renderer.ts", import.meta.url), "utf8");
const youglish = readFileSync(new URL("../../src/web/js/youglish.ts", import.meta.url), "utf8");

// The Linux opener lives in the open_external_url region of handlers.rs,
// bounded by the next top-level function.
function openExternalRegion(source) {
  const start = source.indexOf("pub(crate) fn open_external_url");
  const end = source.indexOf("pub(crate) fn parse_window_zoom_percent");
  assert.ok(start >= 0 && end > start, "handlers.rs structure changed — update the contract");
  return source.slice(start, end);
}

describe("issue #135 bullets 3+4: Linux open feedback + rfd fallback", () => {
  it("open_external_url spawns xdg-open and reaps it with a bounded wait and exit-status check", () => {
    const region = openExternalRegion(handlers);
    assert.match(region, /xdg-open/, "the Linux branch must spawn xdg-open");
    assert.match(region, /try_wait/, "the Linux branch must poll the child with try_wait");
    assert.match(region, /\.success\(\)/, "the Linux branch must check the child's exit status");
    assert.match(region, /kill\(\)/, "the Linux branch must kill the child when the deadline passes");
  });

  it("every /__open_external call site turns a non-OK response into an error toast", () => {
    for (const [name, source] of [
      ["src/web/js/events/shared.ts", sharedEvents],
      ["src/web/js/reader/renderer.ts", readerRenderer],
      ["src/web/js/youglish.ts", youglish]
    ]) {
      assert.match(source, /__open_external[\s\S]*?res\.ok/, `${name}: /__open_external must check res.ok`);
      assert.match(source, /__open_external[\s\S]*?showToast/, `${name}: /__open_external failure must show a toast`);
      assert.match(source, /__open_external[\s\S]*?toast\.openExternalFailed/, `${name}: /__open_external failure must use toast.openExternalFailed`);
    }
  });

  it("declares the rfd gtk3 fallback for the Linux target", () => {
    assert.match(
      cargoToml,
      /\[target\.[^\]]*target_os = "linux"[^\]]*\]\n(?:(?!\[target\.)[\s\S])*?rfd = \{[^}]*gtk3/,
      "the Linux target section must enable the rfd gtk3 feature"
    );
  });
});
