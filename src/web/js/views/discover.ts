// "Discover" view — orchestrator, re-exports from sub-modules.
import { state, saveState } from "../state.js";
import { els as domElements } from "../dom.js";
import { escapeHtml, escapeAttribute } from "../utils.js";
import { t as translate, getLocale } from "../i18n.js";
import { searchGutendex } from "../discover/gutendex.js";
import { searchMediaWiki } from "../discover/mediawiki.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";

interface DiscoverElements {
  discoverForm: HTMLFormElement;
  discoverQuery: HTMLInputElement;
  discoverSource: HTMLSelectElement;
  discoverSort: HTMLSelectElement;
  discoverLevel: HTMLSelectElement;
  discoverResults: HTMLElement;
  discoverPagination: HTMLElement;
  discoverToolbar: HTMLElement;
  discoverStatus: HTMLElement;
}

interface DiscoverSearchResult {
  count: number;
  results: DiscoverBook[];
  next?: boolean;
  previous?: boolean;
}

interface DiscoverAuthor {
  name?: string;
  birth_year?: number;
  death_year?: number;
}

interface DiscoverBook {
  id?: string | number;
  title?: string;
  source?: string;
  formats?: Record<string, string | undefined>;
  coverDataUrl?: string;
  authors?: DiscoverAuthor[];
  languages?: string[];
  summaries?: string[];
  download_count?: number;
}

interface DiscoverHandlers {
  onAdd?: (book: DiscoverBook, options?: { silent?: boolean }) => boolean | Promise<boolean>;
  onRemove?: (id: string) => unknown;
  onOpen?: (id: string) => unknown;
}

const els = domElements as DiscoverElements;
const t = translate as (key: string, vars?: Record<string, string | number | boolean | null | undefined>) => string;

let lastResults: DiscoverBook[] = [];
const selected = new Set<string>();
let searchRunId = 0;
let activeSearchController: AbortController | null = null;
let _cachedPrev: boolean | null = null;
let _cachedNext: boolean | null = null;
let _mwContinueToken: string | null = null;
const FETCH_CONCURRENCY = 2;

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

