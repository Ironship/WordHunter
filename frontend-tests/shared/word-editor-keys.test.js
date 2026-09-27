// Add/Edit word dialog keyboard contract: digits 1-4 are typed text in the
// word, article, translation and example fields ("um 3 Uhr", "1st floor");
// they only pick the status while focus is outside those fields.
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

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add(name) { values.add(name); },
    remove(name) { values.delete(name); },
    contains(name) { return values.has(name); },
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name); else values.delete(name);
      return enabled;
    }
  };
}

async function wordEditorHarness() {
  const listeners = new Map();
  const target = (kind, extra = {}) => ({
    kind,
    value: "",
    addEventListener(type, listener) { listeners.set(`${kind}:${type}`, listener); },
    focus() {},
    ...extra
  });
  const dialog = target("dialog", { close() {}, showModal() {}, querySelector() { return null; } });
  const fields = {
    word: target("input"),
    article: target("input"),
    translation: target("input"),
    example: target("textarea")
  };
  const statusButtons = ["new", "learning", "known", "ignored"].map((status) => ({
    kind: "button",
    dataset: { addWordStatus: status },
    classList: classList(status === "new" ? ["active"] : []),
    setAttribute() {}
  }));
  const statusContainer = {
    innerHTML: "",
    querySelectorAll() { return statusButtons; }
  };
  const bySelector = {
    "#add-word-dialog": dialog,
    "#add-word-input": fields.word,
    "#add-article-input": fields.article,
    "#add-translation-input": fields.translation,
    "#add-example-input": fields.example,
    "#add-word-confirm": target("confirm", { click() {} }),
    "#add-word-cancel": target("cancel"),
    "#add-word-editing": target("hidden")
  };
  const kindClass = (...kinds) => class {
    static [Symbol.hasInstance](value) { return kinds.includes(value?.kind); }
  };
  const { bindWordEditorEvents } = await evaluateWithMocks("dist/web/js/events/word-editor.js", {
    "../state.js": { state: { vocab: {}, preferences: {} }, saveState: async () => {} },
    "../loading.js": { withElementBusy: async (_element, fn) => fn() },
    "../i18n.js": { t: (key) => key },
    "../toast.js": { showToast() {} },
    "../icons.js": { statusIcon: () => "" },
    "../constants.js": { STATUS_ORDER: ["new", "learning", "known", "ignored"] },
    "../utils.js": { statusLabel: (status) => status, escapeHtml: String, escapeAttribute: String, isWordHunterWowReadyForKnown: () => false },
    "../vocabulary/vocab-list.js": { invalidateVocabListCache() {} },
    "../views/vocabulary.js": { getOrCreateEntry: () => ({}), renderVocabulary() {} },
    "../vocabulary/entry-state.js": { setEntryStatus: () => "new" },
    "../status-sounds.js": { playStatusSound() {} },
    "../vocabulary/review-card.js": { invalidateReviewQueueCache() {} },
    "../reader/smart-suggest.js": { invalidateSuggestIndex() {} },
    "../dialog-backdrop.js": { registerUnsavedDialog() {} },
    "./vocab-status.js": { VOCAB_STATUS_FILTERS: ["new", "learning", "known", "ignored"] },
    "../tokenizer_v2.js": { resolveVocabularyKey: (word) => String(word || "").toLowerCase() },
    "../translator-preferences.js": { effectiveLearningLanguage: () => "de" }
  }, {
    document: {
      addEventListener() {},
      querySelector(selector) { return bySelector[selector] ?? null; },
      getElementById(id) { return id === "add-word-status-buttons" ? statusContainer : null; }
    },
    Element: kindClass("dialog", "input", "textarea", "button", "editable"),
    HTMLElement: kindClass("dialog", "input", "textarea", "button", "editable"),
    HTMLInputElement: kindClass("input", "hidden"),
    HTMLTextAreaElement: kindClass("textarea")
  });
  bindWordEditorEvents();

  const keydown = (eventTarget, overrides = {}) => {
    const event = {
      key: "", code: "", target: eventTarget,
      ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...overrides
    };
    listeners.get("dialog:keydown")(event);
    return event;
  };
  const activeStatus = () => statusButtons.find((button) => button.classList.contains("active"))?.dataset.addWordStatus;
  return { dialog, fields, statusButtons, keydown, activeStatus };
}

describe("add/edit word dialog status shortcuts", () => {
  it("lets digits 1-4 type into the word, article, translation and example fields", async () => {
    const { fields, keydown, activeStatus } = await wordEditorHarness();
    for (const [name, field] of Object.entries(fields)) {
      for (const digit of ["1", "2", "3", "4"]) {
        const event = keydown(field, { key: digit, code: `Digit${digit}` });
        assert.equal(event.defaultPrevented, false, `${digit} in the ${name} field must be typed`);
      }
    }
    const editable = { kind: "editable", isContentEditable: true };
    assert.equal(keydown(editable, { key: "3", code: "Digit3" }).defaultPrevented, false);
    assert.equal(activeStatus(), "new", "typing digits must not switch the status");
  });

  it("keeps the 1-4 status shortcuts on the dialog and the status buttons", async () => {
    const { dialog, statusButtons, keydown, activeStatus } = await wordEditorHarness();
    assert.equal(keydown(dialog, { key: "3", code: "Digit3" }).defaultPrevented, true);
    assert.equal(activeStatus(), "known");
    assert.equal(keydown(statusButtons[2], { key: "2", code: "Numpad2" }).defaultPrevented, true);
    assert.equal(activeStatus(), "learning");
  });

  it("matches the typed character only, so AZERTY and shifted keys are left alone", async () => {
    const { dialog, keydown, activeStatus } = await wordEditorHarness();
    // AZERTY: the physical Digit2 key types "é" without Shift.
    assert.equal(keydown(dialog, { key: "é", code: "Digit2" }).defaultPrevented, false);
    assert.equal(keydown(dialog, { key: "3", code: "Digit3", shiftKey: true }).defaultPrevented, false);
    assert.equal(activeStatus(), "new");
  });
});
