export type ThemeName = "familiar" | "alternative-familiar" | "classic-auto" | "classic-light" | "classic-dark";
export type ThemeFamily = "familiar" | "alternative-familiar" | "classic";
export type ThemeMode = "light" | "dark";

export interface ResolvedTheme {
  theme: ThemeName;
  family: ThemeFamily;
  mode: ThemeMode;
  color: string;
}

export const DEFAULT_THEME: ThemeName = "familiar";
export const THEME_ORDER: readonly ThemeName[] = ["familiar", "alternative-familiar", "classic-auto", "classic-light", "classic-dark"];

const THEME_ALIASES = new Map<string, ThemeName>([
  ["auto", "classic-auto"],
  ["light", "classic-light"],
  ["dark", "classic-dark"]
]);

const VALID_THEMES = new Set<string>([
  "familiar",
  "alternative-familiar",
  "classic-auto",
  "classic-light",
  "classic-dark"
]);

export function normalizeTheme(value: unknown, legacyDarkMode?: unknown): ThemeName {
  if ((value === undefined || value === null || value === "") && typeof legacyDarkMode === "boolean") {
    return legacyDarkMode ? "classic-dark" : "classic-light";
  }
  const candidate = typeof value === "string" ? value : "";
  const normalized = THEME_ALIASES.get(candidate) || candidate;
  return VALID_THEMES.has(normalized) ? normalized as ThemeName : DEFAULT_THEME;
}

export function resolveTheme(value: unknown, prefersDark = false): ResolvedTheme {
  const theme = normalizeTheme(value);
  if (theme === "familiar") {
    return { theme, family: "familiar", mode: prefersDark ? "dark" : "light", color: prefersDark ? "#00395d" : "#0067a8" };
  }
  if (theme === "alternative-familiar") {
    return { theme, family: "alternative-familiar", mode: prefersDark ? "dark" : "light", color: prefersDark ? "#2c001e" : "#5e2750" };
  }
  const mode = theme === "classic-dark" || (theme === "classic-auto" && prefersDark)
    ? "dark"
    : "light";
  return { theme, family: "classic", mode, color: mode === "dark" ? "#0d1114" : "#f7f9f6" };
}

export function nextTheme(value: unknown): ThemeName {
  const theme = normalizeTheme(value);
  const index = THEME_ORDER.indexOf(theme);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length];
}

export function applyTheme(
  value: unknown,
  root: HTMLElement = document.documentElement,
  prefersDark?: boolean
): ResolvedTheme {
  const systemDark = prefersDark ?? Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const theme = normalizeTheme(value);
  const forceDesktopDark = root.dataset.platform === "desktop"
    && (theme === "familiar" || theme === "alternative-familiar");
  const resolved = resolveTheme(theme, forceDesktopDark || systemDark);
  root.dataset.theme = resolved.mode;
  root.dataset.themePref = resolved.theme;
  root.dataset.colorTheme = resolved.family;
  root.style?.setProperty("--boot-bg", resolved.color);
  if (root.style) {
    root.style.background = resolved.color;
    root.style.colorScheme = resolved.mode;
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved.color);
  return resolved;
}
