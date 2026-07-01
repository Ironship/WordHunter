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
  if (!state.profiles[lang]) {
    state.profiles[lang] = { vocab: {}, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [] };
  }
  return state.profiles[lang];
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

export function moveCustomTextToProfile(id, targetLang) {
  const textObj = removeCustomTextFromActiveProfile(id);
  if (!textObj) return null;
  const newId = id.replace(/^[a-z]{2}-/, `${targetLang}-`);
  textObj.id = newId;
  textObj.updatedAt = new Date().toISOString();
  ensureProfile(targetLang).customTexts.push(textObj);
  return { textObj, oldId: id, newId };
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
