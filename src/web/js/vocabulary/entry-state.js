export function setEntryStatus(entry, status, updatedAt = new Date().toISOString()) {
  const previousStatus = entry.status;
  entry.status = status;
  if (status === "known" && previousStatus !== "known") entry.knownAt = updatedAt;
  entry.updatedAt = updatedAt;
  return previousStatus;
}
