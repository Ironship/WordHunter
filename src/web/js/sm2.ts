// SM-2 spaced repetition algorithm (SuperMemo 2). Pure logic, no side effects.
// See: https://en.wikipedia.org/wiki/SuperMemo#Description_of_SM-2_algorithm

export type SrsAlgorithm = "sm2" | "fsrs";
type FsrsRating = "again" | "hard" | "good" | "easy";

export interface SrsEntry {
  status?: string;
  addedAt?: string;
  updatedAt?: string;
  learningStartedAt?: string;
  repetition?: number;
  interval?: number;
  efactor?: number;
  stability?: number;
  difficulty?: number;
  nextDate?: string;
  lastReviewedAt?: string;
  srsAlgorithm?: SrsAlgorithm;
}

export interface ReviewSchedule {
  repetition: number;
  interval: number;
  efactor?: number;
  stability?: number;
  difficulty?: number;
  nextDate?: string;
  lastReviewedAt?: string;
  srsAlgorithm?: SrsAlgorithm;
}

export const SM2_DEFAULTS = Object.freeze({
  interval: 0,
  repetition: 0,
  efactor: 2.5
});

export const FSRS_DEFAULTS = Object.freeze({
  stability: 0,
  difficulty: 5,
  desiredRetention: 0.9
});

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeQuality(quality: unknown): number {
  return Math.max(0, Math.min(5, Math.round(Number(quality) || 0)));
}

function fsrsRating(quality: unknown): FsrsRating {
  const q = normalizeQuality(quality);
  if (q < 3) return "again";
  if (q === 3) return "hard";
  if (q === 4) return "good";
  return "easy";
}

function elapsedDaysSince(dateISO: string | null | undefined, now: Date): number {
  if (!dateISO) return 0;
  const then = new Date(dateISO);
  if (Number.isNaN(then.getTime())) return 0;
  return Math.max(0, Math.round((now.getTime() - then.getTime()) / 86400000));
}

/**
 * Calculates new SM-2 parameters.
 * @param {number} quality 0..5 (0 = no memory, 5 = perfect recall)
 * @param {{repetition:number, interval:number, efactor:number}} prev
 * @returns {{repetition:number, interval:number, efactor:number}}
 */
function calculateSM2(quality: unknown, prev: SrsEntry): ReviewSchedule {
  const q = normalizeQuality(quality);
  const repetition = Number.isFinite(prev?.repetition) ? prev.repetition : SM2_DEFAULTS.repetition;
  const interval = Number.isFinite(prev?.interval) ? prev.interval : SM2_DEFAULTS.interval;
  const efactor = Number.isFinite(prev?.efactor) ? prev.efactor : SM2_DEFAULTS.efactor;

  let nextInterval;
  let nextRepetition;
  if (q >= 3) {
    if (repetition === 0) nextInterval = 1;
    else if (repetition === 1) nextInterval = 6;
    else nextInterval = Math.round(interval * efactor);
    nextRepetition = repetition + 1;
  } else {
    nextRepetition = 0;
    nextInterval = 1;
  }

  let nextEfactor = efactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (nextEfactor < 1.3) nextEfactor = 1.3;

  return {
    repetition: nextRepetition,
    interval: nextInterval,
    efactor: Number(nextEfactor.toFixed(4))
  };
}

/**
 * Lightweight FSRS-style scheduler: tracks card stability and difficulty and
 * determines interval with target retention. Does not require external services.
 */
function calculateFSRS(quality: unknown, prev: SrsEntry, now = new Date()): ReviewSchedule {
  const rating = fsrsRating(quality);
  const repetition = Number.isFinite(prev?.repetition) ? prev.repetition : SM2_DEFAULTS.repetition;
  const baseStability = Number.isFinite(prev?.stability) && prev.stability > 0
    ? prev.stability
    : Math.max(0, Number(prev?.interval) || FSRS_DEFAULTS.stability);
  const stability = Math.max(0.1, baseStability || 0.1);
  const difficulty = clampNumber(Number.isFinite(prev?.difficulty) ? prev.difficulty : FSRS_DEFAULTS.difficulty, 1, 10);
  const elapsed = elapsedDaysSince(prev?.lastReviewedAt, now);
  const retrievability = Math.pow(1 + elapsed / (9 * stability), -1);
  const isFirstReview = !prev?.lastReviewedAt && (!Number.isFinite(prev?.stability) || prev.stability <= 0);

  let nextStability: number;
  if (isFirstReview) {
    nextStability = ({ again: 1, hard: 2, good: 4, easy: 7 } satisfies Record<FsrsRating, number>)[rating];
  } else if (rating === "again") {
    nextStability = Math.max(1, stability * (0.45 + 0.2 * retrievability));
  } else {
    const ratingBoost = { hard: 1.2, good: 2.25, easy: 3.4 }[rating];
    const difficultyBoost = 1 + (10 - difficulty) / 12;
    const overdueBoost = 1 + (1 - retrievability) * 1.4;
    nextStability = stability * ratingBoost * difficultyBoost * overdueBoost;
    if (rating === "hard") nextStability = Math.min(nextStability, stability * 1.6);
  }

  const difficultyDelta = ({ again: 1.15, hard: 0.45, good: -0.15, easy: -0.65 } satisfies Record<FsrsRating, number>)[rating];
  const nextDifficulty = clampNumber(difficulty + difficultyDelta, 1, 10);
  const interval = rating === "again"
    ? 1
    : Math.max(1, Math.round(nextStability * (FSRS_DEFAULTS.desiredRetention / 0.9)));

  return {
    repetition: rating === "again" ? 0 : repetition + 1,
    interval,
    stability: Number(nextStability.toFixed(2)),
    difficulty: Number(nextDifficulty.toFixed(2))
  };
}

