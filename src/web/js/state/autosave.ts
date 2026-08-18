import { buildDeltaSavePayload, buildSavePayload, clearPendingDelta, readPendingDelta, saveToLocalStorage, saveWithRetry, saveSyncXhr, type PendingDelta } from "../api.js";

type SaveResult = WhBridgeSaveResult | void;

const TRANSIENT_ROOT_KEYS = new Set<PropertyKey>([
  "dataDirectory",
  "recoveryStatus"
]);

const BRIDGE_UI_ROOT_KEYS = new Set<PropertyKey>([
  "currentView",
  "currentTextId",
  "selectedWord",
  "selectedWordIndex",
  "readerSelectionRange",
  "reviewIndex",
  "readerFontSize",
  "readerPdfZoom",
  "readerPdfViewMode",
  "readerPage",
  "readerPages",
  "readerScrolls",
  "readerScrollsPerPage",
  "filters"
]);

export function createAutosave(getState: () => WhAppState) {
  const proxyCache = new WeakMap<object, object>();
  const bridgeUiTargets = new WeakSet<object>();
  const vocabularyMaps = new WeakSet<object>();
  const vocabularyEntries = new WeakSet<object>();
  let rootTarget: object | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let suspendAutoSave = 0;
  let saveInFlight = false;
  let savePromise: Promise<SaveResult> = Promise.resolve();
  let savePending = false;
  let retryDelayMs = 0;
  let exclusiveWriteActive = false;
  let exclusiveWriteTail: Promise<unknown> = Promise.resolve();
  let queuedSavePromise: Promise<SaveResult> | null = null;
  let resolveQueuedSave: ((value: SaveResult | PromiseLike<SaveResult>) => void) | null;
  let rejectQueuedSave: ((reason?: any) => void) | null;
  let durableStateRevision = 0;
  let vocabularyRevision = 0;
  let mutationSequence = 0;
  // Highest mutation sequence covered by a successful backend save. A
  // mutation above this line with no dirty-language/text attribution means
  // the delta would be empty while real changes are pending — the save must
  // fall back to a full snapshot (order-independent dirty tracking).
  let lastPersistedSequence = 0;
  let saveStartedMutationSequence = 0;
  // Identity of this autosave session: the pending teardown delta is cleared
  // by a later save only when both come from the same session (cross-session
  // deltas are delivered exclusively by the boot replay).
  const AUTOSAVE_SESSION = `wh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let lastMutationAt = 0;
  let lastSaveSucceededAt = 0;
  // Incremental-save dirty tracking: which languages changed vocab (sent in
  // full per language, because the backend tombstones anything omitted from
  // the payload unless it is declared in fullKeys), and whether custom texts
  // changed (texts are large; sent only on change).
  const dirtyVocabLangs = new Set<string>();
  const dirtyTextIds = new Set<string>();
  let allTextsDirty = false;
  const rootProfiles = new WeakSet<object>();
  type DirtyContext = { kind: "vocab" | "word" | "profile" | "books" | "texts" | "text"; lang?: string };
  const dirtyContexts = new WeakMap<object, DirtyContext>();

  function isBridgeSnapshotPending(): boolean {
    return Boolean(window.__qtBridge)
      && (window.__bridgeState === null
        || (window.__bridgeState === undefined && window.__bridgeStatePromise !== undefined));
  }

  function hasPendingChanges(): boolean {
    return lastMutationAt > lastSaveSucceededAt
      || saveInFlight
      || savePending
      || saveTimer !== null;
  }

  function rawState(): WhAppState {
    const state = getState();
    return state._raw || state;
  }

  function syncProfilePreferences(): void {
    const current = rawState();
    const profile = current.profiles?.[current.preferences?.learningLanguage];
    if (profile) {
      profile.preferences = profile.preferences || {};
      profile.preferences.dictionaryUrl = current.preferences.dictionaryUrl;
      profile.preferences.dictionaryMode = current.preferences.dictionaryMode;
      profile.preferences.translationSourceLanguage = current.preferences.translationSourceLanguage;
      profile.preferences.translationTargetLanguage = current.preferences.translationTargetLanguage;
    }
  }

  function unwrapProxy<T>(value: T): T {
    const raw = value && typeof value === "object" ? (value as WhRecord)._raw : undefined;
    return (raw || value) as T;
  }

  function scheduleSave(delayMs = 200): void {
    lastMutationAt = Date.now();
    mutationSequence += 1;
    if (suspendAutoSave > 0) return;
    if (exclusiveWriteActive) {
      savePending = true;
      return;
    }
    if (saveInFlight) {
      savePending = true;
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      doSave().catch(() => {});
    }, delayMs);
  }

  function applyBackendSaveStatus(result: SaveResult): void {
    if (!result || typeof result !== "object") return;
    const current = rawState();
    if (Object.hasOwn(result, "recoveryStatus")) current.recoveryStatus = result.recoveryStatus;
  }

  function doSave(): Promise<SaveResult> {
    const current = rawState();
    syncProfilePreferences();
    if (!window.__qtBridge) {
      try {
        saveToLocalStorage(current);
        lastSaveSucceededAt = Date.now();
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (isBridgeSnapshotPending()) {
      // The backend snapshot has not been applied yet: on Android it is
      // fetched asynchronously after boot. Sending a delta/full payload now
      // would tombstone the store with an effectively empty state. Buffer
      // locally; once the snapshot lands, markDurableStateReplaced flags
      // everything dirty and the next save pushes the full state through.
      // The bootstrap leaves __bridgeState undefined until the async snapshot
      // lands, so both null and undefined must stay behind this guard.
      try {
        saveToLocalStorage(current);
        lastSaveSucceededAt = Date.now();
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    saveInFlight = true;
    saveStartedMutationSequence = mutationSequence;
    const markSucceeded = (result: SaveResult): SaveResult => {
      applyBackendSaveStatus(result);
      retryDelayMs = 0;
      lastSaveSucceededAt = Date.now();
      // The payload built at payloadSequence covers every mutation up to
      // that sequence — record it so a later unattributed mutation is
      // detected (and saved as a full snapshot) instead of silently lost.
      lastPersistedSequence = Math.max(lastPersistedSequence, payloadSequence);
      dirtyVocabLangs.clear();
      dirtyTextIds.clear();
      allTextsDirty = false;
      // A successful backend write makes the pending teardown delta redundant
      // — but only when this save's payload was built AFTER the delta was
      // frozen in this same session: then its full-per-language snapshots
      // necessarily contain every mutation the delta holds. A save built
      // before the freeze (in-flight at hidden time) does NOT cover it, and a
      // save from a later session never contains its mutations at all —
      // clearing in either case would drop the delta's mutations forever
      // (issue #137 class). A surviving cross-session delta is delivered by
      // the boot replay, which clears it on its own success.
      const pending = readPendingDelta();
      if (pending !== null
        && pending.session === AUTOSAVE_SESSION
        && payloadHasRecords
        && payloadSequence >= pending.sequence) {
        clearPendingDelta();
      }
      saveInFlight = false;
      if (savePending) {
        savePending = false;
        return doSave();
      }
      return result;
    };
    // Snapshot the mutation sequence of this payload at build time — a save
    // built at sequence N necessarily contains every mutation up to N, which
    // is the guarantee the pending-delta clear guard relies on.
    const payloadSequence = mutationSequence;
    // The save-pending follow-up (a save re-run right after markSucceeded
    // cleared the dirty sets) builds an EMPTY payload: it carries no records,
    // so it must not be allowed to clear the pending delta either.
    const unattributedMutationsPending = dirtyVocabLangs.size === 0 && dirtyTextIds.size === 0 && !allTextsDirty && mutationSequence > lastPersistedSequence;
    const payloadHasRecords = dirtyVocabLangs.size > 0 || dirtyTextIds.size > 0 || allTextsDirty || unattributedMutationsPending;
    // An empty delta from a dirty state is always a bug indicator: the dirty
    // tracking failed to attribute a mutation (or a save-pending follow-up
    // lost the dirty sets). A full snapshot is unconditionally safe.
    const payload = unattributedMutationsPending
      ? buildSavePayload(current)
      : buildDeltaSavePayload(current, dirtyVocabLangs, allTextsDirty ? true : dirtyTextIds);
    savePromise = saveWithRetry(JSON.stringify(payload), 3).then(markSucceeded).catch(async (error) => {
      // The backend may reject a delta payload (validation edge or an older
      // server build). Retry once with a full snapshot — but only for an
      // HTTP 4xx rejection, never for network failures. A delta rejection
      // must never silently drop changes.
      const status = (error as Error & { status?: number })?.status ?? 0;
      if (status >= 400 && status < 500) {
        try {
          const fullResult = await saveWithRetry(JSON.stringify(buildSavePayload(current)), 3);
          return markSucceeded(fullResult);
        } catch (fallbackError) {
          // fall through to the standard error path
        }
      }
      saveInFlight = false;
      console.error("bridge save failed after retries", error);
      savePending = false;
      retryDelayMs = retryDelayMs ? Math.min(retryDelayMs * 2, 30000) : 1000;
      window.dispatchEvent(new CustomEvent("wordhunter:state-save-error", { detail: { retryDelayMs } }));
      scheduleSave(retryDelayMs);
      throw error;
    });
    return savePromise;
  }

  function saveState(): Promise<SaveResult> {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (exclusiveWriteActive) {
      savePending = true;
      if (!queuedSavePromise) {
        queuedSavePromise = new Promise<SaveResult>((resolve, reject) => {
          resolveQueuedSave = resolve;
          rejectQueuedSave = reject;
        });
      }
      return queuedSavePromise;
    }
    if (saveInFlight) {
      if (mutationSequence > saveStartedMutationSequence) savePending = true;
      return savePromise;
    }
    return doSave();
  }

  function runExclusiveWrite<T>(
    callback: () => T | Promise<T>,
    { saveFirst = true }: { saveFirst?: boolean } = {}
  ): Promise<T> {
    const operation = exclusiveWriteTail.then(async () => {
      if (saveFirst) {
        await saveState();
      } else {
        if (saveInFlight) {
          try {
            await savePromise;
          } catch {
            // A confirmed backup restore may repair the state that autosave could not persist.
          }
        }
        clearTimeout(saveTimer);
        saveTimer = null;
        savePending = false;
      }
      exclusiveWriteActive = true;
      try {
        return await callback();
      } finally {
        exclusiveWriteActive = false;
        try {
          if (savePending) {
            savePending = false;
            const result = await doSave();
            resolveQueuedSave?.(result);
          }
        } catch (error) {
          rejectQueuedSave?.(error);
          throw error;
        } finally {
          queuedSavePromise = null;
          resolveQueuedSave = null;
          rejectQueuedSave = null;
        }
      }
    });
    exclusiveWriteTail = operation.catch(() => {});
    return operation;
  }

  function isUiMutation(object: object, prop: PropertyKey): boolean {
    return bridgeUiTargets.has(object)
      || (object === rootTarget && BRIDGE_UI_ROOT_KEYS.has(prop));
  }

  function recordVocabularyMutation(object: object, prop: PropertyKey): void {
    if ((object === rootTarget && prop === "vocab")
      || vocabularyMaps.has(object)
      || (vocabularyEntries.has(object) && prop === "status")) {
      vocabularyRevision += 1;
    }
  }

  function wrap<T extends object>(target: T, bridgeUiOnly = false): T {
    if (!rootTarget) rootTarget = target;
    if (bridgeUiOnly) bridgeUiTargets.add(target);
    if (proxyCache.has(target)) return proxyCache.get(target) as T;
    const proxy = new Proxy(target, {
      get(object, prop, receiver) {
        if (prop === "_raw") return object;
        const value = Reflect.get(object, prop, receiver);
        if (value !== null && typeof value === "object" && !(value instanceof Date)) {
          const childIsBridgeUi = bridgeUiTargets.has(object)
            || (object === rootTarget && BRIDGE_UI_ROOT_KEYS.has(prop));
          if (prop === "vocab") vocabularyMaps.add(value);
          else if (vocabularyMaps.has(object)) vocabularyEntries.add(value);
          const wrapped = proxyCache.get(value) || wrap(value, childIsBridgeUi);
          // Register the child's dirty-tracking context so mutations can be
          // attributed to a language (vocab) or to the texts store.
          // NOTE: contexts are keyed by the RAW child target (not the proxy):
          // proxy traps receive the target as their first argument, so the
          // lookups in the traps must match target keys.
          if (object === rootTarget && prop === "profiles") {
            rootProfiles.add(value);
          } else if (rootProfiles.has(object)) {
            dirtyContexts.set(value, { kind: "profile", lang: String(prop) });
          } else {
            const ctx = dirtyContexts.get(object);
            if (ctx?.kind === "profile" && prop === "vocab") dirtyContexts.set(value, { kind: "vocab", lang: ctx.lang });
            else if (ctx?.kind === "profile" && prop === "userBooks") dirtyContexts.set(value, { kind: "books", lang: ctx.lang });
            else if (ctx?.kind === "profile" && prop === "customTexts") dirtyContexts.set(value, { kind: "texts", lang: ctx.lang });
            else if (ctx?.kind === "profile") dirtyContexts.set(value, { kind: "profile", lang: ctx.lang });
            else if (ctx?.kind === "vocab") dirtyContexts.set(value, { kind: "word", lang: ctx.lang });
            else if (ctx?.kind === "texts") dirtyContexts.set(value, { kind: "text" });
          }
          return wrapped;
        }
        return value;
      },
      set(object, prop, value, receiver) {
        const oldValue = Reflect.get(object, prop, receiver);
        const rawValue = unwrapProxy(value);
        const result = Reflect.set(object, prop, rawValue, receiver);
        if (oldValue !== rawValue) {
          recordVocabularyMutation(object, prop);
          const ctx = dirtyContexts.get(object);
          if (ctx?.kind === "vocab" || ctx?.kind === "word" || ctx?.kind === "profile" || ctx?.kind === "books") {
            if (ctx.lang) dirtyVocabLangs.add(ctx.lang);
          } else if (vocabularyMaps.has(object) || vocabularyEntries.has(object)) {
            // Root state.vocab path: the mutation was recorded but no
            // profile-chain traversal attributed it to a language. Attribute
            // to the active learning language so the delta carries the
            // change regardless of access order.
            const lang = rawState()?.preferences?.learningLanguage;
            if (typeof lang === "string" && lang) dirtyVocabLangs.add(lang);
          } else if (ctx?.kind === "text") {
            const id = (object as WhRecord).id;
            if (typeof id === "string" && id) dirtyTextIds.add(id);
            else allTextsDirty = true;
          } else if (ctx?.kind === "texts") {
            // Array mutation (push/splice/index write): the changed element
            // carries the id, or fall back to marking all texts dirty.
            const candidate = rawValue !== undefined && rawValue !== null && typeof rawValue === "object" ? rawValue : oldValue;
            const id = candidate && typeof (candidate as WhRecord).id === "string" ? String((candidate as WhRecord).id) : "";
            if (id) dirtyTextIds.add(id);
            else allTextsDirty = true;
          } else if (object === rootTarget && prop === "customTexts") {
            allTextsDirty = true;
          }
        }
        if (oldValue !== rawValue
          && !(object === rootTarget && TRANSIENT_ROOT_KEYS.has(prop))
          && !isUiMutation(object, prop)) {
          if (suspendAutoSave === 0) durableStateRevision += 1;
          scheduleSave();
        }
        return result;
      },
      deleteProperty(object, prop) {
        if (prop in object) {
          const removed = Reflect.get(object, prop);
          Reflect.deleteProperty(object, prop);
          recordVocabularyMutation(object, prop);
          const ctx = dirtyContexts.get(object);
          if (ctx?.kind === "vocab" || ctx?.kind === "word" || ctx?.kind === "profile" || ctx?.kind === "books") {
            if (ctx.lang) dirtyVocabLangs.add(ctx.lang);
          } else if (vocabularyMaps.has(object) || vocabularyEntries.has(object)) {
            // Root state.vocab path: same order-independent attribution as
            // the set trap.
            const lang = rawState()?.preferences?.learningLanguage;
            if (typeof lang === "string" && lang) dirtyVocabLangs.add(lang);
          } else if (ctx?.kind === "text") {
            const id = (object as WhRecord).id;
            if (typeof id === "string" && id) dirtyTextIds.add(id);
            else allTextsDirty = true;
          } else if (ctx?.kind === "texts") {
            const id = removed && typeof (removed as WhRecord).id === "string" ? String((removed as WhRecord).id) : "";
            if (id) dirtyTextIds.add(id);
            else allTextsDirty = true;
          }
          if (!(object === rootTarget && TRANSIENT_ROOT_KEYS.has(prop))
            && !isUiMutation(object, prop)) {
            if (suspendAutoSave === 0) durableStateRevision += 1;
            scheduleSave();
          }
        }
        return true;
      }
    });
    proxyCache.set(target, proxy);
    return proxy as T;
  }

  return {
    wrap,
    saveState,
    runExclusiveWrite,
    getDurableStateRevision() {
      return durableStateRevision;
    },
    getVocabularyRevision() {
      return vocabularyRevision;
    },
    markDurableStateReplaced() {
      durableStateRevision += 1;
      vocabularyRevision += 1;
      const current = rawState();
      for (const lang of Object.keys(current.profiles || {})) dirtyVocabLangs.add(lang);
      allTextsDirty = true;
    },
    flushPendingSave() {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (exclusiveWriteActive) {
        savePending = true;
        return;
      }
      // The autosave debounce already persisted everything when nothing
      // changed since the last successful save — skip the redundant full
      // serialization (a multi-megabyte JSON.stringify) that used to make
      // window shutdown hang for seconds.
      if (!hasPendingChanges()) return;
      const current = rawState();
      syncProfilePreferences();
      if (isBridgeSnapshotPending()) saveToLocalStorage(current);
      else if (window.__qtBridge) saveSyncXhr(JSON.stringify(buildSavePayload(current)));
      else saveToLocalStorage(current);
    },
    // Synchronous serialization of the save delta for the Android teardown
    // flush (see flushPendingDeltaToLocalStorage): reuses the same dirty
    // tracking as doSave so the replayed payload merges cleanly on next boot.
    buildPendingDeltaEnvelope(): PendingDelta | null {
      // Android can hide/tear down the WebView while the durable bridge
      // snapshot is still loading. The temporary frontend state is incomplete
      // at that point; freezing its fullKeys would make the next boot replay
      // tombstone every durable record that has not arrived yet.
      if (isBridgeSnapshotPending()) return null;
      const current = rawState();
      return {
        payload: JSON.stringify(
          buildDeltaSavePayload(current, dirtyVocabLangs, allTextsDirty ? true : dirtyTextIds),
        ),
        session: AUTOSAVE_SESSION,
        sequence: mutationSequence
      };
    },
    hasPendingChanges,
    withoutAutoSave<T>(callback: () => T): T {
      suspendAutoSave++;
      try { return callback(); } finally { suspendAutoSave--; }
    }
  };
}
