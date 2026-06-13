// Reader view: text list + tokenization + word panel.
import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, statusLabel, calcStatsPcts } from "../utils.js";
import { icon } from "../icons.js";
import { tokenizeText, normalizeWord, getTextStats, getSentenceForWord } from "../tokenizer_v2.js";
import { STATUS_ORDER } from "../constants.js";
import { getAllBooks, bookTexts } from "../books.js";
import { getOrCreateEntry } from "./vocabulary.js";
import { t } from "../i18n.js";

let loadingBook = null;
let scrollSaveTimer = null;

export function rememberReaderScrollPosition() {
  if (!els.readerText || !state.currentTextId) return;
  if (!state.readerScrolls) state.readerScrolls = {};

  const scrollTop = Math.max(0, Math.round(els.readerText.scrollTop || 0));
  let wordIndex = null;
  const tokens = els.readerText.querySelectorAll(".word-token");
  const containerRect = els.readerText.getBoundingClientRect();
  for (const token of tokens) {
    const tr = token.getBoundingClientRect();
    if (tr.top < containerRect.bottom && tr.bottom > containerRect.top) {
      const idx = parseInt(token.dataset.wordIndex, 10);
      if (!isNaN(idx)) wordIndex = idx;
      break;
    }
  }

  state.readerScrolls[state.currentTextId] = {
    wordIndex: wordIndex,
    scrollTop: scrollTop,
    readerPage: state.readerPage
  };
  saveState();
}

function resetReaderScrollPosition(textId) {
  if (!textId) return;
  if (!state.readerScrolls) state.readerScrolls = {};
  state.readerScrolls[textId] = { wordIndex: null, scrollTop: 0, readerPage: 1 };
  saveState();
}

function restoreReaderScrollPosition(textId, saved, attempt) {
  const container = els.readerText;
  if (state.currentTextId !== textId || !container) return;
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);

  // Content hasn't been laid out yet — retry after a tick
  if (maxScroll <= 0 && (attempt || 0) < 8) {
    setTimeout(() => restoreReaderScrollPosition(textId, saved, (attempt || 0) + 1), 60);
    return;
  }

  let target = 0;
  if (saved && typeof saved === "object") {
    // 1. Global word index — most precise
    if (saved.wordIndex) {
      const token = container.querySelector(`[data-word-index="${saved.wordIndex}"]`);
      if (token) {
        const tr = token.getBoundingClientRect();
        const cr = container.getBoundingClientRect();
        if (tr.height > 0) {
          target = Math.round(tr.top - cr.top + container.scrollTop - container.clientHeight / 2 + tr.height / 2);
        }
      }
    }
    // 2. Direct scrollTop as backup
    if (target === 0 && typeof saved.scrollTop === "number" && saved.scrollTop > 0) {
      target = saved.scrollTop;
    }
  } else if (typeof saved === "number" && saved > 0) {
    target = saved;
  }

  container.scrollTop = Math.max(0, Math.min(target, maxScroll));
  container.dataset.rendering = "0";
}

function getReaderWordTokens() {
  if (!els.readerText) return [];
  return Array.from(els.readerText.querySelectorAll(".word-token"));
}

function getRangeBounds(range) {
  if (!range) return null;
  const anchor = Number(range.anchor);
  const focus = Number(range.focus);
  if (!Number.isInteger(anchor) || !Number.isInteger(focus)) return null;
  return {
    start: Math.min(anchor, focus),
    end: Math.max(anchor, focus),
    anchor,
    focus
  };
}

function getRangeText(tokens, range) {
  const bounds = getRangeBounds(range);
  if (!bounds) return "";
  const startToken = tokens[bounds.start];
  const endToken = tokens[bounds.end];
  if (!startToken || !endToken || !els.readerText) return "";

  let collecting = false;
  let text = "";
  for (const node of els.readerText.childNodes) {
    if (node === startToken) collecting = true;
    if (!collecting) continue;

    if (node.nodeType === Node.TEXT_NODE || node.classList?.contains("word-token")) {
      text += node.textContent || "";
    }

    if (node === endToken) break;
  }

  return text.replace(/\s+/g, " ").trim();
}

export function setReaderSelectionFromToken(token) {
  const tokens = getReaderWordTokens();
  const index = tokens.indexOf(token);
  if (index === -1) {
    state.readerSelectionRange = null;
    return;
  }
  state.readerSelectionRange = { anchor: index, focus: index };
}

export function setReaderSelectionAnchorFromToken(token) {
  const tokens = getReaderWordTokens();
  const index = tokens.indexOf(token);
  if (index === -1) return false;
  state.readerSelectionRange = { anchor: index, focus: index };
  window.lastActiveToken = token;
  return true;
}

export function clearReaderSelectionRange(renderSelection = false) {
  if (!state.readerSelectionRange) return;
  state.readerSelectionRange = null;
  saveState();
  if (renderSelection) updateReaderSelection();
}

