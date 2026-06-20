export const VOCAB_STATUS_FILTERS = ["new", "learning", "known", "ignored"];

export function legacyVocabStatusFromSelected(statuses) {
  if (statuses.length === VOCAB_STATUS_FILTERS.length) return "all";
  if (statuses.length === 3 && !statuses.includes("ignored")) return "not_ignored";
  if (statuses.length === 1) return statuses[0];
  return "custom";
}
