import { getTextStats } from "./tokenizer_v2.js";
import type { TextStats, Vocabulary } from "./tokenizer_v2.js";

interface StatsWorkerRequest {
  id: string;
  text: string;
  lang: string;
  algorithm: string;
  vocab?: Vocabulary;
}

interface StatsWorkerResponse {
  id: string;
  stats: TextStats;
}

interface StatsWorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<StatsWorkerRequest>) => void): void;
  postMessage(message: StatsWorkerResponse): void;
}

const workerScope = self as unknown as StatsWorkerScope;
let vocab: Vocabulary = {};

workerScope.addEventListener("message", ({ data }) => {
  if (data.vocab) vocab = data.vocab;
  const { id, text, lang, algorithm } = data;
  workerScope.postMessage({ id, stats: getTextStats(text, vocab, lang, algorithm) });
});
