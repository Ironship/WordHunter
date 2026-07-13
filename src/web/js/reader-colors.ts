export const DEFAULT_LEARNING_COLORS = Object.freeze([
  "#ffb84d", "#f5cc4b", "#d4d84f", "#a8d35a", "#7cc96b"
]);

export interface LearningColorEntry {
  repetition?: number;
}

export interface LearningColorPreferences {
  dynamicLearningColors?: boolean;
  learningColors?: readonly unknown[];
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function normalizeLearningColors(colors?: readonly unknown[] | null): string[] {
  return DEFAULT_LEARNING_COLORS.map((fallback, index) => isColor(colors?.[index]) ? colors[index].toLowerCase() : fallback);
}

export function getSrsLevel(entry: LearningColorEntry | null | undefined): number {
  // ponytail: repetition is the shared SRS stage; a second stored level would drift.
  return Math.max(1, Math.min(5, Math.floor(Number(entry?.repetition) || 0) + 1));
}

export function getLearningColor(
  entry: LearningColorEntry | null | undefined,
  preferences: LearningColorPreferences | null | undefined
): string {
  if (preferences?.dynamicLearningColors !== true) return "";
  return normalizeLearningColors(preferences.learningColors)[getSrsLevel(entry) - 1];
}
