import { state } from "../state.js";

function activeProfile() {
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

function ensureProfile(lang) {
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

function withLanguagePrefix(id, lang) {
  const rawId = String(id || "");
  return rawId.match(/^[a-z]{2,3}-/) ? rawId.replace(/^[a-z]{2,3}-/, `${lang}-`) : `${lang}-${rawId}`;
}

function customTextIdsAcrossProfiles() {
  const ids = new Set();
  for (const profile of Object.values(state.profiles || {})) {
    if (!Array.isArray(profile?.customTexts)) continue;
    for (const text of profile.customTexts) {
      if (text?.id) ids.add(String(text.id));
    }
  }
  return ids;
}

function uniqueCustomTextId(candidate) {
  const ids = customTextIdsAcrossProfiles();
  let nextId = candidate;
  let suffix = 2;
  while (ids.has(nextId)) {
    nextId = `${candidate}-${suffix}`;
    suffix += 1;
  }
  return nextId;
}

export function findCustomText(id, { coerce = false } = {}) {
  return state.customTexts.find((text) => coerce ? String(text.id) === String(id) : text.id === id);
}

export function hasCustomText(id) {
  return Boolean(findCustomText(id));
}

export function upsertCustomText(customText) {
  const idx = state.customTexts.findIndex((item) => String(item.id) === String(customText.id));
  if (idx !== -1) state.customTexts.splice(idx, 1);
  state.customTexts.push(customText);
  return customText;
}

export function hasUserBook(id) {
  return state.userBooks.some((book) => book.id === id);
}

export function addUserBookToActiveProfile(book) {
  state.userBooks.push(book);
  return book;
}

export function archiveBookId(id) {
  const { archivedBookIds } = ensureActiveLibraryCollections();
  if (!archivedBookIds.includes(id)) archivedBookIds.push(id);
}

export function forgetArchivedBook(id) {
  const { archivedBookIds } = ensureActiveLibraryCollections();
  const idx = archivedBookIds.indexOf(id);
  if (idx !== -1) archivedBookIds.splice(idx, 1);
}

export function hideBuiltInBookId(id) {
  const { hiddenBuiltInBooks } = ensureActiveLibraryCollections();
  if (hiddenBuiltInBooks.includes(id)) return false;
  forgetArchivedBook(id);
  hiddenBuiltInBooks.push(id);
  return true;
}

export function removeCustomTextFromActiveProfile(id) {
  const idx = state.customTexts.findIndex((text) => text.id === id);
  if (idx === -1) return null;
  forgetArchivedBook(id);
  return state.customTexts.splice(idx, 1)[0];
}

export function removeUserBookFromActiveProfile(id) {
  const idx = state.userBooks.findIndex((book) => book.id === id);
  if (idx === -1) return null;
  forgetArchivedBook(id);
  return state.userBooks.splice(idx, 1)[0];
}

export function planCustomTextMove(id, targetLang) {
  const textObj = findCustomText(id);
  if (!textObj) return null;
  const newId = uniqueCustomTextId(withLanguagePrefix(id, targetLang));
  return {
    oldId: id,
    newId,
    textObj: { ...textObj, id: newId, lang: targetLang, updatedAt: new Date().toISOString() }
  };
}

export function moveCustomTextToProfile(id, targetLang) {
  const planned = planCustomTextMove(id, targetLang);
  if (!planned) return null;
  removeCustomTextFromActiveProfile(id);
  const targetProfile = ensureProfile(targetLang);
  targetProfile.customTexts.push(planned.textObj);
  return planned;
}

export function moveUserBookToProfile(id, targetLang) {
  const bookObj = removeUserBookFromActiveProfile(id);
  if (!bookObj) return null;
  ensureProfile(targetLang).userBooks.push(bookObj);
  return bookObj;
}

export function clearCurrentBookSelectionIfMatches(id) {
  if (state.currentTextId !== id) return false;
  state.currentTextId = null;
  state.selectedWord = null;
  return true;
}
