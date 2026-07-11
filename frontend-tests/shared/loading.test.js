import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { beginElementBusy, setElementBusy, withElementBusy } = await import("../../src/web/js/loading.js");

function fakeElement({ disabled = false } = {}) {
  const classes = new Set();
  const attributes = new Map();
  return {
    disabled,
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); }
  };
}

describe("loading state", () => {
  it("keeps the application disabled state separate from transient busy state", () => {
    const enabled = fakeElement();
    setElementBusy(enabled, true, { disable: true });
    assert.equal(enabled.disabled, false);
    assert.equal(enabled.hasAttribute("inert"), true);
    assert.equal(enabled.getAttribute("aria-disabled"), "true");
    assert.equal(enabled.getAttribute("aria-busy"), "true");
    enabled.disabled = true;
    setElementBusy(enabled, false, { disable: true });
    assert.equal(enabled.disabled, true);
    assert.equal(enabled.hasAttribute("inert"), false);
    assert.equal(enabled.getAttribute("aria-disabled"), null);
    assert.equal(enabled.getAttribute("aria-busy"), null);

    const disabled = fakeElement({ disabled: true });
    setElementBusy(disabled, true, { disable: true });
    setElementBusy(disabled, false, { disable: true });
    assert.equal(disabled.disabled, true);
  });

  it("keeps an element busy until overlapping operations finish", () => {
    const element = fakeElement();
    const releaseFirst = beginElementBusy(element, { disable: true });
    const releaseSecond = beginElementBusy(element);

    releaseFirst();
    assert.equal(element.classList.contains("is-busy"), true);
    assert.equal(element.getAttribute("aria-busy"), "true");
    assert.equal(element.disabled, false);
    assert.equal(element.hasAttribute("inert"), false);

    releaseSecond();
    assert.equal(element.classList.contains("is-busy"), false);
    assert.equal(element.getAttribute("aria-busy"), null);
  });

  it("treats repeated set calls as one idempotent busy state", () => {
    const element = fakeElement();
    setElementBusy(element, true);
    setElementBusy(element, true);
    setElementBusy(element, false);
    assert.equal(element.classList.contains("is-busy"), false);
    assert.equal(element.getAttribute("aria-busy"), null);
  });

  it("cleans up after a rejected operation", async () => {
    const element = fakeElement();
    await assert.rejects(
      withElementBusy(element, async () => { throw new Error("failed"); }, { disable: true }),
      /failed/
    );
    assert.equal(element.disabled, false);
    assert.equal(element.classList.contains("is-busy"), false);
    assert.equal(element.getAttribute("aria-busy"), null);
  });

  it("keeps long-running status visible and respects reduced motion", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
    const bookImport = readFileSync(new URL("../../src/web/js/events/book-import.js", import.meta.url), "utf8");
    const reducedMotion = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));

    for (const id of ["translator-status", "discover-status", "sync-status"]) {
      assert.match(html, new RegExp(`id="${id}"[^>]*role="status"[^>]*aria-live="polite"`));
    }
    assert.match(styles, /\.book-grid\[aria-busy="true"\]::after/);
    assert.match(reducedMotion, /html\.app-booting body::after/);
    assert.match(reducedMotion, /\.book-grid\[aria-busy="true"\]::after/);
    assert.match(bookImport, /id="ocr-progress-eta" aria-hidden="true"/);
  });
});
