import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// PR #194 remediation: the smart-suggest prefix index and the review-queue
// memo are lazily built and keyed by the vocab object reference. In-place
// mutations (deleteWord, getOrCreateEntry, status edits) keep the reference,
// so the index/memo would go stale: dead keys crash the word panel with a
// TypeError, and the review queue shows phantoms. The remediation guards the
// dead keys and invalidates both caches at every mutation site.

async function evaluateWithMocks(file, importValues, globals = {}) {
  const context = vm.createContext(globals);
  const modules = new Map();
  const createMock = (specifier, values) => new vm.SyntheticModule(
    Object.keys(values),
    function initialize() {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    },
    { context, identifier: `mock:${specifier}` }
  );
  for (const [specifier, values] of Object.entries(importValues)) {
    modules.set(specifier, createMock(specifier, values));
  }
  const getModule = (specifier) => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `unexpected import ${specifier} from ${file}`);
    return dependency;
  };
  const module = new vm.SourceTextModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    context,
    identifier: new URL(file, import.meta.url).href,
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

test("smart-suggest skips dead index keys instead of crashing on a TypeError", async () => {
  const vocab = { "rufe an": { status: "learning" } };
  const mockState = {
    vocab,
    preferences: { learningLanguage: "de" },
    selectedWord: "rufe"
  };
  const { getSmartSuggestion } = await evaluateWithMocks("../../dist/web/js/reader/smart-suggest.js", {
    "../state.js": { state: mockState },
    "../utils.js": { escapeHtml: (v) => v, escapeAttribute: (v) => v },
    "../i18n.js": { t: (key) => key },
    "../translator-preferences.js": { effectiveLearningLanguage: () => "de" }
  }, {
    window: {},
    console
  });

  // First query builds the prefix index (tail "an" -> ["rufe an"]).
  getSmartSuggestion("ich rufe an", "rufe");

  // deleteWord removes entries in place — the index still holds the key.
  delete vocab["rufe an"];

  // The second query must not dereference the dead key (old code: TypeError
  // on `state.vocab[vocabWord].status`).
  assert.doesNotThrow(() => getSmartSuggestion("ich rufe an", "rufe"));
});

test("mutation sites invalidate the suggest index and the review-queue memo", () => {
  const vocabActions = readFileSync(new URL("../../src/web/js/vocab-actions.ts", import.meta.url), "utf8");
  const vocabularyView = readFileSync(new URL("../../src/web/js/views/vocabulary.ts", import.meta.url), "utf8");
  const wordEditor = readFileSync(new URL("../../src/web/js/events/word-editor.ts", import.meta.url), "utf8");

  // deleteWord: in-place delete -> both caches invalidated.
  assert.match(vocabActions, /export function deleteWord[\s\S]*?invalidateSuggestIndex\(\);[\s\S]*?invalidateReviewQueueCache\(\);/);
  // setWordStatus: queue depends on statuses -> memo invalidated.
  assert.match(vocabActions, /export function setWordStatus[\s\S]*?invalidateReviewQueueCache\(\);/);
  // selectWord + autoLearnOnClick: fresh entry -> learning feeds the queue.
  assert.match(vocabActions, /autoLearnOnClick[\s\S]*?setEntryStatus\(entry, "learning"\)[\s\S]*?invalidateReviewQueueCache\(\);/);
  // getOrCreateEntry: in-place add -> suggest index invalidated.
  assert.match(vocabularyView, /export function getOrCreateEntry[\s\S]*?invalidateSuggestIndex\(\);/);
  // Word-editor dialog: status edits bypass gradeReview/removeFromSrs —
  // BOTH branches (edit and add) invalidate both caches.
  assert.match(wordEditor, /invalidateReviewQueueCache\(\);/g);
  assert.match(wordEditor, /invalidateSuggestIndex\(\);/g);
  assert.ok(
    (wordEditor.match(/invalidateReviewQueueCache\(\);/g) || []).length >= 2,
    "edit and add branches both invalidate the queue memo"
  );
});
