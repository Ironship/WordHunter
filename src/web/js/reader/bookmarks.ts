import { state, saveState, saveUiState } from "../state.js";
import { t } from "../i18n.js";
import { escapeAttribute, escapeHtml } from "../utils.js";
import { rememberReaderScrollPosition } from "./scroll.js";
import { getReaderSession } from "./session.js";
import { normalizeWord } from "../tokenizer_v2.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";
import { buildPdfDocumentText } from "./pdf-page-text.js";

export interface ReaderBookmarkPosition {
  page: number;
  scrollTop: number;
  wordIndex: number | null;
  anchorOffset?: number;
  anchorWord?: string;
  anchorBefore?: string;
  anchorAfter?: string;
}

let pendingPosition: ReaderBookmarkPosition | null = null;
let editingBookmarkId: string | null = null;
const MAX_BOOKMARKS_PER_BOOK = 200;
const BOOKMARK_COLORS: readonly WhReaderBookmarkColor[] = ["amber", "red", "green", "blue", "purple"];
const resolvedBookmarkIndexes = new Map<string, number>();

function resolvedBookmarkKey(textId: string, bookmark: WhReaderBookmark, algorithm: string): string {
  return `${textId}\0${bookmark.id}\0${bookmark.wordIndex}\0${bookmark.wordAlgorithm || ""}\0${bookmark.anchorOffset ?? ""}\0${bookmark.anchorWord || ""}\0${algorithm}`;
}

function resolvedBookmarkIndex(bookmark: WhReaderBookmark, textId: string): number | null {
  const algorithm = state.preferences.wordDetectionAlgorithm === "classic" ? "classic" : "modern";
  return resolvedBookmarkIndexes.get(resolvedBookmarkKey(textId, bookmark, algorithm))
    ?? bookmark.wordIndex;
}

function showBookmarkToast(key: string): void {
  void import("../toast.js").then(({ showToast }) => showToast(t(key)));
}

function bookmarkStore(): Record<string, WhReaderBookmark[]> {
  const current = state.preferences.readerBookmarks;
  if (current && typeof current === "object" && !Array.isArray(current)) return current;
  state.preferences.readerBookmarks = {};
  return state.preferences.readerBookmarks;
}

function cleanLabel(label: unknown, fallbackNumber: number): string {
  const cleaned = typeof label === "string" ? label.trim().replace(/\s+/g, " ").slice(0, 160) : "";
  return cleaned || t("reader.bookmarkDefault", { n: fallbackNumber });
}

function cleanColor(color: unknown): WhReaderBookmarkColor {
  return BOOKMARK_COLORS.includes(color as WhReaderBookmarkColor) ? color as WhReaderBookmarkColor : "amber";
}

