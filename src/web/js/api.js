import { STORAGE_KEY } from "./constants.js";

/**
 * Build a save payload from the raw state for bridge (Tauri) communication.
 * @param {object} rawState
 * @returns {{ texts: object[], prefs: object, hiddenBooks: string[], vocab: object }}
 */
export function buildSavePayload(rawState) {
  const profileTexts = Object.values(rawState.profiles || {})
    .flatMap((profile) => Array.isArray(profile?.customTexts) ? profile.customTexts : []);
  const profiles = Object.fromEntries(Object.entries(rawState.profiles || {}).map(([lang, profile]) => {
    const { customTexts: _customTexts, ...withoutTexts } = profile || {};
    return [lang, toPlain(withoutTexts)];
  }));
  return {
    texts: toPlain(profileTexts.length ? profileTexts : (rawState.customTexts || [])),
    prefs: {
      ...toPlain(rawState.preferences || {}),
      __userBooks: toPlain(rawState.userBooks || [])
    },
    hiddenBooks: toPlain(rawState.hiddenBuiltInBooks || []),
    // ponytail: texts have their own durable store; do not serialize every book twice.
    vocab: profiles
  };
}

/**
 * Save to localStorage.
 * @param {object} rawState
 */
export function saveToLocalStorage(rawState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toPlain(rawState)));
  } catch (e) {
    console.error("localStorage save failed", e);
  }
}

/**
 * POST the payload to the backend bridge with retry.
 * @param {string} body JSON payload string
 * @param {number} maxRetries
 * @returns {Promise<void>}
 */
export async function saveWithRetry(body, maxRetries) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch("/__store/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WH-Token": window.WH_TOKEN || ""
        },
        body
      });
      if (response.ok) return;
      throw new Error(`HTTP ${response.status}`);
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

/**
 * Synchronous XHR save for window close / flush scenarios.
 * @param {string} body JSON payload string
 */
export function saveSyncXhr(body) {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/__store/save", false);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("X-WH-Token", window.WH_TOKEN || "");
    xhr.send(body);
  } catch (e) {
    console.error("sync save failed", e);
  }
}

// --- helpers (moved from state.js, used only within this module) ---

function toPlain(value, seen = new WeakSet()) {
  value = unwrapProxy(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => toPlain(item, seen)).filter((item) => item !== undefined);
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const plain = toPlain(item, seen);
    if (plain !== undefined) result[key] = plain;
  }
  return result;
}

function unwrapProxy(value) {
  if (value && typeof value === "object" && value._raw) return value._raw;
  return value;
}
