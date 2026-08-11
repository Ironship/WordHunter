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
    textContent: "",
    type: "",
    children: [],
    listeners: {},
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    appendChild(child) { this.children.push(child); },
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); },
    querySelector(selector) {
      const id = selector.replace(/^#/, "");
      return this.children.find((child) => child.id === id) ?? null;
    }
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

function assertBootOrder(rendererCall, elementId, tag = "dialog") {
  const html = read("dist/web/index.html");
  const app = read("dist/web/app.js");
  assert.doesNotMatch(html, new RegExp(`<${tag} id="${elementId}"`));
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
      "../state.js": { state: {}, saveState: async () => {}, saveUiState: async () => {} },
      "../i18n.js": tIdentity,
      "../utils.js": { escapeAttribute: (value) => value, escapeHtml: (value) => value },
      "./scroll.js": { rememberReaderScrollPosition: () => {} },
      "./session.js": { getReaderSession: () => ({ tokens: [], globalWordIndexes: [], globalCharOffsets: [] }) },
      "../tokenizer_v2.js": { normalizeWord: (value) => value },
      "../translator-preferences.js": { effectiveLearningLanguage: () => "en" },
      "./pdf-page-text.js": { buildPdfDocumentText: () => "" }
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
    assertBootOrder("renderBookmarksDialog();", "reader-bookmarks-dialog");
  });
});

