// Translator & offline-model settings section (former monolithic
// events/settings.ts): translation provider/language preferences, DeepL and
// LM Studio endpoints, and the Argos offline-model download dialog flow.
import { state } from "../../state.js";
import { els } from "../../dom.js";
import { t } from "../../i18n.js";
import { renderReader } from "../../reader/renderer.js";
import { syncSettingsControls, updatePreferenceValue } from "../../preferences.js";
import { showToast } from "../../toast.js";
import { registerUnsavedDialog } from "../../dialog-backdrop.js";
import { setElementBusy } from "../../loading.js";
import { OFFLINE_TRANSLATOR_LANGUAGES } from "../../constants.js";
import { normalizeTranslationLanguageCode, normalizeTranslatorTextPreference, resolveProfileTranslationPair } from "../../translator-preferences.js";
import { httpPost } from "../../http.js";

let argosDownloadRunning = false;
let argosSelectionDirty = false;

function isArgosDirty() {
  return argosSelectionDirty;
}

async function cancelArgosDownload() {
  if (argosDownloadRunning) return;
  argosSelectionDirty = false;
  (document.getElementById("argos-download-dialog") as HTMLDialogElement | null)?.close();
  if (els.prefOfflineTranslator) els.prefOfflineTranslator.checked = false;
  if (els.prefArgosAsDictRow) {
    els.prefArgosAsDictRow.style.opacity = "0.5";
    els.prefArgosAsDictRow.style.pointerEvents = "none";
  }
  syncSettingsControls();
  const { renderTranslator } = await import("../../views/translator.js");
  renderTranslator();
}

export function registerArgosUnsavedDialog() {
  registerUnsavedDialog("argos-download-dialog", isArgosDirty, () => {
    document.getElementById("argos-download-confirm")?.click();
  }, cancelArgosDownload);
}

function updateTranslatorTextPreference(key: string, value: unknown): void {
  updatePreferenceValue(key, normalizeTranslatorTextPreference(key, value));
  syncSettingsControls();
}

export function bindTranslationProviderSettings() {
  if (els.prefTranslationProvider) {
    els.prefTranslationProvider.addEventListener("change", async (event: Event) => {
      const target = event.currentTarget as HTMLSelectElement;
      updatePreferenceValue("translationProvider", target.value);
      syncSettingsControls();
      const { renderTranslator } = await import("../../views/translator.js");
      renderTranslator();
    });
  }
  const languageControls: Array<[HTMLInputElement | null, string]> = [
    [els.prefTranslationSourceLanguage, "translationSourceLanguage"],
    [els.prefTranslationTargetLanguage, "translationTargetLanguage"]
  ];
  for (const [control, key] of languageControls) {
    if (!control) continue;
    control.addEventListener("input", () => control.setCustomValidity(""));
    control.addEventListener("change", async (event: Event) => {
      const target = event.currentTarget as HTMLInputElement;
      const raw = target.value.trim();
      const value = normalizeTranslationLanguageCode(raw);
      if (raw && !value) {
        target.setCustomValidity(t("settings.translationLanguageInvalid"));
        target.reportValidity();
        return;
      }
      target.setCustomValidity("");
      target.value = value;
      updatePreferenceValue(key, value);
      syncSettingsControls();
      const { renderTranslator } = await import("../../views/translator.js");
      renderTranslator();
      renderReader();
    });
  }
  if (els.prefDeepLApiKey) {
    els.prefDeepLApiKey.addEventListener("change", (event: Event) => {
      updateTranslatorTextPreference("deeplApiKey", (event.currentTarget as HTMLInputElement).value);
    });
  }
  if (els.prefLmStudioEndpoint) {
    els.prefLmStudioEndpoint.addEventListener("change", (event: Event) => {
      updateTranslatorTextPreference("lmStudioEndpoint", (event.currentTarget as HTMLInputElement).value);
    });
  }
  if (els.prefLmStudioModel) {
    els.prefLmStudioModel.addEventListener("change", (event: Event) => {
      updateTranslatorTextPreference("lmStudioModel", (event.currentTarget as HTMLInputElement).value);
    });
  }
}

