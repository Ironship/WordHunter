// @ts-check

import { STATE_SCHEMA_VERSION, STORAGE_KEY } from "./constants.js";

/** Build a save payload from the raw state for bridge (Tauri) communication. */
export function buildSavePayload(rawState: WhSaveStateInput): WhSavePayload {
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
      __discover: toPlain(discoverPayload(rawState.discover))
    },
    hiddenBooks: toPlain(rawState.hiddenBuiltInBooks || []),
    // Texts have their own durable store; do not serialize every book twice.
    vocab: profiles
  };
}

function discoverPayload(discover: Partial<WhDiscoverState> | undefined): WhDiscoverState {
  const query = typeof discover?.query === "string" ? discover.query : "";
  const source = typeof discover?.source === "string" ? discover.source : "";
  const sort = typeof discover?.sort === "string" ? discover.sort : "";
  const level = typeof discover?.level === "string" ? discover.level : "";
  const page = Math.max(1, Math.trunc(Number(discover?.page) || 1));
  return { query, source, sort, level, page };
}

/** Save to localStorage. */
export function saveToLocalStorage(rawState: WhSaveStateInput): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(withSchemaVersion(rawState)));
  } catch (e) {
    console.error("localStorage save failed", e);
    throw e;
  }
}

/** POST the payload to the backend bridge with retry. */
export async function saveWithRetry(body: string, maxRetries: number): Promise<WhBridgeSaveResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Do not put a client-side deadline on a full store save. Aborting the
      // fetch does not cancel the backend write; retrying while that write is
      // still running queues duplicate multi-file saves behind the write lock.
      const response = await fetch("/__store/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WH-Token": window.WH_TOKEN || ""
        },
        body
      });
      if (response.ok) return await response.json().catch(() => ({ ok: true }));
      const detail = (await response.text()).trim();
      throw new Error(detail || `HTTP ${response.status}`);
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  return {};
}

/** Fire-and-forget save for window close / flush scenarios.
 *
 * Uses a keepalive fetch instead of a blocking synchronous XHR: the server is
 * already shutting down when this fires from pagehide, so a sync XHR could
 * hang the renderer for its full timeout with no one left to answer.
 */
export function saveSyncXhr(body: string): void {
  try {
    void fetch("/__store/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
      body,
      keepalive: true
    }).then((response) => {
      if (response.ok) return;
      window.dispatchEvent(new CustomEvent("wordhunter:state-save-error"));
    }).catch((error) => {
      console.error("sync save failed", error);
      window.dispatchEvent(new CustomEvent("wordhunter:state-save-error"));
    });
  } catch (e) {
    console.error("sync save failed", e);
    window.dispatchEvent(new CustomEvent("wordhunter:state-save-error"));
  }
}

// --- helpers (moved from state.js, used only within this module) ---

function toPlain(value: any, stack: WeakSet<object> = new WeakSet()): any {
  value = unwrapProxy(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (stack.has(value)) return undefined;
  stack.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => toPlain(item, stack)).filter((item) => item !== undefined);
    }

    const result: WhRecord = {};
    for (const [key, item] of Object.entries(value)) {
      const plain = toPlain(item, stack);
      if (plain !== undefined) result[key] = plain;
    }
    return result;
  } finally {
    stack.delete(value);
  }
}

function withSchemaVersion(value: unknown): WhRecord {
  const plain = toPlain(value);
  if (!plain || typeof plain !== "object" || Array.isArray(plain)) {
    return { schemaVersion: STATE_SCHEMA_VERSION };
  }
  return { ...plain, schemaVersion: STATE_SCHEMA_VERSION };
}

function unwrapProxy(value: any): any {
  if (value && typeof value === "object" && value._raw) return value._raw;
  return value;
}
