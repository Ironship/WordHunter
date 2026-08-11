// Library view: book card list (built-in + user-added).
import { state, saveUiState } from "../state.js";
import { escapeHtml, escapeAttribute, parseTagList, calcRoundedStatsPcts, calcStatsPcts } from "../utils.js";
import { icon, renderCardStat, renderCardCount } from "../icons.js";
import { normalizeSearchVariants } from "../tokenizer_v2.js";
import { findBookById, getAllBooks, bookTexts, getLibraryContentGeneration, hydrateActiveLibraryTexts, isBookTextCacheStale, loadBookText, loadCustomTextContent } from "../books.js";
import { getCachedBookTextStats, getCachedTextStats, prepareTextStats } from "../stats-cache.js";
import { t as translate, getLocale } from "../i18n.js";
import { bindSidebarResizer } from "../panel-resizer.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";

interface LibraryBook {
  id: string;
  title?: string;
  author?: string;
  year?: string | number;
  level?: string;
  blurb?: string;
  pageUrl?: string;
  coverDataUrl?: string;
  coverPath?: string;
  coverUrl?: string;
  tags?: unknown;
  source?: string;
  gutenbergId?: string | number;
  pdfOcrPages?: unknown;
  pdfOcrEngine?: string;
  isCustom?: boolean;
  _customText?: string;
  _textLoaded?: boolean;
  sample?: string;
  pages?: string | number;
  updatedAt?: string;
  createdAt?: string;
  textUrl?: string;
  localPath?: string;
}

interface LibraryStats {
  unique: number;
  known: number;
  learning: number;
  ignored: number;
  new: number;
}

const t = translate as (key: string, vars?: Record<string, string | number | boolean | null | undefined>) => string;

/** Typed lookup helper for TS-rendered elements (see renderLibraryPanel). */
function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

const EMPTY_STATS: Readonly<LibraryStats> = { unique: 0, known: 0, learning: 0, ignored: 0, new: 0 };
const STAT_SORT_KEYS = new Set(["length", "known", "new", "learning", "progress"]);
let visibleBookObserver: IntersectionObserver | null = null;
let hydrationRenderPending = false;
let completeStatsHydration: Promise<unknown> | null = null;
let completeStatsHydrationKey = "";
let customTextById = new Map<string, WhText>();

function queueHydrationRender(): void {
  if (hydrationRenderPending) return;
  hydrationRenderPending = true;
  requestAnimationFrame(() => {
    hydrationRenderPending = false;
    if (state.currentView === "library") renderLibrary();
  });
}

function hydrateBookStats(id: string): void {
  if (!id || (bookTexts.has(id) && !isBookTextCacheStale(id))) return;
  const custom = customTextById.get(id);
  const book = custom ? null : findBookById(id);
  const source = custom ? loadCustomTextContent(custom) : book ? loadBookText(book) : null;
  if (!source) return;
  void source.then(queueHydrationRender).catch((error) => console.warn(`Could not load book statistics for ${id}:`, error));
}

function observeVisibleBookStats(bookList: HTMLElement): void {
  const cards = [...bookList.querySelectorAll<HTMLElement>("[data-book-id]")];
  if (!("IntersectionObserver" in window)) {
    cards.forEach((card) => hydrateBookStats(card.dataset.bookId || ""));
    return;
  }
  visibleBookObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      visibleBookObserver?.unobserve(entry.target);
      hydrateBookStats((entry.target as HTMLElement).dataset.bookId || "");
    }
  }, { rootMargin: "300px 0px" });
  cards.forEach((card) => visibleBookObserver?.observe(card));
}

function sourceTagForBook(book: LibraryBook): string {
  const source = `${book.source || ""} ${book.pageUrl || ""}`.toLowerCase();
  if (source.includes("wikipedia.org") || source.includes("wikipedia")) return t("library.sourceWikipedia");
  if (source.includes("wikinews.org") || source.includes("wikinews")) return t("library.sourceWikinews");
  if (source.includes("wikisource.org") || source.includes("wikisource")) return t("library.sourceWikisource");
  if (source.includes("gutenberg.org") || source.includes("project gutenberg")) return book.gutenbergId ? t("library.sourceGutenberg", { id: book.gutenbergId }) : t("library.sourceGutenbergNoId");
  return "";
}

