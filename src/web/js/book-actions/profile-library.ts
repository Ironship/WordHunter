import { state } from "../state.js";
import { LEARNING_LANGUAGES } from "../constants.js";

interface FindCustomTextOptions {
  coerce?: boolean;
}

function activeProfile(): WhProfile | null {
  const lang = state.preferences?.learningLanguage;
  return lang ? state.profiles?.[lang] : null;
}

export function ensureActiveLibraryCollections() {
  if (!Array.isArray(state.archivedBookIds)) state.archivedBookIds = [];
  if (!Array.isArray(state.hiddenBuiltInBooks)) state.hiddenBuiltInBooks = [];
  const profile = activeProfile();
  if (profile) {
    profile.archivedBookIds = state.archivedBookIds;
    profile.hiddenBuiltInBooks = state.hiddenBuiltInBooks;
  }
  return {
    archivedBookIds: state.archivedBookIds,
    hiddenBuiltInBooks: state.hiddenBuiltInBooks
  };
}

function ensureProfile(lang: string): WhProfile {
  if (!state.profiles || typeof state.profiles !== "object" || Array.isArray(state.profiles)) state.profiles = {};
  if (!state.profiles[lang] || typeof state.profiles[lang] !== "object" || Array.isArray(state.profiles[lang])) {
    state.profiles[lang] = { vocab: {}, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [] };
  }
  const profile = state.profiles[lang];
  if (!profile.vocab || typeof profile.vocab !== "object") profile.vocab = {};
  if (!Array.isArray(profile.customTexts)) profile.customTexts = [];
  if (!Array.isArray(profile.userBooks)) profile.userBooks = [];
  if (!Array.isArray(profile.hiddenBuiltInBooks)) profile.hiddenBuiltInBooks = [];
  if (!Array.isArray(profile.archivedBookIds)) profile.archivedBookIds = [];
  return state.profiles[lang];
}

function withLanguagePrefix(id: string, lang: string): string {
  const rawId = String(id || "");
  const prefix = LEARNING_LANGUAGES.find((code) => rawId.startsWith(`${code}-`));
  return prefix ? `${lang}-${rawId.slice(prefix.length + 1)}` : `${lang}-${rawId}`;
}

function customTextIdsAcrossProfiles(): Set<string> {
  const ids = new Set<string>();
  for (const profile of Object.values(state.profiles || {})) {
    if (!Array.isArray(profile?.customTexts)) continue;
    for (const text of profile.customTexts) {
      if (text?.id) ids.add(String(text.id));
    }
  }
  return ids;
}

export function uniqueCustomTextId(candidate: string): string {
  const ids = customTextIdsAcrossProfiles();
  let nextId = candidate;
  let suffix = 2;
  while (ids.has(nextId)) {
    nextId = `${candidate}-${suffix}`;
    suffix += 1;
  }
  return nextId;
}

export function findCustomText(id: unknown, { coerce = false }: FindCustomTextOptions = {}): WhText | undefined {
  return state.customTexts.find((text) => coerce ? String(text.id) === String(id) : text.id === id);
}

export function hasCustomText(id: unknown): boolean {
  return Boolean(findCustomText(id));
}

export function upsertCustomText(customText: WhText): WhText {
  const idx = state.customTexts.findIndex((item) => String(item.id) === String(customText.id));
  if (idx !== -1) state.customTexts.splice(idx, 1);
  state.customTexts.push(customText);
  return customText;
}

export function hasUserBook(id: string): boolean {
  return state.userBooks.some((book) => book.id === id);
}

export function addUserBookToActiveProfile(book: WhText): WhText {
  state.userBooks.push(book);
  return book;
}

export function archiveBookId(id: string): void {
  const { archivedBookIds } = ensureActiveLibraryCollections();
  if (!archivedBookIds.includes(id)) archivedBookIds.push(id);
}

export function forgetArchivedBook(id: string): void {
  const { archivedBookIds } = ensureActiveLibraryCollections();
  const idx = archivedBookIds.indexOf(id);
  if (idx !== -1) archivedBookIds.splice(idx, 1);
}

export function hideBuiltInBookId(id: string): boolean {
  const { hiddenBuiltInBooks } = ensureActiveLibraryCollections();
  if (hiddenBuiltInBooks.includes(id)) return false;
  forgetArchivedBook(id);
  hiddenBuiltInBooks.push(id);
  return true;
}

