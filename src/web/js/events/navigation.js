import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { setView } from "../render.js";
import { updatePreferenceValue, applyPreferences, themeLabel } from "../preferences.js";
import { renderLibrary } from "../views/library.js";
import { renderReader, clearReaderSelectionRange, setReaderSelectionAnchorFromToken, extendReaderSelection } from "../views/reader.js";
import { renderReview } from "../views/vocabulary.js";
import { showToast } from "../toast.js";
import { t } from "../i18n.js";
import { closeYouGlish, openYouGlish } from "../youglish.js";
import { speakWord } from "../tts.js";
import { setWordStatus } from "../vocab-actions.js";
import { openDictionary, getSelectedReaderActionText, copySelectedWordToClipboard, hasNativeTextSelection } from "./shared.js";

export function bindNavigationEvents() {
  els.navItems.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.view === "reader") {
        openReaderView();
        return;
      }
      setView(button.dataset.view);
    });
  });

  els.themeToggle.addEventListener("click", () => {
    const order = ["auto", "light", "dark"];
    const current = state.preferences.theme || "auto";
    const next = order[(order.indexOf(current) + 1) % order.length];
    updatePreferenceValue("theme", next);
    renderLibrary();
    renderReader();
    showToast(t("toast.themeChanged", { name: themeLabel(next) }));
  });

  document.addEventListener("keydown", handleGlobalKeydown);

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
      if ((state.preferences?.theme || "auto") === "auto") applyPreferences();
    });
  }

  if (els.reviewReverseToggle) {
    els.reviewReverseToggle.addEventListener("click", () => {
      state.preferences.reviewReverse = !state.preferences.reviewReverse;
      saveState();
      renderReview();
    });
  }
}

