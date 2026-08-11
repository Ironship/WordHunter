// #127 P1 part 1: the four self-contained dialogs ported from static
// index.html markup into TS renderers (bookmarks, move-book, delete-book,
// update). Each renderer runs during app boot before cacheElements()
// (app.ts), so every boot-time consumer finds its elements in the DOM.
//
// Per-dialog contracts:
//   - behavioral: renderXxxDialog() builds + appends the dialog once and is
//     idempotent, keeps the audited ids, and seeds data-i18n attributes for
//     the boot-time applyTranslations() pass;
//   - static: the dialog markup is gone from dist index.html and the boot
//     sequence renders it before cacheElements().
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

async function evaluateWithMocks(file, importValues, globals = {}) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, ...globals });
  const modules = new Map();
  for (const [specifier, values] of Object.entries(importValues)) {
    modules.set(specifier, new vm.SyntheticModule(
      Object.keys(values),
      function initialize() {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      },
      { context, identifier: `mock:${specifier}` }
    ));
  }
  const getModule = (specifier) => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `unexpected import ${specifier} from ${file}`);
    return dependency;
  };
  const module = new vm.SourceTextModule(read(file), {
    context,
    identifier: new URL(`../../${file}`, import.meta.url).href,
    importModuleDynamically: async (specifier) => {
      const dependency = getModule(specifier);
      if (dependency.status === "unlinked") await dependency.link(() => {});
      if (dependency.status === "linked") await dependency.evaluate();
      return dependency;
    }
  });
  await module.link(getModule);
  await module.evaluate();
  return module.namespace;
}

/** Minimal recording DOM: getElementById registry + appendChild tracking. */
function fakeDocument() {
  const registry = new Map();
  const bodyChildren = [];
  const makeElement = () => ({
    isDialog: true,
    id: "",
    className: "",
    innerHTML: "",
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    appendChild() {}
  });
  return {
    registry,
    bodyChildren,
    getElementById(id) { return registry.get(id) ?? null; },
    createElement() { return makeElement(); },
    body: { appendChild(element) { bodyChildren.push(element); registry.set(element.id, element); } }
  };
}

const HTMLDialogElementInstance = {
  [Symbol.hasInstance](value) { return value?.isDialog === true; }
};

const tIdentity = { t: (key) => key };

function assertBootOrder(rendererCall) {
  const html = read("../../dist/web/index.html");
  const app = read("../../dist/web/app.js");
  assert.doesNotMatch(html, /<dialog id="reader-bookmarks-dialog"/);
  const renderAt = app.indexOf(rendererCall);
  const cacheAt = app.indexOf("cacheElements();");
  assert.ok(renderAt >= 0, `${rendererCall} must be called in app boot`);
  assert.ok(cacheAt >= 0, "cacheElements() must exist in app boot");
  assert.ok(renderAt < cacheAt, `${rendererCall} must run before cacheElements()`);
}

describe("bookmarks dialog renderer (reader/bookmarks.ts)", () => {
  it("builds the dialog once with the audited ids and i18n attributes", async () => {
    const document = fakeDocument();
    const { renderBookmarksDialog } = await evaluateWithMocks("dist/web/js/reader/bookmarks.js", {
      "../state.js": {},
      "../i18n.js": tIdentity,
      "../utils.js": {},
      "./scroll.js": {},
      "./session.js": {},
      "../tokenizer_v2.js": {},
      "../translator-preferences.js": {},
      "./pdf-page-text.js": {}
    }, { document, HTMLDialogElement: HTMLDialogElementInstance });

    const dialog = renderBookmarksDialog();
    assert.equal(dialog.id, "reader-bookmarks-dialog");
    assert.equal(dialog.className, "panel reader-bookmarks-dialog");
    assert.equal(dialog.attrs["aria-labelledby"], "reader-bookmarks-title");
    assert.equal(document.bodyChildren.length, 1);
    for (const id of [
      "reader-bookmarks-title",
      "reader-bookmarks-close",
      "reader-bookmark-form",
      "reader-bookmark-label",
      "reader-bookmark-submit",
      "reader-bookmark-cancel-edit",
      "reader-bookmark-list"
    ]) {
      assert.match(dialog.innerHTML, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.match(dialog.innerHTML, /data-i18n="reader\.bookmarksTitle"/);
    assert.match(dialog.innerHTML, /data-i18n-attr="placeholder=reader\.bookmarkPlaceholder"/);
    assert.equal((dialog.innerHTML.match(/name="reader-bookmark-color"/g) || []).length, 5);
    assert.equal(renderBookmarksDialog(), dialog, "render must be idempotent");
    assert.equal(document.bodyChildren.length, 1);
  });

  it("keeps the dialog out of static HTML and renders it before cacheElements", () => {
    assertBootOrder("renderBookmarksDialog();");
  });
});
