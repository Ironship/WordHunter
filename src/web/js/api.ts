// @ts-check

import { STATE_SCHEMA_VERSION, STORAGE_KEY } from "./constants.js";

/** Build a save payload from the raw state for bridge (Tauri) communication. */
export function buildSavePayload(rawState: WhSaveStateInput): WhSavePayload {
  const texts = collectTexts(rawState);
  const profiles = Object.fromEntries(Object.entries(rawState.profiles || {}).map(([lang, profile]) => {
    const { customTexts: _customTexts, ...withoutTexts } = profile || {};
    return [lang, toPlain(withoutTexts)];
  }));
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    texts: toPlain(texts),
    prefs: {
      ...toPlain(rawState.preferences || {}),
      __discover: toPlain(discoverPayload(rawState.discover))
    },
    hiddenBooks: toPlain(rawState.hiddenBuiltInBooks || []),
    // Texts have their own durable store; do not serialize every book twice.
    vocab: profiles
  };
}

function collectTexts(rawState: WhSaveStateInput): Array<Record<string, unknown>> {
  const profileTexts = Object.values(rawState.profiles || {})
    .flatMap((profile) => Array.isArray(profile?.customTexts) ? profile.customTexts : []);
  return profileTexts.length ? profileTexts : (rawState.customTexts || []);
}

/**
 * Complete list of durable record keys the frontend currently holds, in the
 * backend's key format. Sent with every incremental (delta) save so the
 * backend can tell "untouched" from "deleted" without receiving a full
 * snapshot.
 */
export function buildFullKeys(rawState: WhSaveStateInput): string[] {
  const keys: string[] = [];
  for (const [lang, profile] of Object.entries(rawState.profiles || {})) {
    const language = lang || "other";
    keys.push(`profile:${language}`);
    const current = profile as WhProfile | undefined;
    for (const word of Object.keys(current?.vocab || {})) keys.push(`vocab:${language}:${word}`);
    for (const book of current?.userBooks || []) {
      if (book && typeof book.id === "string") keys.push(`book:${language}:${book.id}`);
    }
  }
  for (const text of collectTexts(rawState)) {
    if (text && typeof text === "object" && typeof text.id === "string") keys.push(`text:${text.id}`);
  }
  for (const key of Object.keys(buildSavePayload(rawState).prefs)) keys.push(`pref:${key}`);
  for (const id of rawState.hiddenBuiltInBooks || []) {
    if (typeof id === "string") keys.push(`hidden:${id}`);
  }
  return keys;
}

/**
 * Incremental save payload: full prefs/hiddenBooks (small), the complete
 * vocab profiles for languages with mutations, and texts only when they
 * changed — plus fullKeys declaring every key still held. Saves ~99% of the
 * payload size compared to a full snapshot on every autosave tick.
 *
 * `dirtyTexts` is a set of the ids of the text records that changed (the
 * backend merges per key, untouched keys survive via fullKeys). `true`
 * means "everything is dirty" (full replace / restore) and sends all
 * texts; `false` sends none.
 */
export function buildDeltaSavePayload(
  rawState: WhSaveStateInput,
  dirtyVocabLangs: ReadonlySet<string>,
  dirtyTexts: ReadonlySet<string> | boolean
): WhDeltaSavePayload {
  const full = buildSavePayload(rawState);
  const vocab: Record<string, WhRecord> = {};
  for (const [lang, profile] of Object.entries(rawState.profiles || {})) {
    if (!dirtyVocabLangs.has(lang)) continue;
    const { customTexts: _customTexts, ...withoutTexts } = profile || {};
    vocab[lang] = toPlain(withoutTexts) as WhRecord;
  }
  let texts: WhText[] = [];
  if (dirtyTexts === true) {
    texts = full.texts;
  } else if (dirtyTexts && typeof (dirtyTexts as ReadonlySet<string>).has === "function" && (dirtyTexts as ReadonlySet<string>).size > 0) {
    // Realm-safe set check (vm-context Sets fail `instanceof Set` in tests).
    texts = full.texts.filter((text) => dirtyTexts.has(String(text?.id)));
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    delta: true,
    fullKeys: buildFullKeys(rawState),
    records: {
      schemaVersion: STATE_SCHEMA_VERSION,
      texts,
      prefs: full.prefs,
      hiddenBooks: full.hiddenBooks,
      vocab
    }
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

// Android teardown flush: the keepalive fetch is capped at 64 KiB while the
// real state is multi-MB, so the final mutations were silently dropped on
// every activity finish (issue #137). Instead the exit flush persists the
// save *delta* (a few MB at most, well inside the localStorage quota) under a
// dedicated key; the next boot replays it through the normal save path.
const PENDING_FLUSH_KEY = "wordhunter.pendingFlush.v1";

export function flushPendingDeltaToLocalStorage(payload: string): void {
  try {
    localStorage.setItem(PENDING_FLUSH_KEY, payload);
  } catch (e) {
    console.error("pending-flush localStorage write failed", e);
  }
}

/** Peek at a pending flush left by a previous teardown (null when absent). */
export function readPendingDelta(): string | null {
  try {
    return localStorage.getItem(PENDING_FLUSH_KEY);
  } catch (e) {
    console.error("pending-flush localStorage read failed", e);
    return null;
  }
}

/** Drop the pending flush once it has been replayed into the backend. */
export function clearPendingDelta(): void {
  try {
    localStorage.removeItem(PENDING_FLUSH_KEY);
  } catch (e) {
    console.error("pending-flush localStorage clear failed", e);
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
      const error = new Error(detail || `HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
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
