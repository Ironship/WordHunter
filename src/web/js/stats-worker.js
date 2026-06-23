import { getTextStats } from "./tokenizer_v2.js";

let vocab = {};

self.addEventListener("message", ({ data }) => {
  if (data.vocab) vocab = data.vocab;
  const { id, text, lang, algorithm } = data;
  self.postMessage({ id, stats: getTextStats(text, vocab, lang, algorithm) });
});
