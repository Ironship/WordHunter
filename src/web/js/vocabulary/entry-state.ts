export function setEntryStatus(
  entry: WhVocabEntry,
  status: WhVocabStatus,
  updatedAt = new Date().toISOString()
): WhVocabStatus {
  const previousStatus = entry.status;
  entry.status = status;
  if (status === "known" && previousStatus !== "known") entry.knownAt = updatedAt;
  entry.updatedAt = updatedAt;
  return previousStatus;
}
