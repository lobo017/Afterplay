/*
 * FSRS-5 spaced-repetition scheduler (open-spaced-repetition, "The Algorithm"), with its
 * published default parameters. Times are in days unless named otherwise.
 *
 *   R(t, S)   = (1 + FACTOR·t/S)^DECAY,  DECAY = −0.5, FACTOR = 19/81  (R(S, S) = 0.9)
 *   I(r, S)   = S/FACTOR · (r^(1/DECAY) − 1)   (= S at the 90% target retention)
 *   S0(G)     = w[G−1]
 *   D0(G)     = w4 − e^(w5·(G−1)) + 1
 *   D'        = D + (−w6·(G−3))·(10 − D)/9;  D'' = w7·D0(4) + (1 − w7)·D'
 *   S'recall  = S·(e^w8·(11 − D)·S^−w9·(e^(w10·(1−R)) − 1)·(w15 if Hard)·(w16 if Easy) + 1)
 *   S'forget  = w11·D^−w12·((S + 1)^w13 − 1)·e^(w14·(1−R)), never above S
 *   S'sameday = S·e^(w17·(G − 3 + w18))
 */

/** 1 Again, 2 Hard, 3 Good, 4 Easy. */
export type Grade = 1 | 2 | 3 | 4;

export type CardState = 'new' | 'learning' | 'review' | 'relearning';

export interface SrsCard {
  state: CardState;
  /** Days until recall probability falls to 90%. */
  stability: number;
  /** 1 (easy) … 10 (hard). */
  difficulty: number;
  reps: number;
  lapses: number;
  /** When it is due (ms since the epoch). */
  dueDate: number;
  /** When it was last reviewed (ms since the epoch). */
  lastReviewDate?: number;
}

export const FSRS5_DEFAULT_WEIGHTS: readonly number[] = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11,
  0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

export const DECAY = -0.5;
export const FACTOR = 19 / 81;
/** Recall probability the intervals aim for. */
export const TARGET_RETENTION = 0.9;
/** A failed card comes back this soon (relearning step). */
export const RELEARN_DELAY_MS = 10 * 60 * 1000;
export const MAX_INTERVAL_DAYS = 36500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FsrsOptions {
  weights?: readonly number[];
  retention?: number;
}

export function newCard(now: number): SrsCard {
  return { state: 'new', stability: 0, difficulty: 0, reps: 0, lapses: 0, dueDate: now };
}

export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);
}

export function intervalDays(stability: number, retention: number = TARGET_RETENTION): number {
  return (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
}

const clampDifficulty = (d: number) => Math.min(10, Math.max(1, d));

export function initialStability(grade: Grade, w: readonly number[] = FSRS5_DEFAULT_WEIGHTS): number {
  return Math.max(0.1, w[grade - 1]!);
}

export function initialDifficulty(grade: Grade, w: readonly number[] = FSRS5_DEFAULT_WEIGHTS): number {
  return w[4]! - Math.exp(w[5]! * (grade - 1)) + 1;
}

export function nextDifficulty(d: number, grade: Grade, w: readonly number[] = FSRS5_DEFAULT_WEIGHTS): number {
  const delta = -w[6]! * (grade - 3);
  const damped = d + (delta * (10 - d)) / 9;
  const reverted = w[7]! * initialDifficulty(4, w) + (1 - w[7]!) * damped;
  return clampDifficulty(reverted);
}

export function recallStability(d: number, s: number, r: number, grade: Grade, w: readonly number[] = FSRS5_DEFAULT_WEIGHTS): number {
  const hardPenalty = grade === 2 ? w[15]! : 1;
  const easyBonus = grade === 4 ? w[16]! : 1;
  return s * (Math.exp(w[8]!) * (11 - d) * Math.pow(s, -w[9]!) * (Math.exp(w[10]! * (1 - r)) - 1) * hardPenalty * easyBonus + 1);
}

export function forgetStability(d: number, s: number, r: number, w: readonly number[] = FSRS5_DEFAULT_WEIGHTS): number {
  const sf = w[11]! * Math.pow(d, -w[12]!) * (Math.pow(s + 1, w[13]!) - 1) * Math.exp(w[14]! * (1 - r));
  return Math.min(sf, s);
}

export function sameDayStability(s: number, grade: Grade, w: readonly number[] = FSRS5_DEFAULT_WEIGHTS): number {
  return s * Math.exp(w[17]! * (grade - 3 + w[18]!));
}

/**
 * The card after a review with `grade` at `now`. Again sends it back in RELEARN_DELAY_MS
 * (learning or relearning); any other grade schedules it at the interval for the target
 * retention, at least one day, with Hard ≤ Good ≤ Easy for the same card.
 */
export function reviewCard(card: SrsCard, grade: Grade, now: number, options: FsrsOptions = {}): SrsCard {
  const w = options.weights ?? FSRS5_DEFAULT_WEIGHTS;
  const retention = options.retention ?? TARGET_RETENTION;
  const next = scheduleOnce(card, grade, now, w, retention);
  if (grade === 1 || card.state === 'new') return next;
  // Keep the grades in order for the same card: Hard ≤ Good ≤ Easy
  const days = (c: SrsCard) => Math.round((c.dueDate - now) / DAY_MS);
  if (grade === 2) {
    const good = scheduleOnce(card, 3, now, w, retention);
    if (days(next) > days(good)) return { ...next, dueDate: good.dueDate };
  } else if (grade === 4) {
    const good = scheduleOnce(card, 3, now, w, retention);
    if (days(next) <= days(good)) return { ...next, dueDate: now + (days(good) + 1) * DAY_MS };
  }
  return next;
}

function scheduleOnce(card: SrsCard, grade: Grade, now: number, w: readonly number[], retention: number): SrsCard {
  const reps = card.reps + 1;
  let stability: number;
  let difficulty: number;
  if (card.state === 'new' || card.stability <= 0) {
    stability = initialStability(grade, w);
    difficulty = clampDifficulty(initialDifficulty(grade, w));
  } else {
    const elapsedDays = card.lastReviewDate === undefined ? 0 : (now - card.lastReviewDate) / DAY_MS;
    difficulty = nextDifficulty(card.difficulty, grade, w);
    if (elapsedDays < 1) {
      stability = sameDayStability(card.stability, grade, w);
    } else {
      const r = retrievability(elapsedDays, card.stability);
      stability = grade === 1 ? forgetStability(card.difficulty, card.stability, r, w) : recallStability(card.difficulty, card.stability, r, grade, w);
    }
  }
  stability = Math.max(0.1, stability);

  if (grade === 1) {
    const lapsed = card.state === 'review';
    return {
      state: lapsed || card.state === 'relearning' ? 'relearning' : 'learning',
      stability,
      difficulty,
      reps,
      lapses: card.lapses + (lapsed ? 1 : 0),
      dueDate: now + RELEARN_DELAY_MS,
      lastReviewDate: now,
    };
  }
  const days = Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(intervalDays(stability, retention))));
  return { state: 'review', stability, difficulty, reps, lapses: card.lapses, dueDate: now + days * DAY_MS, lastReviewDate: now };
}
