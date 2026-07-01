/**
 * Gutendex API client for Project Gutenberg book search.
 */
import { GUTENDEX_URL } from "../constants.js";
import { t } from "../i18n.js";
import { cleanCatalogTitle } from "../utils.js";

const LEVEL_TOPICS = {
  A1: "children",
  A2: "fairy",
  B1: "fiction",
  B2: "drama",
  C1: "philosophy",
  C2: "essays"
};

/**
 * Fetch books from Gutendex with the given discover state.
 * @param {object} discover - state.discover
 * @param {AbortSignal} signal
 * @returns {Promise<{results: object[], count: number, next: boolean, previous: boolean}>}
 */
export async function searchGutendex(discover, signal) {
  const params = new URLSearchParams();
  if (discover.query) params.set("search", discover.query);
  if (discover.language) params.set("languages", discover.language);
  const clientYearSort = discover.sort === "year-asc" || discover.sort === "year-desc";
  const apiSort = clientYearSort ? "popular" : discover.sort;
  if (apiSort) params.set("sort", apiSort);
  const topic = LEVEL_TOPICS[discover.level];
  if (topic) params.set("topic", topic);
  params.set("page", String(discover.page || 1));

  const response = await fetch(`${GUTENDEX_URL}?${params.toString()}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();

  let results = (data.results || []).map((book) => ({
    ...book,
    title: cleanCatalogTitle(book.title)
  }));
  if (clientYearSort) {
    const dir = discover.sort === "year-asc" ? 1 : -1;
    const yearOf = (book) => {
      const years = (book.authors || []).map((a) => a.birth_year).filter((y) => Number.isFinite(y));
      return years.length ? Math.min(...years) : null;
    };
    results = [...results].sort((a, b) => {
      const ya = yearOf(a);
      const yb = yearOf(b);
      if (ya == null && yb == null) return 0;
      if (ya == null) return 1;
      if (yb == null) return -1;
      return (ya - yb) * dir;
    });
  }

  return {
    results,
    count: data.count ?? results.length,
    next: data.next ?? false,
    previous: data.previous ?? false
  };
}
