import { state } from "./state.js";
import { normalizeWord } from "./tokenizer_v2.js";
import { effectiveLearningLanguage } from "./translator-preferences.js";
import { keepReaderTokenVisible } from "./reader/visibility.js";
import { fetchWithTimeout } from "./request.js";

let speaking = false;
let currentAudio: HTMLAudioElement | null = null;
let currentEdgeTtsRequest: AbortController | null = null;
let currentAudioObjectUrl: string | null = null;
let currentEdgeWatchdog = 0;
let onFinishCallback: (() => void) | null = null;
let androidUtteranceSeq = 0;
let currentTtsWordToken: Element | null = null;
let ttsSessionId = 0;
let clearAndroidTtsListener: (() => void) | null = null;
let androidTtsBroken = false;
const MAX_TTS_SEGMENT_LENGTH = 500;
const TTS_WORD_CLASS = "tts-current-word";
const TTS_BACKGROUND_RESUME_WINDOW_MS = 60_000;
// While reading aloud, the highlighted word must never leave the viewport
// unnoticed (boundary events alone miss manual scrolls and layout shifts).
const TTS_VISIBILITY_WATCHDOG_MS = 800;
const TTS_RESYNC_LOOKAHEAD_RUNS = 3;
const TTS_RESYNC_WINDOW_TOKENS = 80;

let ttsVisibilityWatchdog = 0;

function startTtsVisibilityWatchdog(): void {
  if (ttsVisibilityWatchdog || typeof window.setInterval !== "function") return;
  ttsVisibilityWatchdog = window.setInterval(() => {
    if (!speaking || !currentTtsWordToken) return;
    keepReaderTokenVisible(currentTtsWordToken);
  }, TTS_VISIBILITY_WATCHDOG_MS);
}

function stopTtsVisibilityWatchdog(): void {
  if (!ttsVisibilityWatchdog) return;
  if (typeof window.clearInterval === "function") window.clearInterval(ttsVisibilityWatchdog);
  ttsVisibilityWatchdog = 0;
}

interface TtsPausedChain {
  sentences: string[];
  index: number;
  containerElement: HTMLElement | null | undefined;
  tracker: TtsWordTracker | null;
  onFinish: (() => void) | null;
  at: number;
}

let pausedChain: TtsPausedChain | null = null;

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

export interface SpeakTextOptions {
  startTokenIndex?: number;
}

type AndroidSpeakBridge = WhAndroidBridge & {
  speak: (text: string, language: string, rate: number, requestId: string) => boolean;
  isTtsReady?: () => boolean;
  endTtsSession?: () => void;
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

function getTtsRatePreset(rate: string): "slow" | "normal" | "fast" {
  if (rate === "slow" || rate === "fast") return rate;
  return "normal";
}

function edgeTtsUrl(text: string, lang: string): string {
  const rate = getTtsRatePreset(state.preferences.ttsRate || "normal");
  return `/__tts?text=${encodeURIComponent(text)}&lang=${lang}&rate=${rate}`;
}

function getAndroidTtsBridge(): AndroidSpeakBridge | null {
  const bridge = window.WordHunterAndroid;
  return bridge && typeof bridge.speak === "function" ? bridge as AndroidSpeakBridge : null;
}

function isAndroidTtsReady(): boolean {
  const bridge = getAndroidTtsBridge();
  if (!bridge) return false;
  if (typeof bridge.isTtsReady !== "function") return true;
  try {
    return bridge.isTtsReady() === true;
  } catch {
    return false;
  }
}

function waitForAndroidTtsReady(maxMs = 1500): Promise<boolean> {
  if (!getAndroidTtsBridge()) return Promise.resolve(false);
  if (isAndroidTtsReady()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = window.setInterval(() => {
      if (isAndroidTtsReady() || Date.now() - start >= maxMs) {
        window.clearInterval(timer);
        resolve(isAndroidTtsReady());
      }
    }, 100);
  });
}

function endAndroidTtsSession(): void {
  const bridge = getAndroidTtsBridge();
  if (bridge && typeof bridge.endTtsSession === "function") {
    try {
      bridge.endTtsSession();
    } catch {
      // Ignore a failing native session end; the bridge may already be gone.
    }
  }
}

