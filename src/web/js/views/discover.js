// "Discover" view — Project Gutenberg search via Gutendex API.
import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { GUTENDEX_URL } from "../constants.js";
import { escapeHtml, escapeAttribute } from "../utils.js";
import { renderCardStat, renderCardCount } from "../icons.js";
import { getTextStats, cleanGutenbergText } from "../tokenizer_v2.js";
import { t, getLocale } from "../i18n.js";

let lastResults = [];
const selected = new Set();
let searchRunId = 0;
let activeSearchController = null;
let _cachedPrev = null;
let _cachedNext = null;
let _mwContinueToken = null;
// Stats cache for Gutendex books (key = gutenbergId): { unique, known, learning, ... }
const discoverStats = new Map();
// Limit of parallel text fetches for stats
const FETCH_CONCURRENCY = 2;
const STATS_TEXT_LIMIT = 80000;
const AUTO_DISCOVER_STATS = false;
let activeFetches = 0;
const fetchQueue = [];
const activeFetchControllers = new Map(); // id -> AbortController

// Heuristic mapping of CEFR level → Project Gutenberg topic.
// Gutendex has no language levels, so we filter by topic/shelf.
const LEVEL_TOPICS = {
  A1: "children",
  A2: "fairy",
  B1: "fiction",
  B2: "drama",
  C1: "philosophy",
  C2: "essays"
};

export function renderDiscover() {
  if (!els.discoverForm) return;
  els.discoverQuery.value = state.discover.query || "";
  if (els.discoverSource) els.discoverSource.value = state.discover.source || "gutenberg";
  els.discoverLanguage.value = state.discover.language || "de";
  els.discoverSort.value = state.discover.sort || "popular";
  if (els.discoverLevel) els.discoverLevel.value = state.discover.level || "";
  
  const isGutenberg = (state.discover.source || "gutenberg") === "gutenberg";
  if (els.discoverLevel) els.discoverLevel.disabled = !isGutenberg;
  if (els.discoverSort) els.discoverSort.disabled = (state.discover.source === "wikipedia");
  renderResults();
  renderUserBooks();
}

function setStatus(message, busy = false) {
  if (!els.discoverStatus) return;
  els.discoverStatus.textContent = message || "";
  els.discoverStatus.classList.toggle("busy", busy);
}

