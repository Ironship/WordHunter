import { els } from "../dom.js";
import { t } from "../i18n.js";
import { state } from "../state.js";
import { showToast } from "../toast.js";
import { escapeHtml } from "../utils.js";
import { activeTranslationProvider, canUseTranslationProvider, translateText } from "../translation-provider.js";
import { TRANSLATOR_LANGUAGES } from "../constants.js";

// All languages supported by online/local translator providers.
const SUPPORTED_LANGUAGES = TRANSLATOR_LANGUAGES;

let translateTimer = null;

function modelKey(model) {
  return `${model.from}:${model.to}`;
}

function normalizeModels(models) {
  const seen = new Set();
  return (Array.isArray(models) ? models : [])
    .filter((model) => model && typeof model.from === "string" && typeof model.to === "string")
    .filter((model) => {
      const key = modelKey(model);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

function getModels() {
  return normalizeModels(state.argosModels);
}

function languageName(code) {
  const translated = t(`languages.${code}`);
  return translated === `languages.${code}` ? code.toUpperCase() : translated;
}

function updateTranslatorNavState(hasModels) {
  if (!els.translatorNavItem) return;
  const provider = activeTranslationProvider();
  const locked = !canUseTranslationProvider() || (provider === "offline" && !hasModels);
  els.translatorNavItem.hidden = false;
  els.translatorNavItem.classList.toggle("nav-item-locked", locked);
  els.translatorNavItem.title = locked ? t("translator.providerUnavailable") : t("nav.translator");
}

let _packagesFetched = false;

export function invalidatePackagesCache() {
  _packagesFetched = false;
}

export async function refreshTranslatorAvailability() {
  try {
    const response = await fetch("/__argos/status", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.argosModels = normalizeModels(data.models);
    state.argosAvailable = data.available === true && state.argosModels.length > 0;
  } catch (_error) {
    state.argosAvailable = false;
    state.argosModels = [];
  }

  // Fetch available packages only once (they don't change unless models are installed)
  if (!_packagesFetched) {
    try {
      const pkgRes = await fetch("/__argos/packages", { cache: "no-cache" });
      if (pkgRes.ok) {
        const pkgData = await pkgRes.json();
        state.argosAvailablePackages = Array.isArray(pkgData.packages) ? pkgData.packages : [];
        _packagesFetched = true;
      }
    } catch (_e) {
      state.argosAvailablePackages = [];
    }
  }

  const hasModels = state.argosAvailable && getModels().length > 0;
  updateTranslatorNavState(hasModels);
  renderTranslator();
  return hasModels;
}

/** Check if a model exists (directly or via English pivot) for the given pair. */
function hasModelForPair(fromCode, toCode) {
  if (!fromCode || !toCode || fromCode === toCode) return true;
  const installed = getModels();
  // Direct model
  if (installed.some(m => m.from === fromCode && m.to === toCode)) return true;
  // Pivot through English
  if (fromCode !== "en" && toCode !== "en") {
    if (installed.some(m => m.from === fromCode && m.to === "en") &&
        installed.some(m => m.from === "en" && m.to === toCode)) return true;
  }
  return false;
}

/** Find the package size for a missing pair, or return estimated size. */
function getPackageSize(fromCode, toCode) {
  const pkgs = (state.argosAvailablePackages) || [];
  const found = pkgs.find(p => p.from === fromCode && p.to === toCode);
  return found ? found.size_mb : 150;
}

/** Return all supported language codes (not just those with installed models). */
function getAllLanguageCodes() {
  return [...SUPPORTED_LANGUAGES];
}

function optionHtml(code, selected) {
  return `<option value="${escapeHtml(code)}" ${code === selected ? "selected" : ""}>${escapeHtml(languageName(code))} (${escapeHtml(code.toUpperCase())})</option>`;
}

function ensureSelectedPair() {
  const models = getModels();
  if (!models.length || !els.translatorFrom || !els.translatorTo) {
    // Offline translator not available — still show languages so user can see the UI
    const allCodes = getAllLanguageCodes();
    return {
      fromCode: allCodes[0] || "",
      toCode: allCodes[1] || allCodes[0] || "",
      fromCodes: allCodes,
      toCodes: allCodes
    };
  }

  const allCodes = getAllLanguageCodes();
  let fromCode = els.translatorFrom.value || state.preferences.learningLanguage || allCodes[0];
  if (!allCodes.includes(fromCode)) fromCode = allCodes[0];

  let toCode = els.translatorTo.value || state.preferences.locale || allCodes.find(c => c !== fromCode) || allCodes[0];
  if (!allCodes.includes(toCode)) toCode = allCodes.find(c => c !== fromCode) || allCodes[0];

  return { fromCode, toCode, fromCodes: allCodes, toCodes: allCodes };
}

export function renderTranslator() {
  if (!els.translatorFrom || !els.translatorTo) return;

  const models = getModels();
  const pair = ensureSelectedPair();
  const hasModels = state.argosAvailable && models.length > 0;
  const provider = activeTranslationProvider();
  const canTranslate = canUseTranslationProvider() && (provider !== "offline" || hasModels);
  updateTranslatorNavState(hasModels);

  // Save current language codes BEFORE rebuilding innerHTML
  const currentFrom = pair.fromCode;
  const currentTo = pair.toCode;

  if (els.translatorSource) els.translatorSource.disabled = !canTranslate;
  if (els.translatorResult) els.translatorResult.disabled = !canTranslate;
  if (els.translatorSwap) els.translatorSwap.disabled = false;
  
  els.translatorFrom.innerHTML = pair.fromCodes.map((code) => optionHtml(code, currentFrom)).join("");
  els.translatorTo.innerHTML = pair.toCodes.map((code) => optionHtml(code, currentTo)).join("");

  if (!canTranslate) {
    if (els.translatorStatus) els.translatorStatus.textContent = provider === "offline" ? t("translator.noModels") : t("translator.providerUnavailable");
  } else if (els.translatorStatus && !els.translatorStatus.dataset.busy) {
    els.translatorStatus.textContent = t("translator.ready");
  }
  updateTranslatorFlags(currentFrom, currentTo);
}

function updateTranslatorFlags(fromCode, toCode) {
  const fromFlag = document.getElementById("translator-from-flag");
  const toFlag = document.getElementById("translator-to-flag");
  const fCode = fromCode || els.translatorFrom?.value;
  const tCode = toCode || els.translatorTo?.value;
  if (fromFlag && fCode) {
    fromFlag.src = `flags/${fCode}.svg`;
    fromFlag.style.display = "block";
  }
  if (toFlag && tCode) {
    toFlag.src = `flags/${tCode}.svg`;
    toFlag.style.display = "block";
  }
}

async function translateNow() {
  if (!els.translatorSource || !els.translatorResult) return;
  const text = els.translatorSource.value.trim();
  if (!text) {
    els.translatorResult.value = "";
    if (els.translatorStatus) els.translatorStatus.textContent = t("translator.ready");
    return;
  }

  const pair = ensureSelectedPair();
  const provider = activeTranslationProvider();
  if (!canUseTranslationProvider()) {
    showToast(t("translator.providerUnavailable"), "error");
    return;
  }

  // Check if a model exists for this pair (direct or pivot)
  if (provider === "offline" && !hasModelForPair(pair.fromCode, pair.toCode) && pair.fromCode !== pair.toCode) {
    const sizeMb = getPackageSize(pair.fromCode, pair.toCode);
    if (els.translatorStatus) {
      els.translatorStatus.innerHTML = `${t("translator.noModelFor", { from: languageName(pair.fromCode), to: languageName(pair.toCode) })} <button class="ghost-button" id="translator-download-prompt" style="font-size:0.8rem; padding:0.2rem 0.5rem;">${t("translator.downloadNow")} (${t("translator.sizeMb", { size: Math.round(sizeMb) })})</button>`;
      const downloadBtn = document.getElementById("translator-download-prompt");
      if (downloadBtn) {
        downloadBtn.addEventListener("click", () => openDownloadDialog(pair.fromCode, pair.toCode));
      }
    }
    return;
  }

  if (els.translatorStatus) {
    els.translatorStatus.dataset.busy = "true";
    els.translatorStatus.textContent = t("translator.translating");
  }
  if (els.translatorProgress) els.translatorProgress.classList.add("active");

  try {
    const data = await translateText(text, pair.fromCode, pair.toCode);
    els.translatorResult.value = data.translated || "";
    if (els.translatorStatus) els.translatorStatus.textContent = t("translator.done");
  } catch (error) {
    console.error("Translator error", error);
    if (els.translatorStatus) els.translatorStatus.textContent = t("translator.error");
    showToast(t("translator.error"), "error");
  } finally {
    if (els.translatorStatus) delete els.translatorStatus.dataset.busy;
    if (els.translatorProgress) els.translatorProgress.classList.remove("active");
  }
}

/** Open the existing offline model download dialog pre-populated with the target language. */
function openDownloadDialog(fromCode, toCode) {
  const dialog = document.getElementById("argos-download-dialog");
  const list = document.getElementById("argos-languages-list");
  if (!dialog || !list) return;
  
  // Pre-check the target language in the download list
  const checkboxes = list.querySelectorAll("input[type='checkbox']");
  checkboxes.forEach(cb => {
    cb.checked = cb.value === toCode || cb.value === fromCode;
  });
  
  dialog.showModal();
}

function scheduleTranslate() {
  clearTimeout(translateTimer);
  translateTimer = setTimeout(translateNow, 450);
}

export function bindTranslatorEvents() {
  if (els.translatorSource) els.translatorSource.addEventListener("input", scheduleTranslate);
  if (els.translatorFrom) {
    els.translatorFrom.addEventListener("change", () => {
      renderTranslator();
      scheduleTranslate();
    });
  }
  if (els.translatorTo) {
    els.translatorTo.addEventListener("change", () => {
      renderTranslator();
      scheduleTranslate();
    });
  }
  if (els.translatorSwap) {
    els.translatorSwap.addEventListener("click", () => {
      const fromCode = els.translatorFrom?.value;
      const toCode = els.translatorTo?.value;
      // Swap values FIRST, then render + update flags
      els.translatorFrom.value = toCode;
      els.translatorTo.value = fromCode;
      renderTranslator();
      scheduleTranslate();
    });
  }
}
