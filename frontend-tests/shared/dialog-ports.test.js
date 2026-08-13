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
  const mainPanel = {
    isElement: true,
    id: "main-panel",
    className: "main-panel",
    children: [],
    appendChild(child) { this.children.push(child); registry.set(child.id, child); }
  };
  const makeElement = () => ({
    isDialog: true,
    isElement: true,
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
    mainPanel,
    getElementById(id) { return registry.get(id) ?? null; },
    createElement() { return makeElement(); },
    querySelector(selector) {
      return selector === "main.main-panel" ? mainPanel : null;
    },
    body: { appendChild(element) { bodyChildren.push(element); registry.set(element.id, element); } }
  };
}


/** Minimal recording DOM for the library panel renderer: #library-view with
 *  a workspace grid holding a static import panel; insertBefore/appendChild
 *  tracking preserves section -> resizer -> import-panel order. */
function fakeLibraryDocument() {
  const registry = new Map();
  const makeElement = (tagName = "div") => ({
    tagName,
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
    appendChild(child) { this.children.push(child); registry.set(child.id, child); },
    insertBefore(child, before) {
      const idx = this.children.indexOf(before);
      if (idx === -1) this.children.push(child);
      else this.children.splice(idx, 0, child);
      registry.set(child.id, child);
    },
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); },
    querySelector(selector) {
      if (selector.startsWith(".")) {
        return this.children.find((child) => child.className && child.className.split(" ").includes(selector.slice(1))) ?? null;
      }
      return this.children.find((child) => child.id === selector.slice(1)) ?? null;
    }
  });
  const view = makeElement("section");
  view.id = "library-view";
  const grid = makeElement("div");
  grid.className = "workspace-grid library-layout";
  const importPanel = makeElement("aside");
  importPanel.className = "panel import-panel";
  grid.children.push(importPanel);
  view.children.push(grid);
  registry.set("library-view", view);
  return {
    registry,
    gridChildren: grid.children,
    getElementById(id) { return registry.get(id) ?? null; },
    querySelector(selector) {
      if (selector === ".library-panel") {
        return [...registry.values()].find((element) => element.className && element.className.split(" ").includes("library-panel")) ?? null;
      }
      return registry.get(selector.slice(1)) ?? null;
    },
    createElement(tagName) { return makeElement(tagName); },
    body: { appendChild(element) { registry.set(element.id, element); } }
  };
}

const HTMLDialogElementInstance = {
  [Symbol.hasInstance](value) { return value?.isDialog === true; }
};

const tIdentity = { t: (key) => key };

const HTMLElementInstance = {
  [Symbol.hasInstance](value) { return value?.isElement === true; }
};

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
      "../platform.js": { openAndroidUrl: () => false },
      "../toast.js": { showToast: () => {} },
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