export function bindOfflineTranslatorSettings() {
  if (els.prefOfflineTranslator) {
    els.prefOfflineTranslator.addEventListener("change", async (event: Event) => {
      const target = event.currentTarget as HTMLInputElement;
      if (target.checked) {
        const pair = resolveProfileTranslationPair(state.preferences);
        if (!pair.configured) {
          target.checked = false;
          showToast(t("translator.providerUnavailable"), "error");
          return;
        }
        // Dynamically build the language list in the download dialog
        const { t: translate } = await import("../../i18n.js");
        const supported = Array.from(new Set([...OFFLINE_TRANSLATOR_LANGUAGES, pair.fromCode, pair.toCode].filter(Boolean)));

        const languagesList = document.getElementById("argos-languages-list");
        if (languagesList) {
          languagesList.innerHTML = supported.map(lang => `
            <label class="status-check justify-start">
              <input type="checkbox" value="${lang}" ${lang === pair.fromCode || lang === pair.toCode ? "checked" : ""}>
              <span>${translate(`languages.${lang}`) === `languages.${lang}` ? lang.toUpperCase() : translate(`languages.${lang}`)} (${lang.toUpperCase()})</span>
            </label>
          `).join("");

          // Update button text with size
          const updateBtnText = () => {
            const count = languagesList.querySelectorAll("input:checked").length;
            const confirmButton = document.getElementById("argos-download-confirm");
            if (confirmButton) confirmButton.textContent = translate("settings.argosDownloadSize", { label: translate("settings.argosDownloadConfirm"), size: count * 150 });
          };

          languagesList.querySelectorAll<HTMLInputElement>("input").forEach((checkbox) => {
            checkbox.addEventListener("change", updateBtnText);
            checkbox.addEventListener("change", () => { argosSelectionDirty = true; });
          });
          updateBtnText();
        }

        (document.getElementById("argos-download-dialog") as HTMLDialogElement | null)?.showModal();
      } else {
        updatePreferenceValue("offlineTranslator", false);
        if (els.prefArgosAsDictRow) {
          els.prefArgosAsDictRow.style.opacity = "0.5";
          els.prefArgosAsDictRow.style.pointerEvents = "none";
        }
        if (els.prefArgosAsDict) {
          els.prefArgosAsDict.checked = false;
          updatePreferenceValue("argosAsDict", false);
        }
        syncSettingsControls();
        const { renderTranslator } = await import("../../views/translator.js");
        renderTranslator();
      }
    });
  }

  const argosCancelButton = document.getElementById("argos-download-cancel");
  if (argosCancelButton) {
    argosCancelButton.addEventListener("click", cancelArgosDownload);
  }

  const argosConfirmButton = document.getElementById("argos-download-confirm");
  if (argosConfirmButton) {
    argosConfirmButton.addEventListener("click", async () => {
      const languagesList = document.getElementById("argos-languages-list");
      if (!(languagesList instanceof HTMLElement)) return;
      const checkedBoxes = Array.from(languagesList.querySelectorAll<HTMLInputElement>("input:checked"));
      const toCodes = checkedBoxes.map(cb => cb.value);

      if (toCodes.length === 0) {
        import("../../toast.js").then(m => m.showToast(t("toast.selectAtLeastOneLanguage")));
        return;
      }

      setElementBusy(argosConfirmButton, true, { disable: true });
      setElementBusy(document.getElementById("argos-download-dialog"), true);
      argosDownloadRunning = true;
      argosSelectionDirty = false;
      if (argosCancelButton) (argosCancelButton as HTMLButtonElement).disabled = true;
      argosConfirmButton.textContent = t("toast.downloadingWait");

      try {
        const pair = resolveProfileTranslationPair(state.preferences);
        const languages = Array.from(new Set(["en", pair.fromCode, pair.toCode, ...toCodes].filter(Boolean)));
        const response = await httpPost("/__argos/install", { from: languages, to: languages }, { timeoutMs: 600_000 });

        if (!response.ok) throw new Error("Failed to download models");
        const result = await response.json();
        if (!Number.isFinite(result.installed)) throw new Error("Invalid model installation response");
        const { refreshTranslatorAvailability, hasModelForPair, invalidatePackagesCache, renderTranslator } = await import("../../views/translator.js");
        invalidatePackagesCache();
        await refreshTranslatorAvailability();
        if (!hasModelForPair(pair.fromCode, pair.toCode)) throw new Error("No matching translation models were installed");
        updatePreferenceValue("offlineTranslator", true);
        if (els.prefArgosAsDictRow) {
          els.prefArgosAsDictRow.style.opacity = "1";
          els.prefArgosAsDictRow.style.pointerEvents = "auto";
        }
        syncSettingsControls();
        (document.getElementById("argos-download-dialog") as HTMLDialogElement | null)?.close();
        renderTranslator();
        import("../../toast.js").then(m => m.showToast(t("toast.modelsDownloaded")));
      } catch (err) {
        console.error("Offline translator install error", err);
        import("../../toast.js").then(m => m.showToast(t("toast.modelsDownloadError")));
        if (els.prefOfflineTranslator) els.prefOfflineTranslator.checked = false;
        if (els.prefArgosAsDictRow) {
          els.prefArgosAsDictRow.style.opacity = "0.5";
          els.prefArgosAsDictRow.style.pointerEvents = "none";
        }
        updatePreferenceValue("offlineTranslator", false);
        syncSettingsControls();
        const { renderTranslator } = await import("../../views/translator.js");
        renderTranslator();
      } finally {
        argosDownloadRunning = false;
        if (argosCancelButton) (argosCancelButton as HTMLButtonElement).disabled = false;
        setElementBusy(document.getElementById("argos-download-dialog"), false);
        setElementBusy(argosConfirmButton, false, { disable: true });
        argosConfirmButton.textContent = t("settings.argosDownloadConfirm");
      }
    });
  }
}