export async function runDiscoverSearch() {
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
    let data = { count: 0, results: [] };
    
    if (source === "gutenberg") {
      const params = new URLSearchParams();
      if (state.discover.query) params.set("search", state.discover.query);
      if (state.discover.language) params.set("languages", state.discover.language);
      const clientYearSort = state.discover.sort === "year-asc" || state.discover.sort === "year-desc";
      const apiSort = clientYearSort ? "popular" : state.discover.sort;
      if (apiSort) params.set("sort", apiSort);
      const topic = LEVEL_TOPICS[state.discover.level];
      if (topic) params.set("topic", topic);
      params.set("page", String(state.discover.page || 1));
      
      const response = await fetch(`${GUTENDEX_URL}?${params.toString()}`, { signal: activeSearchController.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = await response.json();
      if (runId !== searchRunId) return;
      
      lastResults = data.results || [];
      if (clientYearSort) {
        const dir = state.discover.sort === "year-asc" ? 1 : -1;
        const yearOf = (book) => {
          const years = (book.authors || []).map((a) => a.birth_year).filter((y) => Number.isFinite(y));
          return years.length ? Math.min(...years) : null;
        };
        lastResults = [...lastResults].sort((a, b) => {
          const ya = yearOf(a);
          const yb = yearOf(b);
          if (ya == null && yb == null) return 0;
          if (ya == null) return 1;
          if (yb == null) return -1;
          return (ya - yb) * dir;
        });
      }
      data.results = lastResults;
    } else if (source === "wikipedia" || source === "wikinews") {
      const domain = source === "wikipedia" ? "wikipedia.org" : "wikinews.org";
      const lang = state.discover.language || "en";
      const url = `https://${lang}.${domain}/w/api.php`;
      const query = state.discover.query || "";
      const page = state.discover.page || 1;

      if (page === 1) _mwContinueToken = null;
      
      let apiUrl = "";
      if (query) {
        let sortParam = "";
        if (state.discover.sort === "newest") sortParam = "&gsrsort=create_timestamp_desc";
        else if (state.discover.sort === "oldest") sortParam = "&gsrsort=create_timestamp_asc";
        const offset = (page - 1) * 10;
        apiUrl = `${url}?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsroffset=${offset}&gsrlimit=10${sortParam}&prop=pageimages|extracts&exintro=1&explaintext=1&pithumbsize=300&utf8=&format=json&origin=*`;
      } else {
        if (state.discover.sort === "newest") {
          let continueParam = _mwContinueToken ? `&grccontinue=${encodeURIComponent(_mwContinueToken)}` : "";
          apiUrl = `${url}?action=query&generator=recentchanges&grctype=new&grcnamespace=0&grclimit=10${continueParam}&prop=pageimages|extracts&exintro=1&explaintext=1&pithumbsize=300&format=json&origin=*`;
        } else {
          apiUrl = `${url}?action=query&generator=random&grnnamespace=0&grnlimit=10&prop=pageimages|extracts&exintro=1&explaintext=1&pithumbsize=300&format=json&origin=*`;
        }
      }
      
      const response = await fetch(apiUrl, { signal: activeSearchController.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rawData = await response.json();
      if (runId !== searchRunId) return;
      
      const pages = rawData.query?.pages ? Object.values(rawData.query.pages) : [];
      
      if (query) {
        lastResults = pages.map(item => ({
          id: `mw-${item.pageid}`,
          mwId: item.pageid,
          title: item.title,
          authors: [{name: source === "wikipedia" ? t("discover.sourceWikipedia") : t("discover.sourceWikinews")}],
          languages: [lang],
          summaries: [item.extract ? item.extract.slice(0, 200) + "..." : ""],
          formats: {},
          source: source,
          domain: domain,
          coverDataUrl: item.thumbnail?.source || ""
        }));
        data.next = rawData.continue?.gsroffset ? true : false;
        data.previous = page > 1;
        data.count = lastResults.length;
      } else {
        lastResults = pages.map(item => ({
          id: `mw-${item.pageid}`,
          mwId: item.pageid,
          title: item.title,
          authors: [{name: source === "wikipedia" ? t("discover.sourceWikipedia") : t("discover.sourceWikinews")}],
          languages: [lang],
          summaries: [item.extract ? item.extract.slice(0, 200) + "..." : ""],
          formats: {},
          source: source,
          domain: domain,
          coverDataUrl: item.thumbnail?.source || ""
        }));
        if (state.discover.sort === "newest" && rawData.continue?.grccontinue) {
          _mwContinueToken = rawData.continue.grccontinue;
          data.next = true;
        } else {
          _mwContinueToken = null;
          data.next = false;
        }
        data.previous = page > 1;
        data.count = lastResults.length;
      }
      data.results = lastResults;
    }
    
    renderResults(data);
    const parts = [];
    if (state.discover.query) parts.push(`„${state.discover.query}”`);
    if (source === "gutenberg" && state.discover.level) parts.push(`${t("discover.level")} ${state.discover.level}`);
    const label = parts.length ? parts.join(", ") : `(${t("discover.sortPopular").toLowerCase()})`;
    setStatus(`${data.count ?? lastResults.length} · ${label}`);
  } catch (error) {
    if (runId !== searchRunId || error.name === "AbortError") return;
    console.warn("Gutendex error:", error);
    lastResults = [];
    els.discoverResults.innerHTML = `<div class="empty-row">${escapeHtml(t("discover.error"))}</div>`;
    setStatus(t("discover.error"));
  }
}

function renderResults(data) {
  if (!els.discoverResults) return;
  if (!lastResults.length) {
    els.discoverResults.innerHTML = state.discover.query
      ? `<div class="empty-row">${escapeHtml(t("discover.noResults"))}</div>`
      : `<div class="empty-row">${escapeHtml(t("discover.emptyPrompt"))}</div>`;
    els.discoverToolbar.hidden = true;
    els.discoverPagination.innerHTML = "";
    return;
  }
  // Cache pagination URLs so they survive view re-entry
  if (data) {
    _cachedPrev = data.previous;
    _cachedNext = data.next;
  }
  els.discoverToolbar.hidden = false;
  const localeTag = getLocale() === "en" ? "en-US" : "pl-PL";
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
    const inLibrary = (state.userBooks || []).some((entry) => entry.gutenbergId === id);
    const showCover = state.preferences?.showCovers !== false;
    const coverBlock = showCover
      ? (cover
        ? `<div class="book-cover" aria-hidden="true"><img src="${escapeAttribute(cover)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
        : `<div class="book-cover" aria-hidden="true"><div style="width:100%;height:100%;background:var(--line);border-radius:4px;"></div></div>`)
      : "";
      
    let sourceTag = t("discover.sourceGutenberg", { id: escapeHtml(id) });
    if (book.source === "wikipedia") sourceTag = t("discover.sourceWikipedia");
    if (book.source === "wikinews") sourceTag = t("discover.sourceWikinews");


    const stats = discoverStats.get(id);
    const statsBlock = isGutenberg && AUTO_DISCOVER_STATS ? renderStatsBlock(id, stats) : "";
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
          ${statsBlock}
          <div class="book-actions" style="flex-direction: row; justify-content: space-between; align-items: center; gap: 0.5rem; width: 100%;">
            <label class="discover-check" style="margin: 0;">
              <input type="checkbox" data-discover-check="${escapeAttribute(id)}" ${isSelected ? "checked" : ""}>
              <span>${escapeHtml(t("discover.selectLabel"))}</span>
            </label>
            <div style="display: flex; gap: 0.5rem;">
              <button class="primary-button icon-button" type="button" data-discover-add="${escapeAttribute(id)}" ${inLibrary ? "disabled" : ""} title="${escapeAttribute(inLibrary ? t("discover.added") : t("discover.add"))}">
                ${inLibrary 
                  ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>` 
                  : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`
                }
              </button>
              ${isGutenberg ? 
                `<a class="ghost-button icon-button" href="https://www.gutenberg.org/ebooks/${escapeAttribute(id)}" target="_blank" rel="noreferrer" title="${escapeAttribute(t("discover.openGutenberg"))}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                </a>` : 
                (book.source === "wikipedia" || book.source === "wikinews" ? 
                  `<a class="ghost-button icon-button" href="https://${book.languages[0]}.${book.domain}/?curid=${escapeAttribute(book.mwId)}" target="_blank" rel="noreferrer" title="${escapeAttribute(t("discover.openOnSite"))}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                  </a>` : 
                  ""
                )
              }
            </div>
          </div>
        </div>
      </article>
    `;
  }).join("");

  if (AUTO_DISCOVER_STATS) {
    lastResults.forEach((book) => scheduleStats(book));
  }

  const pageNum = state.discover.page || 1;
  // Use API response data when available; fall back to cache on view re-entry
  const hasPrev = data !== undefined ? data.previous : _cachedPrev;
  const hasNext = data !== undefined ? data.next : _cachedNext;
  const prev = hasPrev ? `<button class="secondary-button" type="button" data-discover-page="prev">${escapeHtml(t("discover.prev"))}</button>` : "";
  const next = hasNext ? `<button class="secondary-button" type="button" data-discover-page="next">${escapeHtml(t("discover.next"))}</button>` : "";
  els.discoverPagination.innerHTML = `${prev}<span class="muted-copy">${escapeHtml(t("discover.page", { n: pageNum }))}</span>${next}`;
}

function renderStatsBlock(id, stats) {
  const localeTag = getLocale() === "en" ? "en-US" : "pl-PL";
  if (!stats) {
    return `
      <div class="progress-block" data-stats-for="${escapeAttribute(id)}" aria-label="${escapeAttribute(t("library.progressLabel"))}">
        <div class="progress-line"><span class="muted-copy">${escapeHtml(t("discover.statsLoading"))}</span><span><span class="spinner" aria-hidden="true"></span></span></div>
        <div class="progress-track" aria-hidden="true">
          <span class="known-track" style="width:0%"></span>
          <span class="learning-track" style="width:0%"></span>
        </div>
      </div>`;
  }
  if (stats.error) {
    return `
      <div class="progress-block" data-stats-for="${escapeAttribute(id)}">
        <div class="progress-line"><span class="muted-copy">${escapeHtml(t("discover.statsNoText"))}</span><span></span></div>
      </div>`;
  }
  const total = stats.unique || 1;
  const knownPct = ((stats.known + stats.ignored) / total) * 100;
  const learningPct = (stats.learning / total) * 100;
  const newPct = 100 - knownPct - learningPct;
  const uniqueValue = stats.unique.toLocaleString(localeTag);
  return `
    <div class="progress-block" data-stats-for="${escapeAttribute(id)}" aria-label="${escapeAttribute(t("library.progressLabel"))}">
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
    </div>`;
}

function getPlainTextUrl(formats) {
  if (!formats) return null;
  const candidates = [
    "text/plain; charset=utf-8",
    "text/plain; charset=us-ascii",
    "text/plain; charset=iso-8859-1",
    "text/plain"
  ];
  for (const key of candidates) {
    const url = formats[key];
    if (url && !url.endsWith(".zip")) return url;
  }
  for (const [key, url] of Object.entries(formats)) {
    if (key.startsWith("text/plain") && !url.endsWith(".zip")) return url;
  }
  return null;
}

function scheduleStats(book) {
  const id = String(book.id);
  if (discoverStats.has(id)) return;
  
  const url = getPlainTextUrl(book.formats);
  if (!url) {
    discoverStats.set(id, { error: true });
    updateStatsCard(id);
    return;
  }
  fetchQueue.push({ id, url });
  pumpQueue();
}

function pumpQueue() {
  while (activeFetches < FETCH_CONCURRENCY && fetchQueue.length) {
    const job = fetchQueue.shift();
    const controller = new AbortController();
    activeFetchControllers.set(job.id, controller);
    activeFetches += 1;
    fetchStats(job, controller.signal).finally(() => {
      activeFetchControllers.delete(job.id);
      activeFetches -= 1;
      pumpQueue();
    });
  }
}

// Export cleanup function for component unmount
export function cancelAllStatsFetches() {
  for (const controller of activeFetchControllers.values()) {
    controller.abort();
  }
  activeFetchControllers.clear();
  fetchQueue.length = 0;
  activeFetches = 0;
}

async function fetchStats({ id, url }, signal) {
  // First try local proxy (bypasses Project Gutenberg CORS). Fallback: direct.
  const proxied = `/__proxy?url=${encodeURIComponent(url)}`;
  let raw = null;
  try {
    const r = await fetch(proxied, { signal });
    if (r.ok) raw = await r.text();
  } catch {
    /* proxy did not respond — try direct */
  }
  if (raw == null) {
    try {
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      raw = await r.text();
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.warn("Discover stats error for", id, error);
      discoverStats.set(id, { error: true });
      updateStatsCard(id);
      return;
    }
  }
  try {
    const truncated = raw.length > STATS_TEXT_LIMIT ? raw.slice(0, STATS_TEXT_LIMIT) : raw;
    const text = cleanGutenbergText(truncated);
    discoverStats.set(id, getTextStats(
      text,
      state.vocab,
      state.preferences.learningLanguage || "en",
      state.preferences.wordDetectionAlgorithm || "modern"
    ));
  } catch (error) {
    console.warn("Discover stats parse error for", id, error);
    discoverStats.set(id, { error: true });
  }
  updateStatsCard(id);
}

function updateStatsCard(id) {
  if (!els.discoverResults) return;
  const block = els.discoverResults.querySelector(`[data-stats-for="${CSS.escape(id)}"]`);
  if (!block) return;
  const stats = discoverStats.get(id);
  block.outerHTML = renderStatsBlock(id, stats);
}

function renderUserBooks() {
  if (!els.userBooksList) return;
  const list = state.userBooks || [];
  if (!list.length) {
    els.userBooksList.innerHTML = `<p class="muted-copy">${escapeHtml(t("discover.userBooksEmpty"))}</p>`;
    return;
  }
  els.userBooksList.innerHTML = list.map((book) => `
    <div class="user-book-row">
      ${book.coverUrl ? `<img src="${escapeAttribute(book.coverUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ""}
      <div>
        <strong>${escapeHtml(book.title)}</strong>
        <p class="muted-copy">${escapeHtml(book.author)} · #${escapeHtml(book.gutenbergId)}</p>
      </div>
      <button class="icon-button danger-button" type="button" data-remove-user-book="${escapeAttribute(book.id)}" title="${escapeAttribute(t("library.remove"))}" style="width: 32px; height: 32px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    </div>
  `).join("");
}

export function getDiscoverHandlers({ onAdd, onRemove }) {
  return {
    onResultsClick(event) {
      const addBtn = event.target.closest("[data-discover-add]");
      if (addBtn) {
        const id = addBtn.dataset.discoverAdd;
        const book = lastResults.find((b) => String(b.id) === id);
        if (book) onAdd(book);
        return;
      }
      const pageBtn = event.target.closest("[data-discover-page]");
      if (pageBtn) {
        const direction = pageBtn.dataset.discoverPage;
        state.discover.page = Math.max(1, (state.discover.page || 1) + (direction === "next" ? 1 : -1));
        saveState();
        runDiscoverSearch();
      }
    },
    onResultsChange(event) {
      const checkbox = event.target.closest("[data-discover-check]");
      if (!checkbox) return;
      const id = checkbox.dataset.discoverCheck;
      if (checkbox.checked) selected.add(id); else selected.delete(id);
      // Only update card class without redrawing.
      const card = checkbox.closest(".discover-card");
      if (card) card.classList.toggle("selected", checkbox.checked);
    },
    toggleAll(checked) {
      selected.clear();
      if (checked) lastResults.forEach((b) => selected.add(String(b.id)));
      renderResults();
    },
    addSelected() {
      const toAdd = lastResults.filter((b) => selected.has(String(b.id)));
      let added = 0;
      toAdd.forEach((book) => { if (onAdd(book, { silent: true })) added += 1; });
      selected.clear();
      renderResults();
      renderUserBooks();
      return added;
    },
    onUserBooksClick(event) {
      const button = event.target.closest("[data-remove-user-book]");
      if (button) onRemove(button.dataset.removeUserBook);
    },
    refreshUserBooks: renderUserBooks
  };
}
