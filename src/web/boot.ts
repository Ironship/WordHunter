type BootRecord = Record<string, unknown>;

function isRecord(value: unknown): value is BootRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readBootPreferences(): BootRecord {
  let saved: unknown = window.__bridgeState;
  if (!saved) saved = JSON.parse(localStorage.getItem("wordHunterStateV2") || "null");
  if (!isRecord(saved)) return {};
  if (isRecord(saved.prefs)) return saved.prefs;
  return isRecord(saved.preferences) ? saved.preferences : {};
}

function applyBootTheme(): void {
  const prefs = readBootPreferences();
  const aliases: Readonly<Record<string, string>> = {
    auto: "classic-auto",
    light: "classic-light",
    dark: "classic-dark"
  };
  const savedTheme = typeof prefs.theme === "string" ? prefs.theme : "";
  let theme = aliases[savedTheme] || savedTheme;
  if (!theme && typeof prefs.darkMode === "boolean") {
    theme = prefs.darkMode ? "classic-dark" : "classic-light";
  }
  if (!["familiar", "alternative-familiar", "classic-auto", "classic-light", "classic-dark"].includes(theme)) {
    theme = "familiar";
  }

  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  const family = theme === "familiar" || theme === "alternative-familiar" ? theme : "classic";
  const mode = theme === "classic-dark" || ((theme === "classic-auto" || family !== "classic") && systemDark)
    ? "dark"
    : "light";
  const color = family === "familiar"
    ? (mode === "dark" ? "#00395d" : "#0067a8")
    : family === "alternative-familiar"
      ? (mode === "dark" ? "#2c001e" : "#5e2750")
      : mode === "dark" ? "#0d1114" : "#f7f9f6";
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.dataset.themePref = theme;
  root.dataset.colorTheme = family;
  root.style.setProperty("--boot-bg", color);
  root.style.background = color;
  root.style.colorScheme = mode;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", color);
}

function reportBootError(text: string): void {
  document.documentElement.classList.remove("app-booting");
  console.error(text);
  fetch("/__log_error", { method: "POST", body: text }).catch(() => {});
}

try {
  applyBootTheme();
} catch {
  // The critical boot style provides a safe default until regular preferences load.
}

const fontStylesheet = document.querySelector<HTMLLinkElement>("#app-font-stylesheet");
if (fontStylesheet) fontStylesheet.rel = "stylesheet";

window.onerror = (message, source, line, column, error): void => {
  reportBootError(`JS Error: ${String(message)} at ${source}:${line}:${column}\n${error instanceof Error ? error.stack || "" : ""}`);
};
const bootRejectionHandler = (event: PromiseRejectionEvent): void => {
  reportBootError(`Unhandled Promise: ${String(event.reason)}`);
};
window.wordHunterBootRejectionHandler = bootRejectionHandler;
window.addEventListener("unhandledrejection", bootRejectionHandler);
