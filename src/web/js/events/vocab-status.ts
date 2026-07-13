type VocabStatusFilterList = WhVocabStatus[] & {
  includes(status: string, fromIndex?: number): boolean;
};

export const VOCAB_STATUS_FILTERS = ["new", "learning", "known", "ignored"] as VocabStatusFilterList;

export function isVocabStatus(status: string): status is WhVocabStatus {
  return VOCAB_STATUS_FILTERS.includes(status);
}
