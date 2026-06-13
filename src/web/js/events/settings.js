import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { t, loadLocale, applyTranslations } from "../i18n.js";
import { render, setView } from "../render.js";
import { renderLibrary } from "../views/library.js";
import { renderReader } from "../views/reader.js";
import { renderReview } from "../views/vocabulary.js";
import { renderDiscover } from "../views/discover.js";
import { applyPreferences, syncSettingsControls, updatePreferenceValue, resetPreferences, setReaderFontSize } from "../preferences.js";
import { showToast } from "../toast.js";
import { exportState, importStateFile, clearLocalState, clearWords, clearLibrary, exportAnkiTsv, importAnkiTsv } from "../sync-actions.js";
import { switchLearningLanguage } from "../state.js";

function resetReaderScrollForCurrentText() {
  if (!state.currentTextId) return;
  if (!state.readerScrolls) state.readerScrolls = {};
  state.readerScrolls[state.currentTextId] = { wordIndex: null, scrollTop: 0, readerPage: 1 };
}

export function bindSettingsEvents() {
  // Settings
  const exportBtn = document.getElementById("export-state");
  if (exportBtn) exportBtn.addEventListener("click", exportState);

  const exportAnkiBtn = document.getElementById("export-anki-tsv");
  if (exportAnkiBtn) exportAnkiBtn.addEventListener("click", exportAnkiTsv);

  if (els.ankiExportStatusFilters?.length) {
    els.ankiExportStatusFilters.forEach((input) => {
      input.addEventListener("change", () => {
        const selected = els.ankiExportStatusFilters
          .filter((statusInput) => statusInput.checked)
          .map((statusInput) => statusInput.value);
        updatePreferenceValue("ankiExportStatuses", selected.length ? selected : ["learning"]);
        syncSettingsControls();
      });
    });
  }

  const importFile = document.getElementById("import-state");
  if (importFile) importFile.addEventListener("change", importStateFile);

  const importAnkiFile = document.getElementById("import-anki-tsv");
  if (importAnkiFile) importAnkiFile.addEventListener("change", importAnkiTsv);

  if (els.clearWords) els.clearWords.addEventListener("click", clearWords);
  if (els.clearLibrary) els.clearLibrary.addEventListener("click", clearLibrary);
  if (els.clearState) els.clearState.addEventListener("click", clearLocalState);

  if (els.resetPrefs) {
    els.resetPrefs.addEventListener("click", () => {
      resetPreferences();
      renderLibrary();
      renderReader();
      showToast(t("toast.prefsReset"));
    });
  }

  if (els.prefRemovalBehavior) {
    els.prefRemovalBehavior.addEventListener("change", (e) => updatePreferenceValue("removalBehavior", e.target.value));
  }

  els.prefTheme.addEventListener("change", () => { updatePreferenceValue("theme", els.prefTheme.value); renderLibrary(); renderReader(); });
  if (els.prefLocale) {
    els.prefLocale.addEventListener("change", async () => {
      const value = els.prefLocale.value;
      state.preferences.locale = value;
      saveState();
      await loadLocale(value);
      applyTranslations();
      syncSettingsControls();
      render();
      showToast(t("toast.languageChanged", { name: t(`languages.${value}`) }));
    });
  }
  if (els.prefLearningLanguage) {
    els.prefLearningLanguage.addEventListener("change", () => {
      switchLearningLanguage(els.prefLearningLanguage.value);
      syncSettingsControls();
      render();
      import("../books.js").then((books) => Promise.all([
        books.loadAllBookTexts(),
        books.loadAllCustomTextContents()
      ])).then(() => render()).catch((error) => console.warn("Not all books loaded:", error));
      showToast(t("toast.learningLanguageChanged"));
    });
  }
  if (els.prefDictionaryUrl) {
    els.prefDictionaryUrl.addEventListener("change", () => {
      state.preferences.dictionaryUrl = els.prefDictionaryUrl.value;
      updatePreferenceValue("dictionaryUrl", els.prefDictionaryUrl.value);
    });
  }
  if (els.prefDictionaryMode) {
    els.prefDictionaryMode.addEventListener("change", () => {
      state.preferences.dictionaryMode = els.prefDictionaryMode.value;
      updatePreferenceValue("dictionaryMode", els.prefDictionaryMode.value);
    });
  }
  els.prefFont.addEventListener("change", (e) => updatePreferenceValue("readerFont", e.target.value));
  if (els.prefWordsPerPage) els.prefWordsPerPage.addEventListener("change", (e) => {
    state.readerPage = 1; // reset page when changing words per page
    resetReaderScrollForCurrentText();
    updatePreferenceValue("wordsPerPage", e.target.value);
    renderReader();
  });
  if (els.prefWordAlgorithm) els.prefWordAlgorithm.addEventListener("change", (e) => {
    state.preferences.wordDetectionAlgorithm = e.target.value === "classic" ? "classic" : "modern";
    state.readerPage = 1;
    resetReaderScrollForCurrentText();
    saveState();
    applyPreferences();
    render();
  });
  if (els.prefSrsAlgorithm) els.prefSrsAlgorithm.addEventListener("change", (e) => {
    state.preferences.srsAlgorithm = e.target.value === "fsrs" ? "fsrs" : "sm2";
    saveState();
    applyPreferences();
    renderReview();
  });
  els.prefLineHeight.addEventListener("change", (e) => updatePreferenceValue("readerLineHeight", e.target.value));
  if (els.prefTextAlign) els.prefTextAlign.addEventListener("change", (e) => updatePreferenceValue("readerTextAlign", e.target.value));
  if (els.prefMaxWidth) els.prefMaxWidth.addEventListener("change", (e) => updatePreferenceValue("readerMaxWidth", e.target.value));
  if (els.prefTtsRate) els.prefTtsRate.addEventListener("change", (e) => updatePreferenceValue("ttsRate", e.target.value));
  if (els.prefUseEdgeTts) els.prefUseEdgeTts.addEventListener("change", (e) => updatePreferenceValue("useEdgeTts", e.target.checked));
  els.prefHighlight.addEventListener("change", (e) => updatePreferenceValue("highlightTokens", e.target.checked));
  if (els.prefHideKnown) els.prefHideKnown.addEventListener("change", (e) => updatePreferenceValue("hideKnownIgnored", e.target.checked));
  if (els.prefReviewGraphType) els.prefReviewGraphType.addEventListener("change", (e) => {
    updatePreferenceValue("reviewGraphType", e.target.value);
    import("../views/vocabulary.js").then(m => m.renderReview());
  });
  els.prefAutoLearn.addEventListener("change", (e) => updatePreferenceValue("autoLearnOnClick", e.target.checked));
  if (els.prefAutoAddLearning) els.prefAutoAddLearning.addEventListener("change", (e) => updatePreferenceValue("autoAddLearningOnly", e.target.checked));
  if (els.prefAutoTranslate) els.prefAutoTranslate.addEventListener("change", (e) => updatePreferenceValue("autoTranslateWords", e.target.checked));
  
  if (els.prefOfflineTranslator) {
    els.prefOfflineTranslator.addEventListener("change", async (e) => {
      if (e.target.checked) {
        // Dynamically build the language list in the download dialog
        const { t } = await import("../i18n.js");
        const supported = ["en", "pl", "de", "es", "fr", "it", "uk", "ru", "ja"];
        
        if (els.argosLanguagesList) {
          els.argosLanguagesList.innerHTML = supported.map(lang => `
            <label class="status-check" style="justify-content: flex-start; gap: 0.5rem;">
              <input type="checkbox" value="${lang}" ${lang === (state.preferences.locale || "pl") || lang === (state.preferences.learningLanguage || "en") ? "checked" : ""}>
              <span>${t(`languages.${lang}`)} (${lang.toUpperCase()})</span>
            </label>
          `).join("");
          
          // Update button text with size
          const updateBtnText = () => {
            const count = els.argosLanguagesList.querySelectorAll("input:checked").length;
            els.argosDownloadConfirm.textContent = t("settings.argosDownloadSize", { label: t("settings.argosDownloadConfirm"), size: count * 150 });
          };
          
          els.argosLanguagesList.querySelectorAll("input").forEach(cb => cb.addEventListener("change", updateBtnText));
          updateBtnText();
        }

        if (els.argosDownloadDialog) els.argosDownloadDialog.showModal();
      } else {
        updatePreferenceValue("offlineTranslator", false);
        if (els.prefArgosAsDictRow) {
          els.prefArgosAsDictRow.style.opacity = "0.5";
          els.prefArgosAsDictRow.style.pointerEvents = "none";
        }
        if (els.prefAutoTranslateRow) {
          els.prefAutoTranslateRow.style.opacity = "0.5";
          els.prefAutoTranslateRow.style.pointerEvents = "none";
        }
        if (els.prefArgosAsDict) {
          els.prefArgosAsDict.checked = false;
          updatePreferenceValue("argosAsDict", false);
        }
        const { renderTranslator } = await import("../views/translator.js");
        renderTranslator();
      }
    });
  }

  if (els.prefArgosAsDict) {
    els.prefArgosAsDict.addEventListener("change", (e) => updatePreferenceValue("argosAsDict", e.target.checked));
  }

  if (els.argosDownloadCancel) {
    els.argosDownloadCancel.addEventListener("click", async () => {
      if (els.argosDownloadDialog) els.argosDownloadDialog.close();
      if (els.prefOfflineTranslator) els.prefOfflineTranslator.checked = false;
      updatePreferenceValue("offlineTranslator", false);
      if (els.prefArgosAsDictRow) {
        els.prefArgosAsDictRow.style.opacity = "0.5";
        els.prefArgosAsDictRow.style.pointerEvents = "none";
      }
      if (els.prefAutoTranslateRow) {
        els.prefAutoTranslateRow.style.opacity = "0.5";
        els.prefAutoTranslateRow.style.pointerEvents = "none";
      }
      const { renderTranslator } = await import("../views/translator.js");
      renderTranslator();
    });
  }

  if (els.argosDownloadConfirm) {
    els.argosDownloadConfirm.addEventListener("click", async () => {
      const checkedBoxes = Array.from(els.argosLanguagesList.querySelectorAll("input:checked"));
      const toCodes = checkedBoxes.map(cb => cb.value);
      
      if (toCodes.length === 0) {
        import("../toast.js").then(m => m.showToast(t("toast.selectAtLeastOneLanguage")));
        return;
      }
      
      els.argosDownloadConfirm.disabled = true;
      els.argosDownloadConfirm.textContent = t("toast.downloadingWait");
      
      try {
        const languages = Array.from(new Set(["en", state.preferences.learningLanguage || "en", ...toCodes]));
        const response = await fetch("/__argos/install", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WH-Token": window.WH_TOKEN || ""
          },
          body: JSON.stringify({ from: languages, to: languages })
        });
        
        if (!response.ok) throw new Error("Failed to download models");
        
        updatePreferenceValue("offlineTranslator", true);
        if (els.prefArgosAsDictRow) {
          els.prefArgosAsDictRow.style.opacity = "1";
          els.prefArgosAsDictRow.style.pointerEvents = "auto";
        }
        if (els.prefAutoTranslateRow) {
          els.prefAutoTranslateRow.style.opacity = "1";
          els.prefAutoTranslateRow.style.pointerEvents = "auto";
        }
        if (els.argosDownloadDialog) els.argosDownloadDialog.close();
        const { refreshTranslatorAvailability, invalidatePackagesCache } = await import("../views/translator.js");
        invalidatePackagesCache();
        await refreshTranslatorAvailability();
        import("../toast.js").then(m => m.showToast(t("toast.modelsDownloaded")));
      } catch (err) {
        console.error("Argos install error", err);
        import("../toast.js").then(m => m.showToast(t("toast.modelsDownloadError")));
        if (els.prefOfflineTranslator) els.prefOfflineTranslator.checked = false;
        if (els.prefArgosAsDictRow) {
          els.prefArgosAsDictRow.style.opacity = "0.5";
          els.prefArgosAsDictRow.style.pointerEvents = "none";
        }
        if (els.prefAutoTranslateRow) {
          els.prefAutoTranslateRow.style.opacity = "0.5";
          els.prefAutoTranslateRow.style.pointerEvents = "none";
        }
        updatePreferenceValue("offlineTranslator", false);
        const { renderTranslator } = await import("../views/translator.js");
        renderTranslator();
      } finally {
        els.argosDownloadConfirm.disabled = false;
        els.argosDownloadConfirm.textContent = t("settings.argosDownloadConfirm");
      }
    });
  }

  els.prefCardStats.addEventListener("change", () => { updatePreferenceValue("showCardStats", els.prefCardStats.checked); renderLibrary(); });
  if (els.prefCovers) {
    els.prefCovers.addEventListener("change", () => { updatePreferenceValue("showCovers", els.prefCovers.checked); renderLibrary(); renderDiscover(); });
  }
  
  if (els.prefColorNew) els.prefColorNew.addEventListener("input", (e) => updatePreferenceValue("colorNew", e.target.value));
  if (els.prefColorLearning) els.prefColorLearning.addEventListener("input", (e) => updatePreferenceValue("colorLearning", e.target.value));
  if (els.prefColorKnown) els.prefColorKnown.addEventListener("input", (e) => updatePreferenceValue("colorKnown", e.target.value));
  if (els.prefColorIgnored) els.prefColorIgnored.addEventListener("input", (e) => updatePreferenceValue("colorIgnored", e.target.value));
  
  els.prefFontSize.addEventListener("input", (e) => setReaderFontSize(e.target.value));
}