function speakSentenceAndroid(
  sentence: string,
  onEnd?: (status: string) => void,
  tracker?: TtsWordTracker | null
): boolean {
  const bridge = getAndroidTtsBridge();
  if (!bridge) return false;
  const sessionId = ttsSessionId;
  const id = `wh-tts-${Date.now()}-${++androidUtteranceSeq}`;
  beginTtsSentenceHighlight(tracker, sentence);
  clearAndroidTtsListener?.();
  let timeout = 0;
  const cleanup = () => {
    window.removeEventListener("wordhunter:android-tts", finish);
    clearTimeout(timeout);
    if (clearAndroidTtsListener === cleanup) clearAndroidTtsListener = null;
  };
  const finish = (event: Event) => {
    const detail = isRecord((event as CustomEvent<unknown>).detail)
      ? (event as CustomEvent<Record<string, unknown>>).detail
      : null;
    if (!detail) return;
    if (detail.id !== id) return;
    if (sessionId !== ttsSessionId) {
      cleanup();
      return;
    }
    if (detail.status === "range") {
      highlightTtsBoundary(tracker, Number(detail.start) || 0);
      return;
    }
    cleanup();
    if (onEnd) onEnd(typeof detail.status === "string" ? detail.status : "done");
  };
  window.addEventListener("wordhunter:android-tts", finish);
  clearAndroidTtsListener = cleanup;
  const rate = getTtsRate(state.preferences.ttsRate || "normal");
  const estimateMs = Math.ceil((sentence.length / Math.max(0.5, rate)) * 80) + 10_000;
  timeout = setTimeout(() => {
    cleanup();
    if (sessionId === ttsSessionId && onEnd) onEnd("timeout");
  }, Math.max(20_000, Math.min(180_000, estimateMs)));
  const ok = bridge.speak(
    sentence,
    getTtsLang(activeTtsLanguage()),
    rate,
    id
  );
  if (!ok) cleanup();
  return ok;
}

export function isSpeaking(): boolean {
  return speaking;
}

