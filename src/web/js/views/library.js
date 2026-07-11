// Library view: book card list (built-in + user-added).
import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, parseTagList, calcStatsPcts } from "../utils.js";
import { icon, renderCardStat, renderCardCount } from "../icons.js";
import { normalizeSearchVariants } from "../tokenizer_v2.js";
import { getAllBooks, bookTexts } from "../books.js";
import { getCachedTextStats, getCachedUniqueWordCount, prepareTextStats } from "../stats-cache.js";
import { t, getLocale } from "../i18n.js";
import { bindSidebarResizer } from "../panel-resizer.js";

const EMPTY_STATS = { unique: 0, known: 0, learning: 0, ignored: 0, new: 0 };

function sourceTagForBook(book) {
  const source = `${book.source || ""} ${book.pageUrl || ""}`.toLowerCase();
  if (source.includes("wikipedia.org") || source.includes("wikipedia")) return t("library.sourceWikipedia");
  if (source.includes("wikinews.org") || source.includes("wikinews")) return t("library.sourceWikinews");
  if (source.includes("wikisource.org") || source.includes("wikisource")) return t("library.sourceWikisource");
  if (source.includes("gutenberg.org") || source.includes("project gutenberg")) return book.gutenbergId ? t("library.sourceGutenberg", { id: book.gutenbergId }) : t("library.sourceGutenbergNoId");
  return "";
}

function getSortValue(book, stats, sortKey) {
  switch (sortKey) {
    case "title":
      return book.title || "";
    case "author":
      return String(book.author || "").toLowerCase();
    case "length":
      return -(stats.known + stats.ignored + stats.learning + stats.new); // Negative for descending (longest first)
    case "known":
      return -((stats.known + stats.ignored) / ((stats.known + stats.ignored + stats.learning + stats.new) || 1)) * 100;
    case "new":
      return -(stats.new / ((stats.known + stats.ignored + stats.learning + stats.new) || 1)) * 100;
    case "learning":
      return -(stats.learning / ((stats.known + stats.ignored + stats.learning + stats.new) || 1)) * 100;
    case "progress":
      return -(((stats.known + stats.ignored) / ((stats.known + stats.ignored + stats.learning + stats.new) || 1)) * 100);
    case "year":
      return Number(book.year) || 0;
    default:
      return book.title || "";
  }
}

