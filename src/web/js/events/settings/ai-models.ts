// AI model discovery picker: cached-model listing, option rendering, keyboard
// navigation and the explicit Refresh action. Split out of the former
// monolithic events/settings.ts; the preference change listeners that call
// into this module live in ai-preferences.ts.
import { state, saveState } from "../../state.js";
import { t } from "../../i18n.js";
import { updatePreferenceValue } from "../../preferences.js";
import { byId } from "./shared.js";
import {
  countAiModelMatches,
  filterAiModels,
  getCachedAiModels,
  isAiModelCommitKey,
  isAiModelCacheFresh,
  requestAiModels
} from "../../ai-model-discovery.js";

let aiModelsLoading = false;
let aiModelsAbortController: AbortController | null = null;
let availableAiModels: string[] = [];
let activeAiModelOption = -1;

function aiModelElements() {
  return {
    endpoint: byId<HTMLInputElement>("pref-ai-endpoint"),
    apiKey: byId<HTMLInputElement>("pref-ai-api-key"),
    model: byId<HTMLInputElement>("pref-ai-model"),
    search: byId<HTMLInputElement>("pref-ai-model-search"),
    refresh: byId<HTMLButtonElement>("pref-ai-model-refresh"),
    status: byId<HTMLElement>("pref-ai-model-status"),
    options: byId<HTMLElement>("pref-ai-model-options")
  };
}

export function cancelAiModelRefresh() {
  aiModelsAbortController?.abort();
  aiModelsAbortController = null;
  aiModelsLoading = false;
  const { refresh } = aiModelElements();
  if (refresh) refresh.disabled = false;
}

function closeAiModelOptions() {
  const { search, options } = aiModelElements();
  if (options) options.hidden = true;
  if (search) {
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
  }
  activeAiModelOption = -1;
}

function setActiveAiModelOption(index: number) {
  const { search, options } = aiModelElements();
  if (!search || !options) return;
  const buttons = [...options.querySelectorAll<HTMLButtonElement>(".ai-model-option")];
  if (!buttons.length) return;
  activeAiModelOption = Math.max(0, Math.min(index, buttons.length - 1));
  buttons.forEach((button, buttonIndex) => {
    const active = buttonIndex === activeAiModelOption;
    button.classList.toggle("active", active);
  });
  const active = buttons[activeAiModelOption];
  search.setAttribute("aria-activedescendant", active.id);
  active.scrollIntoView({ block: "nearest" });
}

function renderAiModelOptions(open = true, updateStatus = true) {
  const { model, search, status, options } = aiModelElements();
  if (!model || !search || !status || !options) return;
  options.replaceChildren();
  activeAiModelOption = -1;
  search.removeAttribute("aria-activedescendant");
  if (!open) {
    closeAiModelOptions();
    return;
  }
  const matches = filterAiModels(availableAiModels, search.value);
  if (!availableAiModels.length) {
    closeAiModelOptions();
    return;
  }
  if (!matches.length) {
    status.textContent = t("settings.aiModelsNoResults");
    closeAiModelOptions();
    return;
  }
  for (const [index, modelId] of matches.entries()) {
    const option = document.createElement("button");
    option.type = "button";
    option.id = `pref-ai-model-option-${index}`;
    option.className = "ai-model-option";
    option.tabIndex = -1;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(modelId === model.value.trim()));
    option.dataset.modelId = modelId;
    option.textContent = modelId;
    options.appendChild(option);
  }
  options.hidden = false;
  search.setAttribute("aria-expanded", "true");
  if (updateStatus) {
    status.textContent = t("settings.aiModelsMatches", {
      n: countAiModelMatches(availableAiModels, search.value)
    });
  }
}

export function showCachedAiModels(open = false) {
  const controls = aiModelElements();
  const endpoint = controls.endpoint?.value.trim() || "";
  availableAiModels = getCachedAiModels(state.preferences.aiExplanationModelsCache, endpoint);
  if (controls.status) {
    controls.status.textContent = availableAiModels.length
      ? t("settings.aiModelsLoaded", { n: availableAiModels.length })
      : "";
  }
  renderAiModelOptions(open, open);
}