export async function speakWord(word: string): Promise<void> {
  stopSpeaking();
  const sessionId = ttsSessionId;
  if (!androidTtsBroken && getAndroidTtsBridge()) {
    const ready = await waitForAndroidTtsReady();
    if (sessionId !== ttsSessionId) return;
    if (ready && speakSentenceAndroid(word, () => endAndroidTtsSession())) return;
    androidTtsBroken = true;
    speakWordLocal(word);
    return;
  }
  if (state.preferences.useEdgeTts === true && !window.WordHunterAndroid) {
    const lang = activeTtsLanguage();
    const url = edgeTtsUrl(word, lang);
    const request = new AbortController();
    currentEdgeTtsRequest = request;
    void fetchWithTimeout(url, { signal: request.signal }, 15_000)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Edge TTS returned HTTP ${response.status}`);
        const audioBlob = await response.blob();
        if (sessionId !== ttsSessionId || currentEdgeTtsRequest !== request) return;
        currentEdgeTtsRequest = null;
        const objectUrl = URL.createObjectURL(audioBlob);
        currentAudioObjectUrl = objectUrl;
        const audio = new Audio(objectUrl);
        currentAudio = audio;
        let settled = false;
        const cleanup = () => {
          if (settled) return false;
          settled = true;
          if (currentAudio === audio) currentAudio = null;
          releaseAudioObjectUrl(objectUrl);
          return true;
        };
        audio.onended = cleanup;
        audio.onerror = () => {
          if (cleanup() && sessionId === ttsSessionId) speakWordLocal(word);
        };
        return audio.play().catch((error: unknown) => {
          if (cleanup() && sessionId === ttsSessionId && errorName(error) !== "AbortError") speakWordLocal(word);
        });
      })
      .catch((error: unknown) => {
        if (currentEdgeTtsRequest === request) currentEdgeTtsRequest = null;
        if (sessionId === ttsSessionId && errorName(error) !== "AbortError") speakWordLocal(word);
      });
  } else {
    speakWordLocal(word);
  }
}

function speakWordLocal(word: string): void {
  if (!window.speechSynthesis) {
    void import("./toast.js").then((m) => {
      void import("./i18n.js").then((i) => m.showToast(i.t("toast.ttsMissing"), "error"));
    });
    return;
  }
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
  utterance.onerror = (event) => {
    console.warn("TTS utterance failed", event.error);
    import("./toast.js").then(m => {
      import("./i18n.js").then(i => {
        m.showToast(i.t("toast.ttsMissing"), "error");
      });
    });
  };
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  ttsSessionId += 1;
  speaking = false;
  androidTtsBroken = false;
  clearAndroidTtsListener?.();
  const androidBridge = getAndroidTtsBridge();
  if (androidBridge && typeof androidBridge.stopTts === "function") {
    androidBridge.stopTts();
  }
  clearCurrentEdgeAudio();
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  clearHighlights();
  endAndroidTtsSession();
  stopTtsVisibilityWatchdog();
  if (onFinishCallback) {
    onFinishCallback();
    onFinishCallback = null;
  }
}

export async function speakText(
  text: string,
  containerElement?: HTMLElement | null,
  onFinish?: (() => void) | null,
  options: SpeakTextOptions = {}
): Promise<void> {
  stopSpeaking();
  onFinishCallback = onFinish;

  const selectedText = getSelectedTextInContainer(containerElement);
  const textToRead = selectedText || text;

  const sentences = splitTextForTts(textToRead);
  const tracker = createTtsWordTracker(
    containerElement,
    textToRead,
    selectedText ? undefined : options.startTokenIndex
  );
  
  speaking = true;
  if (tracker) startTtsVisibilityWatchdog();

  if (!androidTtsBroken && getAndroidTtsBridge()) {
    const ready = await waitForAndroidTtsReady();
    if (!speaking) return;
    if (ready) {
      rememberAndroidChain(sentences, 0, containerElement, tracker, onFinish);
      readNextSentenceAndroid(sentences, 0, containerElement, tracker);
      return;
    }
    androidTtsBroken = true;
  }
  if (state.preferences.useEdgeTts === true && !window.WordHunterAndroid) {
    readNextSentenceEdge(sentences, 0, containerElement, tracker);
  } else {
    readNextSentenceLocal(sentences, 0, containerElement, tracker);
  }
}

window.addEventListener?.("wordhunter:android-tts-stop", () => {
  if (speaking) stopSpeaking();
});

function rememberAndroidChain(
  sentences: string[],
  index: number,
  containerElement: HTMLElement | null | undefined,
  tracker: TtsWordTracker | null,
  onFinish: (() => void) | null
): void {
  pausedChain = {
    sentences,
    index,
    containerElement: containerElement || null,
    tracker,
    onFinish,
    at: Date.now()
  };
}

if (typeof document !== "undefined") {
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (speaking && getAndroidTtsBridge()) {
        const chain = pausedChain;
        if (chain) chain.at = Date.now();
        stopSpeaking();
      }
      return;
    }
    const chain = pausedChain;
    if (!chain) return;
    pausedChain = null;
    if (Date.now() - chain.at > TTS_BACKGROUND_RESUME_WINDOW_MS) return;
    if (chain.index >= chain.sentences.length) return;
    const container = chain.containerElement && document.body?.contains(chain.containerElement)
      ? chain.containerElement
      : null;
    if (!container && chain.index > 0) return;
    onFinishCallback = chain.onFinish;
    speaking = true;
    if (chain.tracker) startTtsVisibilityWatchdog();
    readNextSentenceAndroid(chain.sentences, chain.index, container, chain.tracker);
  });
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
  const sessionId = ttsSessionId;
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
  const url = edgeTtsUrl(sentence, lang);
  beginTtsSentenceHighlight(tracker, sentence);

  const request = new AbortController();
  currentEdgeTtsRequest = request;
  void fetchWithTimeout(url, { signal: request.signal }, 15_000)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Edge TTS returned HTTP ${response.status}`);
      const timings = parseEdgeWordTimings(response.headers.get("X-WH-Word-Timings"));
      const audio = await response.blob();
      if (!speaking || sessionId !== ttsSessionId || currentEdgeTtsRequest !== request) return;
      currentEdgeTtsRequest = null;
      const objectUrl = URL.createObjectURL(audio);
      currentAudioObjectUrl = objectUrl;
      playEdgeTtsAudio(objectUrl, objectUrl, timings, sentences, index, sentence, containerElement, tracker);
    })
    .catch((err: unknown) => {
      if (currentEdgeTtsRequest === request) currentEdgeTtsRequest = null;
      if (!speaking || sessionId !== ttsSessionId || errorName(err) === "AbortError") return;
      console.warn("Edge TTS load failed", err);
      speakSentenceLocal(sentence, () => {
        if (speaking && sessionId === ttsSessionId) readNextSentenceEdge(sentences, index + 1, containerElement, tracker);
      }, tracker);
    });
}

