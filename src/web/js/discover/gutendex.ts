/**
 * Gutendex API client for Project Gutenberg book search.
 */
import { GUTENDEX_URL } from "../constants.js";
import { t } from "../i18n.js";
import { cleanCatalogTitle } from "../utils.js";

const LEVEL_TOPICS: Record<string, string> = {
  A1: "children",
  A2: "fairy",
  B1: "fiction",
  B2: "drama",
  C1: "philosophy",
  C2: "essays"
};

export interface GutendexDiscoverState extends WhDiscoverState {
  language?: string;
}

export interface GutendexAuthor extends WhRecord {
  name?: string;
  birth_year?: number | null;
  death_year?: number | null;
}

export interface GutendexBook extends WhRecord {
  id: string | number;
  title: string;
  authors?: GutendexAuthor[];
  formats?: Record<string, string>;
  languages?: string[];
  summaries?: string[];
}

export interface GutendexSearchResponse {
  results: GutendexBook[];
  count: number;
  next: boolean;
  previous: boolean;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

export async function searchGutendex(
  discover: GutendexDiscoverState,
  signal: AbortSignal
): Promise<GutendexSearchResponse> {
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
  const rawData: unknown = await response.json();
  const data = asRecord(rawData) || {};

  const rawResults = Array.isArray(data.results) ? data.results : [];
  let results: GutendexBook[] = rawResults.map((value: unknown) => {
    const book = asRecord(value) || {};
    const id = typeof book.id === "string" || typeof book.id === "number" ? book.id : "";
    return {
      ...book,
      id,
      title: cleanCatalogTitle(book.title)
    };
  });
  if (clientYearSort) {
    const dir = discover.sort === "year-asc" ? 1 : -1;
    const yearOf = (book: GutendexBook): number | null => {
      const years = (book.authors || [])
        .map((author) => author.birth_year)
        .filter((year): year is number => typeof year === "number" && Number.isFinite(year));
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
    count: typeof data.count === "number" ? data.count : results.length,
    next: (data.next ?? false) as boolean,
    previous: (data.previous ?? false) as boolean
  };
}