describe("argos download dialog renderer (events/settings.ts)", () => {
  it("builds the dialog once with the audited ids and i18n attributes", async () => {
    const document = fakeDocument();
    const { renderArgosDownloadDialog } = await evaluateWithMocks("dist/web/js/events/settings.js", {
      "../state.js": {
        applyBridgeSnapshotToState: () => false,
        flushAllPendingFrontendState: async () => {},
        getDurableStateRevision: () => 0,
        runExclusiveStateWrite: async (fn) => fn(),
        state: {},
        saveState: async () => {},
        switchLearningLanguage: () => {}
      },
      "../dom.js": { els: {} },
      "../i18n.js": { t: (key) => key, loadLocale: async () => {}, applyTranslations: () => {} },
      "../render.js": { render: () => {} },
      "../views/library.js": { renderLibrary: () => {} },
      "../reader/renderer.js": { getTextById: () => null, renderReader: () => {} },
      "../reader/word-panel.js": { renderWordPanel: () => {} },
      "../views/vocabulary.js": { renderReview: () => {} },
      "../views/discover.js": { renderDiscover: () => {} },
      "../preferences.js": {
        applyPreferences: () => {},
        syncSettingsControls: () => {},
        updatePreferenceValue: async () => {},
        resetPreferences: async () => {},
        setReaderFontSize: () => {},
        setUiScale: () => {}
      },
      "../toast.js": { showToast: () => {} },
      "../sync-actions.js": {
        clearWords: async () => {},
        clearLibrary: async () => {},
        exportAnkiTsv: async () => {},
        importAnkiTsv: async () => {},
        exportTransfer: async () => {},
        importTransfer: async () => {}
      },
      "../store-bridge.js": { acknowledgeBackendSnapshot: () => {}, loadBackendSnapshot: async () => {} },
      "../dialog-backdrop.js": { registerUnsavedDialog: () => {}, showConfirmDialog: async () => true },
      "../loading.js": { setElementBusy: () => {} },
      "../platform.js": { applyPlatformUi: () => {}, isAndroidPlatform: () => false },
      "../constants.js": { OFFLINE_TRANSLATOR_LANGUAGES: ["en", "pl", "de", "es", "fr", "zh"] },
      "../translator-preferences.js": {
        normalizeTranslationLanguageCode: (value) => value,
        normalizeTranslatorTextPreference: (key, value) => value,
        resolveProfileTranslationPair: () => ({ fromCode: "en", toCode: "pl", configured: true })
      },
      "../ai-explainer.js": { normalizeAiTextPreference: (value) => value },
      "../state/normalize.js": { normalizeSelectedWordPanelItems: (items) => items },
      "../reader/bookmarks.js": { remapReaderBookmarksForAlgorithm: (bookmarks) => bookmarks }
    }, { document, HTMLDialogElement: HTMLDialogElementInstance });

    const dialog = renderArgosDownloadDialog();
    assert.equal(dialog.id, "argos-download-dialog");
    assert.equal(dialog.className, "panel dialog-500");
    assert.equal(dialog.attrs["aria-labelledby"], "argos-download-title");
    assert.equal(document.bodyChildren.length, 1);
    for (const id of [
      "argos-download-title",
      "argos-languages-list",
      "argos-download-cancel",
      "argos-download-confirm"
    ]) {
      assert.match(dialog.innerHTML, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.match(dialog.innerHTML, /data-i18n="settings\.argosDownloadTitle"/);
    assert.match(dialog.innerHTML, /data-i18n="settings\.argosDownloadConfirm"/);
    assert.match(dialog.innerHTML, /data-i18n="languages\.en"/);
    assert.equal(renderArgosDownloadDialog(), dialog, "render must be idempotent");
    assert.equal(document.bodyChildren.length, 1);
  });

  it("keeps the dialog out of static HTML and renders it before cacheElements", () => {
    assertBootOrder("renderArgosDownloadDialog();", "argos-download-dialog");
  });
});

describe("edit-book dialog renderer (book-actions/edit-modal.ts)", () => {
  it("builds the dialog once with the audited ids and i18n attributes", async () => {
    const document = fakeDocument();
    const { renderEditBookDialog } = await evaluateWithMocks("dist/web/js/book-actions/edit-modal.js", {
      "../state.js": { state: {} },
      "../toast.js": { showToast: () => {} },
      "../books.js": { bookTexts: new Map(), findBookById: () => null, loadCustomTextContent: async () => "" },
      "../vocab-index-client.js": { invalidateBookId: () => {} },
      "../utils.js": { formatTagList: () => "", parseTagList: () => [] },
      "../i18n.js": { t: (key) => key },
      "../views/library.js": { renderLibrary: () => {} },
      "../reader/renderer.js": { renderReader: () => {} },
      "../bridge-commit.js": { reloadBridgeSnapshot: async () => {}, saveStateAndReloadBridge: async () => {} },
      "../store-bridge.js": { upsertStoredText: async () => {} }
    }, { document, HTMLDialogElement: HTMLDialogElementInstance });

    const dialog = renderEditBookDialog();
    assert.equal(dialog.id, "edit-book-dialog");
    assert.equal(dialog.className, "panel edit-book-dialog");
    assert.equal(dialog.attrs["aria-labelledby"], "edit-book-title-heading");
    assert.equal(document.bodyChildren.length, 1);
    for (const id of [
      "edit-book-title-heading",
      "edit-book-title",
      "edit-book-author",
      "edit-book-tags",
      "edit-book-level",
      "edit-book-cover-preview",
      "edit-book-cover-img",
      "edit-book-cover-clear",
      "edit-book-cover-dropzone",
      "edit-book-cover",
      "edit-book-text",
      "edit-book-cancel",
      "edit-book-save"
    ]) {
      assert.match(dialog.innerHTML, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.match(dialog.innerHTML, /data-i18n="editBook\.title"/);
    assert.match(dialog.innerHTML, /data-i18n-attr="placeholder=import\.tagsPlaceholder"/);
    assert.equal(renderEditBookDialog(), dialog, "render must be idempotent");
    assert.equal(document.bodyChildren.length, 1);
  });

  it("keeps the dialog out of static HTML and renders it before cacheElements", () => {
    assertBootOrder("renderEditBookDialog();", "edit-book-dialog");
  });
});

describe("library filter bar renderer (views/library.ts)", () => {
  it("builds the library panel once with the audited ids and i18n attributes", async () => {
    const document = fakeLibraryDocument();
    const { renderLibraryPanel } = await evaluateWithMocks("dist/web/js/views/library.js", {
      "../state.js": { state: {}, saveUiState: async () => {} },
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
      "../platform.js": { openAndroidUrl: () => false },
      "../toast.js": { showToast: () => {} },
      "../translator-preferences.js": { effectiveLearningLanguage: () => "en" }
    }, { document, HTMLDialogElement: HTMLDialogElementInstance });

    const section = renderLibraryPanel();
    assert.equal(section.tagName, "section");
    assert.equal(section.className, "panel library-panel library-filters-collapsed");
    assert.equal(section.attrs["aria-labelledby"], "library-heading");
    for (const id of [
      "library-heading",
      "library-filters-toggle",
      "library-filters",
      "library-search",
      "level-filter",
      "library-archive-filter",
      "library-sort",
      "library-sort-reverse",
      "library-import-toggle",
      "book-list"
    ]) {
      assert.match(section.innerHTML, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.match(section.innerHTML, /data-i18n="library\.search"/);
    assert.match(section.innerHTML, /data-i18n-attr="placeholder=library\.searchPlaceholder"/);
    assert.match(section.innerHTML, /data-i18n-attr="title=library\.showFilters,aria-label=library\.showFilters"/);
    assert.match(section.innerHTML, /aria-controls="library-filters"/);
    const resizer = document.registry.get("library-sidebar-resizer");
    assert.ok(resizer, "sidebar resizer must be rendered");
    assert.equal(resizer.className, "panel-sidebar-resizer");
    assert.equal(resizer.attrs["role"], "separator");
    assert.equal(resizer.attrs["aria-orientation"], "vertical");
    assert.equal(resizer.attrs["data-i18n-attr"], "aria-label=library.resizeImportPanel");
    assert.equal(document.gridChildren.length, 3, "section + resizer must be inserted before the import panel");
    assert.equal(document.gridChildren[0], section);
    assert.equal(document.gridChildren[1], resizer);
    assert.equal(renderLibraryPanel(), section, "render must be idempotent");
    assert.equal(document.gridChildren.length, 3);
  });

  it("keeps the filter bar out of static HTML and renders it before cacheElements", () => {
    assertBootOrder("renderLibraryPanel();", "library-filters-toggle", "button");
  });
});

describe("import panel renderer (events/book-import.ts)", () => {
  it("builds the panel once with the audited ids and i18n attributes", async () => {
    const document = fakeDocument();
    const layoutHost = {
      children: [],
      appendChild(child) {
        document.bodyChildren.push(child);
        document.registry.set(child.id, child);
      }
    };
    document.querySelector = (selector) => selector === ".workspace-grid.library-layout" ? layoutHost : null;
    const { renderImportPanel } = await evaluateWithMocks("dist/web/js/events/book-import.js", {
      "../state.js": { state: {} },
      "../i18n.js": { t: (key) => key },
      "../toast.js": { showToast: () => {} },
      "../platform.js": { isAndroidPlatform: () => false, isImageOcrAvailable: () => true },
      "../request.js": { fetchWithTimeout: async () => ({ ok: false }) },
      "../subtitles.js": {
        decodeImportedTextBytes: () => "",
        parseImportedTextFile: () => "",
        titleFromImportedFileName: () => ""
      },
      "../book-actions.js": {
        cancelEditBook: () => {},
        importCustomText: async () => null,
        isEditBookDirty: () => false,
        pasteImageToEditBook: () => {},
        saveEditedBook: () => {}
      },
      "../dialog-backdrop.js": { registerUnsavedDialog: () => {} },
      "../loading.js": { beginElementBusy: () => () => {}, setElementBusy: () => {} },
      "../store-bridge.js": { deleteStoredText: async () => {} },
      "../translator-preferences.js": { effectiveLearningLanguage: () => "en" },
      "../ocr-image-format.js": { isOcrImageFile: () => false, validatedOcrImageFormat: () => null }
    }, { document, HTMLElement: HTMLDialogElementInstance });

    const panel = renderImportPanel();
    assert.equal(panel.id, "import-panel");
    assert.equal(panel.className, "panel import-panel");
    assert.equal(panel.attrs["aria-labelledby"], "import-heading");
    assert.equal(document.bodyChildren.length, 1);
    for (const id of [
      "import-heading",
      "library-import-close",
      "import-mode-select",
      "import-books-mode",
      "import-form",
      "import-file",
      "import-file-hint",
      "import-title",
      "import-author",
      "import-tags",
      "import-level",
      "import-text",
      "import-cover-dropzone",
      "import-cover",
      "import-cover-preview",
      "import-cover-img",
      "import-cover-clear",
      "import-submit",
      "import-youtube-mode",
      "youtube-import-heading",
      "import-youtube-url",
      "import-youtube-track",
      "import-youtube-load",
      "import-youtube-status"
    ]) {
      assert.match(panel.innerHTML, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.match(panel.innerHTML, /data-i18n="import\.heading"/);
    assert.match(panel.innerHTML, /data-i18n-attr="placeholder=import\.titlePlaceholder"/);
    assert.match(panel.innerHTML, /data-i18n="import\.youtubeLoad"/);
    assert.equal(renderImportPanel(), panel, "render must be idempotent");
    assert.equal(document.bodyChildren.length, 1);
  });

  it("keeps the panel out of static HTML and renders it before cacheElements", () => {
    assertBootOrder("renderImportPanel();", "import-panel", "aside");
    assert.doesNotMatch(read("dist/web/index.html"), /class="panel import-panel"/);
  });
});

describe("settings view renderer (events/settings.ts)", () => {
  it("builds the settings view once with the audited ids and i18n attributes", async () => {
    const document = fakeDocument();
    const { renderSettingsView } = await evaluateWithMocks("dist/web/js/events/settings.js", {
      "../state.js": {
        applyBridgeSnapshotToState: () => false,
        flushAllPendingFrontendState: async () => {},
        getDurableStateRevision: () => 0,
        runExclusiveStateWrite: async (fn) => fn(),
        state: {},
        saveState: async () => {},
        switchLearningLanguage: () => {}
      },
      "../dom.js": { els: {} },
      "../i18n.js": { t: (key) => key, loadLocale: async () => {}, applyTranslations: () => {} },
      "../render.js": { render: () => {} },
      "../views/library.js": { renderLibrary: () => {} },
      "../reader/renderer.js": { getTextById: () => null, renderReader: () => {} },
      "../reader/word-panel.js": { renderWordPanel: () => {} },
      "../views/vocabulary.js": { renderReview: () => {} },
      "../views/discover.js": { renderDiscover: () => {} },
      "../preferences.js": {
        applyPreferences: () => {},
        syncSettingsControls: () => {},
        updatePreferenceValue: async () => {},
        resetPreferences: async () => {},
        setReaderFontSize: () => {},
        setUiScale: () => {}
      },
      "../toast.js": { showToast: () => {} },
      "../sync-actions.js": {
        clearWords: async () => {},
        clearLibrary: async () => {},
        exportAnkiTsv: async () => {},
        importAnkiTsv: async () => {},
        exportTransfer: async () => {},
        importTransfer: async () => {}
      },
      "../store-bridge.js": { acknowledgeBackendSnapshot: () => {}, loadBackendSnapshot: async () => {} },
      "../dialog-backdrop.js": { registerUnsavedDialog: () => {}, showConfirmDialog: async () => true },
      "../loading.js": { setElementBusy: () => {} },
      "../platform.js": { applyPlatformUi: () => {}, isAndroidPlatform: () => false },
      "../constants.js": { OFFLINE_TRANSLATOR_LANGUAGES: ["en", "pl", "de", "es", "fr", "zh"] },
      "../translator-preferences.js": {
        normalizeTranslationLanguageCode: (value) => value,
        normalizeTranslatorTextPreference: (key, value) => value,
        resolveProfileTranslationPair: () => ({ fromCode: "en", toCode: "pl", configured: true })
      },
      "../ai-explainer.js": { normalizeAiTextPreference: (value) => value },
      "../state/normalize.js": { normalizeSelectedWordPanelItems: (items) => items },
      "../reader/bookmarks.js": { remapReaderBookmarksForAlgorithm: (bookmarks) => bookmarks }
    }, { document, HTMLElement: HTMLElementInstance });

    const view = renderSettingsView();
    assert.equal(view.id, "settings-view");
    assert.equal(view.className, "view");
    assert.equal(view.attrs["data-title-key"], "nav.settings");
    // The settings view must mount inside .main-panel (sibling of the other
    // views), NOT document.body — body mounting puts it below the fold and
    // makes the tab look empty until the user scrolls (issue #127 P3 fix).
    assert.equal(document.mainPanel.children.length, 1);
    assert.equal(document.mainPanel.children[0], view);
    assert.equal(document.bodyChildren.length, 0);
    // Shell + all settings panels built by renderSettingsView(): Appearance,
    // Flashcards, Reader, Translator & Dictionary, AI, Local data (#127 P3).
    for (const id of [
      "appearance-heading",
      "pref-theme",
      "pref-locale-settings",
      "pref-learning-language-settings",
      "pref-ui-scale-label",
      "pref-ui-scale",
      "pref-touch-controls",
      "pref-review-graph-type",
      "pref-color-new",
      "pref-color-learning",
      "pref-color-known",
      "pref-color-ignored",
      "pref-dynamic-learning-colors",
      "pref-learning-colors-row",
      "pref-card-stats",
      "pref-card-stats-mode-row",
      "pref-card-stats-mode",
      "pref-covers",
      "ocr-gpu-status",
      "flashcard-prefs-heading",
      "pref-auto-add-learning",
      "pref-auto-tts-on-flashcard-open",
      "pref-in-text-review",
      "pref-srs-algorithm",
      "pref-removal-behavior",
      "reader-prefs-heading",
      "pref-font",
      "pref-line-height",
      "pref-text-align",
      "pref-max-width",
      "pref-reader-focus-mode",
      "pref-reader-word-panel-visible",
      "word-panel-items-heading",
      "word-panel-items-hint",
      "pref-selected-word-panel-items",
      "pref-words-per-page",
      "pref-word-algorithm",
      "pref-font-size-label",
      "pref-font-size",
      "pref-highlight",
      "pref-hide-known",
      "pref-auto-learn",
      "pref-status-sounds-enabled",
      "pref-status-sound-volume-label",
      "pref-status-sound-volume",
      "pref-tts-rate",
      "pref-auto-tts-on-word-focus",
      "pref-tts-word-highlight",
      "pref-use-edge-tts",
      "translator-prefs-heading",
      "pref-translation-language-settings",
      "pref-translation-source-language",
      "pref-translation-target-language",
      "translation-language-codes",
      "pref-offline-translator",
      "pref-translation-provider",
      "pref-deepl-key-row",
      "pref-deepl-api-key",
      "pref-lmstudio-endpoint-row",
      "pref-lmstudio-endpoint",
      "pref-lmstudio-model-row",
      "pref-lmstudio-model",
      "pref-auto-translate-row",
      "pref-auto-translate",
      "pref-argos-as-dict-row",
      "pref-argos-as-dict",
      "pref-dictionary-mode",
      "pref-youglish-mode",
      "pref-dictionary-url",
      "ai-prefs-heading",
      "pref-ai-explanations",
      "pref-ai-endpoint-row",
      "pref-ai-endpoint",
      "pref-ai-model-row",
      "pref-ai-model",
      "pref-ai-key-row",
      "pref-ai-api-key",
      "pref-ai-effort-row",
      "pref-ai-effort",
      "pref-ai-auto-trigger-row",
      "pref-ai-auto-trigger",
      "data-heading",
      "storage-summary",
      "data-directory",
      "choose-data-directory",
      "recovery-status-panel",
      "recovery-status-list",
      "check-updates",
      "reset-prefs"
    ]) {
      assert.match(view.innerHTML, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.match(view.innerHTML, /data-i18n="settings\.appearanceHeading"/);
    assert.match(view.innerHTML, /data-i18n-attr="aria-label=settings\.interfaceLanguageTitle"/);
    assert.match(view.innerHTML, /data-i18n="settings\.groupLocalData"/);
    assert.match(view.innerHTML, /data-i18n="settings\.resetPrefs"/);
    assert.match(view.innerHTML, /data-i18n="settings\.readerEyebrow"/);
    assert.match(view.innerHTML, /data-i18n="settings\.translatorEyebrow"/);
    assert.match(view.innerHTML, /id="pref-offline-translator"/);
    assert.match(view.innerHTML, /id="pref-font"/);
    assert.equal(renderSettingsView(), view, "render must be idempotent");
    assert.equal(document.mainPanel.children.length, 1);
  });

  it("toggles the AI API-key row by the id the settings markup actually uses", () => {
    // Regression (2026-08-13): the row is #pref-ai-key-row in the markup,
    // but preferences.ts toggled the stale #pref-ai-api-key-row, so the API
    // key field stayed hidden forever and AI explanations could never be
    // configured. Pin both sides of the contract.
    const prefs = readFileSync(new URL("../../dist/web/js/preferences.js", import.meta.url), "utf8");
    assert.match(prefs, /"pref-ai-key-row"/, "preferences.js must target #pref-ai-key-row");
    assert.doesNotMatch(prefs, /"pref-ai-api-key-row"/, "stale #pref-ai-api-key-row reference");
  });

  it("keeps the settings view out of static HTML and renders it before cacheElements", () => {
    const html = read("dist/web/index.html");
    const app = read("dist/web/app.js");
    assert.doesNotMatch(html, /<section class="view" id="settings-view"/);
    const renderAt = app.indexOf("renderSettingsView();");
    const cacheAt = app.indexOf("cacheElements();");
    assert.ok(renderAt >= 0, "renderSettingsView() must be called in app boot");
    assert.ok(cacheAt >= 0, "cacheElements() must exist in app boot");
    assert.ok(renderAt < cacheAt, "renderSettingsView() must run before cacheElements()");
  });
});