function getSortValue(book: LibraryBook, stats: LibraryStats | Readonly<LibraryStats>, sortKey: string): string | number {
  switch (sortKey) {
    case "title":
      return book.title || "";
    case "author":
      return String(book.author || "").toLowerCase();
    case "length":
      return -(stats.known + stats.ignored + stats.learning + stats.new); // Negative for descending (longest first)
    case "known":
      return -(stats.known + stats.ignored);
    case "new":
      return -stats.new;
    case "learning":
      return -stats.learning;
    case "progress":
      return -(((stats.known + stats.ignored) / ((stats.known + stats.ignored + stats.learning + stats.new) || 1)) * 100);
    case "year":
      return Number(book.year) || 0;
    default:
      return book.title || "";
  }
}

export function renderLibrary(): void {
  const bookList = el<HTMLElement>("book-list");
  if (!bookList) return;
  visibleBookObserver?.disconnect();
  visibleBookObserver = null;
  const librarySearch = el<HTMLInputElement>("library-search");
  const levelFilter = el<HTMLSelectElement>("level-filter");
  const librarySort = el<HTMLSelectElement>("library-sort");
  const libraryArchiveFilter = el<HTMLSelectElement>("library-archive-filter");
  const librarySortReverse = el<HTMLButtonElement>("library-sort-reverse");
  if (librarySearch) librarySearch.value = state.filters.libraryQuery || "";
  if (levelFilter) levelFilter.value = state.filters.libraryLevel || "all";
  if (librarySort) librarySort.value = state.filters.librarySort || "title";
  if (libraryArchiveFilter) libraryArchiveFilter.value = state.filters.libraryArchive || "active";
  if (librarySortReverse) {
    librarySortReverse.dataset.reverse = state.filters.librarySortReverse ? "true" : "false";
  }

  const queryVariants = normalizeSearchVariants(state.filters.libraryQuery || "");
  const level = state.filters.libraryLevel;
  const sortKey = state.filters.librarySort || "title";
  const sortReverse = state.filters.librarySortReverse || false;
  const archiveFilter = state.filters.libraryArchive || "active";
  const archivedBookIds = new Set(state.archivedBookIds || []);
  const userBookIds = new Set((state.userBooks || []).map((book) => book.id));
  const showStats = state.preferences?.showCardStats !== false;
  customTextById = new Map((state.customTexts || []).map((text) => [text.id, text]));
  const needsStats = showStats || STAT_SORT_KEYS.has(sortKey);
  const preparedVocabStatuses = needsStats ? prepareTextStats(state.vocab) : "";
  const statsHydrationKey = `${effectiveLearningLanguage(state.preferences)}|${state.preferences.wordDetectionAlgorithm || "modern"}|${getLibraryContentGeneration()}|${preparedVocabStatuses}`;
  if (STAT_SORT_KEYS.has(sortKey) && completeStatsHydrationKey !== statsHydrationKey && !completeStatsHydration) {
    completeStatsHydrationKey = statsHydrationKey;
    completeStatsHydration = hydrateActiveLibraryTexts()
      .then(() => {
        if (state.currentView === "library") queueHydrationRender();
      })
      .catch((error) => {
        completeStatsHydrationKey = "";
        console.warn("Could not prepare complete library sorting:", error);
      })
      .finally(() => { completeStatsHydration = null; });
  }

  const allBooks: LibraryBook[] = [
    ...getAllBooks() as LibraryBook[],
    ...(state.customTexts || []).map((ct) => {
      const cachedText = bookTexts.peek(ct.id);
      const hasCachedText = cachedText !== undefined;
      const hasInlineText = typeof ct.text === "string";
      return {
        id: ct.id,
        title: ct.title,
        author: ct.author ?? "",
        year: ct.createdAt ? new Date(ct.createdAt).getFullYear() : "",
        level: ct.level || "custom",
        blurb: ct.blurb || "",
        pageUrl: ct.sourceUrl || "",
        coverDataUrl: ct.coverDataUrl || "",
        tags: parseTagList(ct.tags),
        source: ct.source || "",
        pdfOcrPages: ct.pdfOcrPages,
        pdfOcrEngine: ct.pdfOcrEngine || "",
        isCustom: true,
        _customText: hasCachedText ? cachedText : hasInlineText ? ct.text : "",
        _textLoaded: hasCachedText || hasInlineText
      };
    })
  ];

  const tagsById = new Map<string, string[]>();
  const books = allBooks
    .filter((book) => {
      const isArchived = archivedBookIds.has(book.id);
      if (archiveFilter === "active" && isArchived) return false;
      if (archiveFilter === "archived" && !isArchived) return false;
      const matchesLevel = level === "all" || !book.level || book.level === level;
      const tags = parseTagList(book.tags);
      tagsById.set(book.id, tags);
      const haystackText = `${book.title} ${book.author} ${book.level} ${book.blurb} ${tags.join(" ")}`;
      const haystacks = normalizeSearchVariants(haystackText);
      const matchesQuery = !state.filters.libraryQuery || queryVariants.some(q => haystacks.some(h => h.includes(q)));
      return matchesLevel && matchesQuery;
    })
    .map((book) => {
      const hasCompleteText = book._textLoaded === true || bookTexts.has(book.id);
       const loadedText = book._textLoaded === true ? book._customText : bookTexts.peek(book.id);
      const fullText = hasCompleteText ? String(loadedText || "") : book.sample || "";
      const lang = effectiveLearningLanguage(state.preferences);
      const algorithm = state.preferences.wordDetectionAlgorithm || "modern";
       const stats = !hasCompleteText
        ? getCachedBookTextStats(book.id)
        : needsStats
        ? getCachedTextStats(
          book,
          fullText,
          state.vocab,
          lang,
          algorithm,
          preparedVocabStatuses,
          bookTexts.fingerprint(book.id)
        )
        : { unique: 0, known: 0, ignored: 0, learning: 0, new: 0 };
    return { book, stats, statsReady: stats !== null, ...calcStatsPcts(stats || EMPTY_STATS) };
    })
    .sort((a, b) => {
      const valA = getSortValue(a.book, a.stats || EMPTY_STATS, sortKey);
      const valB = getSortValue(b.book, b.stats || EMPTY_STATS, sortKey);
      
      let result = 0;
      if (typeof valA === "string" && typeof valB === "string") {
        result = valA.localeCompare(valB, getLocale());
      } else if (typeof valA === "number" && typeof valB === "number") {
        result = valA - valB;
      }
      
      return sortReverse ? -result : result;
    });

  if (!books.length) {
    bookList.innerHTML = `<div class="empty-row">${escapeHtml(t("library.empty"))}</div>`;
    return;
  }

  const numberFormat = new Intl.NumberFormat(getLocale());
  const statsMode = ["percentages", "counts", "both"].includes(state.preferences?.cardStatsMode)
    ? state.preferences.cardStatsMode
    : "percentages";

  bookList.innerHTML = books.map(({ book, stats, statsReady, knownPct, learningPct }) => {
    const isArchived = archivedBookIds.has(book.id);
    const uniqueValue = numberFormat.format(stats?.unique || 0);
    const total = (stats?.known || 0) + (stats?.ignored || 0) + (stats?.learning || 0) + (stats?.new || 0);
    const totalValue = numberFormat.format(total);
    const rounded = calcRoundedStatsPcts(stats || EMPTY_STATS);
    const renderStatus = (className: string, label: string, title: string, percent: number, count: number): string => {
      const countValue = numberFormat.format(count);
      const values = statsMode === "percentages"
        ? [`${percent}%`]
        : statsMode === "counts"
          ? [countValue]
          : [`${percent}%`, countValue];
      const descriptionKey = statsMode === "percentages"
        ? "library.cardStatPercent"
        : statsMode === "counts"
          ? "library.cardStatCount"
          : "library.cardStatBoth";
      const description = t(descriptionKey, { label: title, percent, count: countValue, total: totalValue });
      return renderCardStat(className, label, values, description);
    };
    const statsBlock = showStats
      ? !statsReady
        ? `<div class="progress-block" aria-busy="true"><span class="card-stat-summary">…</span></div>`
        : `
        <div class="progress-block" aria-label="${escapeAttribute(t("library.progressLabel"))}">
          <div class="progress-line card-progress-line">
            <span class="card-stat-grid">
              ${renderStatus("card-stat-known", t("reader.statsKnownIgnored"), t("reader.statsKnownIgnoredTitle"), rounded.knownPct, stats.known + stats.ignored)}
              ${renderStatus("card-stat-learning", t("reader.statsLearning"), t("reader.statsLearning"), rounded.learningPct, stats.learning)}
              ${renderStatus("card-stat-new", t("reader.statsNew"), t("reader.statsNew"), rounded.newPct, stats.new)}
            </span>
            <span class="card-stat-footer">
              ${renderCardCount(totalValue, t("library.totalWordsLabel"), "card-stat-total")}
              ${renderCardCount(uniqueValue, t("library.uniqueWordsLabel"))}
            </span>
          </div>
          <div class="progress-track" aria-hidden="true">
            <span class="known-track" style="width:${knownPct}%"></span>
            <span class="learning-track" style="width:${learningPct}%"></span>
          </div>
        </div>`
      : "";
    const lengthHint = !showStats && !statsReady ? `<span class="tag tag-soft">${escapeHtml(t("library.fragment"))}</span>` : "";
    const isUserBook = userBookIds.has(book.id);
    let removeButton = "";
    let moveButton = "";
    if (book.isCustom) {
      removeButton = `<button class="icon-button danger-button" type="button" data-action="remove-custom" data-id="${escapeHtml(book.id)}" title="${escapeAttribute(t("library.removeCustomTitle"))}">${icon("trash", 16)}</button>`;
      moveButton = `<button class="icon-button" type="button" data-action="move-book" data-iscustom="true" data-id="${escapeHtml(book.id)}" title="${escapeAttribute(t("library.moveBook"))}">${icon("swap", 16)}</button>`;
      const editBtn = `<button class="icon-button" type="button" data-action="edit-custom" data-id="${escapeHtml(book.id)}" title="${escapeAttribute(t("editBook.title"))}">${icon("edit", 16)}</button>`;
      moveButton = editBtn + moveButton;
    } else if (isUserBook) {
      removeButton = `<button class="icon-button danger-button" type="button" data-action="remove-user-book" data-id="${escapeHtml(book.id)}" title="${escapeAttribute(t("library.removeUserBookTitle"))}">${icon("trash", 16)}</button>`;
      const editBtn = `<button class="icon-button" type="button" data-action="edit-custom" data-id="${escapeHtml(book.id)}" title="${escapeAttribute(t("editBook.title"))}">${icon("edit", 16)}</button>`;
      moveButton = editBtn + `<button class="icon-button" type="button" data-action="move-book" data-iscustom="false" data-id="${escapeHtml(book.id)}" title="${escapeAttribute(t("library.moveBook"))}">${icon("swap", 16)}</button>`;
    } else {
      removeButton = `<button class="icon-button danger-button" type="button" data-action="hide-builtin" data-id="${escapeHtml(book.id)}" title="${escapeAttribute(t("library.removeBuiltInTitle"))}">${icon("trash", 16)}</button>`;
    }
    const cover = renderBookCover(book);
    const levelTag = book.level && book.level !== "custom"
      ? `<span class="tag tag-level tag-level-${escapeHtml(book.level)}">${escapeHtml(book.level)}</span>`
      : "";
    const sourceLabel = sourceTagForBook(book);
    const sourceTag = sourceLabel ? `<span class="tag">${escapeHtml(sourceLabel)}</span>` : "";
    const archiveTag = isArchived ? `<span class="tag tag-soft">${escapeHtml(t("library.archivedTag"))}</span>` : "";
    const userTags = (tagsById.get(book.id) || parseTagList(book.tags))
      .map((tag) => `<span class="tag tag-user">${escapeHtml(tag)}</span>`)
      .join("");
    const metaParts = [book.author, book.year || "", book.pages || ""].map((part) => String(part || "").trim()).filter(Boolean);
    const metaLine = metaParts.length ? `<p class="book-card-meta-line">${escapeHtml(metaParts.join(" · "))}</p>` : "";
    const blurbLine = book.blurb ? `<p class="book-card-blurb">${escapeHtml(book.blurb)}</p>` : "";
    const gutenbergLink = book.pageUrl && !book.isCustom
      ? `<a class="icon-button" href="${escapeHtml(book.pageUrl)}" target="_blank" rel="noreferrer" title="${escapeHtml(t("reader.sourceGutenberg"))}">${icon("external", 16)}</a>`
      : "";
    return `
      <article class="book-card ${cover ? "has-cover" : ""} ${isArchived ? "archived" : ""}" data-book-id="${escapeAttribute(book.id)}" data-level="${escapeHtml(book.level)}">
        ${cover}
        <div class="book-card-body">
          <div class="book-meta">
            ${levelTag}
            ${sourceTag}
            ${archiveTag}
            ${userTags}
            ${lengthHint}
          </div>
          <div>
            <h3>${escapeHtml(book.title)}</h3>
            ${metaLine}
          </div>
          ${blurbLine}
          ${statsBlock}
          <div class="book-actions actions-row">
             <button class="primary-button action-grow" type="button" data-action="read-sample" data-id="${escapeHtml(book.id)}">
              ${icon("play", 16)}
              ${escapeHtml(t("library.read"))}
            </button>
            ${gutenbergLink}
            ${moveButton}
            <button class="icon-button" type="button" data-action="${isArchived ? "unarchive-book" : "archive-book"}" data-id="${escapeHtml(book.id)}" title="${escapeAttribute(t(isArchived ? "library.unarchiveTitle" : "library.archiveTitle"))}">${icon(isArchived ? "unarchive" : "archive", 16)}</button>
            ${removeButton}
          </div>
        </div>
      </article>
    `;
  }).join("");
  if (needsStats) observeVisibleBookStats(bookList);
}