function playEdgeTtsAudio(
  source: string,
  objectUrl: string | null,
  wordTimings: number[],
  sentences: string[],
  index: number,
  sentence: string,
  containerElement: HTMLElement | null | undefined,
  tracker: TtsWordTracker | null
): void {
  const sessionId = ttsSessionId;
  const audio = new Audio(source);
  currentAudio = audio;
  let settled = false;
  let highlightedIndex = -1;
  const updateWordHighlight = () => {
    if (!speaking || sessionId !== ttsSessionId || currentAudio !== audio) return;
    const elapsedMs = audio.currentTime * 1000;
    while (highlightedIndex + 1 < wordTimings.length
      && wordTimings[highlightedIndex + 1] <= elapsedMs) {
      highlightedIndex++;
      const run = tracker?.sentenceRuns[highlightedIndex];
      if (run) highlightNextTtsWord(tracker, run.word);
    }
  };

  audio.onplay = () => {
    if (!speaking || sessionId !== ttsSessionId || currentAudio !== audio) return;
    highlightContainer(containerElement);
    updateWordHighlight();
  };
  audio.ontimeupdate = updateWordHighlight;
  audio.onended = () => {
    if (settled) return;
    settled = true;
    clearTimeout(currentEdgeWatchdog);
    currentEdgeWatchdog = 0;
    if (currentAudio === audio) currentAudio = null;
    releaseAudioObjectUrl(objectUrl);
    if (speaking && sessionId === ttsSessionId) readNextSentenceEdge(sentences, index + 1, containerElement, tracker);
  };
  const watchdog = setTimeout(() => {
    if (settled) return;
    settled = true;
    currentEdgeWatchdog = 0;
    if (currentAudio === audio) currentAudio = null;
    releaseAudioObjectUrl(objectUrl);
    console.warn("Edge TTS playback watchdog fired; falling back to local speech");
    if (!speaking || sessionId !== ttsSessionId) return;
    speakSentenceLocal(sentence, () => {
      if (speaking && sessionId === ttsSessionId) readNextSentenceEdge(sentences, index + 1, containerElement, tracker);
    }, tracker);
  }, sentence.length * 120 + 15_000);
  currentEdgeWatchdog = watchdog;
  const fallback = (err: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(currentEdgeWatchdog);
    currentEdgeWatchdog = 0;
    if (currentAudio === audio) currentAudio = null;
    releaseAudioObjectUrl(objectUrl);
    console.warn("Edge TTS play failed", err);
    if (!speaking || sessionId !== ttsSessionId || errorName(err) === "AbortError") return;
    speakSentenceLocal(sentence, () => {
      if (speaking && sessionId === ttsSessionId) readNextSentenceEdge(sentences, index + 1, containerElement, tracker);
    }, tracker);
  };
  audio.onerror = () => fallback(new Error("Edge TTS audio playback failed"));
  audio.play().catch(fallback);
}

function parseEdgeWordTimings(value: string | null): number[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((timing) => Number(timing.trim()))
    .filter((timing) => Number.isFinite(timing) && timing >= 0);
}

function clearCurrentEdgeAudio(): void {
  currentEdgeTtsRequest?.abort();
  currentEdgeTtsRequest = null;
  clearTimeout(currentEdgeWatchdog);
  currentEdgeWatchdog = 0;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  releaseAudioObjectUrl(currentAudioObjectUrl);
}

function releaseAudioObjectUrl(objectUrl: string | null): void {
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  if (currentAudioObjectUrl === objectUrl) currentAudioObjectUrl = null;
}

function finishAndroidTtsChain(status: string): void {
  console.warn("Android TTS chain stopped unexpectedly", status);
  stopSpeaking();
  if (status === "error" || status === "timeout") {
    void import("./toast.js").then((m) => {
      void import("./i18n.js").then((i) => m.showToast(i.t("toast.ttsInterrupted"), "error"));
    });
  }
}

