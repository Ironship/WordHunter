// All DOM event listeners — barrel module delegating to feature submodules.
import { state, saveState } from "./state.js";
import { els } from "./dom.js";
import { escapeAttribute } from "./utils.js";
import { clearReaderSelectionRange } from "./views/reader.js";
import { renderVocabulary, getOrCreateEntry, gradeReview, removeFromSrs, loadMoreVocab } from "./views/vocabulary.js";
import { setWordStatus, updateWordField, deleteWord, ignoreWord, handleReviewAction, setWordImage, removeWordImage } from "./vocab-actions.js";
import { importCustomText, addUserBook, removeUserBook, saveEditedBook, pasteImageToEditBook, moveBookToProfile, isEditBookDirty, cancelEditBook } from "./book-actions.js";
import { exportVocabularySelection } from "./sync-actions.js";
import { showToast } from "./toast.js";
import { t } from "./i18n.js";
import { openYouGlish } from "./youglish.js";
import { speakWord, speakText, stopSpeaking } from "./tts.js";
import { parseImportedTextFile, titleFromImportedFileName } from "./subtitles.js";
import { setReaderFontSize } from "./preferences.js";
import { openDictionary, getSelectedReaderActionText } from "./events/shared.js";
import { bindSettingsEvents } from "./events/settings.js";
import { bindTranslatorEvents } from "./events/translator.js";
import { bindNavigationEvents } from "./events/navigation.js";
import { bindDiscoverEvents } from "./events/discover.js";
import { registerUnsavedDialog } from "./dialog-backdrop.js";

const VOCAB_STATUS_FILTERS = ["new", "learning", "known", "ignored"];

function legacyVocabStatusFromSelected(statuses) {
  if (statuses.length === VOCAB_STATUS_FILTERS.length) return "all";
  if (statuses.length === 3 && !statuses.includes("ignored")) return "not_ignored";
  if (statuses.length === 1) return statuses[0];
  return "custom";
}

function imageSearchMessage(key) {
  return `<div style="font-size: 11px; color: var(--muted); padding: 0.25rem;">${t(key)}</div>`;
}

function uploadImageCardHtml(safeWord) {
  return `<div class="search-img-suggestion" style="cursor: pointer; text-align: center; border: 2px dashed var(--line); padding: 0.25rem; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; width: 180px;" data-action="upload-image" data-word="${safeWord}" title="${t("vocab.uploadOwnImage")}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 32px; height: 32px; color: var(--muted);"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
      <div style="font-size: 12px; margin-top: 0.25rem; color: var(--blue); font-weight: 500;">${t("vocab.uploadOwnImage")} <span class="shortcut-badge">Ctrl+4</span></div>
      <input type="file" accept="image/*" style="display:none" data-upload-image="${safeWord}">
    </div>`;
}

function uploadImageHtml(safeWord) {
  return `<div style="display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; margin-top: 0.5rem;">${uploadImageCardHtml(safeWord)}</div>`;
}

function imageSuggestionHtml(page, index, safeWord) {
  const imageUrl = escapeAttribute(page.thumbnail.source);
  return `<div class="search-img-suggestion" style="cursor: pointer; text-align: center; border: 1px solid var(--line); padding: 0.25rem; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: space-between; width: 180px;" data-action="save-image" data-word="${safeWord}" data-img-url="${imageUrl}" title="${t("vocab.clickToSave")}"><img src="${imageUrl}" style="height: 120px; width: 100%; object-fit: cover; border-radius: 4px;" /><div style="font-size: 12px; margin-top: 0.25rem; color: var(--blue); font-weight: 500;">${t("vocab.selectImage")} <span class="shortcut-badge">Ctrl+${index + 1}</span></div></div>`;
}

function renderImageSuggestions(container, word, pages) {
  const safeWord = escapeAttribute(word);
  const suggestions = Object.values(pages || {}).filter((page) => page?.thumbnail?.source).slice(0, 3);
  if (!suggestions.length) {
    container.innerHTML = imageSearchMessage(pages ? "toast.imageSearchNoImages" : "toast.imageSearchNoResults") + uploadImageHtml(safeWord);
    return;
  }
  container.innerHTML = `<div style="display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; margin-top: 0.5rem;">${suggestions.map((page, index) => imageSuggestionHtml(page, index, safeWord)).join("")}${uploadImageCardHtml(safeWord)}</div>`;
}