function renderBookCover(book: LibraryBook): string {
  if (state.preferences?.showCovers === false) return "";
  const sources: string[] = [];
  if (book.coverDataUrl) sources.push(book.coverDataUrl);
  if (book.coverPath) sources.push(book.coverPath);
  if (book.coverUrl) sources.push(book.coverUrl);
  if (!sources.length) return "";
  const fallback = sources.slice(1).map((src) => escapeAttribute(src)).join("|");
  return `<div class="book-cover" aria-hidden="true"><img src="${escapeAttribute(sources[0])}" onerror="const fallbacks=this.dataset.fallback?.split('|')||[]; if(fallbacks.length) { this.src=fallbacks.shift(); this.dataset.fallback=fallbacks.join('|'); } else { this.parentElement.style.display='none'; }" data-fallback="${fallback}" alt="${escapeHtml(t("library.coverAlt"))}" /></div>`;
}

function bindLibraryFiltersToggle(): void {
  const libraryPanel = document.querySelector<HTMLElement>(".library-panel");
  const libraryFiltersToggle = el<HTMLButtonElement>("library-filters-toggle");
  if (!libraryPanel || !libraryFiltersToggle) return;
  const setExpanded = (expanded: boolean): void => {
    libraryPanel.classList.toggle("library-filters-collapsed", !expanded);
    libraryFiltersToggle.setAttribute("aria-expanded", String(expanded));
    const labelKey = expanded ? "library.hideFilters" : "library.showFilters";
    const label = t(labelKey);
    libraryFiltersToggle.dataset.i18nAttr = `title=${labelKey},aria-label=${labelKey}`;
    libraryFiltersToggle.title = label;
    libraryFiltersToggle.setAttribute("aria-label", label);
  };
  setExpanded(!libraryPanel.classList.contains("library-filters-collapsed"));
  libraryFiltersToggle.addEventListener("click", () => {
    setExpanded(libraryPanel.classList.contains("library-filters-collapsed"));
  });
}

