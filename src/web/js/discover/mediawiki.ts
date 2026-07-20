/**
 * Wikipedia / Wikinews API client for the Discover view.
 */
import { t as translate } from "../i18n.js";

const t = translate as (key: string, vars?: WhRecord) => string;

export type MediaWikiSource = "wikipedia" | "wikinews" | "wikisource";

export interface MediaWikiBook extends WhRecord {
  id: string;
  mwId: string | number;
  apiLang: string;
  title: string;
  authors: Array<{ name: string }>;
  languages: string[];
  summaries: string[];
  formats: Record<string, string>;
  source: MediaWikiSource;
  domain: string;
  coverDataUrl: string;
}

export interface MediaWikiSearchResponse {
  results: MediaWikiBook[];
  count: number;
  next: boolean;
  previous: boolean;
  continueToken: string | null;
}

export function mediaWikiBookId(
  source: MediaWikiSource,
  apiLang: string,
  pageId: string | number,
  profileId = ""
): string {
  const language = String(apiLang || "en").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const id = String(pageId).replace(/[^a-zA-Z0-9-]+/g, "-");
  const profile = String(profileId).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const profileNamespace = profile ? `${profile}-` : "";
  return `mw-${profileNamespace}${source}-${language}-${id}`;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

export async function searchMediaWiki(
  source: MediaWikiSource,
  lang: string,
  query: string,
  page: number,
  sort: string,
  continueToken: string | null,
  signal: AbortSignal
): Promise<MediaWikiSearchResponse> {
  const domain = mediaWikiDomain(source);
  const apiLang = mediaWikiLang(source, lang);
  const baseUrl = `https://${apiLang}.${domain}/w/api.php`;
  const currentContinue = page === 1 ? null : continueToken;

  let apiUrl = "";
  if (query) {
    let sortParam = "";
    if (sort === "newest") sortParam = "&gsrsort=create_timestamp_desc";
    else if (sort === "oldest") sortParam = "&gsrsort=create_timestamp_asc";
    const offset = (page - 1) * 10;
    apiUrl = `${baseUrl}?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsroffset=${offset}&gsrlimit=10${sortParam}&prop=pageimages|extracts&exintro=1&explaintext=1&pithumbsize=300&utf8=&format=json&origin=*`;
  } else if (sort === "newest") {
    const continueParam = currentContinue ? `&grccontinue=${encodeURIComponent(currentContinue)}` : "";
    apiUrl = `${baseUrl}?action=query&generator=recentchanges&grctype=new&grcnamespace=0&grclimit=10${continueParam}&prop=pageimages|extracts&exintro=1&explaintext=1&pithumbsize=300&format=json&origin=*`;
  } else {
    apiUrl = `${baseUrl}?action=query&generator=random&grnnamespace=0&grnlimit=10&prop=pageimages|extracts&exintro=1&explaintext=1&pithumbsize=300&format=json&origin=*`;
  }

  const response = await fetch(apiUrl, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const rawData: unknown = await response.json();
  const data = asRecord(rawData) || {};
  const queryData = asRecord(data.query);
  const pageData = asRecord(queryData?.pages);
  const pages: unknown[] = pageData ? Object.values(pageData) : [];

  const mapPage = (item: unknown): MediaWikiBook => {
    const pageData = asRecord(item) || {};
    const pageId = typeof pageData.pageid === "string" || typeof pageData.pageid === "number"
      ? pageData.pageid
      : "";
    const extract = typeof pageData.extract === "string" ? pageData.extract : "";
    const thumbnail = asRecord(pageData.thumbnail);
    return {
      id: mediaWikiBookId(source, apiLang, pageId),
      mwId: pageId,
      apiLang,
      title: typeof pageData.title === "string" ? pageData.title : "",
      authors: [{ name: mediaWikiSourceName(source) }],
      languages: [lang || apiLang],
      summaries: [extract ? extract.slice(0, 200) + "..." : ""],
      formats: {},
      source,
      domain,
      coverDataUrl: typeof thumbnail?.source === "string" ? thumbnail.source : ""
    };
  };

  const results = pages.map(mapPage);
  let next = false;
  let newContinueToken: string | null = null;
  const continuation = asRecord(data.continue);

  if (query) {
    next = continuation?.gsroffset ? true : false;
  } else if (sort === "newest" && typeof continuation?.grccontinue === "string" && continuation.grccontinue) {
    newContinueToken = continuation.grccontinue;
    next = true;
  }

  return {
    results,
    count: results.length,
    next,
    previous: page > 1,
    continueToken: newContinueToken
  };
}

function mediaWikiDomain(source: MediaWikiSource): string {
  if (source === "wikinews") return "wikinews.org";
  if (source === "wikisource") return "wikisource.org";
  return "wikipedia.org";
}

function mediaWikiLang(source: MediaWikiSource, lang: string): string {
  if (source === "wikisource" && lang === "grc") return "el";
  return lang || "en";
}

function mediaWikiSourceName(source: MediaWikiSource): string {
  if (source === "wikinews") return t("discover.sourceWikinews");
  if (source === "wikisource") return t("discover.sourceWikisource");
  return t("discover.sourceWikipedia");
}
