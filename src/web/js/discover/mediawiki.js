/**
 * Wikipedia / Wikinews API client for the Discover view.
 */
import { t } from "../i18n.js";

/**
 * Search or browse Wikipedia/Wikinews.
 * @param {string} source - "wikipedia" or "wikinews"
 * @param {string} lang
 * @param {string} query - search term (empty = browse)
 * @param {number} page - 1-based page
 * @param {string} sort - "popular", "newest", "oldest"
 * @param {string|null} continueToken - continuation token for pagination
 * @param {AbortSignal} signal
 * @returns {Promise<{results: object[], count: number, next: boolean, previous: boolean, continueToken: string|null}>}
 */
export async function searchMediaWiki(source, lang, query, page, sort, continueToken, signal) {
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
  const rawData = await response.json();
  const pages = rawData.query?.pages ? Object.values(rawData.query.pages) : [];

  const mapPage = (item) => ({
    id: source === "wikisource" ? `wikisource-${item.pageid}` : `mw-${item.pageid}`,
    mwId: item.pageid,
    apiLang,
    title: item.title,
    authors: [{ name: mediaWikiSourceName(source) }],
    languages: [lang || apiLang],
    summaries: [item.extract ? item.extract.slice(0, 200) + "..." : ""],
    formats: {},
    source: source,
    domain: domain,
    coverDataUrl: item.thumbnail?.source || ""
  });

  const results = pages.map(mapPage);
  let next = false;
  let newContinueToken = null;

  if (query) {
    next = rawData.continue?.gsroffset ? true : false;
  } else if (sort === "newest" && rawData.continue?.grccontinue) {
    newContinueToken = rawData.continue.grccontinue;
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

function mediaWikiDomain(source) {
  if (source === "wikinews") return "wikinews.org";
  if (source === "wikisource") return "wikisource.org";
  return "wikipedia.org";
}

function mediaWikiLang(source, lang) {
  if (source === "wikisource" && lang === "grc") return "el";
  return lang || "en";
}

function mediaWikiSourceName(source) {
  if (source === "wikinews") return t("discover.sourceWikinews");
  if (source === "wikisource") return t("discover.sourceWikisource");
  return t("discover.sourceWikipedia");
}
