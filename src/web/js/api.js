import { STATE_SCHEMA_VERSION, STORAGE_KEY } from "./constants.js";

/**
 * Build a save payload from the raw state for bridge (Tauri) communication.
 * @param {object} rawState
 * @returns {{ schemaVersion: number, texts: object[], prefs: object, hiddenBooks: string[], vocab: object }}
 */
export function buildSavePayload(rawState) {
  const profileTexts = Object.values(rawState.profiles || {})
    .flatMap((profile) => Array.isArray(profile?.customTexts) ? profile.customTexts : []);
  const profiles = Object.fromEntries(Object.entries(rawState.profiles || {}).map(([lang, profile]) => {
    const { customTexts: _customTexts, ...withoutTexts } = profile || {};
    return [lang, toPlain(withoutTexts)];
  }));
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    texts: toPlain(profileTexts.length ? profileTexts : (rawState.customTexts || [])),
    prefs: {
      ...toPlain(rawState.preferences || {}),
      __discover: toPlain(discoverPayload(rawState.discover)),
      __userBooks: toPlain(rawState.userBooks || [])
    },
    hiddenBooks: toPlain(rawState.hiddenBuiltInBooks || []),
    // Texts have their own durable store; do not serialize every book twice.
    vocab: profiles
  };
}

function discoverPayload(discover) {
  const query = typeof discover?.query === "string" ? discover.query : "";
  const source = typeof discover?.source === "string" ? discover.source : "";
  const sort = typeof discover?.sort === "string" ? discover.sort : "";
  const level = typeof discover?.level === "string" ? discover.level : "";
  const page = Math.max(1, Math.trunc(Number(discover?.page) || 1));
  return { query, source, sort, level, page };
}

/**
 * Save to localStorage.
 * @param {object} rawState
 */
export function saveToLocalStorage(rawState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(withSchemaVersion(rawState)));
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
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    } catch (e) {
      if (e.status === 409) throw e;
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
    if (xhr.status === 409) {
      window.dispatchEvent(new CustomEvent("wordhunter:sync-conflict"));
    } else if (xhr.status >= 200 && xhr.status < 300) {
      window.dispatchEvent(new CustomEvent("wordhunter:sync-saved", { detail: { time: new Date().toLocaleTimeString() } }));
    } else {
      window.dispatchEvent(new CustomEvent("wordhunter:sync-error"));
    }
  } catch (e) {
    console.error("sync save failed", e);
    window.dispatchEvent(new CustomEvent("wordhunter:sync-error"));
  }
}

// --- helpers (moved from state.js, used only within this module) ---

function toPlain(value, stack = new WeakSet()) {
  value = unwrapProxy(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (stack.has(value)) return undefined;
  stack.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => toPlain(item, stack)).filter((item) => item !== undefined);
    }

    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const plain = toPlain(item, stack);
      if (plain !== undefined) result[key] = plain;
    }
    return result;
  } finally {
    stack.delete(value);
  }
}

function withSchemaVersion(value) {
  const plain = toPlain(value);
  if (!plain || typeof plain !== "object" || Array.isArray(plain)) {
    return { schemaVersion: STATE_SCHEMA_VERSION };
  }
  return { ...plain, schemaVersion: STATE_SCHEMA_VERSION };
}

function unwrapProxy(value) {
  if (value && typeof value === "object" && value._raw) return value._raw;
  return value;
}