async function refreshAiModels(force = false) {
  const controls = aiModelElements();
  if (!controls.endpoint || !controls.apiKey || !controls.status || !controls.refresh) return;
  if (force && aiModelsAbortController) {
    cancelAiModelRefresh();
  } else if (aiModelsLoading) {
    return;
  }
  const endpoint = controls.endpoint.value.trim();
  if (!endpoint) {
    controls.status.textContent = t("settings.aiModelsError");
    closeAiModelOptions();
    return;
  }
  const cache = state.preferences.aiExplanationModelsCache;
  availableAiModels = getCachedAiModels(cache, endpoint);
  renderAiModelOptions(controls.search === document.activeElement);
  if (!force && isAiModelCacheFresh(cache, endpoint)) {
    controls.status.textContent = t("settings.aiModelsLoaded", { n: availableAiModels.length });
    return;
  }

  const requestController = new AbortController();
  aiModelsAbortController = requestController;
  aiModelsLoading = true;
  controls.refresh.disabled = true;
  controls.status.textContent = t("settings.aiModelsLoading");
  try {
    const models = await requestAiModels(endpoint, controls.apiKey.value, requestController.signal);
    if (aiModelsAbortController !== requestController) return;
    if (!models.length) throw new Error("AI model catalog is empty");
    availableAiModels = models;
    state.preferences.aiExplanationModelsCache = {
      endpoint,
      models,
      fetchedAt: Date.now()
    };
    await saveState();
    controls.status.textContent = t("settings.aiModelsLoaded", { n: models.length });
    renderAiModelOptions(controls.search === document.activeElement, false);
  } catch (error) {
    if (requestController.signal.aborted || aiModelsAbortController !== requestController) return;
    console.warn("AI model discovery failed", error instanceof Error ? error.message : error);
    controls.status.textContent = availableAiModels.length
      ? t("settings.aiModelsCached", { n: availableAiModels.length })
      : t("settings.aiModelsError");
    renderAiModelOptions(controls.search === document.activeElement, false);
  } finally {
    if (aiModelsAbortController === requestController) {
      aiModelsAbortController = null;
      aiModelsLoading = false;
      controls.refresh.disabled = false;
    }
  }
}

export function bindAiModelPicker() {
  const controls = aiModelElements();
  if (!controls.model || !controls.search || !controls.refresh || !controls.options) return;

  controls.search.addEventListener("focus", () => {
    showCachedAiModels(true);
  });
  controls.search.addEventListener("input", () => renderAiModelOptions());
  controls.search.addEventListener("keydown", (event) => {
    const count = controls.options?.querySelectorAll(".ai-model-option").length || 0;
    if (event.key === "ArrowDown" && count) {
      event.preventDefault();
      setActiveAiModelOption(activeAiModelOption + 1);
    } else if (event.key === "ArrowUp" && count) {
      event.preventDefault();
      setActiveAiModelOption(activeAiModelOption < 0 ? count - 1 : activeAiModelOption - 1);
    } else if (isAiModelCommitKey(event) && count) {
      event.preventDefault();
      const selectedIndex = activeAiModelOption < 0 ? 0 : activeAiModelOption;
      controls.options?.querySelectorAll<HTMLButtonElement>(".ai-model-option")[selectedIndex]?.click();
    } else if (event.key === "Escape") {
      closeAiModelOptions();
    }
  });
  controls.search.addEventListener("search", () => {
    const options = controls.options?.querySelectorAll<HTMLButtonElement>(".ai-model-option");
    const selectedIndex = activeAiModelOption < 0 ? 0 : activeAiModelOption;
    options?.[selectedIndex]?.click();
  });
  controls.options.addEventListener("click", (event) => {
    const option = (event.target as HTMLElement).closest<HTMLButtonElement>(".ai-model-option");
    const modelId = option?.dataset.modelId;
    if (!modelId) return;
    controls.model!.value = modelId;
    controls.search!.value = "";
    void updatePreferenceValue("aiExplanationModel", modelId);
    closeAiModelOptions();
    controls.model!.focus();
  });
  controls.refresh.addEventListener("click", () => void refreshAiModels(true));
  document.addEventListener("pointerdown", (event) => {
    const row = byId("pref-ai-model-row");
    if (row && !row.contains(event.target as Node)) closeAiModelOptions();
  });
  window.addEventListener("wordhunter:view-changed", (event) => {
    const view = (event as CustomEvent<{ view?: string }>).detail?.view;
    if (view !== "settings") {
      cancelAiModelRefresh();
      closeAiModelOptions();
      return;
    }
    if (state.preferences.aiExplanationsEnabled) {
      showCachedAiModels(false);
    }
  });
}
