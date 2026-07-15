/**
 * Smart suggestions for the word panel: grammatical articles and German separable verbs.
 */
import { state } from "../state.js";
import { escapeHtml, escapeAttribute } from "../utils.js";
import { t } from "../i18n.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";

export interface ArticleSmartSuggestion {
  kind: "article";
  article: string;
  word: string;
}

export interface SeparableVerbSmartSuggestion {
  kind: "separable-verb";
  word: string;
}

export type SmartSuggestion = ArticleSmartSuggestion | SeparableVerbSmartSuggestion;

const ARTICLES: Record<string, readonly string[]> = {
  de: ["der", "die", "das", "ein", "eine", "einen", "einem", "einer", "eines", "dem", "den", "des"],
  fr: ["le", "la", "les", "un", "une", "l'"],
  es: ["el", "la", "los", "las", "un", "una", "unos", "unas"],
  it: ["il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "l'", "un'"]
};

const SUGGESTIBLE_ARTICLES: Record<string, readonly string[]> = {
  ...ARTICLES,
  // Inflected German forms such as "dem" and "den" do not identify one
  // canonical dictionary article, so only unambiguous forms are suggested.
  de: ["der", "die", "das"]
};

function baseLanguage(language: string): string {
  return language.toLowerCase().split("-")[0];
}

export function articleOptionsForLanguage(language = effectiveLearningLanguage(state.preferences)): readonly string[] {
  return ARTICLES[baseLanguage(language)] || [];
}

export function supportsArticleLanguage(language = effectiveLearningLanguage(state.preferences)): boolean {
  return articleOptionsForLanguage(language).length > 0;
}

function suggestionArticlesForLanguage(language: string): readonly string[] {
  return SUGGESTIBLE_ARTICLES[baseLanguage(language)] || [];
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSuggestedArticle(value: string): string {
  return value.toLowerCase().replaceAll("’", "'");
}

function detectArticle(context: string, word: string, language: string): ArticleSmartSuggestion | null {
  const options = suggestionArticlesForLanguage(language);
  if (!options.length) return null;
  const selectedWord = word.toLowerCase();
  const wordPattern = regexEscape(word);
  const boundaryBefore = "(?:^|[^\\p{L}\\p{M}])";
  const boundaryAfter = "(?![\\p{L}\\p{M}])";
  const spaced = options.filter((article) => !article.endsWith("'"));
  const attached = options.filter((article) => article.endsWith("'"));

  if (!state.vocab[word]?.article && spaced.length) {
    const pattern = spaced.map(regexEscape).join("|");
    const match = context.match(new RegExp(`${boundaryBefore}(${pattern})\\s+${wordPattern}${boundaryAfter}`, "iu"));
    if (match?.[1]) {
      return { kind: "article", article: normalizeSuggestedArticle(match[1]), word };
    }
  }
  if (!state.vocab[word]?.article && attached.length) {
    const pattern = attached
      .map((article) => regexEscape(article).replace("'", "['’]"))
      .join("|");
    const match = context.match(new RegExp(`${boundaryBefore}(${pattern})${wordPattern}${boundaryAfter}`, "iu"));
    if (match?.[1]) {
      return { kind: "article", article: normalizeSuggestedArticle(match[1]), word };
    }
  }

  if (spaced.includes(selectedWord)) {
    const match = context.match(new RegExp(
      `${boundaryBefore}${wordPattern}\\s+([\\p{L}\\p{M}][\\p{L}\\p{M}'’\\-]*)${boundaryAfter}`,
      "iu"
    ));
    const targetWord = match?.[1]?.toLowerCase() || "";
    if (targetWord && !state.vocab[targetWord]?.article) {
      return { kind: "article", article: normalizeSuggestedArticle(selectedWord), word: targetWord };
    }
  }
  return null;
}

export function getSmartSuggestion(context: string, word: string): SmartSuggestion | null {
  if (!context || !word || word.includes(" ")) return null;
  const language = effectiveLearningLanguage(state.preferences);
  const articleSuggestion = detectArticle(context, word, language);
  if (articleSuggestion) return articleSuggestion;

  if (baseLanguage(language) === "de") {
    const suggestedWord = checkGermanSeparableVerb(context, word);
    if (suggestedWord) return { kind: "separable-verb", word: suggestedWord };
  }
  return null;
}
export function renderSmartSuggestionHtml(suggestion: SmartSuggestion | null): string {
  if (!suggestion) return "";
  if (suggestion.kind === "article") {
    return `
      <div class="smart-suggestion smart-suggestion-article">
        <p>${escapeHtml(t("reader.smartSuggestArticle"))}</p>
        <button class="primary-button button-xs" type="button" data-suggest-article="${escapeAttribute(suggestion.article)}" data-suggest-word="${escapeAttribute(suggestion.word)}">
          ${escapeHtml(t("reader.smartSuggestArticleBtn", { article: suggestion.article }))}
          <span class="shortcut-badge">5</span>
        </button>
      </div>
    `;
  }
  const particle = suggestion.word.toLowerCase().replace(state.selectedWord?.toLowerCase() || "", "").trim();
  return `
    <div class="smart-suggestion smart-suggestion-separable">
      <p>${escapeHtml(t("reader.smartSuggestSeparableVerb"))}</p>
      <button class="primary-button button-xs" type="button" data-suggest-word="${escapeAttribute(suggestion.word)}">
        ${escapeHtml(t("reader.smartSuggestBtn").replace("{word}", particle))}
        <strong>${escapeHtml(suggestion.word)}</strong>
        <span class="shortcut-badge">5</span>
      </button>
    </div>
  `;
}

export function getSmartSuggestionHtml(context: string, word: string): string {
  return renderSmartSuggestionHtml(getSmartSuggestion(context, word));
}
function checkGermanSeparableVerb(context: string, word: string): string | null {
  const dePrefixes = ["ab", "an", "auf", "aus", "bei", "ein", "fest", "her", "herein", "hin", "hinaus", "los", "mit", "nach", "vor", "vorbei", "weg", "weiter", "zu", "zurück", "zusammen", "dran", "drauf", "raus", "rein", "rüber", "runter"];
  const pronouns = ["ich", "du", "er", "sie", "es", "wir", "ihr", "mich", "dich", "ihn", "uns", "euch", "ihnen", "mir", "dir", "ihm"];
  const wordsInContext = context.split(/[\s.,!?;:"'(){}\[\]„”«»\-]+/).filter(Boolean);

  if (wordsInContext.length <= 1) return null;

  const deArticles = ["der", "die", "das", "ein", "eine", "einen", "einem", "einer", "eines", "dem", "den", "des"];
  const dePrepositions = ["um", "in", "auf", "unter", "über", "vor", "nach", "für", "mit", "ohne", "aus", "bei", "von", "zu", "durch", "gegen", "wider", "entlang", "bis", "ab", "seit", "wegen", "während", "trotz", "statt"];
  const deConjunctions = ["und", "oder", "aber", "weil", "dass", "wenn", "als", "denn", "ob", "obwohl", "da", "damit", "sodass"];
  const deAdverbs = ["nicht", "auch", "so", "nur", "noch", "schon", "sehr", "immer", "oft", "hier", "da", "dort", "heute", "morgen", "gestern", "jetzt", "dann", "danach", "vorher", "wieder", "gerne", "vielleicht", "wohl", "ja", "nein", "doch", "mal", "eben", "einfach", "halt", "ganz", "gar"];
  const deOthers = ["sich", "mein", "dein", "sein", "unser", "euer", "ihr", "meine", "deine", "seine", "unsere", "eure", "ihre", "meinen", "deinen", "seinen", "unseren", "euren", "ihren", "was", "wer", "wie", "wo", "wann", "warum", "wieso", "weshalb", "wohin", "woher", "wem", "wen", "man", "alle", "alles", "viele", "einige", "andere", "jedes", "jeden", "jede", "jeder", "kein", "keine", "keinen", "keinem", "keiner", "gut", "viel", "wenig", "mehr"];
  const nonVerbs = [...pronouns, ...deArticles, ...dePrepositions, ...deConjunctions, ...deAdverbs, ...deOthers];

  const isNonVerb = nonVerbs.includes(word.toLowerCase());
  const isNumber = /^[\d.,]+$/.test(word);

  const wordIndex = wordsInContext.findIndex(w => w.toLowerCase() === word.toLowerCase());
  const originalWordInContext = wordIndex >= 0 ? wordsInContext[wordIndex] : word;

  const isCapitalized = originalWordInContext[0] === originalWordInContext[0].toUpperCase() && originalWordInContext[0] !== originalWordInContext[0].toLowerCase();
  const isFirstWord = wordIndex === 0;
  const isLikelyNoun = isCapitalized && !isFirstWord;

  if (isNonVerb || isNumber || isLikelyNoun) {
    return null;
  }

  // The separable prefix normally sits at the end of the clause containing the verb.
  // Use the clause (comma-delimited segment) that contains the verb, not the whole
  // sentence, so cases like "Ich rufe dich morgen an, wenn …" still match "an".
  const clauseSegments = context.split(/,/);
  let clauseWords = wordsInContext;
  for (const seg of clauseSegments) {
    const segWords = seg.split(/[\s.,!?;:"'(){}\[\]„”«»\-]+/).filter(Boolean);
    if (segWords.some(w => w.toLowerCase() === word.toLowerCase())) {
      clauseWords = segWords;
      break;
    }
  }
  if (clauseWords.length <= 1) return null;
  const lastWord = clauseWords[clauseWords.length - 1].toLowerCase();

  if (!dePrefixes.includes(lastWord) || lastWord === word.toLowerCase()) {
    return null;
  }

  // Check if prefix has already been consumed by another word in this sentence
  let isPrefixConsumed = false;
  for (const vocabWord in state.vocab) {
    if (vocabWord.toLowerCase().endsWith(" " + lastWord) && state.vocab[vocabWord].status !== "new") {
      const verbPart = vocabWord.split(" ")[0];
      if (!verbPart) continue;
      const verbRegex = new RegExp(`\\b${verbPart}\\b`, 'i');
      if (verbRegex.test(context)) {
        isPrefixConsumed = true;
        break;
      }
    }
  }

  if (isPrefixConsumed) return null;
  return `${word} ${lastWord}`;
}