export function bindLibraryEvents(): void {
  bindLibraryFiltersToggle();
  bindSidebarResizer(el<HTMLElement>("library-sidebar-resizer"), {
    preference: "librarySidebarWidth", cssVariable: "--library-sidebar-width",
    defaultWidth: 360, minWidth: 280, maxWidth: 600, minMainWidth: 360,
    sidebarSelector: ".import-panel", overlay: true
  });
  const deleteDialog = document.getElementById("delete-book-dialog") as HTMLDialogElement | null;
  const deleteTitle = document.getElementById("delete-book-title");
  const deleteMessage = document.getElementById("delete-book-message");
  const deleteCancel = document.getElementById("delete-book-cancel") as HTMLButtonElement | null;
  const deleteConfirm = document.getElementById("delete-book-confirm") as HTMLButtonElement | null;
  let pendingDelete: (() => unknown) | null = null;
  const closeDeleteDialog = () => {
    pendingDelete = null;
    deleteDialog?.close();
  };
  const requestBookRemoval = (
    title: string,
    message: string,
    remove: () => unknown,
    confirmLabel = t("library.removeConfirmButton")
  ): void => {
    if (!deleteDialog || !deleteTitle || !deleteMessage || !deleteConfirm) return;
    pendingDelete = remove;
    deleteTitle.textContent = title;
    deleteMessage.textContent = message;
    deleteConfirm.textContent = confirmLabel;
    deleteDialog.showModal();
  };
  deleteCancel?.addEventListener("click", closeDeleteDialog);
  deleteConfirm?.addEventListener("click", () => {
    const remove = pendingDelete;
    closeDeleteDialog();
    remove?.();
  });
  deleteDialog?.addEventListener("cancel", (event) => { event.preventDefault(); closeDeleteDialog(); });
  deleteDialog?.addEventListener("click", (event) => { if (event.target === deleteDialog) closeDeleteDialog(); });

  let librarySearchTimer: number | null = null;
  const librarySearch = el<HTMLInputElement>("library-search");
  const levelFilter = el<HTMLSelectElement>("level-filter");
  const librarySort = el<HTMLSelectElement>("library-sort");
  const librarySortReverse = el<HTMLButtonElement>("library-sort-reverse");
  const libraryArchiveFilter = el<HTMLSelectElement>("library-archive-filter");
  const bookList = el<HTMLElement>("book-list");
  if (librarySearch) librarySearch.addEventListener("input", () => {
    state.filters.libraryQuery = librarySearch.value;
    if (librarySearchTimer !== null) clearTimeout(librarySearchTimer);
    librarySearchTimer = window.setTimeout(() => {
      librarySearchTimer = null;
      void saveUiState();
      renderLibrary();
    }, 120);
  });
  if (levelFilter) levelFilter.addEventListener("change", () => {
    state.filters.libraryLevel = levelFilter.value;
    void saveUiState();
    renderLibrary();
  });
  if (librarySort) librarySort.addEventListener("change", () => {
    state.filters.librarySort = librarySort.value;
    void saveUiState();
    renderLibrary();
  });
  if (librarySortReverse) {
    librarySortReverse.addEventListener("click", () => {
      state.filters.librarySortReverse = !state.filters.librarySortReverse;
      void saveUiState();
      renderLibrary();
    });
  }
  if (libraryArchiveFilter) {
    libraryArchiveFilter.addEventListener("change", () => {
      state.filters.libraryArchive = libraryArchiveFilter.value;
      void saveUiState();
      renderLibrary();
    });
  }
  if (bookList) bookList.addEventListener("click", async (event) => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>("[data-action]");
    if (!control) return;
    const id = control.dataset.id;
    const actions = await import("../book-actions.js");

    const customText = (state.customTexts || []).find((t) => t.id === id);
    if (control.dataset.action === "remove-custom" && customText) {
      requestBookRemoval(
        t("library.removeConfirmTitle"),
        t("library.removeConfirmMessage", { title: customText.title }),
        () => actions.removeCustomText(id)
      );
      return;
    }
    if (control.dataset.action === "hide-builtin") {
      requestBookRemoval(
        t("library.removeBuiltInTitle"),
        t("toast.confirmHideBook"),
        () => actions.hideBuiltInBook(id),
        t("library.removeBuiltInTitle")
      );
      return;
    }
    if (control.dataset.action === "archive-book") { actions.archiveBook(id); return; }
    if (control.dataset.action === "unarchive-book") { actions.unarchiveBook(id); return; }

    if (customText) {
      if (control.dataset.action === "read-sample") actions.openBook(id);
      if (control.dataset.action === "edit-custom") actions.openEditBookModal(id);
      return;
    }

    const book = await import("../books.js").then(m => m.findBookById(id));
    if (!book) return;

    if (control.dataset.action === "read-sample") {
      const cached = bookTexts.get(book.id);
      if (!cached || cached.length < 500) await actions.loadFullGutenbergText(book);
      else actions.openBook(book.id);
    }
    if (control.dataset.action === "load-full") await actions.loadFullGutenbergText(book);
    if (control.dataset.action === "remove-user-book") {
      requestBookRemoval(
        t("library.removeConfirmTitle"),
        t("library.removeConfirmMessage", { title: book.title }),
        () => actions.removeUserBook(book.id)
      );
    }
    if (control.dataset.action === "edit-custom") actions.openEditBookModal(id);
  });
}