function authorName(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function formatAuthors(value: unknown): string {
  return Array.isArray(value) ? value.map(authorName).filter(Boolean).join(", ") : "";
}

function getDiscoverLanguage(): string {
  return effectiveLearningLanguage(state.preferences).split("-")[0];
}

export function renderDiscover(): void {
  if (!els.discoverForm) return;
  els.discoverQuery.value = state.discover.query || "";
  if (els.discoverSource) els.discoverSource.value = state.discover.source || "gutenberg";
  els.discoverSort.value = state.discover.sort || "popular";
  if (els.discoverLevel) els.discoverLevel.value = state.discover.level || "";

  const isGutenberg = (state.discover.source || "gutenberg") === "gutenberg";
  if (els.discoverLevel) els.discoverLevel.disabled = !isGutenberg;
  if (els.discoverSort) els.discoverSort.disabled = (state.discover.source === "wikipedia");
  renderResults();
  renderUserBooks();
}

function setStatus(message: string, busy = false): void {
  if (!els.discoverStatus) return;
  els.discoverStatus.textContent = message || "";
  els.discoverStatus.classList.toggle("busy", busy);
}

export async function runDiscoverSearch(): Promise<void> {
  const runId = searchRunId + 1;
  searchRunId = runId;
  if (activeSearchController) activeSearchController.abort();
  activeSearchController = new AbortController();
  setStatus(t("discover.loading"), true);
  els.discoverToolbar.hidden = false;
  els.discoverResults.innerHTML = `
    <div class="discover-loading" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
    </div>`;
  els.discoverPagination.innerHTML = "";
  try {
    const source = state.discover.source || "gutenberg";
    let data: DiscoverSearchResult = { count: 0, results: [] };
    const language = getDiscoverLanguage();

    if (source === "gutenberg") {
      data = await searchGutendex({ ...state.discover, language }, activeSearchController.signal);
      if (runId !== searchRunId) return;
      lastResults = data.results || [];
      data.results = lastResults;
    } else if (source === "wikipedia" || source === "wikinews" || source === "wikisource") {
      const mw = await searchMediaWiki(
        source,
        language,
        state.discover.query || "",
        state.discover.page || 1,
        state.discover.sort,
        _mwContinueToken,
        activeSearchController.signal
      );
      if (runId !== searchRunId) return;
      lastResults = mw.results || [];
      _mwContinueToken = mw.continueToken;
      data = { count: mw.count, results: lastResults, next: mw.next, previous: mw.previous };
    }

    renderResults(data);
    const parts: string[] = [];
    if (state.discover.query) parts.push(`„${state.discover.query}”`);
    if (source === "gutenberg" && state.discover.level) parts.push(`${t("discover.level")} ${state.discover.level}`);
    const label = parts.length ? parts.join(", ") : `(${t("discover.sortPopular").toLowerCase()})`;
    setStatus(`${data.count ?? lastResults.length} · ${label}`);
  } catch (error: unknown) {
    if (runId !== searchRunId || isAbortError(error)) return;
    console.warn("Discover error:", error);
    lastResults = [];
    els.discoverResults.innerHTML = `<div class="empty-row">${escapeHtml(t("discover.error"))}</div>`;
    setStatus(t("discover.error"));
  }
}

function renderResults(data?: DiscoverSearchResult): void {
  if (!els.discoverResults) return;
  if (!lastResults.length) {
    els.discoverResults.innerHTML = state.discover.query
      ? `<div class="empty-row">${escapeHtml(t("discover.noResults"))}</div>`
      : `<div class="empty-row">${escapeHtml(t("discover.emptyPrompt"))}</div>`;
    els.discoverToolbar.hidden = true;
    els.discoverPagination.innerHTML = "";
    return;
  }
  if (data) {
    _cachedPrev = data.previous;
    _cachedNext = data.next;
  }
  els.discoverToolbar.hidden = false;
  const localeTag = getLocale();
  els.discoverResults.innerHTML = lastResults.map((book) => {
    const id = String(book.id);
    const isGutenberg = !book.source || book.source === "gutenberg";
    let cover = "";
    if (isGutenberg) {
      cover = book.formats?.["image/jpeg"] || `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`;
    } else {
      cover = book.coverDataUrl || "";
    }
    const author = (book.authors || []).map((a) => a.name).join(", ") || "—";
    const authorYears = (book.authors || []).map((a) => {
      if (a.birth_year && a.death_year) return `${a.birth_year}–${a.death_year}`;
      if (a.birth_year) return t("discover.born", { year: a.birth_year });
      if (a.death_year) return t("discover.died", { year: a.death_year });
      return "";
    }).filter(Boolean).join(" · ");
    const langs = (book.languages || []).join(", ");
    const summary = (book.summaries && book.summaries[0]) || "";
    const isSelected = selected.has(id);
    const inLibrary = isGutenberg
      ? (state.userBooks || []).some((entry) => entry.gutenbergId === id)
      : (state.customTexts || []).some((entry) => String(entry.id) === id);
    const showCover = state.preferences?.showCovers !== false;
    const coverBlock = showCover
      ? (cover
        ? `<div class="book-cover" aria-hidden="true"><img src="${escapeAttribute(cover)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
        : `<div class="book-cover" aria-hidden="true"><div style="width:100%;height:100%;background:var(--line);border-radius:4px;"></div></div>`)
      : "";

    let sourceTag = t("discover.sourceGutenberg", { id: escapeHtml(id) });
    if (book.source === "wikipedia") sourceTag = t("discover.sourceWikipedia");
    if (book.source === "wikinews") sourceTag = t("discover.sourceWikinews");
    if (book.source === "wikisource") sourceTag = t("discover.sourceWikisource");

    const downloads = book.download_count ? `<span class="tag tag-soft">${escapeHtml(t("discover.downloads", { n: book.download_count.toLocaleString(localeTag) }))}</span>` : "";

    return `
      <article class="discover-card book-card${showCover ? " has-cover" : ""}${isSelected ? " selected" : ""}" data-id="${escapeAttribute(id)}">
        ${coverBlock}
        <div class="book-card-body">
          <div class="book-meta">
            <span class="tag">${sourceTag}</span>
            ${langs ? `<span class="tag tag-soft">${escapeHtml(langs)}</span>` : ""}
            ${downloads}
          </div>
          <div>
            <h3>${escapeHtml(book.title || "—")}</h3>
            <p>${escapeHtml(author)}${authorYears ? ` · ${escapeHtml(authorYears)}` : ""}</p>
          </div>
          ${summary ? `<p class="book-summary">${escapeHtml(summary.slice(0, 200))}${summary.length > 200 ? "…" : ""}</p>` : ""}
          <div class="book-actions" style="flex-direction: row; justify-content: space-between; align-items: center; gap: 0.5rem; width: 100%;">
            <label class="discover-check" style="margin: 0;">
              <input type="checkbox" data-discover-check="${escapeAttribute(id)}" ${isSelected ? "checked" : ""}>
              <span>${escapeHtml(t("discover.selectLabel"))}</span>
            </label>
            <div style="display: flex; gap: 0.5rem;">
              <button class="primary-button icon-button" type="button" data-discover-add="${escapeAttribute(id)}" ${inLibrary ? "disabled" : ""} title="${escapeAttribute(inLibrary ? t("discover.added") : t("discover.add"))}" aria-label="${escapeAttribute(inLibrary ? t("discover.added") : t("discover.add"))}">
                ${inLibrary
                  ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`
                  : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`
                }
              </button>
            </div>
          </div>
        </div>
      </article>
    `;
  }).join("");

  renderPagination();
}

function renderPagination(): void {
  if (!els.discoverPagination) return;
  const page = state.discover.page || 1;
  els.discoverPagination.innerHTML = [
    `<button class="secondary-button" data-page="${page - 1}" ${page <= 1 || !_cachedPrev ? "disabled" : ""}>${escapeHtml(t("discover.prev"))}</button>`,
    `<span class="page-label">${page}</span>`,
    `<button class="secondary-button" data-page="${page + 1}" ${!_cachedNext ? "disabled" : ""}>${escapeHtml(t("discover.next"))}</button>`
  ].join("");
}

function renderUserBooks(): void {
  const el = document.getElementById("user-books-list");
  if (!el) return;
  const books = state.userBooks || [];
  if (!books.length) { el.innerHTML = ""; return; }
  el.innerHTML = books.map((entry) => {
    const id = entry.id;
    const cover = entry.formats?.["image/jpeg"] || entry.coverDataUrl || entry.coverUrl || "";
    const coverBlock = cover
      ? `<div class="book-cover" aria-hidden="true"><img src="${escapeAttribute(cover)}" alt="" loading="lazy"></div>`
      : "";
    const author = Array.isArray(entry.authors) ? formatAuthors(entry.authors) : entry.author || "";
    return `
      <article class="discover-card book-card has-cover" data-id="${escapeAttribute(id)}">
        ${coverBlock}
        <div class="book-card-body">
          <h4>${escapeHtml(entry.title || "—")}</h4>
          <p class="muted-copy">${escapeHtml(author)}</p>
          <div class="book-actions">
            <button class="secondary-button" type="button" data-open-book="${escapeAttribute(id)}">${escapeHtml(t("discover.open"))}</button>
            <button class="secondary-button danger-button" type="button" data-remove-book="${escapeAttribute(id)}">${escapeHtml(t("discover.remove"))}</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

export function getDiscoverHandlers({ onAdd, onRemove, onOpen }: DiscoverHandlers = {}) {
  const findResult = (id: unknown) => lastResults.find((book) => String(book.id) === String(id));

  async function addOne(id: unknown, options?: { silent?: boolean }): Promise<boolean> {
    const book = findResult(id);
    if (!book || !onAdd) return false;
    const added = await onAdd(book, options);
    if (added) selected.delete(String(id));
    renderResults();
    renderUserBooks();
    return added;
  }

  async function addSelected(): Promise<number> {
    let added = 0;
    for (const id of [...selected]) {
      if (await addOne(id, { silent: true })) added++;
    }
    return added;
  }

  function toggleAll(checked: boolean): void {
    lastResults.forEach((book) => {
      const id = String(book.id);
      if (checked) selected.add(id); else selected.delete(id);
    });
    renderResults();
  }

  async function onResultsClick(event: Event): Promise<void> {
    if (!(event.target instanceof Element)) return;
    const addButton = event.target.closest<HTMLButtonElement>("[data-discover-add]");
    if (addButton) {
      addButton.disabled = true;
      await addOne(addButton.dataset.discoverAdd);
      return;
    }

    const pageButton = event.target.closest<HTMLButtonElement>("[data-page]");
    if (!pageButton || pageButton.disabled) return;
    state.discover.page = Number(pageButton.dataset.page);
    saveState();
    runDiscoverSearch();
  }

  function onResultsChange(event: Event): void {
    if (!(event.target instanceof Element)) return;
    const checkbox = event.target.closest<HTMLInputElement>("[data-discover-check]");
    if (!checkbox) return;
    const { discoverCheck: id } = checkbox.dataset;
    if (checkbox.checked) selected.add(id); else selected.delete(id);
    renderResults();
  }

  function onUserBooksClick(event: Event): unknown {
    if (!(event.target instanceof Element)) return;
    const openButton = event.target.closest<HTMLButtonElement>("[data-open-book]");
    if (openButton) return onOpen?.(openButton.dataset.openBook);
    const removeButton = event.target.closest<HTMLButtonElement>("[data-remove-book]");
    if (removeButton) onRemove?.(removeButton.dataset.removeBook);
  }

  return {
    selected,
    lastResults,
    searchRunId,
    activeSearchController,
    _cachedPrev,
    _cachedNext,
    _mwContinueToken,
    FETCH_CONCURRENCY,
    setStatus,
    renderResults,
    renderPagination,
    addSelected,
    toggleAll,
    onResultsClick,
    onResultsChange,
    onUserBooksClick
  };
}
