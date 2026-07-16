type TranslationRecord = Record<string, unknown>;

function isRecord(value: unknown): value is TranslationRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`translator element is missing: ${id}`);
  return element as T;
}

function errorName(error: unknown): string {
  return isRecord(error) && typeof error.name === "string" ? error.name : "";
}

function cleanTranslation(text: unknown): string {
  return String(text || "")
    .replace(/\{[A-Z]:\s*[^{}]{0,120}\}/g, "")
    .replace(/\{\s*\d+\s*\}/g, "")
    .replace(/\{\s*[A-Za-z0-9_$:;.,#@\- ]{1,80}\s*\}/g, "")
    .replace(/^\s*[/\\|]+\s*/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+'/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function applyAutomaticTheme(): void {
  if (document.documentElement.dataset.theme !== "auto" || !window.matchMedia) return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (): void => {
    document.documentElement.dataset.theme = media.matches ? "dark" : "light";
  };
  apply();
  if (typeof media.addEventListener === "function") media.addEventListener("change", apply);
  else if (typeof media.addListener === "function") media.addListener(apply);
}

applyAutomaticTheme();

const sourceEl = requiredElement<HTMLTextAreaElement>("source-text");
const targetEl = requiredElement<HTMLTextAreaElement>("target-text");
const fromEl = requiredElement<HTMLSelectElement>("from-lang");
const toEl = requiredElement<HTMLSelectElement>("to-lang");
const flagFrom = requiredElement<HTMLImageElement>("flag-from");
const flagTo = requiredElement<HTMLImageElement>("flag-to");
const progressEl = requiredElement<HTMLElement>("translator-progress");
const copyButton = requiredElement<HTMLButtonElement>("copy-btn");
const baseUrl = document.documentElement.dataset.baseUrl || "";
let timer: ReturnType<typeof setTimeout> | null = null;
let activeTranslation = 0;
let translationController: AbortController | null = null;

function invalidateTranslation(): void {
  activeTranslation += 1;
  translationController?.abort();
  translationController = null;
  progressEl.classList.remove("active");
}

async function translate(): Promise<void> {
  const generation = ++activeTranslation;
  translationController?.abort();
  translationController = null;
  const value = sourceEl.value.trim();
  if (!value) {
    targetEl.value = "";
    progressEl.classList.remove("active");
    return;
  }

  const controller = new AbortController();
  translationController = controller;
  progressEl.classList.add("active");
  try {
    const url = `/__argos/translate?text=${encodeURIComponent(value)}&from=${fromEl.value}&to=${toEl.value}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || generation !== activeTranslation) return;
    const data: unknown = await response.json();
    if (generation === activeTranslation && isRecord(data)) {
      targetEl.value = cleanTranslation(data.translated);
    }
  } catch (error) {
    if (errorName(error) !== "AbortError") console.error("Translation error", error);
  } finally {
    if (generation === activeTranslation) {
      translationController = null;
      progressEl.classList.remove("active");
    }
  }
}

function updateFlags(): void {
  flagFrom.src = `${baseUrl}/flags/${fromEl.value}.svg`;
  flagFrom.style.display = "block";
  flagTo.src = `${baseUrl}/flags/${toEl.value}.svg`;
  flagTo.style.display = "block";
}

for (const flag of [flagFrom, flagTo]) {
  flag.addEventListener("error", () => {
    flag.style.display = "none";
  });
}
sourceEl.addEventListener("input", () => {
  if (timer !== null) clearTimeout(timer);
  invalidateTranslation();
  timer = setTimeout(translate, 300);
});
for (const select of [fromEl, toEl]) {
  select.addEventListener("change", () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    updateFlags();
    void translate();
  });
}
copyButton.addEventListener("click", () => {
  if (!targetEl.value) return;
  targetEl.select();
  document.execCommand("copy");
  const originalHtml = copyButton.innerHTML;
  copyButton.textContent = copyButton.dataset.copied || "";
  setTimeout(() => {
    copyButton.innerHTML = originalHtml;
  }, 2000);
});
if (sourceEl.value) void translate();
sourceEl.focus();