export function extendReaderSelection(direction) {
  const tokens = getReaderWordTokens();
  if (!tokens.length) return false;

  const activeToken = document.activeElement?.classList?.contains("word-token")
    ? document.activeElement
    : (window.lastActiveToken && document.body.contains(window.lastActiveToken) ? window.lastActiveToken : null);
  const activeIndex = tokens.indexOf(activeToken);
  if (activeIndex === -1) return false;

  let range = state.readerSelectionRange;
  if (!range || Number(range.focus) !== activeIndex) {
    range = { anchor: activeIndex, focus: activeIndex };
  }

  const step = direction === "left" ? -1 : 1;
  const nextFocus = Math.max(0, Math.min(tokens.length - 1, Number(range.focus) + step));
  state.readerSelectionRange = { anchor: Number(range.anchor), focus: nextFocus };
  const text = getRangeText(tokens, state.readerSelectionRange);
  if (!text) return false;

  state.selectedWord = normalizeWord(text);
  saveState();
  window.lastActiveToken = tokens[nextFocus];
  tokens[nextFocus].focus({ preventScroll: true });
  updateReaderSelection();
  return true;
}

export function getReaderSelectionText() {
  const tokens = getReaderWordTokens();
  const text = getRangeText(tokens, state.readerSelectionRange);
  return normalizeWord(text) === state.selectedWord ? text : "";
}

function isTransientReaderRangeSelection() {
  return !!getReaderSelectionText() && !Object.hasOwn(state.vocab, state.selectedWord);
}

export function setReaderLoading(book) {
  loadingBook = book;
  renderReader();
}
export function clearReaderLoading() {
  loadingBook = null;
}

function renderTrackingSummary(stats) {
  const { knownPct, learningPct, newPct } = calcStatsPcts(stats);
  const items = [
    {
      className: "tracking-known",
      label: t("reader.statsKnownIgnored"),
      title: t("reader.statsKnownIgnoredTitle"),
      value: knownPct
    },
    { className: "tracking-learning", label: t("reader.statsLearning"), title: t("reader.statsLearning"), value: learningPct },
    { className: "tracking-new", label: t("reader.statsNew"), title: t("reader.statsNew"), value: newPct }
  ];
  els.trackingSummary.innerHTML = items.map(({ className, label, title, value }) => {
    const percent = `${Math.round(value)}%`;
    const description = `${title}: ${percent}`;
    return `
      <span class="tracking-stat ${className}" title="${escapeAttribute(description)}" aria-label="${escapeAttribute(description)}">
        <strong>${percent}</strong>
        <span class="tracking-label">${escapeHtml(label)}</span>
      </span>
    `;
  }).join("");
  els.progressBar.style.width = `${knownPct}%`;
  if (els.progressBarLearning) els.progressBarLearning.style.width = `${learningPct}%`;
}

export function getAllTexts() {
  const fromBooks = getAllBooks().map((book) => ({
    id: book.id,
    title: book.title,
    author: book.author,
    level: book.level,
    source: t("reader.sourceGutenberg"),
    sourceUrl: book.pageUrl,
    textUrl: book.textUrl,
    text: bookTexts.get(book.id) || book.sample || ""
  }));
  const fromCustom = (state.customTexts || []).map((ct) => ({
    ...ct,
    text: bookTexts.get(ct.id) || ct.text || ""
  }));
  return [...fromBooks, ...fromCustom];
}


export function getTextById(id) {
  return getAllTexts().find((text) => text.id === id);
}

