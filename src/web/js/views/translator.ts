import { els } from "../dom.js";
import { t } from "../i18n.js";
import { state, saveState } from "../state.js";
import { showToast } from "../toast.js";
import { setElementBusy } from "../loading.js";
import { escapeHtml } from "../utils.js";
import { activeTranslationProvider, canUseTranslationProvider, translateText } from "../translation-provider.js";
import { OTHER_PROFILE_ID, TRANSLATOR_LANGUAGES } from "../constants.js";
import { normalizeTranslationLanguageCode, resolveProfileTranslationPair } from "../translator-preferences.js";

// All languages supported by online/local translator providers.
const SUPPORTED_LANGUAGES = TRANSLATOR_LANGUAGES;

interface TranslationModel {
  from: string;
  to: string;
}

interface ArgosPackage extends TranslationModel {
  size_mb?: number;
}

interface TranslatorPairOptions {
  fromValue?: string;
  toValue?: string;
  learningLanguage?: string;
  locale?: string;
  allCodes?: string[];
}

interface TranslatorPair {
  fromCode: string;
  toCode: string;
  fromCodes: string[];
  toCodes: string[];
}

let translateTimer: number | null = null;
let translateGeneration = 0;

function setTranslatorBusy(busy: boolean): void {
  if (els.translatorStatus) {
    if (busy) els.translatorStatus.dataset.busy = "true";
    else delete els.translatorStatus.dataset.busy;
  }
  els.translatorProgress?.classList.toggle("active", busy);
  setElementBusy(document.getElementById("translator-view"), busy);
}

function modelKey(model: TranslationModel): string {
  return `${model.from}:${model.to}`;
}

function isTranslationModel(model: unknown): model is TranslationModel {
  return Boolean(model)
    && typeof model === "object"
    && "from" in model
    && "to" in model
    && typeof model.from === "string"
    && typeof model.to === "string";
}

function isArgosPackage(item: unknown): item is ArgosPackage {
  return isTranslationModel(item)
    && (!("size_mb" in item) || item.size_mb === undefined || typeof item.size_mb === "number");
}