function renderImageSearch(container, word) {
  container.innerHTML = imageSearchMessage("toast.searching");
  const lang = state.preferences.learningLanguage || "de";
  fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(word)}&gsrlimit=10&prop=pageimages&format=json&pithumbsize=300&origin=*`)
    .then((response) => response.json())
    .then((data) => renderImageSuggestions(container, word, data?.query?.pages))
    .catch(() => {
      container.innerHTML = imageSearchMessage("toast.imageSearchError") + uploadImageHtml(escapeAttribute(word));
    });
}

export function bindEvents() {
  // Navigation & global keyboard shortcuts
  bindNavigationEvents();

  // ── Import form (cover, file, ebook, paste) ──
  let pendingCoverDataUrl = "";
  const resetCoverPreview = () => {
    pendingCoverDataUrl = "";
    if (els.importCoverImg) els.importCoverImg.src = "";
    if (els.importCoverPreview) els.importCoverPreview.hidden = true;
    if (els.importCover) els.importCover.value = "";
    const dropzone = document.getElementById("import-cover-dropzone");
    if (dropzone) dropzone.style.display = "flex";
  };
  const setImportCoverPreview = (dataUrl) => {
    pendingCoverDataUrl = dataUrl || "";
    if (els.importCoverImg) els.importCoverImg.src = pendingCoverDataUrl;
    if (els.importCoverPreview) els.importCoverPreview.hidden = !pendingCoverDataUrl;
    const dropzone = document.getElementById("import-cover-dropzone");
    if (dropzone) dropzone.style.display = pendingCoverDataUrl ? "none" : "flex";
  };
  const isEbookFile = (file) => /\.(epub|mobi|azw|azw3)$/i.test(file?.name || "");
  const readFileAsBase64 = async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };
  function setImportLoading(visible) {
    let overlay = document.getElementById("import-loading");
    if (visible) {
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "import-loading";
        overlay.className = "section-loading";
        overlay.style.position = "absolute";
        overlay.style.zIndex = "10";
        overlay.style.background = "var(--panel)";
        overlay.innerHTML = `<div class="spinner" aria-hidden="true"></div><p class="muted-copy">${t("import.parsingEbook")}</p>`;
        const form = document.getElementById("import-form");
        if (form) form.style.position = "relative", form.appendChild(overlay);
      }
      overlay.hidden = false;
    } else {
      const ov = document.getElementById("import-loading");
      if (ov) ov.hidden = true;
    }
  }

  const importEbookFile = async (file) => {
    if (!window.__qtBridge) {
      throw new Error(t("toast.ebookRequiresApp"));
    }
    setImportLoading(true);
    try {
      const response = await fetch("/__import/ebook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
        body: JSON.stringify({ filename: file.name, data: await readFileAsBase64(file) })
      });
      if (!response.ok) {
        const message = await response.text().catch(() => "");
        throw new Error(message || `HTTP ${response.status}`);
      }
      return response.json();
    } finally {
      setImportLoading(false);
    }
  };

  if (els.importFile) {
    els.importFile.addEventListener("change", async () => {
      const file = els.importFile.files?.[0];
      if (!file) return;
      try {
        if (isEbookFile(file)) {
          const ebook = await importEbookFile(file);
          if (!ebook.text) throw new Error("Imported ebook is empty");
          els.importText.value = ebook.text;
          if (!els.importTitle.value.trim()) els.importTitle.value = ebook.title || titleFromImportedFileName(file.name);
          if (els.importAuthor && !els.importAuthor.value.trim()) els.importAuthor.value = ebook.author || "";
          setImportCoverPreview(ebook.coverDataUrl || "");
        } else {
          const rawText = await file.text();
          const text = parseImportedTextFile(file, rawText);
          if (!text) throw new Error("Imported file is empty after parsing");
          els.importText.value = text;
          if (!els.importTitle.value.trim()) {
            els.importTitle.value = titleFromImportedFileName(file.name);
          }
        }
        showToast(t("toast.fileLoaded", { name: file.name }));
      } catch (err) {
        console.warn(err);
        showToast(t("toast.fileError"));
      }
    });
  }

  function handleImportCoverFile(file) {
    if (!file) return;
    if (file.size > 1_500_000) {
      showToast(t("toast.coverTooBig"));
      if (els.importCover) els.importCover.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { setImportCoverPreview(String(reader.result || "")); };
    reader.readAsDataURL(file);
  }

  function handleEditCoverFile(file) {
    if (!file) return;
    if (file.size > 1_500_000) {
      showToast(t("toast.coverTooBig"));
      if (els.editBookCover) els.editBookCover.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      import("./book-actions.js").then(m => m.setPendingEditCoverDataUrl(dataUrl));
      if (els.editBookCoverImg) els.editBookCoverImg.src = dataUrl;
      if (els.editBookCoverPreview) els.editBookCoverPreview.hidden = false;
      const dropzone = document.getElementById("edit-book-cover-dropzone");
      if (dropzone) dropzone.style.display = "none";
    };
    reader.readAsDataURL(file);
  }

  if (els.importCover) {
    els.importCover.addEventListener("change", () => handleImportCoverFile(els.importCover.files?.[0]));
  }

  document.addEventListener("paste", (e) => {
    const importOpen = state.currentView === "library";
    const editOpen = els.editBookDialog && els.editBookDialog.open;
    if (!importOpen && !editOpen) return;
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
    if (!items) return;
    let handled = false;
    for (let index in items) {
      const item = items[index];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          handled = true;
          if (editOpen) handleEditCoverFile(file);
          else if (importOpen) handleImportCoverFile(file);
        }
      }
    }
    if (handled) e.preventDefault();
  });

  if (els.importCoverClear) {
    els.importCoverClear.addEventListener("click", () => {
      pendingCoverDataUrl = null;
      if (els.importCoverImg) els.importCoverImg.src = "";
      if (els.importCoverPreview) els.importCoverPreview.hidden = true;
      if (els.importCover) els.importCover.value = "";
      const dropzone = document.getElementById("import-cover-dropzone");
      if (dropzone) dropzone.style.display = "flex";
    });
  }

  // Edit Book modal
  registerUnsavedDialog("edit-book-dialog", isEditBookDirty, () => saveEditedBook());
  if (els.editBookCancel) els.editBookCancel.addEventListener("click", () => cancelEditBook());
  if (els.editBookSave) els.editBookSave.addEventListener("click", () => saveEditedBook());
  // Enter to save in edit book dialog
  if (els.editBookDialog) {
    els.editBookDialog.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        saveEditedBook();
      }
    });
  }
  if (els.editBookCoverClear) els.editBookCoverClear.addEventListener("click", () => {
    import("./book-actions.js").then(m => m.setPendingEditCoverDataUrl(null));
    if (els.editBookCoverImg) els.editBookCoverImg.src = "";
    if (els.editBookCoverPreview) els.editBookCoverPreview.hidden = true;
    if (els.editBookCover) els.editBookCover.value = "";
    const dropzone = document.getElementById("edit-book-cover-dropzone");
    if (dropzone) dropzone.style.display = "flex";
  });
  if (els.editBookCover) {
    els.editBookCover.addEventListener("change", () => handleEditCoverFile(els.editBookCover.files?.[0]));
  }

  if (els.editBookText) {
    els.editBookText.addEventListener("paste", (e) => {
      const items = (e.clipboardData || e.originalEvent.clipboardData).items;
      for (const item of items) {
        if (item.type.indexOf("image") === 0) {
          const file = item.getAsFile();
          if (file) pasteImageToEditBook(file);
          e.preventDefault();
        }
      }
    });
  }

  els.importForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const meta = {
      author: els.importAuthor?.value,
      tags: els.importTags?.value,
      coverDataUrl: pendingCoverDataUrl
    };
    const levelVal = els.importLevel?.value;
    if (levelVal) meta.level = levelVal;
    importCustomText(els.importTitle.value, els.importText.value, meta);
    els.importForm.reset();
    resetCoverPreview();
  });

  // ── Global clicks (status, TTS, dictionary, image search, review) ──
  document.addEventListener("click", (event) => {
    const ttsWordBtn = event.target.closest("[data-tts-word]");
    if (ttsWordBtn) speakWord(getSelectedReaderActionText() || ttsWordBtn.dataset.ttsWord);

    const youglishBtn = event.target.closest("[data-youglish-word]");
    if (youglishBtn) openYouGlish(getSelectedReaderActionText() || youglishBtn.dataset.youglishWord);

    const dictBtn = event.target.closest("[data-dict-word]");
    if (dictBtn) openDictionary(getSelectedReaderActionText() || dictBtn.dataset.dictWord);

    if (state.currentView === "reader" && !event.target.closest("#reader-text, #word-panel")) {
      clearReaderSelectionRange(true);
    }

    const playTextBtn = event.target.closest("#tts-play-text");
    if (playTextBtn) {
      const readerTextEl = document.getElementById("reader-text");
      let currentText = readerTextEl ? readerTextEl.innerText || readerTextEl.textContent : "";
      if (state.selectedWord && currentText) {
        const wordIndex = currentText.toLowerCase().indexOf(state.selectedWord.toLowerCase());
        if (wordIndex >= 0) currentText = currentText.slice(wordIndex);
      }
      const stopBtn = document.getElementById("tts-stop-text");
      if (playTextBtn && stopBtn) { playTextBtn.hidden = true; stopBtn.hidden = false; }
      speakText(currentText, readerTextEl, () => {
        if (playTextBtn && stopBtn) { playTextBtn.hidden = false; stopBtn.hidden = true; }
      });
    }

    const stopTextBtn = event.target.closest("#tts-stop-text");
    if (stopTextBtn) stopSpeaking();

    const readerVocabListBtn = event.target.closest("#reader-vocab-list");
    if (readerVocabListBtn && state.currentTextId) {
      state.filters.vocabTextId = state.currentTextId;
      saveState();
      import("./render.js").then(m => m.setView("vocabulary"));
    }

    const exportVocabTxtBtn = event.target.closest("#export-vocab-txt");
    if (exportVocabTxtBtn) exportVocabularySelection("txt");

    const exportVocabAnkiBtn = event.target.closest("#export-vocab-anki");
    if (exportVocabAnkiBtn) exportVocabularySelection("anki");

    const statusButton = event.target.closest("[data-set-status]");
    if (statusButton) setWordStatus(statusButton.dataset.word, statusButton.dataset.setStatus);

    const deleteButton = event.target.closest("[data-delete-word]");
    if (deleteButton) deleteWord(deleteButton.dataset.deleteWord);

    const ignoreButton = event.target.closest("[data-ignore-word]");
    if (ignoreButton) ignoreWord(ignoreButton.dataset.ignoreWord);

    const reviewButton = event.target.closest("[data-review-action]");
    if (reviewButton) {
      if (reviewButton.dataset.reviewAction === "search-image") {
        const word = reviewButton.dataset.word;
        const container = document.getElementById(`review-image-search-results-${word}`);
        if (container) renderImageSearch(container, word);
      } else {
        handleReviewAction(reviewButton.dataset.reviewAction);
      }
    }

    const uploadImageBtn = event.target.closest("[data-action='upload-image']");
    if (uploadImageBtn) {
      const fileInput = uploadImageBtn.querySelector('input[type="file"]');
      if (fileInput) fileInput.click();
    }

    const uploadFileInput = event.target.closest("[data-upload-image]");
    if (uploadFileInput && uploadFileInput.files && uploadFileInput.files[0]) {
      const word = uploadFileInput.dataset.uploadImage;
      const file = uploadFileInput.files[0];
      const reader = new FileReader();
      reader.onload = (e) => { setWordImage(word, e.target.result); };
      reader.readAsDataURL(file);
      uploadFileInput.value = "";
    }

    const searchImageBtn = event.target.closest("[data-action='search-image']");
    if (searchImageBtn) {
      const word = searchImageBtn.dataset.word;
      const container = document.getElementById(`image-search-results-${word}`);
      if (container) renderImageSearch(container, word);
    }

    const saveImageBtn = event.target.closest("[data-action='save-image']");
    if (saveImageBtn) { setWordImage(saveImageBtn.dataset.word, saveImageBtn.dataset.imgUrl); }

    const removeImageBtn = event.target.closest("[data-action='remove-image']");
    if (removeImageBtn) { removeWordImage(removeImageBtn.dataset.word); }

    const sm2Button = event.target.closest("[data-sm2-grade]");
    if (sm2Button) gradeReview(sm2Button.dataset.word, Number(sm2Button.dataset.sm2Grade));

    const srsRemove = event.target.closest("[data-srs-remove]");
    if (srsRemove) removeFromSrs(srsRemove.dataset.srsRemove);

    const fontButton = event.target.closest("[data-font]");
    if (fontButton) {
      const delta = fontButton.dataset.font === "up" ? 1 : -1;
      setReaderFontSize((state.readerFontSize || 18) + delta);
      import("./preferences.js").then(m => m.syncSettingsControls());
    }

    const loadMoreVocabBtn = event.target.closest("#load-more-vocab");
    if (loadMoreVocabBtn) loadMoreVocab();
  });

  document.addEventListener("input", (event) => {
    const field = event.target.closest("[data-word-field]");
    if (!field) return;
    if (field.classList.contains("vocab-translation-input")) {
      field.classList.toggle("empty", !field.value.trim());
    }
    updateWordField(field.dataset.word, field.dataset.wordField, field.value);
  });

  // Vocabulary search & filters
  let vocabSearchDebounceTimer = null;
  els.vocabSearch.addEventListener("input", () => {
    clearTimeout(vocabSearchDebounceTimer);
    vocabSearchDebounceTimer = setTimeout(() => {
      state.filters.vocabQuery = els.vocabSearch.value;
      saveState();
      renderVocabulary();
    }, 200);
  });
  if (els.vocabStatusFilters?.length) {
    els.vocabStatusFilters.forEach((input) => input.addEventListener("change", () => {
      const selected = els.vocabStatusFilters.filter((cb) => cb.checked).map((cb) => cb.value).filter((s) => VOCAB_STATUS_FILTERS.includes(s));
      state.filters.vocabStatuses = selected;
      state.filters.vocabStatus = legacyVocabStatusFromSelected(selected);
      saveState();
      renderVocabulary();
    }));
  } else if (els.vocabStatusFilter) {
    els.vocabStatusFilter.addEventListener("change", () => {
      state.filters.vocabStatus = els.vocabStatusFilter.value;
      state.filters.vocabStatuses = els.vocabStatusFilter.value === "all" ? [...VOCAB_STATUS_FILTERS] : els.vocabStatusFilter.value === "not_ignored" ? ["new", "learning", "known"] : [els.vocabStatusFilter.value].filter((s) => VOCAB_STATUS_FILTERS.includes(s));
      saveState();
      renderVocabulary();
    });
  }
  if (els.vocabTextFilter) {
    els.vocabTextFilter.addEventListener("change", () => {
      state.filters.vocabTextId = els.vocabTextFilter.value || "all";
      saveState();
      renderVocabulary();
    });
  }

  // Move book dialog
  let moveBookTarget = null;
  let moveBookIsCustom = false;
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='move-book']");
    if (!btn) return;
    moveBookTarget = btn.dataset.id;
    moveBookIsCustom = btn.dataset.iscustom === "true";
    const dialog = document.getElementById("move-book-dialog");
    const select = document.getElementById("move-book-select");
    const langs = [{ code: "en" }, { code: "de" }, { code: "es" }, { code: "it" }, { code: "fr" }, { code: "pl" }, { code: "uk" }, { code: "ru" }];
    select.innerHTML = langs.filter(l => l.code !== state.preferences.learningLanguage).map(l => `<option value="${l.code}">${t(`languages.${l.code}`)}</option>`).join("");
    dialog.showModal();
  });
  const moveCancelBtn = document.getElementById("move-book-cancel");
  if (moveCancelBtn) moveCancelBtn.addEventListener("click", () => document.getElementById("move-book-dialog").close());
  const moveConfirmBtn = document.getElementById("move-book-confirm");
  if (moveConfirmBtn) {
    moveConfirmBtn.addEventListener("click", () => {
      const select = document.getElementById("move-book-select");
      if (select.value && moveBookTarget) moveBookToProfile(moveBookTarget, select.value, moveBookIsCustom);
      document.getElementById("move-book-dialog").close();
    });
    // Enter on move-book select triggers confirm
    const moveSelect = document.getElementById("move-book-select");
    if (moveSelect) {
      moveSelect.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          moveConfirmBtn.click();
        }
      });
    }
  }

  // Add / Edit word dialog
  const addWordBtn = document.getElementById("add-word-btn");
  const addWordDialog = document.getElementById("add-word-dialog");
  const addWordInput = document.getElementById("add-word-input");
  const addTranslationInput = document.getElementById("add-translation-input");
  const addExampleInput = document.getElementById("add-example-input");
  const addWordConfirm = document.getElementById("add-word-confirm");
  const addWordCancel = document.getElementById("add-word-cancel");
  const addWordEditing = document.getElementById("add-word-editing");
  const addWordStatusInputs = [...document.querySelectorAll("input[name='add-word-status']")];
  let addWordOriginalValues = null;

  function getAddWordStatus() {
    return addWordStatusInputs.find(input => input.checked)?.value || "new";
  }

  function setAddWordStatus(status) {
    const normalized = VOCAB_STATUS_FILTERS.includes(status) ? status : "new";
    addWordStatusInputs.forEach(input => { input.checked = input.value === normalized; });
  }

  function isAddWordDirty() {
    if (!addWordOriginalValues) return false;
    const word = addWordInput?.value || "";
    const translation = addTranslationInput?.value || "";
    const example = addExampleInput?.value || "";
    const status = getAddWordStatus();
    return word !== addWordOriginalValues.word
      || translation !== addWordOriginalValues.translation
      || example !== addWordOriginalValues.example
      || status !== addWordOriginalValues.status;
  }

  function resetAddWordDirty() {
    addWordOriginalValues = null;
  }

  function captureAddWordOriginal() {
    addWordOriginalValues = {
      word: addWordInput?.value || "",
      translation: addTranslationInput?.value || "",
      example: addExampleInput?.value || "",
      status: getAddWordStatus()
    };
  }

  registerUnsavedDialog(
    "add-word-dialog",
    isAddWordDirty,
    () => addWordConfirm.click(),
    () => { resetAddWordDirty(); addWordDialog.close(); }
  );

  if (addWordBtn && addWordDialog) {
    addWordBtn.addEventListener("click", () => {
      addWordEditing.value = "";
      if (addWordInput) { addWordInput.value = ""; addWordInput.disabled = false; }
      if (addTranslationInput) addTranslationInput.value = "";
      if (addExampleInput) addExampleInput.value = "";
      setAddWordStatus("new");
      const title = addWordDialog.querySelector("#add-word-dialog-title");
      if (title) title.textContent = t("vocab.addWordTitle");
      addWordConfirm.textContent = t("vocab.addWordConfirm");
      captureAddWordOriginal();
      addWordDialog.showModal();
      if (addWordInput) setTimeout(() => addWordInput.focus(), 100);
    });
  }

  // Edit word buttons (delegated from vocab table)
  document.addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit-word]");
    if (!editBtn || !addWordDialog) return;
    const word = editBtn.dataset.editWord;
    const entry = state.vocab[word];
    if (!entry) return;
    addWordEditing.value = word;
    if (addWordInput) { addWordInput.value = word; addWordInput.disabled = true; }
    if (addTranslationInput) addTranslationInput.value = entry.translation || "";
    if (addExampleInput) addExampleInput.value = (entry.examples && entry.examples[0]) || entry.note || "";
    setAddWordStatus(entry.status || "new");
    const title = addWordDialog.querySelector("#add-word-dialog-title");
    if (title) title.textContent = t("vocab.editWordTitle");
    addWordConfirm.textContent = t("vocab.editWordConfirm");
    captureAddWordOriginal();
    addWordDialog.showModal();
    if (addTranslationInput) setTimeout(() => addTranslationInput.focus(), 100);
  });

  if (addWordCancel && addWordDialog) {
    addWordCancel.addEventListener("click", () => {
      resetAddWordDirty();
      addWordDialog.close();
    });
  }
  if (addWordConfirm && addWordDialog) {
    addWordConfirm.addEventListener("click", () => {
      const editing = addWordEditing?.value;
      const selectedStatus = getAddWordStatus();
      if (editing) {
        // Edit mode — update existing entry
        const entry = state.vocab[editing];
        if (!entry) return;
        const translation = addTranslationInput?.value.trim();
        if (translation !== undefined) entry.translation = translation;
        entry.status = selectedStatus;
        const example = addExampleInput?.value.trim();
        if (example) {
          entry.examples = [example, ...(entry.examples || []).filter(e => e !== example)].slice(0, 3);
        } else {
          entry.examples = entry.examples || [];
        }
        entry.updatedAt = new Date().toISOString();
      } else {
        // Add mode — create new entry
        const word = addWordInput?.value.trim();
        if (!word) return;
        getOrCreateEntry(word);
        state.vocab[word].status = selectedStatus;
        const translation = addTranslationInput?.value.trim();
        if (translation) {
          state.vocab[word].translation = translation;
        }
        const example = addExampleInput?.value.trim();
        if (example) {
          if (!state.vocab[word].examples?.includes(example)) {
            state.vocab[word].examples = [example, ...(state.vocab[word].examples || [])].slice(0, 3);
          }
        }
      }
      saveState();
      renderVocabulary();
      resetAddWordDirty();
      addWordDialog.close();
    });
    addWordDialog.addEventListener("keydown", (e) => {
      if (e.target === addExampleInput && e.key === "Enter" && !e.ctrlKey && !e.metaKey) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        addWordConfirm.click();
      }
    });
  }

  // Feature submodules
  bindSettingsEvents();
  bindTranslatorEvents();
  bindDiscoverEvents({ addUserBook, removeUserBook });
}