export function renderReader() {
  if (!els.readerText) return;
  if (loadingBook) {
    els.readerText.dataset.rendering = "1";
    if (els.textSelect) els.textSelect.innerHTML = `<option>${escapeHtml(loadingBook.title)}</option>`;
    if (els.readerHeading) els.readerHeading.textContent = loadingBook.title;
    if (els.readerSource) els.readerSource.textContent = loadingBook.author || loadingBook.source || t("reader.sourceGutenberg");
    if (els.trackingSummary) els.trackingSummary.textContent = "—";
    if (els.uniqueSummary) els.uniqueSummary.textContent = "";
    if (els.progressBar) els.progressBar.style.width = "0%";
    if (els.progressBarLearning) els.progressBarLearning.style.width = "0%";
    els.readerText.innerHTML = `
      <div class="reader-loading">
        <div class="spinner" aria-hidden="true"></div>
        <p class="eyebrow">${escapeHtml(t("reader.loadingEyebrow"))}</p>
        <h3>${escapeHtml(t("reader.loadingHeading", { title: loadingBook.title }))}</h3>
        <p class="muted-copy">${escapeHtml(t("reader.loadingHint"))}</p>
        <div class="loading-bar"><div class="loading-bar-fill"></div></div>
      </div>`;
    if (els.wordPanel) {
      els.wordPanel.innerHTML = `<div class="empty-state"><p class="eyebrow">${escapeHtml(t("reader.wordPanelEyebrow"))}</p><h2>${escapeHtml(t("reader.loadingHeading", { title: loadingBook.title }))}</h2><p>${escapeHtml(t("reader.loadingHint"))}</p></div>`;
    }
    els.readerText.dataset.rendering = "0";
    return;
  }
  const texts = getAllTexts();
  const current = getTextById(state.currentTextId);

  if (!current) {
    if (els.textSelect) {
      els.textSelect.innerHTML = texts.map((text) => `<option value="${escapeHtml(text.id)}">${escapeHtml(text.title)}</option>`).join("");
    }
    if (els.readerHeading) els.readerHeading.textContent = t("reader.title");
    if (els.readerSource) els.readerSource.textContent = t("reader.source");
    if (els.trackingSummary) els.trackingSummary.textContent = "—";
    if (els.uniqueSummary) els.uniqueSummary.textContent = "";
    if (els.progressBar) els.progressBar.style.width = "0%";
    if (els.progressBarLearning) els.progressBarLearning.style.width = "0%";
    els.readerText.innerHTML = `<p>${escapeHtml(t("reader.empty"))}</p>`;
    if (els.wordPanel) {
      els.wordPanel.innerHTML = `<div class="empty-state"><p class="eyebrow">${escapeHtml(t("reader.wordPanelEyebrow"))}</p><h2>${escapeHtml(t("reader.wordPanelHeading"))}</h2><p>${escapeHtml(t("reader.wordPanelHint"))}</p></div>`;
    }
    els.readerText.dataset.rendering = "0";
    return;
  }

  els.textSelect.innerHTML = texts.map((text) => {
    const selected = text.id === current.id ? "selected" : "";
    return `<option value="${escapeHtml(text.id)}" ${selected}>${escapeHtml(text.title)}</option>`;
  }).join("");

  els.readerHeading.textContent = current.title;
  els.readerSource.textContent = current.author || current.source || t("reader.localSource");
  els.readerText.style.fontSize = "";

  els.readerText.dataset.rendering = "1";
  const scrollPerPageKey = state.currentTextId ? `${state.currentTextId}-p${state.readerPage}` : null;
  const savedPos = state.readerScrolls?.[current.id] || 0;
  els.readerText.innerHTML = `<div class="reader-loading" style="padding: 2rem; text-align: center;"><div class="spinner" aria-hidden="true" style="margin: 0 auto 1rem;"></div><p class="muted-copy">${escapeHtml(t("reader.loadingHint"))}</p></div>`;

  setTimeout(() => {
    // Defer again so the spinner paint is committed before heavy work
    setTimeout(() => {
    // 1. Statistics
    const wordAlgorithm = state.preferences.wordDetectionAlgorithm || "modern";
    const stats = getTextStats(current.text, state.vocab, state.preferences.learningLanguage || "en", wordAlgorithm);
    renderTrackingSummary(stats);
    els.uniqueSummary.textContent = t("reader.uniqueSummary", { n: stats.unique });



    // 2. Tokenization
    const tokens = tokenizeText(current.text, state.preferences.learningLanguage || "en", wordAlgorithm);
    // Global index of each word in the book (1-based, -1 for non-word)
    const globalWordIdx = new Array(tokens.length).fill(-1);
    for (let i = 0, wc = 0; i < tokens.length; i++) {
      if (tokens[i].type === "word") globalWordIdx[i] = ++wc;
    }
    const wordsPerPage = Number(state.preferences.wordsPerPage) || 1000;
    // Build a list of multi-word phrases for fast matching
    const multiWordVocab = Object.keys(state.vocab)
      .filter(k => k.includes(" "))
      .map(k => ({ key: k, words: k.split(" ") }))
      .sort((a, b) => b.words.length - a.words.length);

    let pageStartIndex = 0;
    let pageEndIndex = tokens.length;
    let totalWords = tokens.filter(t => t.type === "word").length;
    let totalPages = wordsPerPage >= 999999 ? 1 : Math.ceil(totalWords / wordsPerPage);
    
    if (totalPages < 1) totalPages = 1;
    
    // Restore saved position for this book
    if (state.readerPages && state.readerPages[current.id]) {
      state.readerPage = state.readerPages[current.id];
    }
    
    if (state.readerPage > totalPages) state.readerPage = totalPages;
    if (state.readerPage < 1) state.readerPage = 1;
    
    // Save position in case it was adjusted
    if (!state.readerPages) state.readerPages = {};
    state.readerPages[current.id] = state.readerPage;
    saveState();

    if (wordsPerPage < 999999) {
      let wordCount = 0;
      let i = 0;
      for (; i < tokens.length; i++) {
        if (wordCount >= (state.readerPage - 1) * wordsPerPage) {
          pageStartIndex = i;
          break;
        }
        if (tokens[i].type === "word") wordCount++;
      }
      wordCount = 0;
      for (; i < tokens.length; i++) {
        if (tokens[i].type === "word") wordCount++;
        if (wordCount > wordsPerPage) {
          pageEndIndex = i;
          break;
        }
      }
    }
    
    const pageTokens = tokens.slice(pageStartIndex, pageEndIndex);
    const CHUNK_SIZE = 500;
    let index = 0;
    els.readerText.innerHTML = "";
    
    const renderId = Date.now();
    els.readerText.dataset.renderId = renderId;

    function renderNextChunk() {
      if (els.readerText.dataset.renderId !== String(renderId)) return;

      if (index >= pageTokens.length) {
        if (totalPages > 1) {
          els.readerText.insertAdjacentHTML("beforeend", `
            <div class="pagination-controls">
              <button class="secondary-button" id="btn-prev-page" ${state.readerPage <= 1 ? "disabled" : ""} data-i18n-attr="title=reader.prevPageTitle"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg><kbd style="font-size:0.6rem; padding: 1px 3px; margin-left: 4px;">PgUp</kbd></button>
              <span class="page-jump">
                <input type="number" id="page-jump-input" class="page-jump-input" min="1" max="${totalPages}" value="${state.readerPage}" aria-label="${t("reader.pageJumpLabel")}">
                <span class="page-jump-total">/&thinsp;${totalPages}</span>
              </span>
              <button class="secondary-button" id="btn-next-page" ${state.readerPage >= totalPages ? "disabled" : ""} data-i18n-attr="title=reader.nextPageTitle"><kbd style="font-size:0.6rem; padding: 1px 3px; margin-right: 4px;">PgDn</kbd><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></button>
            </div>
          `);
          const prevBtn = document.getElementById("btn-prev-page");
          const nextBtn = document.getElementById("btn-next-page");
          const pageInput = document.getElementById("page-jump-input");
          function goToPage(n) {
            const p = Math.max(1, Math.min(totalPages, n));
            if (p !== state.readerPage) {
              // Save current scroll position for current page
              if (!state.readerScrollsPerPage) state.readerScrollsPerPage = {};
              const key = `${current.id}-p${state.readerPage}`;
              state.readerScrollsPerPage[key] = els.readerText ? els.readerText.scrollTop : 0;

              state.readerPage = p;
              if (!state.readerPages) state.readerPages = {};
              state.readerPages[current.id] = state.readerPage;
              renderReader();
            }
          }
          if (prevBtn) prevBtn.addEventListener("click", () => goToPage(state.readerPage - 1));
          if (nextBtn) nextBtn.addEventListener("click", () => goToPage(state.readerPage + 1));
          if (pageInput) {
            pageInput.addEventListener("keydown", (e) => {
              if (e.key === "Enter") {
                const val = parseInt(pageInput.value, 10);
                if (!isNaN(val) && val >= 1 && val <= totalPages) goToPage(val);
                else pageInput.value = state.readerPage;
                pageInput.blur();
              }
            });
            pageInput.addEventListener("blur", () => { pageInput.value = state.readerPage; });
          }
        }
        renderWordPanel(current);
        // Restore per-page scroll if available, else fallback to text-level scroll
        const perPageScroll = state.readerScrollsPerPage?.[scrollPerPageKey];
        if (perPageScroll !== undefined) {
          els.readerText.scrollTop = perPageScroll;
        } else {
          restoreReaderScrollPosition(current.id, savedPos);
        }
        updateReaderSelection();
        return;
      }
      
      let htmlChunk = "";
      let i = index;
      let tokensProcessed = 0;
      
      while (i < pageTokens.length && tokensProcessed < CHUNK_SIZE) {
        const part = pageTokens[i];
        if (part.type === "image") {
          htmlChunk += `<img src="/__media?book=${encodeURIComponent(current.id)}&img=${encodeURIComponent(part.value)}" style="max-width: 100%; height: auto; display: block; margin: 1rem auto; border-radius: 6px;" alt="${escapeHtml(t("reader.imageAlt"))}">`;
          i++;
          tokensProcessed++;
          continue;
        }
        if (part.type === "text") {
          htmlChunk += escapeHtml(part.value);
          i++;
          tokensProcessed++;
          continue;
        }

        const word = normalizeWord(part.value);
        let matchedPhraseKey = null;
        let consumedTokens = 1;

        for (const phrase of multiWordVocab) {
          if (phrase.words[0] === word) {
            let match = true;
            let tokenOffset = 1;
            let wordOffset = 1;
            while (wordOffset < phrase.words.length && i + tokenOffset < pageTokens.length) {
              const nextToken = pageTokens[i + tokenOffset];
              if (nextToken.type === "text") {
                tokenOffset++;
                continue;
              }
              if (nextToken.type === "word" && normalizeWord(nextToken.value) === phrase.words[wordOffset]) {
                wordOffset++;
                tokenOffset++;
              } else {
                match = false;
                break;
              }
            }
            if (match && wordOffset === phrase.words.length) {
              matchedPhraseKey = phrase.key;
              consumedTokens = tokenOffset;
              break;
            }
          }
        }

        let status = "new";
        let selected = "";
        let dataWord = escapeHtml(word);

        if (matchedPhraseKey) {
          const phrEntry = state.vocab[matchedPhraseKey];
          if (phrEntry) {
            status = phrEntry.status;
            selected = state.selectedWord === matchedPhraseKey ? "selected" : "";
            dataWord = escapeHtml(matchedPhraseKey);
          }
          // else: entry was deleted between chunk renders — render as new single words
        }
        if (!matchedPhraseKey || !Object.hasOwn(state.vocab, matchedPhraseKey)) {
          // Fall back to rendering as individual single words
          consumedTokens = 1;
          const entry = state.vocab[word];
          status = entry ? entry.status : "new";
          selected = state.selectedWord === word ? "selected" : "";
        }

        for (let j = 0; j < consumedTokens; j++) {
          const consumedPart = pageTokens[i + j];
          if (consumedPart.type === "text") {
             htmlChunk += escapeHtml(consumedPart.value);
          } else {
             const pSelected = selected || (state.selectedWord === normalizeWord(consumedPart.value) ? "selected" : "");
             const globalIdx = globalWordIdx[pageStartIndex + i + j];
             htmlChunk += `<button class="word-token status-${status} ${pSelected}" type="button" data-word="${dataWord}" data-word-index="${globalIdx}">${escapeHtml(consumedPart.value)}</button>`;
          }
        }
        
        i += consumedTokens;
        tokensProcessed += consumedTokens;
      }

      els.readerText.insertAdjacentHTML("beforeend", htmlChunk);
      index = i;
      setTimeout(renderNextChunk, 0); // Allows UI to breathe
    }
    

    setTimeout(renderNextChunk, 0);
    });  // inner setTimeout for spinner paint
  }, 10);
}

