import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function stubElement(id, extra = {}) {
  const listeners = {};
  return Object.assign({
    id,
    dataset: {},
    textContent: "",
    title: "",
    hidden: false,
    value: "",
    listeners,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    addEventListener(type, handler) {
      (listeners[type] = listeners[type] || []).push(handler);
    },
    click(type = "click") {
      for (const handler of listeners[type] || []) handler({});
    }
  }, extra);
}

async function loadLibraryView({ removeCustomText }) {
  const calls = [];
  let shownCount = 0;
  let closedCount = 0;

  const deleteDialog = stubElement("delete-book-dialog", {
    showModal() { shownCount += 1; },
    close() { closedCount += 1; }
  });
  const deleteTitle = stubElement("delete-book-title");
  const deleteMessage = stubElement("delete-book-message");
  const deleteCancel = stubElement("delete-book-cancel");
  const deleteConfirm = stubElement("delete-book-confirm");
  const bookList = stubElement("book-list");

  const documentElement = { dataset: {}, classList: { toggle() {}, contains: () => false } };
  const elementById = {
    "delete-book-dialog": deleteDialog,
    "delete-book-title": deleteTitle,
    "delete-book-message": deleteMessage,
    "delete-book-cancel": deleteCancel,
    "delete-book-confirm": deleteConfirm,
    "book-list": bookList
  };
  const document = {
    documentElement,
    getElementById: (id) => elementById[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}
  };

  const state = {
    currentView: "library",
    filters: {},
    customTexts: [{ id: "text-1", title: "Imported book" }],
    profiles: {}
  };

  const noOp = () => {};
  const ContextElement = class Element {};
  const context = vm.createContext({
    window: { __qtBridge: false },
    document,
    console,
    Element: ContextElement,
    setTimeout,
    clearTimeout
  });
  const importValues = {
    "../state.js": { state, saveUiState: noOp },
    "../utils.js": {
      escapeHtml: (value) => String(value),
      escapeAttribute: (value) => String(value),
      parseTagList: () => [],
      calcRoundedStatsPcts: () => [],
      calcStatsPcts: () => ({})
    },
    "../icons.js": { icon: () => "", renderCardStat: () => "", renderCardCount: () => "" },
    "../tokenizer_v2.js": { normalizeSearchVariants: (value) => value },
    "../books.js": {
      findBookById: () => null,
      getAllBooks: () => [],
      bookTexts: new Map(),
      getLibraryContentGeneration: () => 0,
      hydrateActiveLibraryTexts: async () => {},
      isBookTextCacheStale: () => false,
      loadBookText: async () => "",
      loadCustomTextContent: async () => ""
    },
    "../stats-cache.js": { getCachedBookTextStats: () => null, getCachedTextStats: () => null, prepareTextStats: () => null },
    "../i18n.js": { t: (key) => key, getLocale: () => "en" },
    "../panel-resizer.js": { bindSidebarResizer: noOp },
    "../translator-preferences.js": { effectiveLearningLanguage: () => "en" },
    "../platform.js": { openAndroidUrl: () => false },
    "../toast.js": { showToast(message) { calls.push(`toast:${message}`); } },
    "../loading.js": {
      beginElementBusy(element, options) {
        calls.push(`busy:${element.id}:${options?.disable ? "disable" : "plain"}`);
        return () => calls.push(`release:${element.id}`);
      }
    }
  };
  const modules = new Map(Object.entries(importValues).map(([specifier, values]) => [
    specifier,
    new vm.SyntheticModule(Object.keys(values), function initialize() {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context, identifier: `mock:${specifier}` })
  ]));
  modules.set("../book-actions.js", new vm.SyntheticModule(
    ["removeCustomText"],
    function initialize() {
      this.setExport("removeCustomText", removeCustomText);
    },
    { context, identifier: "mock:../book-actions.js" }
  ));
  const source = new vm.SourceTextModule(
    readFileSync(new URL("../../dist/web/js/views/library.js", import.meta.url), "utf8"),
    {
      context,
      identifier: "library-view-under-test",
      importModuleDynamically: async (specifier) => {
        const dependency = modules.get(specifier);
        assert.ok(dependency, `unexpected dynamic import ${specifier}`);
        if (dependency.status === "unlinked") await dependency.link(() => {});
        if (dependency.status === "linked") await dependency.evaluate();
        return dependency;
      }
    }
  );
  await source.link((specifier) => {
    if (!modules.has(specifier)) throw new Error(`unexpected import ${specifier}`);
    return modules.get(specifier);
  });
  await source.evaluate();
  source.namespace.bindLibraryEvents();

  // Dispatch a card-menu click for the custom text through #book-list:
  async function requestRemovalViaCardMenu() {
    const control = stubElement("menu-item");
    control.dataset.action = "remove-custom";
    control.dataset.id = "text-1";
    control.closest = () => control;
    const target = new ContextElement();
    target.closest = () => control;
    for (const handler of bookList.listeners.click || []) await handler({ target });
  }

  return {
    calls,
    state,
    deleteDialog,
    deleteTitle,
    deleteConfirm,
    deleteCancel,
    shown: () => shownCount,
    closed: () => closedCount,
    confirmClick: () => { for (const handler of deleteConfirm.listeners.click || []) handler({}); },
    cancelClick: () => { for (const handler of deleteCancel.listeners.click || []) handler({}); },
    requestRemovalViaCardMenu
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  await Promise.resolve();
}

describe("delete book busy indicator", () => {
  it("keeps the confirm dialog open with a busy indicator until removal settles", async () => {
    let releaseRemoval;
    const removalPromise = new Promise((resolve) => { releaseRemoval = resolve; });
    const harness = await loadLibraryView({
      removeCustomText() {
        harness.calls.push("removed");
        return removalPromise;
      }
    });

    assert.equal(harness.shown(), 0);

    await harness.requestRemovalViaCardMenu();

    assert.equal(harness.shown(), 1);
    assert.equal(harness.deleteTitle.textContent, "library.removeConfirmTitle");

    // Confirm: busy indicators start, dialog stays open while removal runs.
    harness.confirmClick();
    await Promise.resolve();
    assert.deepEqual(harness.calls.slice(-3), [
      "busy:delete-book-confirm:disable",
      "busy:delete-book-cancel:disable",
      "removed"
    ]);
    assert.equal(harness.closed(), 0);

    // Cancel/backdrop must not dismiss the pinned dialog mid-flight.
    harness.cancelClick();
    assert.equal(harness.closed(), 0);

    releaseRemoval();
    await settle();

    assert.deepEqual(harness.calls.slice(-2), [
      "release:delete-book-confirm",
      "release:delete-book-cancel"
    ]);
    assert.equal(harness.closed(), 1);
  });

  it("closes the dialog when the remover rejects and keeps the UI usable", async () => {
    const harness = await loadLibraryView({
      async removeCustomText() { throw new Error("disk full"); }
    });

    await harness.requestRemovalViaCardMenu();
    harness.confirmClick();
    await settle();

    assert.equal(harness.closed(), 1);
    assert.equal(harness.calls.includes("release:delete-book-confirm"), true);
    assert.equal(harness.calls.includes("release:delete-book-cancel"), true);
  });

  it("ignores repeated confirm clicks while a removal is already running", async () => {
    let releaseRemoval;
    const removalPromise = new Promise((resolve) => { releaseRemoval = resolve; });
    let removalCalls = 0;
    const harness = await loadLibraryView({
      removeCustomText() {
        removalCalls += 1;
        return removalPromise;
      }
    });

    await harness.requestRemovalViaCardMenu();
    harness.confirmClick();
    harness.confirmClick();
    harness.confirmClick();
    await Promise.resolve();

    assert.equal(removalCalls, 1);
    assert.equal(harness.closed(), 0);

    releaseRemoval();
    await settle();
    assert.equal(harness.closed(), 1);
  });
});