/** Today's date in YYYY-MM-DD format (local time zone). */
export function todayISO(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Adds N days to a date and returns in YYYY-MM-DD format. */
function addDaysISO(days: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + Math.max(0, Math.round(days)));
  return todayISO(d);
}

export function scheduleFirstLearningReview<T extends SrsEntry>(entry: T, now = new Date()): T {
  entry.nextDate = addDaysISO(1, now);
  return entry;
}

/** Whether a given date is due (≤ today)? No date = immediately due. */
export function isDue(nextDate: unknown, today = todayISO()): boolean {
  if (!nextDate) return true;
  return String(nextDate) <= today;
}

function localDateISO(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : todayISO(date);
}

export function isInTextReviewDue(entry: SrsEntry | null | undefined, today = todayISO()): boolean {
  if (entry?.status !== "learning") return false;
  const firstLearningDate = localDateISO(entry.learningStartedAt)
    || localDateISO(entry.addedAt)
    || (!entry.lastReviewedAt && (Number(entry.repetition) || 0) <= 0
      ? localDateISO(entry.updatedAt)
      : "");
  if (firstLearningDate && firstLearningDate >= today) return false;
  return isDue(entry.nextDate, today);
}

/**
 * Applies a grade to a vocabulary entry: overwrites scheduling fields and nextDate.
 * Mutates the entry and returns it.
 */
function applyReview<T extends SrsEntry>(entry: T, quality: unknown, now = new Date(), algorithm: string = "sm2"): T {
  const mode = algorithm === "fsrs" ? "fsrs" : "sm2";
  const next = mode === "fsrs" ? calculateFSRS(quality, entry, now) : calculateSM2(quality, entry);
  applyReviewResult(entry, next, now, mode);
  return entry;
}

export async function applyReviewNative<T extends SrsEntry>(
  entry: T,
  quality: unknown,
  now = new Date(),
  algorithm: string = "sm2"
): Promise<T> {
  if (!window.__qtBridge) {
    return applyReview(entry, quality, now, algorithm);
  }
  const mode = algorithm === "fsrs" ? "fsrs" : "sm2";
  try {
    const response = await fetch("/__srs/review", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WH-Token": window.WH_TOKEN || ""
      },
      body: JSON.stringify({
        entry,
        quality,
        algorithm: mode,
        now: now.toISOString(),
        today: todayISO(now)
      })
    });
    if (!response.ok) throw new Error(await response.text());
    const next = await response.json() as ReviewSchedule;
    applyReviewResult(entry, next, now, mode);
    return entry;
  } catch (err) {
    console.warn("native SRS review failed, falling back to JS", err);
    return applyReview(entry, quality, now, mode);
  }
}

function applyReviewResult<T extends SrsEntry>(entry: T, next: ReviewSchedule, now: Date, mode: SrsAlgorithm): T {
  entry.repetition = next.repetition;
  entry.interval = next.interval;
  if (Number.isFinite(next.efactor)) entry.efactor = next.efactor;
  if (Number.isFinite(next.stability)) entry.stability = next.stability;
  if (Number.isFinite(next.difficulty)) entry.difficulty = next.difficulty;
  entry.nextDate = next.nextDate || addDaysISO(next.interval, now);
  entry.lastReviewedAt = next.lastReviewedAt || now.toISOString();
  entry.srsAlgorithm = next.srsAlgorithm === "fsrs" ? "fsrs" : mode;
  return entry;
}

/** Fills missing SM-2 fields with default values (idempotent). */
export function ensureSM2Fields<T extends SrsEntry>(entry: T): T {
  if (!Number.isFinite(entry.interval)) entry.interval = SM2_DEFAULTS.interval;
  if (!Number.isFinite(entry.repetition)) entry.repetition = SM2_DEFAULTS.repetition;
  if (!Number.isFinite(entry.efactor)) entry.efactor = SM2_DEFAULTS.efactor;
  if (!Number.isFinite(entry.stability)) entry.stability = FSRS_DEFAULTS.stability;
  if (!Number.isFinite(entry.difficulty)) entry.difficulty = FSRS_DEFAULTS.difficulty;
  if (entry.srsAlgorithm !== "fsrs") entry.srsAlgorithm = "sm2";
  if (!entry.nextDate) entry.nextDate = todayISO();
  return entry;
}