function normalizeModels(models: unknown): TranslationModel[] {
  const seen = new Set();
  return (Array.isArray(models) ? models : [])
    .filter(isTranslationModel)
    .filter((model) => {
      const key = modelKey(model);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

function getModels(): TranslationModel[] {
  return normalizeModels(state.argosModels);
}

function getPackages(): ArgosPackage[] {
  return Array.isArray(state.argosAvailablePackages)
    ? state.argosAvailablePackages.filter(isArgosPackage)
    : [];
}

function languageName(code: string): string {
  const translated = t(`languages.${code}`);
  return translated === `languages.${code}` ? code.toUpperCase() : translated;
}

function updateTranslatorNavState(hasModels: boolean): void {
  if (!els.translatorNavItem) return;
  const provider = activeTranslationProvider();
  const locked = !canUseTranslationProvider() || (provider === "offline" && !hasModels);
  els.translatorNavItem.hidden = false;
  els.translatorNavItem.classList.toggle("nav-item-locked", locked);
  els.translatorNavItem.setAttribute("aria-disabled", String(locked));
  if (els.translatorNavItem instanceof HTMLButtonElement) els.translatorNavItem.disabled = locked;
  els.translatorNavItem.title = locked ? t("translator.providerUnavailable") : t("nav.translator");
}

let _packagesFetched = false;

export function invalidatePackagesCache(): void {
  _packagesFetched = false;
}

export async function refreshTranslatorAvailability(): Promise<boolean> {
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
export function hasModelForPair(fromCode: string, toCode: string): boolean {
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
function getPackageSize(fromCode: string, toCode: string): number {
  const pkgs = getPackages();
  const found = pkgs.find(p => p.from === fromCode && p.to === toCode);
  return found?.size_mb ?? 150;
}

/** Return all supported language codes (not just those with installed models). */
function getAllLanguageCodes(): string[] {
  const pair = resolveProfileTranslationPair(state.preferences);
  const modelCodes = getModels().flatMap((model) => [model.from, model.to]);
  const packageCodes = getPackages().flatMap((item) => [item.from, item.to]);
  return [...new Set([...SUPPORTED_LANGUAGES, pair.fromCode, pair.toCode, ...modelCodes, ...packageCodes]
    .map(normalizeTranslationLanguageCode)
    .filter(Boolean))];
}

function pickLanguageCode(candidates: string[], codes: string[], fallback: string): string {
  return candidates.find((code) => codes.includes(code)) || fallback;
}

export function resolveTranslatorPair({
  fromValue = "",
  toValue = "",
  learningLanguage = "",
  locale = "",
  allCodes = getAllLanguageCodes()
}: TranslatorPairOptions = {}): TranslatorPair {
  const codes = Array.isArray(allCodes) ? allCodes.filter(Boolean) : [];
  const fallbackFrom = codes[0] || "";
  const fromCode = pickLanguageCode([fromValue, learningLanguage], codes, fallbackFrom);

  const fallbackTo = codes.find((code) => code !== fromCode) || fallbackFrom;
  const toCode = pickLanguageCode([toValue, locale], codes, fallbackTo);

  return { fromCode, toCode, fromCodes: codes, toCodes: codes };
}

function optionHtml(code: string, selected: string): string {
  return `<option value="${escapeHtml(code)}" ${code === selected ? "selected" : ""}>${escapeHtml(languageName(code))} (${escapeHtml(code.toUpperCase())})</option>`;
}

function ensureSelectedPair(): TranslatorPair {
  const allCodes = getAllLanguageCodes();
  const profilePair = resolveProfileTranslationPair(state.preferences);
  const isOtherProfile = state.preferences.learningLanguage === OTHER_PROFILE_ID;
  return resolveTranslatorPair({
    fromValue: isOtherProfile ? profilePair.fromCode : els.translatorFrom?.value,
    toValue: isOtherProfile ? profilePair.toCode : els.translatorTo?.value,
    learningLanguage: isOtherProfile ? profilePair.fromCode : state.preferences.learningLanguage,
    locale: isOtherProfile ? profilePair.toCode : state.preferences.locale,
    allCodes
  });
}

function saveOtherProfilePair(fromCode: string, toCode: string): void {
  if (state.preferences.learningLanguage !== OTHER_PROFILE_ID) return;
  const source = normalizeTranslationLanguageCode(fromCode);
  const target = normalizeTranslationLanguageCode(toCode);
  state.preferences.translationSourceLanguage = source;
  state.preferences.translationTargetLanguage = target;
  const profile = state.profiles?.[OTHER_PROFILE_ID];
  if (profile) {
    profile.preferences = profile.preferences || {};
    profile.preferences.translationSourceLanguage = source;
    profile.preferences.translationTargetLanguage = target;
  }
  saveState();
}

export function renderTranslator(): void {
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

function updateTranslatorFlags(fromCode: string, toCode: string): void {
  const fromFlag = document.getElementById("translator-from-flag");
  const toFlag = document.getElementById("translator-to-flag");
  const fCode = fromCode || els.translatorFrom?.value;
  const tCode = toCode || els.translatorTo?.value;
  if (fromFlag instanceof HTMLImageElement && fCode) {
    fromFlag.src = `flags/${TRANSLATOR_LANGUAGES.includes(fCode) ? fCode : OTHER_PROFILE_ID}.svg`;
    fromFlag.style.display = "block";
  }
  if (toFlag instanceof HTMLImageElement && tCode) {
    toFlag.src = `flags/${TRANSLATOR_LANGUAGES.includes(tCode) ? tCode : OTHER_PROFILE_ID}.svg`;
    toFlag.style.display = "block";
  }
}

async function translateNow(): Promise<void> {
  if (!els.translatorSource || !els.translatorResult) return;
  const generation = ++translateGeneration;
  const text = els.translatorSource.value.trim();
  if (!text) {
    els.translatorResult.value = "";
    if (els.translatorStatus) els.translatorStatus.textContent = t("translator.ready");
    setTranslatorBusy(false);
    return;
  }

  const pair = ensureSelectedPair();
  const provider = activeTranslationProvider();
  if (!canUseTranslationProvider()) {
    showToast(t("translator.providerUnavailable"), "error");
    setTranslatorBusy(false);
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
    setTranslatorBusy(false);
    return;
  }

  if (els.translatorStatus) {
    els.translatorStatus.dataset.busy = "true";
    els.translatorStatus.textContent = t("translator.translating");
  }
  setTranslatorBusy(true);

  try {
    const data = await translateText(text, pair.fromCode, pair.toCode);
    if (generation !== translateGeneration) return;
    els.translatorResult.value = data.translated || "";
    if (els.translatorStatus) els.translatorStatus.textContent = t("translator.done");
  } catch (error) {
    if (generation !== translateGeneration) return;
    console.error("Translator error", error);
    if (els.translatorStatus) els.translatorStatus.textContent = t("translator.error");
    showToast(t("translator.error"), "error");
  } finally {
    if (generation === translateGeneration) setTranslatorBusy(false);
  }
}

/** Open the existing offline model download dialog pre-populated with the target language. */
function openDownloadDialog(fromCode: string, toCode: string): void {
  const dialog = document.getElementById("argos-download-dialog");
  const list = document.getElementById("argos-languages-list");
  if (!(dialog instanceof HTMLDialogElement) || !(list instanceof HTMLElement)) return;
  
  // Pre-check the target language in the download list
  const checkboxes = list.querySelectorAll("input[type='checkbox']");
  checkboxes.forEach(cb => {
    if (!(cb instanceof HTMLInputElement)) return;
    cb.checked = cb.value === toCode || cb.value === fromCode;
  });
  
  dialog.showModal();
}

function scheduleTranslate(): void {
  clearTimeout(translateTimer);
  translateTimer = setTimeout(translateNow, 450);
}

export function bindTranslatorEvents(): void {
  if (els.translatorSource) els.translatorSource.addEventListener("input", scheduleTranslate);
  if (els.translatorFrom) {
    els.translatorFrom.addEventListener("change", () => {
      saveOtherProfilePair(els.translatorFrom.value, els.translatorTo?.value);
      renderTranslator();
      scheduleTranslate();
    });
  }
  if (els.translatorTo) {
    els.translatorTo.addEventListener("change", () => {
      saveOtherProfilePair(els.translatorFrom?.value, els.translatorTo.value);
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
      saveOtherProfilePair(toCode, fromCode);
      renderTranslator();
      scheduleTranslate();
    });
  }
}
