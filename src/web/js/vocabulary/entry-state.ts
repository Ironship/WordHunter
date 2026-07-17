import { scheduleFirstLearningReview } from "../sm2.js";

export function setEntryStatus(
  entry: WhVocabEntry,
  status: WhVocabStatus,
  updatedAt = new Date().toISOString()
): WhVocabStatus {
  const previousStatus = entry.status;
  entry.status = status;
  if (status === "learning" && previousStatus !== "learning") {
    entry.learningStartedAt = updatedAt;
    const learningStartedAt = new Date(updatedAt);
    scheduleFirstLearningReview(
      entry,
      Number.isNaN(learningStartedAt.getTime()) ? new Date() : learningStartedAt
    );
  }
  if (status === "known" && previousStatus !== "known") entry.knownAt = updatedAt;
  entry.updatedAt = updatedAt;
  return previousStatus;
}
