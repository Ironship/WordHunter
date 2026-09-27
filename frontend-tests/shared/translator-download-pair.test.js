// Translator view "Download now" for a pair outside the profile (it→pl while
// learning German): the download dialog must list and install that pair, and
// only report success once the pair can translate. Opening the dialog from
// Settings afterwards must not reuse the old pair.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

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

function eventTarget(extra = {}) {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
    dispatch(type, event = {}) {
      return Promise.all((listeners.get(type) || []).map((listener) => listener({ type, currentTarget: this, target: this, ...event })));
    },
    ...extra
  };
}

async function argosHarness({ installedPairs }) {
  const state = { preferences: { learningLanguage: "de", locale: "en", offlineTranslator: false } };
  const checkboxes = [];
  const languagesList = {
    kind: "element",
    set innerHTML(html) {
      checkboxes.length = 0;
      for (const match of html.matchAll(/<input type="checkbox" value="([^"]+)" (checked)?>/g)) {
        checkboxes.push(eventTarget({ value: match[1], checked: Boolean(match[2]) }));
      }
    },
    querySelectorAll(selector) {
      if (selector === "input") return checkboxes;
      if (selector === "input:checked") return checkboxes.filter((checkbox) => checkbox.checked);
      return [];
    }
  };
  const dialog = eventTarget({
    kind: "dialog",
    dataset: {},
    open: false,
    showModal() { this.open = true; },
    close() {
      this.open = false;
      void this.dispatch("close");
    }
  });
  const confirm = eventTarget({ textContent: "" });
  const cancel = eventTarget({ disabled: false });
  const elements = {
    "argos-download-dialog": dialog,
    "argos-languages-list": languagesList,
    "argos-download-confirm": confirm,
    "argos-download-cancel": cancel
  };
  const els = {
    prefOfflineTranslator: eventTarget({ checked: false }),
    prefArgosAsDictRow: { style: {} },
    prefArgosAsDict: null
  };
  const installRequests = [];
  const toasts = [];
  const kindClass = (...kinds) => class {
    static [Symbol.hasInstance](value) { return kinds.includes(value?.kind); }
  };
  const settings = await evaluateWithMocks("dist/web/js/events/settings/translator.js", {
    "../../state.js": { state },
    "../../dom.js": { els },
    "../../i18n.js": { t: (key) => key },
    "../../reader/renderer.js": { renderReader() {} },
    "../../preferences.js": {
      syncSettingsControls() {},
      updatePreferenceValue(key, value) { state.preferences[key] = value; }
    },
    "../../toast.js": { showToast(message) { toasts.push(message); } },
    "../../dialog-backdrop.js": { registerUnsavedDialog() {} },
    "../../loading.js": { setElementBusy() {} },
    // The dialog's static default list: no Italian.
    "../../constants.js": { OFFLINE_TRANSLATOR_LANGUAGES: ["en", "pl", "de", "es", "fr", "zh"] },
    "../../translator-preferences.js": {
      normalizeTranslationLanguageCode: (value) => String(value || ""),
      normalizeTranslatorTextPreference: (_key, value) => value,
      resolveProfileTranslationPair: (preferences) => ({ fromCode: preferences.learningLanguage, toCode: preferences.locale, configured: true })
    },
    "../../http.js": {
      async httpPost(url, body) {
        installRequests.push({ url, languages: [...body.from].sort() });
        return { ok: true, json: async () => ({ installed: 2 }) };
      }
    },
    "../../views/translator.js": {
      invalidatePackagesCache() {},
      async refreshTranslatorAvailability() { return true; },
      hasModelForPair: (from, to) => !from || !to || installedPairs.has(`${from}:${to}`),
      renderTranslator() {}
    }
  }, {
    document: { getElementById(id) { return elements[id] ?? null; } },
    HTMLElement: kindClass("element", "dialog"),
    HTMLDialogElement: kindClass("dialog")
  });
  settings.bindOfflineTranslatorSettings();

  const confirmDownload = async () => {
    await confirm.dispatch("click");
    await flush();
  };
  const checked = () => checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
  return { settings, state, dialog, els, checkboxes, checked, confirmDownload, installRequests, toasts };
}

describe("Translator view offline model download", () => {
  it("lists, checks and installs the requested pair even when it is outside the defaults", async () => {
    const harness = await argosHarness({ installedPairs: new Set(["de:en", "it:pl"]) });

    harness.settings.openArgosDownloadDialogForPair("it", "pl");

    assert.equal(harness.dialog.open, true);
    assert.deepEqual(harness.checked(), ["pl", "it"]);
    // Unchecking the requested language does not drop it from the install.
    harness.checkboxes.find((checkbox) => checkbox.value === "it").checked = false;
    await harness.confirmDownload();

    assert.deepEqual(harness.installRequests.map((request) => request.languages), [["de", "en", "it", "pl"]]);
    assert.deepEqual(harness.toasts, ["toast.modelsDownloaded"]);
    assert.equal(harness.state.preferences.offlineTranslator, true);
  });

  it("does not report success while the requested pair still has no model", async () => {
    const harness = await argosHarness({ installedPairs: new Set(["de:en"]) });

    harness.settings.openArgosDownloadDialogForPair("it", "pl");
    await harness.confirmDownload();

    assert.deepEqual(harness.toasts, ["toast.modelsDownloadError"]);
    // The profile pair installed, so offline translation stays usable.
    assert.equal(harness.state.preferences.offlineTranslator, true);
  });

  it("forgets the requested pair when the dialog closes", async () => {
    const harness = await argosHarness({ installedPairs: new Set(["de:en"]) });

    harness.settings.openArgosDownloadDialogForPair("it", "pl");
    harness.dialog.close();
    await flush();
    assert.deepEqual(harness.dialog.dataset, {});

    harness.els.prefOfflineTranslator.checked = true;
    await harness.els.prefOfflineTranslator.dispatch("change");
    assert.deepEqual(harness.checked(), ["en", "de"]);
    await harness.confirmDownload();

    assert.deepEqual(harness.installRequests.map((request) => request.languages), [["de", "en"]]);
    assert.deepEqual(harness.toasts, ["toast.modelsDownloaded"]);
  });
});
