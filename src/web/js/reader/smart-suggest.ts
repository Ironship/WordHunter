/**
 * Smart suggestions for the word panel: article detection & German separable verbs.
 */
import { state } from "../state.js";
import { escapeHtml } from "../utils.js";
import { t } from "../i18n.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";

/**
 * @param {string} context - sentence context around the word
 * @param {string} word - the selected word
 * @returns {string} HTML for the smart suggestion, or empty string
 */
export function getSmartSuggestionHtml(context: string, word: string): string {
  if (!context || !word || word.includes(" ")) return "";

  const lang = effectiveLearningLanguage(state.preferences).split("-")[0];
  const articles: Record<string, string[]> = {
    de: ["der", "die", "das", "ein", "eine", "einen", "einem", "einer", "eines", "dem", "den", "des"],
    fr: ["le", "la", "les", "un", "une", "l'", "d'"],
    es: ["el", "la", "los", "las", "un", "una", "unos", "unas"],
    it: ["il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "un'"]
  };

  let suggestion = null;
  let suggestType = "";

  // 1. Check articles first (higher priority)
  if (articles[lang]) {
    const langArticles = articles[lang];
    const spaceArticles = langArticles.filter(a => !a.endsWith("'"));
    const aposArticles = langArticles.filter(a => a.endsWith("'"));
    const wordEsc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Is the clicked word preceded by an article?
    let patternParts = [];
    if (spaceArticles.length > 0) patternParts.push(`(?:\\b(?:${spaceArticles.join("|")})\\s+${wordEsc}\\b)`);
    if (aposArticles.length > 0) patternParts.push(`(?:\\b(?:${aposArticles.join("|")})${wordEsc}\\b)`);

    if (patternParts.length > 0) {
      const regex = new RegExp(patternParts.join("|"), "i");
      const match = context.match(regex);
      if (match) {
        suggestion = match[0];
        suggestType = t("reader.smartSuggestArticle");
      }
    }

    // Is the clicked word the ARTICLE itself?
    if (!suggestion && langArticles.includes(word.toLowerCase())) {
      const isApos = word.endsWith("'");
      const spaceRegex = isApos ? "" : "\\s+";
      const nextWordRegex = new RegExp(`\\b${wordEsc}${spaceRegex}([\\p{L}\\p{M}\\-]+)\\b`, "iu");
      const match = context.match(nextWordRegex);
      if (match) {
        suggestion = match[0];
        suggestType = t("reader.smartSuggestArticle");
      }
    }
  }

  // 2. If not an article, check German separable prefixes
  if (!suggestion && lang === "de") {
    suggestion = checkGermanSeparableVerb(context, word);
    if (suggestion) {
      suggestType = t("reader.smartSuggestSeparableVerb");
    }
  }

  if (!suggestion) return "";

  const paramWord = suggestion.toLowerCase().replace(word.toLowerCase(), "").trim();
  const suggestText = t("reader.smartSuggest");
  const btnText = t("reader.smartSuggestBtn").replace("{word}", paramWord);
  return `
    <div style="margin-top: 0.75rem; background: color-mix(in srgb, var(--control-accent) 5%, transparent); padding: 0.5rem; border-radius: 6px; border: 1px dashed var(--control-accent); text-align: center;">
      <p style="font-size: 0.75rem; color: var(--control-accent); margin: 0 0 0.4rem 0; opacity: 0.9;">${escapeHtml(suggestText)}</p>
      <button class="primary-button button-xs" type="button" data-suggest-word="${escapeHtml(suggestion)}" style="font-size: 0.8rem; padding: 0.2rem 0.5rem; height: auto; min-height: 24px;">
        ${escapeHtml(btnText)} <strong style="margin-left: 0.2rem">${escapeHtml(suggestion)}</strong> <span class="shortcut-badge" style="margin-left: 0.4rem; font-size: 0.7rem;">5</span>
      </button>
    </div>
  `;
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