export function handleGlobalKeydown(event) {
  if (event.defaultPrevented) return;
  const key = event.key.toLowerCase();

  const target = event.target;
  const inField = target && target.matches && target.matches("input, textarea, select, [contenteditable=true]");

  if (key === "escape") {
    if (inField) {
      target.blur();
      return;
    }

    const activeImageSearch = document.querySelector('[id^="image-search-results-"]:not(:empty), [id^="review-image-search-results-"]:not(:empty)');
    if (activeImageSearch) {
      activeImageSearch.innerHTML = "";
      return;
    }

    const modal = document.getElementById("youglish-modal");
    if (modal && modal.open) {
      event.preventDefault();
      closeYouGlish();
      return;
    }
  }

  if (inField) return;

  if (event.ctrlKey && (key === "1" || key === "2" || key === "3" || key === "4")) {
    const index = parseInt(key) - 1;
    const suggestions = document.querySelectorAll(".search-img-suggestion");
    if (suggestions.length > index) {
      event.preventDefault();
      suggestions[index].click();
      return;
    }
  }

  if (key === "pageup") {
    const prevBtn = document.getElementById("btn-prev-page");
    if (prevBtn && !prevBtn.disabled) { event.preventDefault(); prevBtn.click(); }
    return;
  }
  if (key === "pagedown") {
    const nextBtn = document.getElementById("btn-next-page");
    if (nextBtn && !nextBtn.disabled) { event.preventDefault(); nextBtn.click(); }
    return;
  }

  if (key === "b" && event.ctrlKey) {
    event.preventDefault();
    const textSelect = document.getElementById("text-select");
    if (textSelect) textSelect.focus();
    return;
  }
  if (event.ctrlKey && (key === "=" || key === "+" || key === "-")) {
    event.preventDefault();
    const btn = document.querySelector(`button[data-font="${key === "-" ? "down" : "up"}"]`);
    if (btn) btn.click();
    return;
  }

  if (key === "?") { event.preventDefault(); setView("help"); return; }
  if (key === "b") { event.preventDefault(); setView("library"); return; }
  if (key === "d") { event.preventDefault(); setView("discover"); return; }
  if (key === "f") { event.preventDefault(); setView("flashcards"); return; }
  if (key === "g") { event.preventDefault(); setView("graphs"); return; }
  if (key === "r") { event.preventDefault(); openReaderView(); return; }
  if (key === "s") { event.preventDefault(); setView("settings"); return; }
  if (key === "t") { event.preventDefault(); setView("translator"); return; }
  if (key === "v") { event.preventDefault(); setView("vocabulary"); return; }

  // Focus search input with /
  if (key === "/" && !event.ctrlKey) {
    const searchInputs = {
      library: "#library-search",
      discover: "#discover-query",
      vocabulary: "#vocab-search"
    };
    const sel = searchInputs[state.currentView];
    if (sel) {
      const input = document.querySelector(sel);
      if (input) {
        event.preventDefault();
        input.focus();
        input.select();
        return;
      }
    }
  }

  // Focus reader page jump with Ctrl+G
  if (key === "g" && event.ctrlKey && state.currentView === "reader") {
    event.preventDefault();
    const pageInput = document.getElementById("page-jump-input");
    if (pageInput) { pageInput.focus(); pageInput.select(); }
    return;
  }

  // Theme toggle with Ctrl+Shift+T
  if (key === "t" && event.ctrlKey && event.shiftKey) {
    event.preventDefault();
    if (els.themeToggle) els.themeToggle.click();
    return;
  }

  if (key === "m" && state.currentView !== "reader" && state.preferences?.argosAsDict && state.preferences?.offlineTranslator) {
    event.preventDefault();
    openDictionary("");
    return;
  }

  if (state.currentView === "flashcards") {
    if (key === "arrowleft") {
      event.preventDefault();
      const btn = document.getElementById("btn-flashcard-prev");
      if (btn && !btn.disabled) btn.click();
      return;
    }
    if (key === "arrowright") {
      event.preventDefault();
      const btn = document.getElementById("btn-flashcard-next");
      if (btn && !btn.disabled) btn.click();
      return;
    }
    if (key === "enter") {
      event.preventDefault();
      const toggleBtn = document.querySelector('[data-review-action="toggle"]');
      if (toggleBtn) toggleBtn.click();
      return;
    }
    if ((key === " " || key === "spacebar") && !event.ctrlKey) {
      event.preventDefault();
      const ttsBtn = document.querySelector('.review-word [data-tts-word]');
      if (ttsBtn) import("../tts.js").then(m => m.speakWord(ttsBtn.dataset.ttsWord));
      return;
    }
    if ((key === " " || key === "spacebar") && event.ctrlKey) {
      event.preventDefault();
      const ttsCtxBtn = document.querySelector('.review-context [data-tts-word], .review-context-unmasked [data-tts-word]');
      if (ttsCtxBtn) import("../tts.js").then(m => m.speakText(ttsCtxBtn.dataset.ttsWord));
      return;
    }
    if (key === "m") {
      event.preventDefault();
      const dictBtn = document.querySelector('#review-card [data-dict-word]');
      if (dictBtn) openDictionary(dictBtn.dataset.dictWord);
      return;
    }
    if (key === "y") {
      event.preventDefault();
      const youglishBtn = document.querySelector('#review-card [data-youglish-word]');
      if (youglishBtn) openYouGlish(youglishBtn.dataset.youglishWord);
      return;
    }
    if (key === "i") {
      event.preventDefault();
      const imageBtn = document.querySelector('#review-card [data-review-action="search-image"]');
      if (imageBtn) imageBtn.click();
      return;
    }
    const map = { "0": "0", "1": "1", "2": "2", "3": "3", "4": "4", "5": "5" };
    if (map[key] || (event.code && map[event.code.replace("Digit", "").replace("Numpad", "")])) {
       const q = map[key] || map[event.code.replace("Digit", "").replace("Numpad", "")];
       const btn = document.querySelector(`[data-sm2-grade="${q}"]`);
       if (btn) { event.preventDefault(); btn.click(); return; }
    }
  }
  if (state.currentView === "reader") {
    if (key === "escape") {
      const active = document.activeElement;
      if (active && active.classList.contains("word-token")) {
        active.blur();
      }
      if (document.activeElement && document.activeElement.tagName === "SELECT") {
        event.preventDefault();
        document.activeElement.blur();
        return;
      }
      if (state.readerSelectionRange) {
        clearReaderSelectionRange(false);
      }
      if (state.selectedWord) {
        event.preventDefault();
        state.selectedWord = null;
        renderReader();
        return;
      }
    }

    const isSpace = key === " " || key === "spacebar" || event.code === "Space";

    if (key === "x" && state.selectedWord) {
      event.preventDefault();
      const readerText = document.getElementById("reader-text");
      const tokens = Array.from(readerText.querySelectorAll(".word-token"));
      const idx = tokens.indexOf(window.lastActiveToken);

      import("../vocab-actions.js").then(m => {
        m.deleteWord(state.selectedWord);
        if (idx !== -1 && idx + 1 < tokens.length) {
          const nextToken = tokens[idx + 1];
          nextToken.focus();
          window.lastActiveToken = nextToken;
          import("../tokenizer_v2.js").then(t => {
            m.selectWord(nextToken.dataset.word, t.normalizeWord);
          });
        }
      });
      return;
    }

    if (isSpace && event.ctrlKey) {
      event.preventDefault();
      import("../tts.js").then(m => {
        if (window.speechSynthesis && window.speechSynthesis.speaking) {
          m.stopSpeaking();
        } else {
          const active = document.activeElement;
          let container = null;
          let activeToken = window.lastActiveToken;
          if (!activeToken || !document.body.contains(activeToken)) {
            activeToken = active && active.classList.contains("word-token") ? active : null;
          }
          if (!activeToken && state.selectedWord) {
            const readerText = document.getElementById("reader-text");
            if (readerText) {
              try {
                activeToken = readerText.querySelector(`.word-token[data-word="${CSS.escape(state.selectedWord)}"]`);
              } catch (_) { /* ignore invalid selector */ }
            }
          }

          if (activeToken) {
            let fullText = "";
            let tokenStart = -1;
            let tokenEnd = -1;
            const readerText = document.getElementById("reader-text");
            for (const node of readerText.childNodes) {
              if (node === activeToken) {
                tokenStart = fullText.length;
                fullText += node.textContent;
                tokenEnd = fullText.length;
              } else if (node.nodeType === Node.TEXT_NODE || node.classList?.contains("word-token")) {
                fullText += node.textContent;
              }
            }
            if (tokenStart !== -1) {
              let start = tokenStart;
              while (start > 0 && !/[.!?\n。！？]/.test(fullText[start - 1])) start--;
              let end = tokenEnd;
              while (end < fullText.length && !/[.!?\n。！？]/.test(fullText[end])) end++;
              if (end < fullText.length) end++;
              const sentence = fullText.slice(start, end).trim();
              if (sentence) {
                m.speakText(sentence, activeToken.parentElement);
              }
            }
          }
        }
      });
      return;
    }

    if (key === "enter" && event.ctrlKey) {
      event.preventDefault();
      const readerText = document.getElementById("reader-text");
      if (!readerText) return;
      const tokens = Array.from(readerText.querySelectorAll(".word-token"));
      if (tokens.length === 0) return;
      let targetToken = state.selectedWord ? tokens.find(t => t.dataset.word === state.selectedWord) : tokens[0];
      if (targetToken) {
        targetToken.focus(); window.lastActiveToken = targetToken;
        setReaderSelectionAnchorFromToken(targetToken);
        import("../vocab-actions.js").then(m => {
          import("../tokenizer_v2.js").then(t => {
            m.selectWord(targetToken.dataset.word, t.normalizeWord);
          });
        });
      }
      return;
    }

    if (key === "arrowup" || key === "arrowdown") {
      const active = document.activeElement;
      if (active && active.classList.contains("word-token") && event.ctrlKey) {
        event.preventDefault();
        const readerText = document.getElementById("reader-text");
        const tokens = Array.from(readerText.querySelectorAll(".word-token"));
        const idx = tokens.indexOf(active);
        if (idx !== -1) {
          const isDown = key === "arrowdown";
          const currentRect = active.getBoundingClientRect();
          let nextIdx = isDown ? idx + 1 : idx - 1;
          while (nextIdx >= 0 && nextIdx < tokens.length) {
            const rect = tokens[nextIdx].getBoundingClientRect();
            if (isDown ? rect.top >= currentRect.bottom - 4 : rect.bottom <= currentRect.top + 4) {
              tokens[nextIdx].focus(); window.lastActiveToken = tokens[nextIdx];
              setReaderSelectionAnchorFromToken(tokens[nextIdx]);
              import("../vocab-actions.js").then(m => {
                import("../tokenizer_v2.js").then(t => {
                  m.selectWord(tokens[nextIdx].dataset.word, t.normalizeWord);
                });
              });
              break;
            }
            nextIdx += isDown ? 1 : -1;
          }
        }
        return;
      }
    }
    if (key === "arrowleft" || key === "arrowright") {
      if (event.shiftKey) {
        event.preventDefault();
        extendReaderSelection(key === "arrowleft" ? "left" : "right");
        return;
      }
      const active = document.activeElement;
      if (active && active.classList.contains("word-token")) {
        event.preventDefault();
        const readerText = document.getElementById("reader-text");
        const tokens = Array.from(readerText.querySelectorAll(".word-token"));
        const idx = tokens.indexOf(active);
        if (idx !== -1) {
          const nextIdx = key === "arrowleft" ? idx - 1 : idx + 1;
          if (nextIdx >= 0 && nextIdx < tokens.length) {
            tokens[nextIdx].focus(); window.lastActiveToken = tokens[nextIdx];
            setReaderSelectionAnchorFromToken(tokens[nextIdx]);
            import("../vocab-actions.js").then(m => {
              import("../tokenizer_v2.js").then(t => {
                m.selectWord(tokens[nextIdx].dataset.word, t.normalizeWord);
              });
            });
          }
        }
        return;
      }
    }

    if (state.selectedWord) {
      if (key === "c" && event.ctrlKey) {
        if (hasNativeTextSelection()) return;
        event.preventDefault();
        copySelectedWordToClipboard();
        return;
      }

      const map = { "1": "new", "2": "learning", "3": "known", "4": "ignored" };
      const keyCodeMatch = event.code ? event.code.match(/Digit([1-4])|Numpad([1-4])/) : null;
      const digit = keyCodeMatch ? (keyCodeMatch[1] || keyCodeMatch[2]) : null;
      const statusAction = map[key] || (digit ? map[digit] : null);

      if (statusAction) {
        event.preventDefault();
        setWordStatus(state.selectedWord, statusAction);
        return;
      }

      if (key === "e") {
        event.preventDefault();
        focusSelectedWordField("translation");
        return;
      }

      if (key === "n") {
        event.preventDefault();
        focusSelectedWordField("note");
        return;
      }

      if (key === "i") {
        event.preventDefault();
        const imageButton = document.querySelector(`[data-action="search-image"][data-word="${CSS.escape(state.selectedWord)}"]`);
        if (imageButton) imageButton.click();
        return;
      }

      if (key === "m") {
        event.preventDefault();
        openDictionary(getSelectedReaderActionText());
        return;
      }

      if (key === "y") {
        event.preventDefault();
        openYouGlish(getSelectedReaderActionText());
        return;
      }

      if ((key === " " || key === "spacebar" || event.code === "Space") && !event.ctrlKey) {
        event.preventDefault();
        speakWord(getSelectedReaderActionText());
        return;
      }
    }
  }
}

async function openReaderView() {
  const { openLastReadBook } = await import("../book-actions.js");
  await openLastReadBook();
}

function focusSelectedWordField(field) {
  if (!state.selectedWord) return;
  focusWordField(state.selectedWord, field);
}

function focusWordField(word, field) {
  if (!word || !field) return;
  const selector = `[data-word-field="${field}"][data-word="${CSS.escape(word)}"]`;
  const input = document.querySelector(selector);
  if (input) {
    input.focus();
    if (typeof input.select === "function") input.select();
  }
}