describe("move-book dialog renderer (events/move-book.ts)", () => {
  it("builds the dialog once with the audited ids and i18n attributes", async () => {
    const document = fakeDocument();
    const { renderMoveBookDialog } = await evaluateWithMocks("dist/web/js/events/move-book.js", {
      "../state.js": { state: { preferences: {} } },
      "../i18n.js": tIdentity,
      "../book-actions.js": { moveBookToProfile: async () => true },
      "../constants.js": { LEARNING_LANGUAGES: [] }
    }, { document, HTMLDialogElement: HTMLDialogElementInstance });

    const dialog = renderMoveBookDialog();
    assert.equal(dialog.id, "move-book-dialog");
    assert.equal(dialog.className, "panel");
    assert.equal(dialog.attrs["aria-labelledby"], "move-book-title");
    assert.equal(document.bodyChildren.length, 1);
    for (const id of ["move-book-title", "move-book-select", "move-book-cancel", "move-book-confirm"]) {
      assert.match(dialog.innerHTML, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.match(dialog.innerHTML, /data-i18n="moveBook\.title"/);
    assert.match(dialog.innerHTML, /data-i18n-attr="aria-label=library\.moveBook"/);
    assert.equal(renderMoveBookDialog(), dialog, "render must be idempotent");
    assert.equal(document.bodyChildren.length, 1);
  });

  it("keeps the dialog out of static HTML and renders it before cacheElements", () => {
    assertBootOrder("renderMoveBookDialog();", "move-book-dialog");
  });
});

describe("delete-book dialog renderer (views/library.ts)", () => {
  it("builds the dialog once with the audited ids and i18n attributes", async () => {
    const document = fakeDocument();
    const { renderDeleteBookDialog } = await evaluateWithMocks("dist/web/js/views/library.js", {
      "../state.js": { state: {}, saveUiState: async () => {} },
      "../dom.js": { els: {} },
      "../utils.js": {
        escapeHtml: (value) => value,
        escapeAttribute: (value) => value,
        parseTagList: () => [],
        calcRoundedStatsPcts: () => ({}),
        calcStatsPcts: () => ({})
      },
      "../icons.js": { icon: () => "", renderCardStat: () => "", renderCardCount: () => "" },
      "../tokenizer_v2.js": { normalizeSearchVariants: (value) => value },
      "../books.js": {
        findBookById: () => undefined,
        getAllBooks: () => [],
        bookTexts: new Map(),
        getLibraryContentGeneration: () => 0,
        hydrateActiveLibraryTexts: async () => {},
        isBookTextCacheStale: () => false,
        loadBookText: async () => "",
        loadCustomTextContent: async () => ""
      },
      "../stats-cache.js": {
        getCachedBookTextStats: () => null,
        getCachedTextStats: () => null,
        prepareTextStats: async () => null
      },
      "../i18n.js": { t: (key) => key, getLocale: () => "en" },
      "../panel-resizer.js": { bindSidebarResizer: () => {} },
      "../translator-preferences.js": { effectiveLearningLanguage: () => "en" }
    }, { document, HTMLDialogElement: HTMLDialogElementInstance });

    const dialog = renderDeleteBookDialog();
    assert.equal(dialog.id, "delete-book-dialog");
    assert.equal(dialog.className, "panel confirmation-dialog");
    assert.equal(dialog.attrs["aria-labelledby"], "delete-book-title");
    assert.equal(document.bodyChildren.length, 1);
    for (const id of ["delete-book-title", "delete-book-message", "delete-book-cancel", "delete-book-confirm"]) {
      assert.match(dialog.innerHTML, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.match(dialog.innerHTML, /data-i18n="library\.moveCancel"/);
    assert.match(dialog.innerHTML, /data-i18n="library\.removeConfirmButton"/);
    assert.equal(renderDeleteBookDialog(), dialog, "render must be idempotent");
    assert.equal(document.bodyChildren.length, 1);
  });

  it("keeps the dialog out of static HTML and renders it before cacheElements", () => {
    assertBootOrder("renderDeleteBookDialog();", "delete-book-dialog");
  });
});

describe("update dialog renderer (update-checker.ts)", () => {
  it("builds the dialog once with the audited ids and i18n attributes", async () => {
    const document = fakeDocument();
    const { renderUpdateDialog } = await evaluateWithMocks("dist/web/js/update-checker.js", {
      "./state.js": { state: {}, saveState: async () => {} },
      "./platform.js": { openAndroidUrl: () => false },
      "./i18n.js": tIdentity,
      "./toast.js": { showToast: () => {} }
    }, { document, HTMLDialogElement: HTMLDialogElementInstance });

    const dialog = renderUpdateDialog();
    assert.equal(dialog.id, "update-dialog");
    assert.equal(dialog.className, "panel dialog-500");
    assert.equal(dialog.attrs["aria-labelledby"], "update-title");
    assert.equal(document.bodyChildren.length, 1);
    for (const id of ["update-title", "update-message", "update-dismiss", "update-skip", "update-disable", "update-open"]) {
      assert.match(dialog.innerHTML, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.match(dialog.innerHTML, /data-i18n="update\.title"/);
    assert.match(dialog.innerHTML, /data-i18n="update\.openReleases"/);
    assert.equal(renderUpdateDialog(), dialog, "render must be idempotent");
    assert.equal(document.bodyChildren.length, 1);
  });

  it("keeps the dialog out of static HTML and renders it before cacheElements", () => {
    assertBootOrder("renderUpdateDialog();", "update-dialog");
  });
});

describe("toast renderer (toast.ts)", () => {
  it("builds the toast once with the audited ids, i18n attributes and close binding", async () => {
    const document = fakeDocument();
    const { renderToast } = await evaluateWithMocks("dist/web/js/toast.js", {}, { document, HTMLDialogElement: HTMLDialogElementInstance });

    const toast = renderToast();
    assert.equal(toast.id, "toast");
    assert.equal(toast.className, "toast");
    assert.equal(toast.attrs["role"], "status");
    assert.equal(document.bodyChildren.length, 1);
    assert.equal(toast.children.length, 2);
    assert.equal(toast.children[0].id, "toast-message");
    const close = toast.children[1];
    assert.equal(close.id, "toast-close");
    assert.equal(close.className, "toast-close");
    assert.equal(close.attrs["data-i18n-attr"], "aria-label=reader.close");
    assert.equal(typeof close.listeners.click?.[0], "function", "close button must hide the toast");
    assert.equal(renderToast(), toast, "render must be idempotent");
    assert.equal(document.bodyChildren.length, 1);
  });

  it("keeps the toast out of static HTML and renders it before cacheElements", () => {
    assertBootOrder("renderToast();", "toast", "div");
  });
});

describe("language-onboarding dialog renderer (onboarding.ts)", () => {
  it("builds the dialog once with the audited ids and i18n attributes", async () => {
    const document = fakeDocument();
    const { renderLanguageOnboardingDialog } = await evaluateWithMocks("dist/web/js/onboarding.js", {
      "./state.js": { state: { preferences: { locale: "en", learningLanguage: "de" } }, saveState: async () => {}, switchLearningLanguage: () => {} },
      "./i18n.js": { t: (key) => key, loadLocale: async () => {}, applyTranslations: () => {} },
      "./render.js": { render: () => {} },
      "./preferences.js": { applyPreferences: () => {}, syncSettingsControls: () => {} },
      "./platform.js": { applyPlatformUi: () => {} },
      "./toast.js": { showToast: () => {} }
    }, { document, HTMLDialogElement: HTMLDialogElementInstance });

    const dialog = renderLanguageOnboardingDialog();
    assert.equal(dialog.id, "language-onboarding-dialog");
    assert.equal(dialog.className, "panel language-onboarding-dialog");
    assert.equal(dialog.attrs["aria-labelledby"], "language-onboarding-title");
    assert.equal(document.bodyChildren.length, 1);
    for (const id of [
      "language-onboarding-title",
      "language-onboarding-done",
      "pref-locale-onboarding",
      "pref-learning-language-onboarding"
    ]) {
      assert.match(dialog.innerHTML, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.match(dialog.innerHTML, /data-i18n="onboarding\.languageHeading"/);
    assert.match(dialog.innerHTML, /data-i18n-attr="aria-label=settings\.interfaceLanguageTitle"/);
    assert.equal((dialog.innerHTML.match(/<option value="/g) || []).length, 23);
    assert.equal(renderLanguageOnboardingDialog(), dialog, "render must be idempotent");
    assert.equal(document.bodyChildren.length, 1);
  });

  it("keeps the dialog out of static HTML and renders it before cacheElements", () => {
    assertBootOrder("renderLanguageOnboardingDialog();", "language-onboarding-dialog");
  });
});
describe("add-word dialog renderer (events/word-editor.ts)", () => {
  it("builds the dialog once with the audited ids and i18n attributes", async () => {
    const document = fakeDocument();
    const { renderAddWordDialog } = await evaluateWithMocks("dist/web/js/events/word-editor.js", {
      "../state.js": { state: {}, saveState: async () => {} },
      "../i18n.js": tIdentity,
      "../toast.js": { showToast: () => {} },
      "../icons.js": { statusIcon: () => "" },
      "../constants.js": { STATUS_ORDER: ["new", "learning", "known", "ignored"] },
      "../utils.js": { statusLabel: (status) => status, escapeHtml: (value) => value, escapeAttribute: (value) => value },
      "../vocabulary/vocab-list.js": { invalidateVocabListCache: () => {} },
      "../views/vocabulary.js": { getOrCreateEntry: () => ({}), renderVocabulary: () => {} },
      "../vocabulary/entry-state.js": { setEntryStatus: () => "new" },
      "../status-sounds.js": { playStatusSound: () => {} },
      "../vocabulary/review-card.js": { invalidateReviewQueueCache: () => {} },
      "../reader/smart-suggest.js": { invalidateSuggestIndex: () => {} },
      "../dialog-backdrop.js": { registerUnsavedDialog: () => {} },
      "./vocab-status.js": { VOCAB_STATUS_FILTERS: [] }
    }, { document, HTMLDialogElement: HTMLDialogElementInstance });

    const dialog = renderAddWordDialog();
    assert.equal(dialog.id, "add-word-dialog");
    assert.equal(dialog.className, "panel word-editor-dialog dialog-680");
    assert.equal(dialog.attrs["aria-labelledby"], "add-word-dialog-title");
    assert.equal(document.bodyChildren.length, 1);
    for (const id of [
      "add-word-dialog-title",
      "add-word-input",
      "add-article-input",
      "add-translation-input",
      "add-word-status-buttons",
      "add-example-input",
      "add-word-cancel",
      "add-word-confirm",
      "add-word-editing"
    ]) {
      assert.match(dialog.innerHTML, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.match(dialog.innerHTML, /data-i18n="vocab\.addWordTitle"/);
    assert.match(dialog.innerHTML, /data-i18n="vocab\.addWordConfirm"/);
    assert.equal(renderAddWordDialog(), dialog, "render must be idempotent");
    assert.equal(document.bodyChildren.length, 1);
  });

  it("keeps the dialog out of static HTML and renders it before cacheElements", () => {
    assertBootOrder("renderAddWordDialog();", "add-word-dialog");
  });
});