export function renderLibrary() {
  if (!els.bookList) return;
  els.librarySearch.value = state.filters.libraryQuery || "";
  els.levelFilter.value = state.filters.libraryLevel || "all";
  if (els.librarySort) els.librarySort.value = state.filters.librarySort || "title";
  if (els.libraryArchiveFilter) els.libraryArchiveFilter.value = state.filters.libraryArchive || "active";
  if (els.librarySortReverse) {
    els.librarySortReverse.dataset.reverse = state.filters.librarySortReverse ? "true" : "false";
  }

  const queryVariants = normalizeSearchVariants(state.filters.libraryQuery || "");
  const level = state.filters.libraryLevel;
  const sortKey = state.filters.librarySort || "title";
  const sortReverse = state.filters.librarySortReverse || false;
  const archiveFilter = state.filters.libraryArchive || "active";
  const archivedBookIds = new Set(state.archivedBookIds || []);
  const showStats = state.preferences?.showCardStats !== false;
  const statSortKeys = new Set(["length", "known", "new", "learning", "progress"]);
  const needsStats = showStats || statSortKeys.has(sortKey);
  const preparedVocabStatuses = needsStats ? prepareTextStats(state.vocab) : "";

  const allBooks = [
    ...getAllBooks(),
    ...(state.customTexts || []).map((ct) => ({
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
      _customText: bookTexts.get(ct.id) || ct.text || ""
    }))
  ];

  const books = allBooks
    .filter((book) => {
      const isArchived = archivedBookIds.has(book.id);
      if (archiveFilter === "active" && isArchived) return false;
      if (archiveFilter === "archived" && !isArchived) return false;
      const matchesLevel = level === "all" || !book.level || book.level === level;
      const haystackText = `${book.title} ${book.author} ${book.level} ${book.blurb} ${parseTagList(book.tags).join(" ")}`;
      const haystacks = normalizeSearchVariants(haystackText);
      const matchesQuery = !state.filters.libraryQuery || queryVariants.some(q => haystacks.some(h => h.includes(q)));
      return matchesLevel && matchesQuery;
    })
    .map((book) => {
      const loadedText = book._customText || bookTexts.get(book.id) || "";
      const fullText = loadedText || book.sample || "";
      const hasCompleteText = Boolean(loadedText);
      const isArchived = archivedBookIds.has(book.id);
      const lang = state.preferences.learningLanguage || "en";
      const algorithm = state.preferences.wordDetectionAlgorithm || "modern";
      // ponytail: archive view reads its existing count; it never starts a vocabulary lookup.
      const stats = !hasCompleteText
        ? null
        : isArchived
        ? { unique: getCachedUniqueWordCount(book, fullText, lang, algorithm), known: 0, ignored: 0, learning: 0, new: 0 }
        : needsStats && fullText
        ? getCachedTextStats(book, fullText, state.vocab, lang, algorithm, preparedVocabStatuses)
        : { unique: 0, known: 0, ignored: 0, learning: 0, new: 0 };
    return { book, stats, statsReady: stats !== null, ...calcStatsPcts(stats || EMPTY_STATS) };
    })
    .sort((a, b) => {
      const valA = getSortValue(a.book, a.stats || EMPTY_STATS, sortKey);
      const valB = getSortValue(b.book, b.stats || EMPTY_STATS, sortKey);
      
      let result = 0;
      if (typeof valA === "string" && typeof valB === "string") {
        result = valA.localeCompare(valB, getLocale() === "en" ? "en-US" : "pl-PL");
      } else {
        result = valA - valB;
      }
      
      return sortReverse ? -result : result;
    });

  if (!books.length) {
    els.bookList.innerHTML = `<div class="empty-row">${escapeHtml(t("library.empty"))}</div>`;
    return;
  }

  const localeTag = getLocale() === "en" ? "en-US" : "pl-PL";

  els.bookList.innerHTML = books.map(({ book, stats, statsReady, progress, knownPct, learningPct, newPct }) => {
    const isArchived = archivedBookIds.has(book.id);
    const uniqueValue = (stats?.unique || 0).toLocaleString(localeTag);
    const statsBlock = showStats
      ? !statsReady
        ? `<div class="progress-block" aria-busy="true"><span class="card-stat-summary">…</span></div>`
        : isArchived
        ? `<div class="progress-block"><span class="card-stat-summary">${renderCardCount(uniqueValue, t("library.uniqueWordsLabel"))}</span></div>`
        : `
        <div class="progress-block" aria-label="${escapeAttribute(t("library.progressLabel"))}">
          <div class="progress-line card-progress-line">
            <span class="card-stat-summary">
              ${renderCardStat("card-stat-known", t("reader.statsKnownIgnored"), t("reader.statsKnownIgnoredTitle"), knownPct)}
              ${renderCardStat("card-stat-learning", t("reader.statsLearning"), t("reader.statsLearning"), learningPct)}
              ${renderCardStat("card-stat-new", t("reader.statsNew"), t("reader.statsNew"), newPct)}
              ${renderCardCount(uniqueValue, t("library.uniqueWordsLabel"))}
            </span>
          </div>
          <div class="progress-track" aria-hidden="true">
            <span class="known-track" style="width:${knownPct}%"></span>
            <span class="learning-track" style="width:${learningPct}%"></span>
          </div>
        </div>`
      : "";
    const lengthHint = !showStats && (book._customText || bookTexts.has(book.id))
      ? `<span class="tag tag-soft">${escapeHtml(t("library.uniqueWords", { n: uniqueValue }))}</span>`
      : (!showStats ? `<span class="tag tag-soft">${escapeHtml(t("library.fragment"))}</span>` : "");
    const isUserBook = (state.userBooks || []).some((entry) => entry.id === book.id);
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
    const userTags = parseTagList(book.tags)
      .map((tag) => `<span class="tag tag-user">${escapeHtml(tag)}</span>`)
      .join("");
    const metaParts = [book.author, book.year || "", book.pages || ""].map((part) => String(part || "").trim()).filter(Boolean);
    const metaLine = metaParts.length ? `<p class="book-card-meta-line">${escapeHtml(metaParts.join(" · "))}</p>` : "";
    const blurbLine = book.blurb ? `<p class="book-card-blurb">${escapeHtml(book.blurb)}</p>` : "";
    const gutenbergLink = book.pageUrl && !book.isCustom
      ? `<a class="icon-button" href="${escapeHtml(book.pageUrl)}" target="_blank" rel="noreferrer" title="${escapeHtml(t("reader.sourceGutenberg"))}">${icon("external", 16)}</a>`
      : "";
    return `
      <article class="book-card ${cover ? "has-cover" : ""} ${isArchived ? "archived" : ""}" data-level="${escapeHtml(book.level)}">
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
          <div class="book-actions" style="display: flex; gap: 0.5rem; align-items: center; width: 100%; flex-wrap: wrap; margin-top: auto;">
             <button class="primary-button" type="button" data-action="read-sample" data-id="${escapeHtml(book.id)}" style="flex: 1; justify-content: center; display: inline-flex; align-items: center; gap: 0.4rem;">
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
}

function renderBookCover(book) {
  if (state.preferences?.showCovers === false) return "";
  const sources = [];
  if (book.coverDataUrl) sources.push(book.coverDataUrl);
  if (book.coverPath) sources.push(book.coverPath);
  if (book.coverUrl) sources.push(book.coverUrl);
  if (!sources.length) return "";
  const fallback = sources.slice(1).map((src) => escapeAttribute(src)).join("|");
  return `<div class="book-cover" aria-hidden="true"><img src="${escapeAttribute(sources[0])}" onerror="const fallbacks=this.dataset.fallback?.split('|')||[]; if(fallbacks.length) { this.src=fallbacks.shift(); this.dataset.fallback=fallbacks.join('|'); } else { this.parentElement.style.display='none'; }" data-fallback="${fallback}" alt="${escapeHtml(t("library.coverAlt"))}" /></div>`;
}

function bindLibraryFiltersToggle() {
  if (!els.libraryPanel || !els.libraryFiltersToggle) return;
  const setExpanded = (expanded) => {
    els.libraryPanel.classList.toggle("library-filters-collapsed", !expanded);
    els.libraryFiltersToggle.setAttribute("aria-expanded", String(expanded));
    const labelKey = expanded ? "library.hideFilters" : "library.showFilters";
    const label = t(labelKey);
    els.libraryFiltersToggle.dataset.i18nAttr = `title=${labelKey},aria-label=${labelKey}`;
    els.libraryFiltersToggle.title = label;
    els.libraryFiltersToggle.setAttribute("aria-label", label);
  };
  setExpanded(!els.libraryPanel.classList.contains("library-filters-collapsed"));
  els.libraryFiltersToggle.addEventListener("click", () => {
    setExpanded(els.libraryPanel.classList.contains("library-filters-collapsed"));
  });
}

export function bindLibraryEvents() {
  bindLibraryFiltersToggle();
  bindSidebarResizer(els.librarySidebarResizer, {
    preference: "librarySidebarWidth", cssVariable: "--library-sidebar-width",
    defaultWidth: 360, minWidth: 280, maxWidth: 600, minMainWidth: 360,
    sidebarSelector: ".import-panel", overlay: true
  });
  const deleteDialog = document.getElementById("delete-book-dialog");
  const deleteTitle = document.getElementById("delete-book-title");
  const deleteMessage = document.getElementById("delete-book-message");
  const deleteCancel = document.getElementById("delete-book-cancel");
  const deleteConfirm = document.getElementById("delete-book-confirm");
  let pendingDelete = null;
  const closeDeleteDialog = () => {
    pendingDelete = null;
    deleteDialog?.close();
  };
  const requestBookRemoval = (title, message, remove, confirmLabel = t("library.removeConfirmButton")) => {
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

  els.librarySearch.addEventListener("input", () => {
    state.filters.libraryQuery = els.librarySearch.value;
    saveState();
    renderLibrary();
  });
  els.levelFilter.addEventListener("change", () => {
    state.filters.libraryLevel = els.levelFilter.value;
    saveState();
    renderLibrary();
  });
  els.librarySort.addEventListener("change", () => {
    state.filters.librarySort = els.librarySort.value;
    saveState();
    renderLibrary();
  });
  if (els.librarySortReverse) {
    els.librarySortReverse.addEventListener("click", () => {
      state.filters.librarySortReverse = !state.filters.librarySortReverse;
      saveState();
      renderLibrary();
    });
  }
  if (els.libraryArchiveFilter) {
    els.libraryArchiveFilter.addEventListener("change", () => {
      state.filters.libraryArchive = els.libraryArchiveFilter.value;
      saveState();
      renderLibrary();
    });
  }
  els.bookList.addEventListener("click", async (event) => {
    const control = event.target.closest("[data-action]");
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