function bookmarkId(): string {
  return globalThis.crypto?.randomUUID?.()
    || `bookmark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function getReaderBookmarkPage(bookmark: WhReaderBookmark, textId = state.currentTextId): number {
  const current = state.customTexts?.find((text) => text.id === textId);
  const wordIndex = textId ? resolvedBookmarkIndex(bookmark, textId) : bookmark.wordIndex;
  if (wordIndex === null || current?.pdfOcrPages?.length) return bookmark.page;
  const wordsPerPage = Math.max(1, Number(state.preferences.wordsPerPage) || 1000);
  return wordsPerPage >= 999999 ? 1 : Math.floor(wordIndex / wordsPerPage) + 1;
}

export function getReaderBookmarks(textId = state.currentTextId): WhReaderBookmark[] {
  if (!textId) return [];
  return (bookmarkStore()[textId] || []).map((bookmark) => ({
    ...bookmark,
    wordIndex: resolvedBookmarkIndex(bookmark, textId)
  })).sort((left, right) =>
    getReaderBookmarkPage(left, textId) - getReaderBookmarkPage(right, textId)
    || (left.wordIndex ?? Number.MAX_SAFE_INTEGER) - (right.wordIndex ?? Number.MAX_SAFE_INTEGER)
    || left.scrollTop - right.scrollTop
    || left.createdAt.localeCompare(right.createdAt)
  );
}

export function captureCurrentBookmarkPosition(activeWordIndex?: number): ReaderBookmarkPosition | null {
  const textId = state.currentTextId;
  if (!textId) return null;
  rememberReaderScrollPosition({ precise: true });
  const saved = state.readerScrolls?.[textId];
  const explicitWordIndex = Number.isInteger(activeWordIndex) && Number(activeWordIndex) >= 0
    ? Number(activeWordIndex)
    : null;
  const candidateWordIndex = explicitWordIndex
    ?? (state.selectedWord || state.readerSelectionRange ? state.selectedWordIndex : null);
  const readerText = document.getElementById("reader-text");
  const selectedToken = Number.isInteger(candidateWordIndex) && Number(candidateWordIndex) >= 0
    ? readerText?.querySelector<HTMLElement>(`.word-token${explicitWordIndex === null ? ".selected" : ""}[data-word-index="${candidateWordIndex}"]`)
    : null;
  const selectedWordIndex = selectedToken ? Number(candidateWordIndex) : null;
  const savedWordIndex = saved && typeof saved === "object" && Number.isInteger(saved.wordIndex) && saved.wordIndex >= 0
    ? Number(saved.wordIndex)
    : null;
  const wordIndex = selectedWordIndex ?? savedWordIndex;
  const anchorToken = wordIndex === null
    ? null
    : readerText?.querySelector<HTMLElement>(`.word-token[data-word-index="${wordIndex}"]`) || null;
  const pageTokens = readerText ? Array.from(readerText.querySelectorAll<HTMLElement>(".word-token")) : [];
  const anchorIndex = anchorToken ? pageTokens.indexOf(anchorToken) : -1;
  const anchorValue = (token: HTMLElement | undefined | null) => normalizeWord(token?.textContent || token?.dataset.word || "");
  const anchorWord = anchorValue(anchorToken);
  const anchorOffset = Number.parseInt(anchorToken?.dataset.charOffset || "", 10);
  const anchorBefore = anchorIndex > 0 ? anchorValue(pageTokens[anchorIndex - 1]) : "";
  const anchorAfter = anchorIndex >= 0 ? anchorValue(pageTokens[anchorIndex + 1]) : "";
  return {
    page: Math.max(1, Math.round(state.readerPage) || 1),
    scrollTop: saved && typeof saved === "object"
      ? Math.max(0, Math.round(Number(saved.scrollTop) || 0))
      : Math.max(0, Math.round(document.getElementById("reader-text")?.scrollTop || 0)),
    wordIndex,
    ...(Number.isInteger(anchorOffset) && anchorOffset >= 0 ? { anchorOffset } : {}),
    ...(anchorWord ? { anchorWord } : {}),
    ...(anchorBefore ? { anchorBefore } : {}),
    ...(anchorAfter ? { anchorAfter } : {})
  };
}

export function addReaderBookmark(
  label: unknown,
  position = captureCurrentBookmarkPosition(),
  color: unknown = "amber"
): WhReaderBookmark | null {
  const textId = state.currentTextId;
  if (!textId || !position) return null;
  const bookmarks = bookmarkStore()[textId] || [];
  if (bookmarks.length >= MAX_BOOKMARKS_PER_BOOK) {
    showBookmarkToast("reader.bookmarkLimit");
    return null;
  }
  const bookmark: WhReaderBookmark = {
    id: bookmarkId(),
    label: cleanLabel(label, bookmarks.length + 1),
    color: cleanColor(color),
    page: Math.max(1, Math.round(position.page) || 1),
    scrollTop: Math.max(0, Math.round(position.scrollTop) || 0),
    wordIndex: Number.isInteger(position.wordIndex) && Number(position.wordIndex) >= 0 ? Number(position.wordIndex) : null,
    ...(Number.isInteger(position.anchorOffset) && Number(position.anchorOffset) >= 0
      ? { anchorOffset: Number(position.anchorOffset) }
      : {}),
    ...(normalizeWord(position.anchorWord) ? { anchorWord: normalizeWord(position.anchorWord) } : {}),
    ...(normalizeWord(position.anchorBefore) ? { anchorBefore: normalizeWord(position.anchorBefore) } : {}),
    ...(normalizeWord(position.anchorAfter) ? { anchorAfter: normalizeWord(position.anchorAfter) } : {}),
    wordAlgorithm: state.preferences.wordDetectionAlgorithm === "classic" ? "classic" : "modern",
    createdAt: new Date().toISOString()
  };
  bookmarkStore()[textId] = [...bookmarks, bookmark];
  void saveState();
  renderReaderBookmarks(textId);
  renderBookmarkDialogList();
  showBookmarkToast("reader.bookmarkAdded");
  return bookmark;
}

export function toggleReaderBookmarkAtCurrentWord(activeWordIndex?: number): boolean {
  const position = captureCurrentBookmarkPosition(activeWordIndex);
  if (!position || !Number.isInteger(position.wordIndex)) return false;
  const existing = getReaderBookmarks().find((bookmark) => bookmark.wordIndex === position.wordIndex);
  return existing ? removeReaderBookmark(existing.id) : addReaderBookmark("", position) !== null;
}

export async function remapReaderBookmarksForAlgorithm(
  targetAlgorithm: "classic" | "modern",
  onlyTextId?: string
): Promise<number> {
  const store = bookmarkStore();
  const [{ getTextById }, { bookTexts, loadBookText, loadCustomTextContent }] = await Promise.all([
    import("./renderer.js"),
    import("../books.js")
  ]);
  let changed = 0;
  for (const [textId, bookmarks] of Object.entries(store)) {
    if (onlyTextId && textId !== onlyTextId) continue;
    if (!bookmarks.some((bookmark) => bookmark.wordIndex !== null && (bookmark.anchorWord || Number.isInteger(bookmark.anchorOffset)))) continue;
    let profileText: WhText | undefined;
    let profileLanguage = "";
    let profileTextKind: "custom" | "book" | "" = "";
    for (const [language, profile] of Object.entries(state.profiles || {})) {
      const customText = (profile.customTexts || []).find((text) => text.id === textId);
      const userBook = (profile.userBooks || []).find((text) => text.id === textId);
      if (!customText && !userBook) continue;
      profileText = customText || userBook;
      profileLanguage = language;
      profileTextKind = customText ? "custom" : "book";
      break;
    }
    const cachedText = bookTexts.get(textId);
    let current = getTextById(textId)
      || (profileText ? { ...profileText, text: cachedText || profileText.text || "" } : undefined)
      || (cachedText ? { id: textId, text: cachedText } : undefined);
    if (!current) continue;
    if (!current.text) {
      try {
        const text = profileTextKind === "custom" && profileText
          ? await loadCustomTextContent(profileText)
          : await loadBookText((profileText || current));
        current = { ...current, text };
      } catch (error) {
        console.warn(`Could not remap Reader bookmarks without book text: ${textId}`, error);
        continue;
      }
    }
    const language = current.lang && current.lang !== "other"
      ? current.lang
      : profileLanguage
        ? effectiveLearningLanguage({
            ...state.preferences,
            learningLanguage: profileLanguage,
            translationSourceLanguage: state.profiles[profileLanguage]?.preferences?.translationSourceLanguage
          })
        : effectiveLearningLanguage(state.preferences);
    const sessionText = current.pdfOcrPages?.length
      ? buildPdfDocumentText(current.pdfOcrPages)
      : current.text;
    const session = getReaderSession({ ...current, text: sessionText }, language, targetAlgorithm);
    const words = session.tokens.flatMap((token, tokenIndex) => token.type === "word"
      ? [{
          index: session.globalWordIndexes[tokenIndex],
          value: normalizeWord(token.value),
          start: session.globalCharOffsets[tokenIndex],
          end: session.globalCharOffsets[tokenIndex] + token.value.length
        }]
      : []);
    for (const bookmark of bookmarks) {
      if (bookmark.wordIndex === null || (!bookmark.anchorWord && !Number.isInteger(bookmark.anchorOffset))) continue;
      const currentWord = words[bookmark.wordIndex];
      if (bookmark.wordAlgorithm === targetAlgorithm && currentWord?.value === bookmark.anchorWord) {
        resolvedBookmarkIndexes.set(resolvedBookmarkKey(textId, bookmark, targetAlgorithm), bookmark.wordIndex);
        continue;
      }
      const offsetCandidate = Number.isInteger(bookmark.anchorOffset)
        ? words.find((word) => Number(bookmark.anchorOffset) >= word.start && Number(bookmark.anchorOffset) < word.end)
        : undefined;
      const candidates = words
        .filter((word) => word.value === bookmark.anchorWord)
        .map((word) => {
          const before = words[word.index - 1]?.value;
          const after = words[word.index + 1]?.value;
          const contextScore = Number(!!bookmark.anchorBefore && before === bookmark.anchorBefore)
            + Number(!!bookmark.anchorAfter && after === bookmark.anchorAfter);
          return { index: word.index, contextScore, distance: Math.abs(word.index - bookmark.wordIndex!) };
        })
        .sort((left, right) => right.contextScore - left.contextScore || left.distance - right.distance);
      const targetIndex = candidates[0]?.index ?? offsetCandidate?.index;
      if (targetIndex === undefined) continue;
      resolvedBookmarkIndexes.set(resolvedBookmarkKey(textId, bookmark, targetAlgorithm), targetIndex);
      if (bookmark.wordIndex !== targetIndex || bookmark.wordAlgorithm !== targetAlgorithm) changed += 1;
    }
  }
  return changed;
}

export function renameReaderBookmark(id: string, label: unknown, color?: unknown): boolean {
  const textId = state.currentTextId;
  if (!textId) return false;
  const bookmarks = bookmarkStore()[textId] || [];
  const bookmark = bookmarks.find((item) => item.id === id);
  if (!bookmark) return false;
  bookmark.label = cleanLabel(label, bookmarks.indexOf(bookmark) + 1);
  if (color !== undefined) bookmark.color = cleanColor(color);
  void saveState();
  renderReaderBookmarks(textId);
  renderBookmarkDialogList();
  showBookmarkToast("reader.bookmarkUpdated");
  return true;
}

export function removeReaderBookmark(id: string): boolean {
  const textId = state.currentTextId;
  if (!textId) return false;
  const bookmarks = bookmarkStore()[textId] || [];
  const next = bookmarks.filter((item) => item.id !== id);
  if (next.length === bookmarks.length) return false;
  if (next.length) bookmarkStore()[textId] = next;
  else delete bookmarkStore()[textId];
  void saveState();
  renderReaderBookmarks(textId);
  renderBookmarkDialogList();
  showBookmarkToast("reader.bookmarkRemoved");
  return true;
}

export async function jumpToReaderBookmark(id: string): Promise<boolean> {
  const textId = state.currentTextId;
  const bookmark = getReaderBookmarks(textId).find((item) => item.id === id);
  if (!textId || !bookmark) return false;
  const { renderReader } = await import("./renderer.js");
  const targetPage = getReaderBookmarkPage(bookmark, textId);
  state.readerPage = targetPage;
  state.readerPages = state.readerPages || {};
  state.readerPages[textId] = targetPage;
  state.readerScrolls = state.readerScrolls || {};
  state.readerScrolls[textId] = {
    wordIndex: bookmark.wordIndex,
    scrollTop: bookmark.scrollTop,
    readerPage: targetPage
  };
  const perPageKey = `${textId}-p${targetPage}`;
  if (state.readerScrollsPerPage) delete state.readerScrollsPerPage[perPageKey];
  const readerText = document.getElementById("reader-text");
  if (readerText && bookmark.wordIndex !== null) readerText.dataset.focusWordIndex = String(bookmark.wordIndex);
  await saveUiState();
  renderReader();
  return true;
}

export function renderReaderBookmarks(textId = state.currentTextId): void {
  const button = document.getElementById("reader-bookmarks-button") as HTMLButtonElement | null;
  const count = document.getElementById("reader-bookmarks-count");
  const tabs = document.getElementById("reader-bookmark-tabs");
  const bookmarks = getReaderBookmarks(textId);
  if (button) button.disabled = !textId;
  if (count) {
    count.textContent = String(bookmarks.length);
    count.hidden = bookmarks.length === 0;
  }
  if (!tabs) return;
  tabs.hidden = bookmarks.length === 0;
  tabs.innerHTML = bookmarks.map((bookmark) => {
    const page = getReaderBookmarkPage(bookmark, textId);
    return `
    <button type="button" class="reader-bookmark-tab" data-bookmark-color="${cleanColor(bookmark.color)}" data-bookmark-jump="${escapeAttribute(bookmark.id)}"
      title="${escapeAttribute(t("reader.bookmarkTabTitle", { label: bookmark.label, page }))}"
      aria-label="${escapeAttribute(t("reader.bookmarkTabTitle", { label: bookmark.label, page }))}">
      <span class="reader-bookmark-page" aria-hidden="true">${page}</span>
      <span class="reader-bookmark-tab-label">${escapeHtml(bookmark.label)}</span>
    </button>`;
  }).join("");
  renderInlineBookmarkIndicators(textId);
}

export function renderInlineBookmarkIndicators(textId = state.currentTextId): void {
  const readerText = document.getElementById("reader-text");
  if (!readerText) return;
  for (const token of readerText.querySelectorAll<HTMLElement>(".word-token.reader-inline-bookmark")) {
    token.classList.remove("reader-inline-bookmark");
    delete token.dataset.readerBookmarkCount;
    delete token.dataset.bookmarkColor;
    if (token.dataset.readerBookmarkTitle === "1") {
      token.removeAttribute("title");
      delete token.dataset.readerBookmarkTitle;
    }
  }
  if (!textId) return;

  const byWordIndex = new Map<number, WhReaderBookmark[]>();
  for (const bookmark of getReaderBookmarks(textId)) {
    if (bookmark.wordIndex === null) continue;
    const matches = byWordIndex.get(bookmark.wordIndex) || [];
    matches.push(bookmark);
    byWordIndex.set(bookmark.wordIndex, matches);
  }
  for (const [wordIndex, bookmarks] of byWordIndex) {
    const token = readerText.querySelector<HTMLElement>(`.word-token[data-word-index="${wordIndex}"]`);
    if (!token) continue;
    const first = bookmarks[0];
    token.classList.add("reader-inline-bookmark");
    token.dataset.readerBookmarkCount = String(bookmarks.length);
    token.dataset.bookmarkColor = cleanColor(first.color);
    if (!token.hasAttribute("title")) {
      token.title = t("reader.bookmarkTabTitle", { label: first.label, page: getReaderBookmarkPage(first, textId) });
      token.dataset.readerBookmarkTitle = "1";
    }
  }
}

function renderBookmarkDialogList(): void {
  const list = document.getElementById("reader-bookmark-list");
  if (!list) return;
  const bookmarks = getReaderBookmarks();
  if (!bookmarks.length) {
    list.innerHTML = `<p class="muted-copy reader-bookmark-empty">${escapeHtml(t("reader.bookmarkEmpty"))}</p>`;
    return;
  }
  list.innerHTML = bookmarks.map((bookmark) => `
    <div class="reader-bookmark-row">
      <button type="button" class="reader-bookmark-location" data-bookmark-jump="${escapeAttribute(bookmark.id)}">
        <span class="reader-bookmark-row-marker" data-bookmark-color="${cleanColor(bookmark.color)}" aria-hidden="true"></span>
        <span><strong>${escapeHtml(bookmark.label)}</strong><small>${escapeHtml(t("reader.bookmarkPage", { page: getReaderBookmarkPage(bookmark) }))}</small></span>
      </button>
      <div class="reader-bookmark-row-actions">
        <button type="button" class="icon-button" data-bookmark-edit="${escapeAttribute(bookmark.id)}" title="${escapeAttribute(t("reader.bookmarkEdit"))}" aria-label="${escapeAttribute(t("reader.bookmarkEdit"))}">✎</button>
        <button type="button" class="icon-button" data-bookmark-remove="${escapeAttribute(bookmark.id)}" title="${escapeAttribute(t("reader.bookmarkDelete"))}" aria-label="${escapeAttribute(t("reader.bookmarkDelete"))}">×</button>
      </div>
    </div>`).join("");
}

function resetEditor(): void {
  editingBookmarkId = null;
  const input = document.getElementById("reader-bookmark-label") as HTMLInputElement | null;
  const submit = document.getElementById("reader-bookmark-submit");
  const cancel = document.getElementById("reader-bookmark-cancel-edit");
  if (input) input.value = "";
  const color = document.querySelector<HTMLInputElement>('input[name="reader-bookmark-color"][value="amber"]');
  if (color) color.checked = true;
  if (submit) submit.textContent = t("reader.bookmarkAdd");
  if (cancel) cancel.hidden = true;
}

function editBookmark(id: string): void {
  const bookmark = getReaderBookmarks().find((item) => item.id === id);
  const input = document.getElementById("reader-bookmark-label") as HTMLInputElement | null;
  if (!bookmark || !input) return;
  editingBookmarkId = id;
  input.value = bookmark.label;
  const color = document.querySelector<HTMLInputElement>(`input[name="reader-bookmark-color"][value="${cleanColor(bookmark.color)}"]`);
  if (color) color.checked = true;
  document.getElementById("reader-bookmark-submit")!.textContent = t("reader.bookmarkSave");
  document.getElementById("reader-bookmark-cancel-edit")!.hidden = false;
  input.focus();
  input.select();
}

function openBookmarksDialog(): void {
  if (!state.currentTextId) return;
  pendingPosition = captureCurrentBookmarkPosition();
  resetEditor();
  renderBookmarkDialogList();
  const dialog = document.getElementById("reader-bookmarks-dialog");
  if (!(dialog instanceof HTMLDialogElement)) return;
  dialog.showModal();
  requestAnimationFrame(() => (document.getElementById("reader-bookmark-label") as HTMLInputElement | null)?.focus());
}

export function bindReaderBookmarkEvents(): void {
  const button = document.getElementById("reader-bookmarks-button");
  const tabs = document.getElementById("reader-bookmark-tabs");
  const dialog = document.getElementById("reader-bookmarks-dialog") as HTMLDialogElement | null;
  const form = document.getElementById("reader-bookmark-form") as HTMLFormElement | null;
  const list = document.getElementById("reader-bookmark-list");
  if (!button || !tabs || !dialog || !form || !list || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  button.addEventListener("click", openBookmarksDialog);
  tabs.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-bookmark-jump]") : null;
    if (target?.dataset.bookmarkJump) void jumpToReaderBookmark(target.dataset.bookmarkJump);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("reader-bookmark-label") as HTMLInputElement | null;
    const color = document.querySelector<HTMLInputElement>('input[name="reader-bookmark-color"]:checked')?.value;
    if (editingBookmarkId) renameReaderBookmark(editingBookmarkId, input?.value, color);
    else addReaderBookmark(input?.value, pendingPosition, color);
    resetEditor();
  });
  list.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const jump = target?.closest<HTMLElement>("[data-bookmark-jump]")?.dataset.bookmarkJump;
    const edit = target?.closest<HTMLElement>("[data-bookmark-edit]")?.dataset.bookmarkEdit;
    const remove = target?.closest<HTMLElement>("[data-bookmark-remove]")?.dataset.bookmarkRemove;
    if (jump) {
      dialog.close();
      void jumpToReaderBookmark(jump);
    } else if (edit) editBookmark(edit);
    else if (remove) {
      removeReaderBookmark(remove);
      if (editingBookmarkId === remove) resetEditor();
    }
  });
  document.getElementById("reader-bookmarks-close")?.addEventListener("click", () => dialog.close());
  document.getElementById("reader-bookmark-cancel-edit")?.addEventListener("click", resetEditor);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", resetEditor);
  renderReaderBookmarks();
}