export function updateWordStatusInReader(word, status) {
  if (!els.readerText) return;
  const tokens = els.readerText.querySelectorAll(`.word-token[data-word="${CSS.escape(word)}"]`);
  tokens.forEach(token => {
    token.classList.remove("status-new", "status-learning", "status-known", "status-ignored");
    token.classList.add(`status-${status}`);
  });
  const current = getTextById(state.currentTextId);
  if (current && state.selectedWord === word) {
    renderWordPanel(current);
  }
  
  if (current) {
    const stats = getTextStats(
      current.text,
      state.vocab,
      state.preferences.learningLanguage || "en",
      state.preferences.wordDetectionAlgorithm || "modern"
    );
    renderTrackingSummary(stats);
    if (els.uniqueSummary) {
      els.uniqueSummary.textContent = t("reader.uniqueSummary", { n: stats.unique });
    }
  }
}

export function updateReaderSelection() {
  if (!els.readerText) return;
  const current = getTextById(state.currentTextId);
  if (!current) return;
  
  // Update 'selected' classes without reloading the entire text
  const tokens = getReaderWordTokens();
  const rangeBounds = getRangeBounds(state.readerSelectionRange);
  const rangeText = rangeBounds ? normalizeWord(getRangeText(tokens, state.readerSelectionRange)) : "";
  const useRange = rangeBounds && rangeText && rangeText === state.selectedWord;
  if (state.readerSelectionRange && !useRange) {
    state.readerSelectionRange = null;
  }
  tokens.forEach((token, index) => {
    if ((useRange && index >= rangeBounds.start && index <= rangeBounds.end) || token.dataset.word === state.selectedWord) {
      token.classList.add("selected");
    } else {
      token.classList.remove("selected");
    }
  });
  
  renderWordPanel(current);
}