/**
 * Builds the delete-book confirmation dialog markup once (idempotent).
 * Called during app boot before cacheElements() so every consumer finds
 * the elements in the DOM; data-i18n attributes are applied by the
 * boot-time applyTranslations() pass (see app.ts).
 */
export function renderDeleteBookDialog(): HTMLDialogElement {
  const existing = document.getElementById("delete-book-dialog");
  if (existing instanceof HTMLDialogElement) return existing;
  if (existing) throw new TypeError("#delete-book-dialog must be a dialog element");

  const dialog = document.createElement("dialog");
  dialog.id = "delete-book-dialog";
  dialog.className = "panel confirmation-dialog";
  dialog.setAttribute("aria-labelledby", "delete-book-title");
  dialog.innerHTML = `
    <div class="panel-header"><h2 id="delete-book-title"></h2></div>
    <div class="confirmation-dialog-body">
      <p id="delete-book-message" class="muted-copy"></p>
      <div class="confirmation-dialog-actions">
        <button id="delete-book-cancel" type="button" class="secondary-button" data-i18n="library.moveCancel">Cancel</button>
        <button id="delete-book-confirm" type="button" class="danger-button" data-i18n="library.removeConfirmButton"></button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  return dialog;
}

/**
 * Builds the library filter-bar panel (section + sidebar resizer) once
 * (idempotent). Called during app boot before cacheElements() so every
 * consumer finds the elements in the DOM; data-i18n attributes are applied
 * by the boot-time applyTranslations() pass (see app.ts). The section and
 * resizer must land BEFORE the still-static .import-panel inside the
 * workspace grid so the grid columns keep their order.
 */
export function renderLibraryPanel(): HTMLElement {
  const existing = document.querySelector(".library-panel");
  if (existing) return existing as HTMLElement;

  const view = document.getElementById("library-view");
  if (!view) throw new TypeError("#library-view must exist before renderLibraryPanel");
  const grid = view.querySelector<HTMLElement>(".workspace-grid");
  if (!grid) throw new TypeError(".workspace-grid must exist inside #library-view");

  const section = document.createElement("section");
  section.className = "panel library-panel library-filters-collapsed";
  section.setAttribute("aria-labelledby", "library-heading");
  section.innerHTML = `
    <div class="panel-header">
      <div class="library-title-row">
        <div>
          <p class="eyebrow" data-i18n="library.eyebrow">Offline catalog</p>
          <h2 id="library-heading" data-i18n="library.heading">Books</h2>
        </div>
        <button type="button" id="library-filters-toggle" class="icon-button library-filters-toggle" aria-expanded="false" aria-controls="library-filters" data-i18n-attr="title=library.showFilters,aria-label=library.showFilters" title="Show search and filters" aria-label="Show search and filters">
          <svg class="library-filters-icon library-filters-icon-down" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
          <svg class="library-filters-icon library-filters-icon-up" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg>
        </button>
      </div>
      <div class="filters compact-filters" id="library-filters">
        <label class="library-search-field">
          <span data-i18n="library.search">Search</span>
          <div class="search-with-hint">
            <input id="library-search" type="search" data-i18n-attr="placeholder=library.searchPlaceholder">
            <span class="shortcut-badge">/</span>
          </div>
        </label>
        <label class="library-level-field">
          <span data-i18n="library.level">Level</span>
           <select id="level-filter">
            <option value="all" data-i18n="library.levelAll">All</option>
            <option value="A1">A1</option>
            <option value="A2">A2</option>
            <option value="B1">B1</option>
            <option value="B2">B2</option>
            <option value="C1">C1</option>
            <option value="C2">C2</option>
          </select>
        </label>
        <label class="library-status-field">
          <span data-i18n="library.archiveFilter">Status</span>
          <select id="library-archive-filter">
            <option value="active" data-i18n="library.archiveActive">Active</option>
            <option value="archived" data-i18n="library.archiveArchived">Archive</option>
            <option value="all" data-i18n="library.archiveAll">All</option>
          </select>
        </label>
        <label class="library-sort-field">
          <span data-i18n="library.sort">Sort</span>
          <div class="row-tight">
            <select id="library-sort" class="flex-1">
              <option value="title" data-i18n="library.sortByTitle">By title</option>
              <option value="author" data-i18n="library.sortByAuthor">By author</option>
              <option value="length" data-i18n="library.sortByLength">By length</option>
              <option value="known" data-i18n="library.sortByKnown">Known words</option>
              <option value="new" data-i18n="library.sortByNew">New words</option>
              <option value="learning" data-i18n="library.sortByLearning">Learning words</option>
              <option value="progress" data-i18n="library.sortByProgress">By progress</option>
              <option value="year" data-i18n="library.sortByYear">By date</option>
            </select>
            <button type="button" id="library-sort-reverse" class="icon-button" data-reverse="true" data-i18n-attr="title=library.sortReverse,aria-label=library.sortReverse" aria-label="Reverse sort">
              <span class="sort-indicator"></span>
            </button>
          </div>
        </label>
      </div>
      <button type="button" id="library-import-toggle" class="secondary-button pocket-import-toggle" aria-expanded="false" data-i18n="import.heading" data-i18n-attr="title=import.heading,aria-label=import.heading">Import</button>
    </div>
    <div class="book-grid" id="book-list" aria-busy="false"></div>
  `;

  const resizer = document.createElement("div");
  resizer.id = "library-sidebar-resizer";
  resizer.className = "panel-sidebar-resizer";
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.setAttribute("data-i18n-attr", "aria-label=library.resizeImportPanel");

  const importPanel = grid.querySelector<HTMLElement>(".import-panel");
  if (importPanel) {
    grid.insertBefore(section, importPanel);
    grid.insertBefore(resizer, importPanel);
  } else {
    grid.appendChild(section);
    grid.appendChild(resizer);
  }
  return section;
}