function readNextSentenceAndroid(
  sentences: string[],
  index: number,
  containerElement: HTMLElement | null | undefined,
  tracker: TtsWordTracker | null
): void {
  const sessionId = ttsSessionId;
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
  const started = speakSentenceAndroid(sentence, (status) => {
    if (!speaking || sessionId !== ttsSessionId) return;
    if (status === "done") {
      if (pausedChain) pausedChain.index = index + 1;
      readNextSentenceAndroid(sentences, index + 1, containerElement, tracker);
    } else {
      finishAndroidTtsChain(status);
    }
  }, tracker);
  if (!started) {
    if (!window.speechSynthesis) {
      finishAndroidTtsChain("error");
      return;
    }
    androidTtsBroken = true;
    speakSentenceLocal(sentence, () => {
      if (speaking && sessionId === ttsSessionId) readNextSentenceAndroid(sentences, index + 1, containerElement, tracker);
    }, tracker);
  }
}

function readNextSentenceLocal(
  sentences: string[],
  index: number,
  containerElement: HTMLElement | null | undefined,
  tracker: TtsWordTracker | null
): void {
  const sessionId = ttsSessionId;
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
    if (!speaking || sessionId !== ttsSessionId) return;
    highlightContainer(containerElement);
  };

  utterance.onboundary = (event) => {
    if (!speaking || sessionId !== ttsSessionId) return;
    if (event.name && event.name !== "word") return;
    highlightTtsBoundary(tracker, Number(event.charIndex) || 0);
  };
  
  utterance.onend = () => {
    if (speaking && sessionId === ttsSessionId) {
      readNextSentenceLocal(sentences, index + 1, containerElement, tracker);
    }
  };
  
  utterance.onerror = (e) => {
    if (!speaking || sessionId !== ttsSessionId) return;
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
  if (typeof document.querySelectorAll !== "function") {
    currentTtsWordToken = null;
    return;
  }
  document.querySelectorAll('.reading-active').forEach(el => el.classList.remove('reading-active'));
  document.querySelectorAll(`.${TTS_WORD_CLASS}`).forEach(el => el.classList.remove(TTS_WORD_CLASS));
  currentTtsWordToken = null;
}

function createTtsWordTracker(
  containerElement: HTMLElement | null | undefined,
  textToRead: string,
  startTokenIndex?: number
): TtsWordTracker | null {
  if (state.preferences.ttsWordHighlight !== true || !containerElement?.querySelectorAll) return null;
  const tokens = [...containerElement.querySelectorAll<HTMLElement>(".word-token")]
    .map((element) => ({ element, word: normalizeWord(element.textContent || element.dataset.word || "") }))
    .filter((token) => token.word);
  if (!tokens.length) return null;

  const exactStart = Number.isInteger(startTokenIndex)
    && Number(startTokenIndex) >= 0
    && Number(startTokenIndex) < tokens.length
    ? Number(startTokenIndex)
    : null;

  return {
    tokens,
    tokenIndex: exactStart ?? findTtsTokenStart(tokens, getTtsWordRuns(textToRead).map((run) => run.word)),
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
  resyncTtsHighlight(tracker);
}

// A spoken word can fail to match any DOM token (numbers, abbreviations,
// tokenizer drift). Without recovery the highlight freezes somewhere
// off-screen while the audio keeps going and nothing scrolls anymore.
// Look ahead at the upcoming words of the current sentence and jump to the
// first token matching one of them so tracking resumes.
function resyncTtsHighlight(tracker: TtsWordTracker): void {
  const upcoming: string[] = [];
  for (const run of tracker.sentenceRuns) {
    const normalized = normalizeWord(run.word);
    if (normalized && !upcoming.includes(normalized)) upcoming.push(normalized);
    if (upcoming.length >= TTS_RESYNC_LOOKAHEAD_RUNS) break;
  }
  if (!upcoming.length) return;
  const windowEnd = Math.min(tracker.tokens.length, tracker.tokenIndex + TTS_RESYNC_WINDOW_TOKENS);
  for (let index = tracker.tokenIndex + 1; index < windowEnd; index++) {
    if (!upcoming.includes(tracker.tokens[index].word)) continue;
    setCurrentTtsWordToken(tracker.tokens[index].element);
    tracker.tokenIndex = index + 1;
    return;
  }
}

function setCurrentTtsWordToken(token: Element): void {
  if (currentTtsWordToken === token) return;
  if (currentTtsWordToken) currentTtsWordToken.classList.remove(TTS_WORD_CLASS);
  currentTtsWordToken = token;
  if (currentTtsWordToken) {
    currentTtsWordToken.classList.add(TTS_WORD_CLASS);
    keepReaderTokenVisible(currentTtsWordToken);
  }
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