function renderWordPanel(currentText) {
  const word = state.selectedWord;
  if (!word) {
    els.wordPanel.innerHTML = `
      <div class="empty-state">
        <p class="eyebrow">${escapeHtml(t("reader.wordPanelEyebrow"))}</p>
        <h2>${escapeHtml(t("reader.wordPanelHeading"))}</h2>
        <p>${escapeHtml(t("reader.wordPanelHint"))}</p>
      </div>
    `;
    return;
  }

  const isTransientRange = isTransientReaderRangeSelection();
  const entry = isTransientRange
    ? { status: "new", translation: "", note: "", imageUrl: "", examples: [] }
    : getOrCreateEntry(word, currentText.text);
  const context = entry.examples?.[0] || getSentenceForWord(
    currentText.text,
    word,
    state.preferences.learningLanguage || "en",
    state.preferences.wordDetectionAlgorithm || "modern"
  );
  
  let smartSuggestionHtml = "";
  const lang = state.preferences.learningLanguage || "en";
  if (context && word && !word.includes(" ")) {
    const articles = {
      de: ["der", "die", "das", "ein", "eine", "einen", "einem", "einer", "eines", "dem", "den", "des"],
      fr: ["le", "la", "les", "un", "une", "l'", "d'"],
      es: ["el", "la", "los", "las", "un", "una", "unos", "unas"],
      it: ["il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "un'"]
    };
    
    let suggestion = null;
    let suggestType = "";
    
    // 1. Check articles first (higher priority)
    if (articles[lang]) {
      const langArticles = articles[lang];
      const spaceArticles = langArticles.filter(a => !a.endsWith("'"));
      const aposArticles = langArticles.filter(a => a.endsWith("'"));
      const wordEsc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      // Is the clicked word preceded by an article?
      let patternParts = [];
      if (spaceArticles.length > 0) patternParts.push(`(?:\\b(?:${spaceArticles.join("|")})\\s+${wordEsc}\\b)`);
      if (aposArticles.length > 0) patternParts.push(`(?:\\b(?:${aposArticles.join("|")})${wordEsc}\\b)`);
      
      if (patternParts.length > 0) {
        const regex = new RegExp(patternParts.join("|"), "i");
        const match = context.match(regex);
        if (match) {
          suggestion = match[0];
          suggestType = t("reader.smartSuggestArticle");
        }
      }
      
      // Is the clicked word the ARTICLE itself?
      if (!suggestion && langArticles.includes(word.toLowerCase())) {
        const isApos = word.endsWith("'");
        const spaceRegex = isApos ? "" : "\\s+";
        // Look for an article and the next word
        const nextWordRegex = new RegExp(`\\b${wordEsc}${spaceRegex}([\\p{L}\\p{M}\\-]+)\\b`, "iu");
        const match = context.match(nextWordRegex);
        if (match) {
          suggestion = match[0];
          suggestType = t("reader.smartSuggestArticle");
        }
      }
    }
    
    // 2. If not an article, check German separable prefixes
    if (!suggestion && lang === "de") {
      const dePrefixes = ["ab", "an", "auf", "aus", "bei", "ein", "fest", "her", "herein", "hin", "hinaus", "los", "mit", "nach", "vor", "vorbei", "weg", "weiter", "zu", "zurück", "zusammen", "dran", "drauf", "raus", "rein", "rüber", "runter"];
      const pronouns = ["ich", "du", "er", "sie", "es", "wir", "ihr", "mich", "dich", "ihn", "uns", "euch", "ihnen", "mir", "dir", "ihm"];
      const wordsInContext = context.split(/[\s.,!?;:"'(){}\[\]„”«»\-]+/).filter(Boolean);
      
      if (wordsInContext.length > 1) {
        const lastWord = wordsInContext[wordsInContext.length - 1].toLowerCase();
        
        // Extended list of words that are definitely not verbs
        const deArticles = ["der", "die", "das", "ein", "eine", "einen", "einem", "einer", "eines", "dem", "den", "des"];
        const dePrepositions = ["um", "in", "auf", "unter", "über", "vor", "nach", "für", "mit", "ohne", "aus", "bei", "von", "zu", "durch", "gegen", "wider", "entlang", "bis", "ab", "seit", "wegen", "während", "trotz", "statt"];
        const deConjunctions = ["und", "oder", "aber", "weil", "dass", "wenn", "als", "denn", "ob", "obwohl", "da", "damit", "sodass"];
        const deAdverbs = ["nicht", "auch", "so", "nur", "noch", "schon", "sehr", "immer", "oft", "hier", "da", "dort", "heute", "morgen", "gestern", "jetzt", "dann", "danach", "vorher", "wieder", "gerne", "vielleicht", "wohl", "ja", "nein", "doch", "mal", "eben", "einfach", "halt", "ganz", "gar"];
        const deOthers = ["sich", "mein", "dein", "sein", "unser", "euer", "ihr", "meine", "deine", "seine", "unsere", "eure", "ihre", "meinen", "deinen", "seinen", "unseren", "euren", "ihren", "was", "wer", "wie", "wo", "wann", "warum", "wieso", "weshalb", "wohin", "woher", "wem", "wen", "man", "alle", "alles", "viele", "einige", "andere", "jedes", "jeden", "jede", "jeder", "kein", "keine", "keinen", "keinem", "keiner", "gut", "viel", "wenig", "mehr"];
        const nonVerbs = [...pronouns, ...deArticles, ...dePrepositions, ...deConjunctions, ...deAdverbs, ...deOthers];
        
        const isNonVerb = nonVerbs.includes(word.toLowerCase());
        const isNumber = /^[\d.,]+$/.test(word);
        
        // Find the original word in context to check capitalization
        const wordIndex = wordsInContext.findIndex(w => w.toLowerCase() === word.toLowerCase());
        const originalWordInContext = wordIndex >= 0 ? wordsInContext[wordIndex] : word;
        
        // Rough noun detection (capital letter mid-sentence)
        const isCapitalized = originalWordInContext[0] === originalWordInContext[0].toUpperCase() && originalWordInContext[0] !== originalWordInContext[0].toLowerCase();
        const isFirstWord = wordIndex === 0;
        const isLikelyNoun = isCapitalized && !isFirstWord;
        
        if (dePrefixes.includes(lastWord) && lastWord !== word.toLowerCase() && !isNonVerb && !isNumber && !isLikelyNoun) {
          // Check if prefix has already been consumed by another word in this sentence
          let isPrefixConsumed = false;
          for (const vocabWord in state.vocab) {
            if (vocabWord.toLowerCase().endsWith(" " + lastWord) && state.vocab[vocabWord].status !== "new") {
              const verbPart = vocabWord.split(" ")[0];
              if (!verbPart) continue;
              const verbRegex = new RegExp(`\\b${verbPart}\\b`, 'i');
              if (verbRegex.test(context)) {
                isPrefixConsumed = true;
                break;
              }
            }
          }
          
          if (!isPrefixConsumed) {
            suggestion = `${word} ${lastWord}`;
            suggestType = t("reader.smartSuggestSeparableVerb");
          }
        }
      }
    }
    
    if (suggestion) {
      let paramWord = suggestion.toLowerCase().replace(word.toLowerCase(), "").trim();
const suggestText = t("reader.smartSuggest");
const btnText = t("reader.smartSuggestBtn").replace("{word}", paramWord);
      smartSuggestionHtml = `
        <div style="margin-top: 0.75rem; background: rgba(35, 105, 77, 0.05); padding: 0.5rem; border-radius: 6px; border: 1px dashed var(--green); text-align: center;">
          <p style="font-size: 0.75rem; color: var(--green); margin: 0 0 0.4rem 0; opacity: 0.9;">${escapeHtml(suggestText)}</p>
          <button class="primary-button button-xs" type="button" data-suggest-word="${escapeHtml(suggestion)}" style="font-size: 0.8rem; padding: 0.2rem 0.5rem; height: auto; min-height: 24px;">
            ${escapeHtml(btnText)} <strong style="margin-left: 0.2rem">${escapeHtml(suggestion)}</strong> <span class="shortcut-badge" style="margin-left: 0.4rem; font-size: 0.7rem;">5</span>
          </button>
        </div>
      `;
    }
  }

  els.wordPanel.innerHTML = `
    <p class="eyebrow">${escapeHtml(statusLabel(entry.status))}</p>
    <h2 class="word-title">${escapeHtml(word)}</h2>
    <div class="word-form">
      <div class="status-options">
        ${STATUS_ORDER.map((status) => {
          const mapShortcut = { new: 1, learning: 2, known: 3, ignored: 4 };
          const mapIcon = { new: "☆", learning: "✎", known: "✓", ignored: "✕" };
          return `
            <button class="status-button status-${status} ${entry.status === status ? "active" : ""}" type="button" data-word="${escapeHtml(word)}" data-set-status="${status}">
              ${mapIcon[status]} ${escapeHtml(statusLabel(status))} <span class="shortcut-badge">${mapShortcut[status]}</span>
            </button>
          `;
        }).join("")}
      </div>
      ${smartSuggestionHtml}
      <label style="margin-top: ${smartSuggestionHtml ? '0.75rem' : '0'};">
        <span style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
          ${escapeHtml(t("reader.translationLabel"))} <span class="shortcut-badge" style="font-size: 0.65rem; padding: 0.1rem 0.3rem;">E</span>
        </span>
        <input type="text" value="${escapeAttribute(entry.translation || "")}" data-word="${escapeHtml(word)}" data-word-field="translation" placeholder="${escapeAttribute(t("reader.translationPlaceholder"))}">
      </label>
      <label>
        <span style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
          ${escapeHtml(t("reader.noteLabel"))} <span class="shortcut-badge" style="font-size: 0.65rem; padding: 0.1rem 0.3rem;">N</span>
        </span>
        <textarea rows="4" data-word="${escapeHtml(word)}" data-word-field="note" placeholder="${escapeAttribute(t("reader.notePlaceholder"))}">${escapeHtml(entry.note || "")}</textarea>
      </label>
      ${entry.imageUrl ? `
        <div class="word-image-preview" style="margin-top: 1rem; text-align: center; position: relative; display: inline-block; width: 100%;">
          <img src="${escapeAttribute(entry.imageUrl)}" style="max-height: 120px; max-width: 100%; border-radius: 6px; border: 1px solid var(--line);" />
          <button type="button" data-action="remove-image" data-word="${escapeHtml(word)}" style="position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; padding: 0; font-size: 12px; line-height: 1; border: none; background: var(--red); color: white; cursor: pointer;">×</button>
        </div>
      ` : `
        <div class="word-image-search" style="margin-top: 1rem; text-align: center;">
          <button class="secondary-button button-xs image-action-button" type="button" data-action="search-image" data-word="${escapeHtml(word)}" title="${escapeAttribute(t("vocab.addImage"))}">
            ${icon("image", 14)}
            ${escapeHtml(t("vocab.addImage"))}
            <span class="shortcut-badge">I</span>
          </button>
          <div id="image-search-results-${escapeHtml(word)}" style="margin-top: 0.25rem;"></div>
        </div>
      `}
      <div class="context-box">${escapeHtml(context || t("reader.noContext"))}</div>
      <div class="word-actions">
        <button class="secondary-button" type="button" data-dict-word="${escapeHtml(word)}" title="${escapeAttribute(t("vocab.openDictionary"))}">${icon("book", 18)}<span class="shortcut-badge">M</span></button>
        <button class="secondary-button" type="button" data-tts-word="${escapeHtml(word)}" title="${escapeAttribute(t("reader.ttsWordTitle"))}">${icon("speaker", 18)}<span class="shortcut-badge">${escapeHtml(t("reader.keySpace"))}</span></button>
        <button class="secondary-button" type="button" data-youglish-word="${escapeHtml(word)}" title="${escapeAttribute(t("reader.youglishWordTitle"))}">${icon("video", 18)}<span class="shortcut-badge">Y</span></button>
        <button class="secondary-button" type="button" data-delete-word="${escapeHtml(word)}" title="${escapeAttribute(t("reader.removeWord"))}">${icon("trash", 18)}<span class="shortcut-badge">X</span></button>
      </div>
    </div>
  `;
}

export function bindReaderEvents() {
  import("../dom.js").then(({ els }) => {
    els.textSelect.addEventListener("change", async () => {
      const actions = await import("../book-actions.js");
      actions.openBook(els.textSelect.value);
    });
    els.readerText.addEventListener("scroll", () => {
      if (els.readerText.dataset.rendering === "1") return;
      if (state.currentView !== "reader" || !state.currentTextId) return;
      clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(() => {
        const last = state.readerScrolls?.[state.currentTextId];
        if (last && last.readerPage != null && last.readerPage !== state.readerPage) return;
        rememberReaderScrollPosition();
      }, 150);
    }, { passive: true });
    els.readerText.addEventListener("click", async (event) => {
      if(event.target.classList.contains("word-token")) window.lastActiveToken = event.target;
      const token = event.target.closest(".word-token");
      if (token) {
        event.stopPropagation();
        const { selectWord } = await import("../vocab-actions.js");
        const { normalizeWord } = await import("../tokenizer_v2.js");
        const { state } = await import("../state.js");
        let wordToSelect = token.dataset.word;
        
        if (event.ctrlKey && state.selectedWord && state.selectedWord !== wordToSelect) {
          wordToSelect = state.selectedWord + " " + wordToSelect;
        } else {
          setReaderSelectionAnchorFromToken(token);
        }
        
        selectWord(wordToSelect, normalizeWord);
      } else {
        clearReaderSelectionRange(true);
      }
    });
    els.readerText.addEventListener("focusout", () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (!active) return;
        if (active.closest?.("#reader-text .word-token, #word-panel")) return;
        clearReaderSelectionRange(true);
      }, 150);
    });
    els.readerText.addEventListener("keydown", async (event) => {
      if (event.key === "5") {
        const suggestBtn = els.wordPanel.querySelector("[data-suggest-word]");
        if (suggestBtn) {
          event.preventDefault();
          suggestBtn.click();
        }
        return;
      }
      
      if (event.ctrlKey) return;
      if (event.key !== "Enter" && event.key !== " " && event.code !== "Space") return;
      const token = event.target.closest(".word-token");
      if (!token) return;

      const { state } = await import("../state.js");
      const isSpace = event.key === " " || event.key === "spacebar" || event.code === "Space";
      
      if (isSpace && state.readerSelectionRange && state.selectedWord !== token.dataset.word) {
        return;
      }

      if (isSpace && state.selectedWord === token.dataset.word) {
        return;
      }

      event.preventDefault();
      const { selectWord } = await import("../vocab-actions.js");
      const { normalizeWord } = await import("../tokenizer_v2.js");
      let wordToSelect = token.dataset.word;
      
      if (event.ctrlKey && state.selectedWord && state.selectedWord !== wordToSelect) {
          wordToSelect = state.selectedWord + " " + wordToSelect;
      } else {
          setReaderSelectionAnchorFromToken(token);
      }

      selectWord(wordToSelect, normalizeWord);
    });
    
    // Handle smart suggestion click
    els.wordPanel.addEventListener("click", async (event) => {
      const suggestBtn = event.target.closest("[data-suggest-word]");
      if (suggestBtn) {
        const { selectWord } = await import("../vocab-actions.js");
        const { normalizeWord } = await import("../tokenizer_v2.js");
        selectWord(suggestBtn.dataset.suggestWord, normalizeWord, true);
      }
    });
  });
}
