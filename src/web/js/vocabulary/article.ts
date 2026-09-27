function baseLanguage(language: string): string {
  return String(language || "").toLowerCase().split(/[-_]/)[0];
}

function normalizeArticle(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function formatHeadword(word: string, article?: unknown): string {
  const normalizedArticle = normalizeArticle(article);
  if (!normalizedArticle) return word;
  const comparableWord = word.trim().toLowerCase().replaceAll("’", "'");
  const comparableArticle = normalizedArticle.toLowerCase().replaceAll("’", "'");
  const alreadyHasArticle = comparableArticle.endsWith("'")
    ? comparableWord.startsWith(comparableArticle)
    : comparableWord === comparableArticle || comparableWord.startsWith(`${comparableArticle} `);
  if (alreadyHasArticle) return word;
  return normalizedArticle.endsWith("'") || normalizedArticle.endsWith("’")
    ? `${normalizedArticle}${word}`
    : `${normalizedArticle} ${word}`;
}

function splitAttachedArticle(value: string, language: string): { word: string; article: string } | null {
  const lang = baseLanguage(language);
  const prefixes = lang === "fr" ? ["l'"] : lang === "it" ? ["un'", "l'"] : [];
  if (!prefixes.length) return null;
  const lower = String(value || "").toLowerCase();
  for (const prefix of prefixes) {
    const straight = prefix;
    const curly = prefix.replace("'", "’");
    const matched = lower.startsWith(straight) ? straight : lower.startsWith(curly) ? curly : "";
    if (!matched) continue;
    const word = value.slice(matched.length).trim();
    if (word) return { word, article: prefix };
  }
  return null;
}

// Elided words written onto the next one ("d'amour", "qu'il", "dell'acqua"):
// the vocabulary key is the word after the apostrophe. Longest prefixes come
// first. Keep in sync with ELIDED_PREFIXES in src-tauri/src/tokenizer.rs.
const ELIDED_PREFIXES: Record<string, string[]> = {
  fr: ["lorsqu'", "puisqu'", "jusqu'", "qu'", "l'", "d'", "j'", "m'", "t'", "s'", "n'", "c'"],
  it: [
    "dell'", "dall'", "nell'", "sull'", "coll'", "degl'", "dagl'", "negl'", "sugl'", "quest'", "quell'",
    "all'", "agl'", "gl'", "un'", "l'", "c'", "d'", "m'", "t'", "s'", "v'"
  ]
};

export function vocabularyWordKey(value: string, language: string): string {
  const article = splitAttachedArticle(value, language);
  if (article) return article.word;
  const prefixes = ELIDED_PREFIXES[baseLanguage(language)] || [];
  const lower = String(value || "").toLowerCase().replaceAll("’", "'");
  const prefix = prefixes.find((candidate) => lower.startsWith(candidate));
  const word = prefix ? value.slice(prefix.length).trim() : "";
  return word || value;
}
