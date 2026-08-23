// Shared helpers for the split settings-events submodules (former monolithic
// events/settings.ts): element lookup plus the word-detection algorithm
// change generation counter shared by the data and review sections.
export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

let wordAlgorithmChangeGeneration = 0;

export function beginWordAlgorithmChange(): number {
  return ++wordAlgorithmChangeGeneration;
}

export function currentWordAlgorithmChangeGeneration(): number {
  return wordAlgorithmChangeGeneration;
}
