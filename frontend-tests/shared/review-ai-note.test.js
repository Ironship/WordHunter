import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/**
 * vm harness for the flashcards AI-explain flow (review-ai.js). Static imports
 * are synthetic mocks; `realModules` maps an import specifier to a REAL dist
 * chunk (its own imports resolve from the same mock map) so the shared
 * note-append logic is exercised end to end instead of being stubbed.
 */
async function evaluateReviewAi(importValues, globals = {}, realModules = {}) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, ...globals });
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
  for (const [specifier, file] of Object.entries(realModules)) {
    modules.set(specifier, new vm.SourceTextModule(read(file), {
      context,
      identifier: new URL(`../../${file}`, import.meta.url).href
    }));
  }
  const getModule = (specifier) => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `unexpected import ${specifier}`);
    return dependency;
  };
  const module = new vm.SourceTextModule(read("dist/web/js/vocabulary/review-ai.js"), {
    context,
    identifier: new URL("../../dist/web/js/vocabulary/review-ai.js", import.meta.url).href,
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

function makeState() {
  return {
    currentView: "flashcards",
    reviewIndex: 0,
    preferences: {
      aiExplanationsEnabled: true,
      aiExplanationEndpoint: "https://example.com/v1/chat/completions",
      aiExplanationModel: "m",
      learningLanguage: "en"
    },
    vocab: {
      run: { word: "run", note: "", status: "new", translation: "", examples: ["She runs fast."] }
    }
  };
}

function makeCardDom({ noteEl } = {}) {
  const output = { hidden: false, textContent: "", innerHTML: "", isConnected: true };
  const card = {
    isConnected: true,
    querySelector(selector) {
      if (selector === "[data-review-ai-explanation]") return output;
      if (selector === ".review-note") return noteEl || null;
      return null;
    }
  };
  const button = {
    closest(selector) { return selector === "#review-card" ? card : null; },
    isConnected: true,
    disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}
  };
  return { output, card, button };
}

const MARKER = "Wyjaśnienie AI";

function sharedMocks({ state, calls, flushed }) {
  return {
    "../state.js": { state },
    "../ai-explainer.js": {
      aiExplanationConfigured: () => true,
      aiExplanationLanguagePair: () => ({ from: "en", to: "pl" }),
      explainWord: async (request, onDelta) => {
        onDelta?.("To czasownik.");
        return { explanation: "To czasownik." };
      },
      formatAiExplanation: (text) => String(text ?? "")
    },
    "../loading.js": { beginElementBusy: () => () => {} },
    "../i18n.js": { t: (key) => (key === "reader.aiNoteMarker" ? MARKER : key) },
    // Deps of the real shared ai-note-append chunk (loaded from dist).
    "./state.js": { state },
    "./i18n.js": { t: (key) => (key === "reader.aiNoteMarker" ? MARKER : key) },
    "./views/vocabulary.js": {
      getOrCreateEntry(word) {
        if (!state.vocab[word]) state.vocab[word] = { word, note: "", status: "new", examples: [] };
        return state.vocab[word];
      }
    },
    "./vocab-actions.js": {
      updateWordField(word, field, value) {
        calls.push([word, field, value]);
        state.vocab[word][field] = value;
      }
    }
  };
}

function globalsWith(flushed, field = null) {
  return {
    document: { querySelector: () => field },
    CSS: { escape: (value) => String(value) },
    window: {
      flushWordFieldSave: () => flushed.push("flush"),
      scheduleWordFieldSave: (...args) => flushed.push(["schedule", ...args])
    }
  };
}

describe("flashcards AI explanation → word note", () => {
  it("ignores the hidden reader textarea outside the reader view", async () => {
    const state = makeState(); // currentView: "flashcards"
    state.vocab.run.note = "Bieżąca notatka.";
    const calls = [];
    const flushed = [];
    const { button } = makeCardDom();
    // The reader panel stays in the DOM when another view is active; its
    // textarea is stale and must not be read or re-scheduled.
    const field = { value: "STALE HIDDEN PANEL VALUE" };
    const { runReviewCardAiExplain } = await evaluateReviewAi(
      sharedMocks({ state, calls, flushed }),
      globalsWith(flushed, field),
      { "../ai-note-append.js": "dist/web/js/ai-note-append.js" }
    );

    await runReviewCardAiExplain(button, "run");

    assert.match(state.vocab.run.note, /^Bieżąca notatka\./);
    assert.doesNotMatch(state.vocab.run.note, /STALE/);
    // The shared pending-save slot must not be hijacked by a stale-field write.
    assert.ok(!flushed.some((entry) => Array.isArray(entry) && entry[0] === "schedule"));
  });

  it("reads the live textarea value when the reader view is open", async () => {
    const state = makeState();
    state.currentView = "reader";
    const calls = [];
    const flushed = [];
    const { button } = makeCardDom();
    const field = { value: "Live edit." };
    const { runReviewCardAiExplain } = await evaluateReviewAi(
      sharedMocks({ state, calls, flushed }),
      globalsWith(flushed, field),
      { "../ai-note-append.js": "dist/web/js/ai-note-append.js" }
    );

    await runReviewCardAiExplain(button, "run");

    assert.match(state.vocab.run.note, /^Live edit\.\n\nWyjaśnienie AI:\nTo czasownik\.$/);
    // Only a flush: the single global pending slot must never be re-scheduled
    // here, or an unrelated pending field save would be silently dropped.
    assert.ok(flushed.includes("flush"));
    assert.ok(!flushed.some((entry) => Array.isArray(entry) && entry[0] === "schedule"));
  });

  it("appends the finished explanation to state.vocab[word].note", async () => {
    const state = makeState();
    const calls = [];
    const flushed = [];
    const { output, button } = makeCardDom();
    const { runReviewCardAiExplain } = await evaluateReviewAi(
      sharedMocks({ state, calls, flushed }),
      globalsWith(flushed),
      { "../ai-note-append.js": "dist/web/js/ai-note-append.js" }
    );

    await runReviewCardAiExplain(button, "run");

    // The explanation must persist to the word's note (append-only with the
    // localized marker), exactly like the reader word panel does.
    assert.match(state.vocab.run.note, new RegExp(`${MARKER}:\\nTo czasownik\\.`));
    // The streamed card output still renders as before.
    assert.equal(output.innerHTML, "To czasownik.");
    // The canonical write goes through updateWordField("run", "note", ...).
    assert.ok(calls.some(([word, field]) => word === "run" && field === "note"));
  });

  it("does not append the same explanation twice (dedupe)", async () => {
    const state = makeState();
    const calls = [];
    const flushed = [];
    const { button } = makeCardDom();
    const { runReviewCardAiExplain } = await evaluateReviewAi(
      sharedMocks({ state, calls, flushed }),
      globalsWith(flushed),
      { "../ai-note-append.js": "dist/web/js/ai-note-append.js" }
    );

    await runReviewCardAiExplain(button, "run");
    await runReviewCardAiExplain(button, "run");

    const marker = `${MARKER}:\nTo czasownik.`;
    const occurrences = state.vocab.run.note.split(marker).length - 1;
    assert.equal(occurrences, 1, "a cache-hit repeat must not duplicate the block");
  });

  it("flushes pending debounced field saves before writing the note", async () => {
    const state = makeState();
    const calls = [];
    const flushed = [];
    const { button } = makeCardDom();
    const { runReviewCardAiExplain } = await evaluateReviewAi(
      sharedMocks({ state, calls, flushed }),
      globalsWith(flushed),
      { "../ai-note-append.js": "dist/web/js/ai-note-append.js" }
    );

    await runReviewCardAiExplain(button, "run");

    assert.ok(flushed.length >= 1, "flushWordFieldSave must run before the note write");
    const noteWrite = calls.find(([word, field]) => word === "run" && field === "note");
    assert.ok(noteWrite, "updateWordField must be called for the note");
    assert.match(String(noteWrite[2]), new RegExp(`${MARKER}:\\nTo czasownik\\.$`));
  });

  it("keeps the visible note paragraph on the card in sync after the append", async () => {
    const state = makeState();
    state.vocab.run.note = "Stara notatka.";
    const calls = [];
    const flushed = [];
    const noteEl = { textContent: "Stara notatka." };
    const { button } = makeCardDom({ noteEl });
    const { runReviewCardAiExplain } = await evaluateReviewAi(
      sharedMocks({ state, calls, flushed }),
      globalsWith(flushed),
      { "../ai-note-append.js": "dist/web/js/ai-note-append.js" }
    );

    await runReviewCardAiExplain(button, "run");

    assert.equal(noteEl.textContent, state.vocab.run.note);
    assert.match(noteEl.textContent, new RegExp(`Stara notatka\\.\\n\\n${MARKER}:\\nTo czasownik\\.`));
  });
});