function isBookReferenced(id: string): boolean {
  if (state.customTexts.some((text) => text.id === id) || state.userBooks.some((book) => book.id === id)) return true;
  return Object.values(state.profiles || {}).some((profile) =>
    profile?.customTexts?.some((text) => text.id === id)
    || profile?.userBooks?.some((book) => book.id === id)
  );
}

export function isCustomTextReferenced(id: string): boolean {
  return state.customTexts.some((text) => text.id === id)
    || Object.values(state.profiles || {}).some((profile) =>
      profile?.customTexts?.some((text) => text.id === id)
    );
}

export function removeCustomTextFromActiveProfile(id: string): WhText | null {
  const idx = state.customTexts.findIndex((text) => text.id === id);
  if (idx === -1) return null;
  forgetArchivedBook(id);
  const removed = state.customTexts.splice(idx, 1)[0];
  if (!isBookReferenced(id) && state.preferences.readerBookmarks) delete state.preferences.readerBookmarks[id];
  return removed;
}

export function removeUserBookFromActiveProfile(id: string): WhText | null {
  const idx = state.userBooks.findIndex((book) => book.id === id);
  if (idx === -1) return null;
  forgetArchivedBook(id);
  const removed = state.userBooks.splice(idx, 1)[0];
  if (!isBookReferenced(id) && state.preferences.readerBookmarks) delete state.preferences.readerBookmarks[id];
  return removed;
}

export function planCustomTextMove(id: string, targetLang: string) {
  const textObj = findCustomText(id);
  if (!textObj) return null;
  const newId = uniqueCustomTextId(withLanguagePrefix(id, targetLang));
  return {
    oldId: id,
    newId,
    textObj: { ...textObj, id: newId, lang: targetLang, updatedAt: new Date().toISOString() }
  };
}

export function moveCustomTextToProfile(id: string, targetLang: string) {
  const planned = planCustomTextMove(id, targetLang);
  if (!planned) return null;
  const bookmarks = state.preferences.readerBookmarks?.[id];
  const sourceLang = state.preferences.learningLanguage;
  const wasLastRead = state.preferences.lastReadTextIds?.[sourceLang] === id;
  removeCustomTextFromActiveProfile(id);
  const oldIdStillReferenced = isBookReferenced(id);
  if (bookmarks?.length) state.preferences.readerBookmarks[planned.newId] = bookmarks;
  if (state.readerPages && Object.hasOwn(state.readerPages, id)) {
    state.readerPages[planned.newId] = state.readerPages[id];
    if (!oldIdStillReferenced) delete state.readerPages[id];
  }
  if (state.readerScrolls && Object.hasOwn(state.readerScrolls, id)) {
    state.readerScrolls[planned.newId] = state.readerScrolls[id];
    if (!oldIdStillReferenced) delete state.readerScrolls[id];
  }
  if (state.readerScrollsPerPage) {
    for (const [key, value] of Object.entries(state.readerScrollsPerPage)) {
      if (!key.startsWith(`${id}-`)) continue;
      state.readerScrollsPerPage[`${planned.newId}${key.slice(id.length)}`] = value;
      if (!oldIdStillReferenced) delete state.readerScrollsPerPage[key];
    }
  }
  if (wasLastRead) {
    if (!state.preferences.lastReadTextIds) state.preferences.lastReadTextIds = {};
    state.preferences.lastReadTextIds[targetLang] = planned.newId;
  }
  const targetProfile = ensureProfile(targetLang);
  targetProfile.customTexts.push(planned.textObj);
  return planned;
}

export function moveUserBookToProfile(id: string, targetLang: string): WhText | null {
  const bookmarks = state.preferences.readerBookmarks?.[id];
  const bookObj = removeUserBookFromActiveProfile(id);
  if (!bookObj) return null;
  if (bookmarks?.length) state.preferences.readerBookmarks[id] = bookmarks;
  ensureProfile(targetLang).userBooks.push(bookObj);
  return bookObj;
}

export function clearCurrentBookSelectionIfMatches(id: string): boolean {
  if (state.currentTextId !== id) return false;
  state.currentTextId = null;
  state.selectedWord = null;
  return true;
}
