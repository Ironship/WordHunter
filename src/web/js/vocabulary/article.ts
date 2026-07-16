function baseLanguage(language: string): string {
  return String(language || "").toLowerCase().split("-")[0];
}

export function normalizeArticle(value: unknown): string {
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

export function splitAttachedArticle(value: string, language: string): { word: string; article: string } | null {
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

export function vocabularyWordKey(value: string, language: string): string {
  return splitAttachedArticle(value, language)?.word || value;
}
