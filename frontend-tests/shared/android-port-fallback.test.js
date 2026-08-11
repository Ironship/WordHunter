import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = process.env.WORDHUNTER_TEST_ROOT || defaultRoot;
const androidSource = readFileSync(resolve(root, "src-tauri/src/platform/android.rs"), "utf8");

describe("Android backend port fallback", () => {
  it("retries the bounded fallback range when the preferred port cannot bind", () => {
    assert.match(androidSource, /let mut port = ANDROID_SERVER_PORT;/);
    assert.match(androidSource, /port < ANDROID_SERVER_PORT \+ 10/);
    assert.match(androidSource, /port \+= 1;/);
  });

  it("opens the webview on the port that actually bound", () => {
    assert.match(androidSource, /let actual_port = loop/);
    assert.match(androidSource, /Ok\(bound\)\s*=>\s*break bound/);
    assert.match(
      androidSource,
      /WebviewUrl::External\([\s\S]*127\.0\.0\.1:\{actual_port\}\/index\.html/,
    );
  });
});
