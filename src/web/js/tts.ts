import { state } from "./state.js";
import { normalizeWord } from "./tokenizer_v2.js";
import { effectiveLearningLanguage } from "./translator-preferences.js";

let speaking = false;
let currentAudio: HTMLAudioElement | null = null;
let onFinishCallback: (() => void) | null = null;
let androidUtteranceSeq = 0;
let currentTtsWordToken: Element | null = null;
const MAX_TTS_SEGMENT_LENGTH = 500;
const TTS_WORD_CLASS = "tts-current-word";

interface TtsWordRun {
  word: string;
  start: number;
  end: number;
}

interface TtsWordTracker {
  tokens: Array<{ element: Element; word: string }>;
  tokenIndex: number;
  sentenceRuns: TtsWordRun[];
}

type AndroidSpeakBridge = WhAndroidBridge & {
  speak: (text: string, language: string, rate: number, requestId: string) => boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorName(value: unknown): string {
  if (value instanceof Error) return value.name;
  return isRecord(value) && typeof value.name === "string" ? value.name : "";
}

function getTtsLang(lang: string | null | undefined): string {
  const map: Readonly<Record<string, string>> = { en: "en-US", de: "de-DE", es: "es-ES", fr: "fr-FR", it: "it-IT", pl: "pl-PL", uk: "uk-UA", ru: "ru-RU", ja: "ja-JP", zh: "zh-CN", la: "la", grc: "el-GR" };
  return map[lang] || lang || "en-US";
}

function activeTtsLanguage(): string {
  return effectiveLearningLanguage(state.preferences);
}

function getTtsRate(rate: string): number {
  if (rate === "slow") return 0.75;
  if (rate === "fast") return 1.25;
  return 1.0;
}

function getAndroidTtsBridge(): AndroidSpeakBridge | null {
  const bridge = window.WordHunterAndroid;
  return bridge && typeof bridge.speak === "function" ? bridge as AndroidSpeakBridge : null;
}

function speakSentenceAndroid(
  sentence: string,
  onEnd?: (status: string) => void,
  tracker?: TtsWordTracker | null
): boolean {
  const bridge = getAndroidTtsBridge();
  if (!bridge) return false;
  const id = `wh-tts-${Date.now()}-${++androidUtteranceSeq}`;
  beginTtsSentenceHighlight(tracker, sentence);
  const finish = (event: Event) => {
    const detail = isRecord((event as CustomEvent<unknown>).detail)
      ? (event as CustomEvent<Record<string, unknown>>).detail
      : null;
    if (!detail) return;
    if (detail.id !== id) return;
    if (detail.status === "range") {
      highlightTtsBoundary(tracker, Number(detail.start) || 0);
      return;
    }
    window.removeEventListener("wordhunter:android-tts", finish);
    if (onEnd) onEnd(typeof detail.status === "string" ? detail.status : "done");
  };
  window.addEventListener("wordhunter:android-tts", finish);
  const ok = bridge.speak(
    sentence,
    getTtsLang(activeTtsLanguage()),
    getTtsRate(state.preferences.ttsRate || "normal"),
    id
  );
  if (!ok) window.removeEventListener("wordhunter:android-tts", finish);
  return ok;
}

export function speakWord(word: string): void {
  if (speakSentenceAndroid(word)) return;

  if (state.preferences.useEdgeTts === true) {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    
    const lang = activeTtsLanguage();
    const url = `/__tts?text=${encodeURIComponent(word)}&lang=${lang}`;
    
    currentAudio = new Audio(url);
    currentAudio.playbackRate = getTtsRate(state.preferences.ttsRate || "normal");
    
    currentAudio.play().catch((err: unknown) => {
      console.warn("Edge TTS audio play failed", err);
      // Only fall back to local if it was a real load failure and not an intentional abort/pause
      if (errorName(err) !== "AbortError") {
        speakWordLocal(word);
      }
    });
  } else {
    speakWordLocal(word);
  }
}

function speakWordLocal(word: string): void {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  
  const lang = activeTtsLanguage();
  const ttsLang = getTtsLang(lang);
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
    const hasVoice = voices.some(v => v.lang.toLowerCase().startsWith(ttsLang.split('-')[0].toLowerCase()));
    if (!hasVoice) {
      import("./toast.js").then(m => {
        import("./i18n.js").then(i => {
          m.showToast(i.t("toast.ttsMissing"));
        });
      });
    }
  }

  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = getTtsLang(activeTtsLanguage());
  utterance.rate = getTtsRate(state.preferences.ttsRate || "normal");
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  speaking = false;
  const androidBridge = getAndroidTtsBridge();
  if (androidBridge && typeof androidBridge.stopTts === "function") {
    androidBridge.stopTts();
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  clearHighlights();
  if (onFinishCallback) {
    onFinishCallback();
    onFinishCallback = null;
  }
}

export function speakText(
  text: string,
  containerElement?: HTMLElement | null,
  onFinish?: (() => void) | null
): void {
  stopSpeaking();
  onFinishCallback = onFinish;

  const selectedText = getSelectedTextInContainer(containerElement);
  const textToRead = selectedText || text;

  const sentences = splitTextForTts(textToRead);
  const tracker = createTtsWordTracker(containerElement, textToRead);
  
  speaking = true;

  if (getAndroidTtsBridge()) {
    readNextSentenceAndroid(sentences, 0, containerElement, tracker);
  } else if (state.preferences.useEdgeTts === true) {
    readNextSentenceEdge(sentences, 0, containerElement, tracker);
  } else {
    readNextSentenceLocal(sentences, 0, containerElement, tracker);
  }
}

function splitTextForTts(text: string): string[] {
  const normalized = normalizeTextForTts(text);
  if (!normalized) return [];

  const sentences = normalized.match(/[^.!?。！？]+[.!?。！？]+(?:["')\]]+)?|[^.!?。！？]+$/gu) || [normalized];
  return sentences.flatMap(splitLongTtsSegment).map((sentence) => sentence.trim()).filter(Boolean);
}

function normalizeTextForTts(text: string): string {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\p{L})-\n(?=\p{L})/gu, "$1")
    .replace(/[ \t]*\n+[ \t]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitLongTtsSegment(segment: string): string[] {
  const text = String(segment || "").trim();
  if (!text) return [];
  if (text.length <= MAX_TTS_SEGMENT_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_TTS_SEGMENT_LENGTH) {
    let cut = remaining.lastIndexOf(" ", MAX_TTS_SEGMENT_LENGTH);
    if (cut < Math.floor(MAX_TTS_SEGMENT_LENGTH / 2)) cut = MAX_TTS_SEGMENT_LENGTH;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function getSelectedTextInContainer(containerElement?: HTMLElement | null): string {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) return "";
  const text = selection.toString().trim();
  if (!text) return "";
  if (!containerElement || !selection.rangeCount) return text;

  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    const node = range.commonAncestorContainer;
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (element && containerElement.contains(element)) return text;
  }
  return "";
}

function readNextSentenceEdge(
  sentences: string[],
  index: number,
  containerElement: HTMLElement | null | undefined,
  tracker: TtsWordTracker | null
): void {
  if (!speaking || index >= sentences.length) {
    stopSpeaking();
    return;
  }

  const sentence = sentences[index].trim();
  if (!sentence) {
    readNextSentenceEdge(sentences, index + 1, containerElement, tracker);
    return;
  }

  const lang = activeTtsLanguage();
  const url = `/__tts?text=${encodeURIComponent(sentence)}&lang=${lang}`;
  
  currentAudio = new Audio(url);
  currentAudio.playbackRate = getTtsRate(state.preferences.ttsRate || "normal");
  
  currentAudio.onplay = () => {
    highlightContainer(containerElement);
  };
  
  currentAudio.onended = () => {
    if (speaking) {
      readNextSentenceEdge(sentences, index + 1, containerElement, tracker);
    }
  };
  
  currentAudio.play().catch((err: unknown) => {
    console.warn("Edge TTS play failed", err);
    if (!speaking) return; // Stopped or changed intentionally
    
    if (errorName(err) !== "AbortError") {
      speakSentenceLocal(sentence, () => {
        if (speaking) {
          readNextSentenceEdge(sentences, index + 1, containerElement, tracker);
        }
      }, tracker);
    }
  });
}

function readNextSentenceAndroid(
  sentences: string[],
  index: number,
  containerElement: HTMLElement | null | undefined,
  tracker: TtsWordTracker | null
): void {
  if (!speaking || index >= sentences.length) {
    stopSpeaking();
    return;
  }

  const sentence = sentences[index].trim();
  if (!sentence) {
    readNextSentenceAndroid(sentences, index + 1, containerElement, tracker);
    return;
  }

  highlightContainer(containerElement);
  const started = speakSentenceAndroid(sentence, () => {
    if (speaking) readNextSentenceAndroid(sentences, index + 1, containerElement, tracker);
  }, tracker);
  if (!started) {
    speakSentenceLocal(sentence, () => {
      if (speaking) readNextSentenceAndroid(sentences, index + 1, containerElement, tracker);
    }, tracker);
  }
}

function readNextSentenceLocal(
  sentences: string[],
  index: number,
  containerElement: HTMLElement | null | undefined,
  tracker: TtsWordTracker | null
): void {
  if (!speaking || index >= sentences.length) {
    stopSpeaking();
    return;
  }

  const sentence = sentences[index].trim();
  if (!sentence) {
    readNextSentenceLocal(sentences, index + 1, containerElement, tracker);
    return;
  }

  const lang = activeTtsLanguage();
  const ttsLang = getTtsLang(lang);
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
    const hasVoice = voices.some(v => v.lang.toLowerCase().startsWith(ttsLang.split('-')[0].toLowerCase()));
    if (!hasVoice) {
      import("./toast.js").then(m => {
        import("./i18n.js").then(i => {
          m.showToast(i.t("toast.ttsMissing"));
        });
      });
    }
  }

  const utterance = new SpeechSynthesisUtterance(sentence);
  utterance.lang = getTtsLang(activeTtsLanguage());
  utterance.rate = getTtsRate(state.preferences.ttsRate || "normal");
  beginTtsSentenceHighlight(tracker, sentence);
  
  utterance.onstart = () => {
    highlightContainer(containerElement);
  };

  utterance.onboundary = (event) => {
    if (event.name && event.name !== "word") return;
    highlightTtsBoundary(tracker, Number(event.charIndex) || 0);
  };
  
  utterance.onend = () => {
    if (speaking) {
      readNextSentenceLocal(sentences, index + 1, containerElement, tracker);
    }
  };
  
  utterance.onerror = (e) => {
    console.warn("TTS Error", e);
    stopSpeaking();
  };

  window.speechSynthesis.speak(utterance);
}

function speakSentenceLocal(
  sentence: string,
  onEnd?: (() => void) | null,
  tracker?: TtsWordTracker | null
): void {
  if (!window.speechSynthesis) {
    if (onEnd) onEnd();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(sentence);
  utterance.lang = getTtsLang(activeTtsLanguage());
  utterance.rate = getTtsRate(state.preferences.ttsRate || "normal");
  beginTtsSentenceHighlight(tracker, sentence);
  utterance.onboundary = (event) => {
    if (event.name && event.name !== "word") return;
    highlightTtsBoundary(tracker, Number(event.charIndex) || 0);
  };
  utterance.onend = () => {
    if (onEnd) onEnd();
  };
  utterance.onerror = () => {
    if (onEnd) onEnd();
  };
  window.speechSynthesis.speak(utterance);
}

function highlightContainer(containerElement: HTMLElement | null | undefined): void {
  if (!containerElement) return;
  containerElement.classList.add('reading-active');
}

function clearHighlights(): void {
  document.querySelectorAll('.reading-active').forEach(el => el.classList.remove('reading-active'));
  document.querySelectorAll(`.${TTS_WORD_CLASS}`).forEach(el => el.classList.remove(TTS_WORD_CLASS));
  currentTtsWordToken = null;
}

function createTtsWordTracker(
  containerElement: HTMLElement | null | undefined,
  textToRead: string
): TtsWordTracker | null {
  if (state.preferences.ttsWordHighlight !== true || !containerElement?.querySelectorAll) return null;
  const tokens = [...containerElement.querySelectorAll<HTMLElement>(".word-token")]
    .map((element) => ({ element, word: normalizeWord(element.textContent || element.dataset.word || "") }))
    .filter((token) => token.word);
  if (!tokens.length) return null;

  return {
    tokens,
    tokenIndex: findTtsTokenStart(tokens, getTtsWordRuns(textToRead).map((run) => run.word)),
    sentenceRuns: []
  };
}

function beginTtsSentenceHighlight(tracker: TtsWordTracker | null | undefined, sentence: string): void {
  if (!tracker) return;
  tracker.sentenceRuns = getTtsWordRuns(sentence);
}

function highlightTtsBoundary(tracker: TtsWordTracker | null | undefined, charIndex: number): void {
  if (!tracker?.sentenceRuns?.length) return;
  const run = tracker.sentenceRuns.find((item) => charIndex >= item.start && charIndex < item.end)
    || [...tracker.sentenceRuns].reverse().find((item) => charIndex >= item.start);
  if (!run) return;
  highlightNextTtsWord(tracker, run.word);
}

function highlightNextTtsWord(tracker: TtsWordTracker, word: string): void {
  const target = normalizeWord(word);
  if (!target) return;
  for (let index = tracker.tokenIndex; index < tracker.tokens.length; index++) {
    if (tracker.tokens[index].word !== target) continue;
    setCurrentTtsWordToken(tracker.tokens[index].element);
    tracker.tokenIndex = index + 1;
    return;
  }
}

function setCurrentTtsWordToken(token: Element): void {
  if (currentTtsWordToken === token) return;
  if (currentTtsWordToken) currentTtsWordToken.classList.remove(TTS_WORD_CLASS);
  currentTtsWordToken = token;
  if (currentTtsWordToken) currentTtsWordToken.classList.add(TTS_WORD_CLASS);
}

function findTtsTokenStart(tokens: TtsWordTracker["tokens"], words: string[]): number {
  const target = words.filter(Boolean).slice(0, 6);
  if (!target.length) return 0;
  for (let start = 0; start < tokens.length; start++) {
    let matched = 0;
    while (matched < target.length && tokens[start + matched]?.word === target[matched]) matched++;
    if (matched === target.length) return start;
  }
  return 0;
}

function getTtsWordRuns(text: string): TtsWordRun[] {
  const value = String(text || "");
  const runs: TtsWordRun[] = [];
  const pattern = /[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu;
  let match = pattern.exec(value);
  while (match) {
    const word = normalizeWord(match[0]);
    if (word) runs.push({ word, start: match.index, end: match.index + match[0].length });
    match = pattern.exec(value);
  }
  return runs;
}
