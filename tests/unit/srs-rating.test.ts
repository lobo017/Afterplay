import { describe, expect, it } from 'vitest';
import {
  FACTOR,
  FSRS5_DEFAULT_WEIGHTS as W,
  RELEARN_DELAY_MS,
  forgetStability,
  initialDifficulty,
  intervalDays,
  newCard,
  nextDifficulty,
  recallStability,
  retrievability,
  reviewCard,
  sameDayStability,
  type Grade,
  type SrsCard,
} from '../../src/trainers/fsrs';
import { DEFAULT_PLAYER, MIN_PLAYER_RD, ratePuzzleAttempt, updateGlicko2 } from '../../src/trainers/glicko2';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 19, 12);
const daysUntil = (card: SrsCard, now: number) => Math.round((card.dueDate - now) / DAY);

describe('Phase 6 — FSRS-5 scheduler', () => {
  it('uses the FSRS-5 forgetting curve: 90% recall after S days', () => {
    expect(FACTOR).toBeCloseTo(19 / 81, 12);
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 10);
    expect(retrievability(0, 10)).toBe(1);
    expect(retrievability(30, 10)).toBeLessThan(retrievability(20, 10));
    expect(intervalDays(12.5)).toBeCloseTo(12.5, 10);
    expect(intervalDays(10, 0.8)).toBeGreaterThan(10);
  });

  it('starts a new card from S0 = w[G−1] and D0(G) = w4 − e^(w5·(G−1)) + 1', () => {
    for (const g of [2, 3, 4] as Grade[]) {
      const c = reviewCard(newCard(T0), g, T0);
      expect(c.stability).toBeCloseTo(W[g - 1]!, 10);
      expect(c.difficulty).toBeCloseTo(Math.min(10, Math.max(1, W[4]! - Math.exp(W[5]! * (g - 1)) + 1)), 10);
      expect(c.state).toBe('review');
      expect(c.reps).toBe(1);
    }
    // Good on a new card: S0 = 3.173 days → due in 3 days; Easy: 15.69 → 16 days; Hard → 1 day minimum
    expect(daysUntil(reviewCard(newCard(T0), 3, T0), T0)).toBe(3);
    expect(daysUntil(reviewCard(newCard(T0), 4, T0), T0)).toBe(16);
    expect(daysUntil(reviewCard(newCard(T0), 2, T0), T0)).toBe(1);
    expect(initialDifficulty(1)).toBeCloseTo(W[4]!, 10);
  });

  it('Again sends a card back in 10 minutes, and a lapse counts only for a learned card', () => {
    const learning = reviewCard(newCard(T0), 1, T0);
    expect(learning).toMatchObject({ state: 'learning', lapses: 0, dueDate: T0 + RELEARN_DELAY_MS });
    const learned = reviewCard(newCard(T0), 3, T0);
    const later = T0 + 3 * DAY;
    const lapsed = reviewCard(learned, 1, later);
    expect(lapsed).toMatchObject({ state: 'relearning', lapses: 1, dueDate: later + RELEARN_DELAY_MS });
    expect(lapsed.stability).toBeLessThan(learned.stability);
    expect(lapsed.difficulty).toBeGreaterThan(learned.difficulty);
  });

  it('a successful review on time grows the interval, Hard ≤ Good ≤ Easy', () => {
    const card = reviewCard(newCard(T0), 3, T0);
    const due = card.dueDate;
    const [hard, good, easy] = ([2, 3, 4] as Grade[]).map((g) => reviewCard(card, g, due));
    expect(daysUntil(good!, due)).toBeGreaterThan(daysUntil(card, T0));
    expect(daysUntil(hard!, due)).toBeLessThanOrEqual(daysUntil(good!, due));
    expect(daysUntil(easy!, due)).toBeGreaterThan(daysUntil(good!, due));
    // The formula, checked by hand
    const r = retrievability(3, card.stability);
    expect(good!.stability).toBeCloseTo(recallStability(card.difficulty, card.stability, r, 3), 10);
    expect(good!.difficulty).toBeCloseTo(nextDifficulty(card.difficulty, 3), 10);
  });

  it('applies the difficulty, recall, forgetting and same-day formulas as published', () => {
    const d = 5;
    const s = 10;
    const r = 0.85;
    // D' = D − w6·(G−3)·(10−D)/9, then mean reversion to D0(4)
    const damped = d + (-W[6]! * (4 - 3) * (10 - d)) / 9;
    expect(nextDifficulty(d, 4)).toBeCloseTo(W[7]! * initialDifficulty(4) + (1 - W[7]!) * damped, 10);
    expect(recallStability(d, s, r, 3)).toBeCloseTo(
      s * (Math.exp(W[8]!) * (11 - d) * Math.pow(s, -W[9]!) * (Math.exp(W[10]! * (1 - r)) - 1) + 1),
      10,
    );
    expect(recallStability(d, s, r, 2)).toBeLessThan(recallStability(d, s, r, 3));
    expect(recallStability(d, s, r, 4)).toBeGreaterThan(recallStability(d, s, r, 3));
    expect(forgetStability(d, s, r)).toBeCloseTo(
      Math.min(s, W[11]! * Math.pow(d, -W[12]!) * (Math.pow(s + 1, W[13]!) - 1) * Math.exp(W[14]! * (1 - r))),
      10,
    );
    expect(sameDayStability(s, 3)).toBeCloseTo(s * Math.exp(W[17]! * W[18]!), 10);
  });

  it('a relearning card reviewed the same day uses the short-term stability', () => {
    const learned = reviewCard(newCard(T0), 3, T0);
    const lapsed = reviewCard(learned, 1, T0 + 3 * DAY);
    const again = reviewCard(lapsed, 3, lapsed.dueDate);
    expect(again.state).toBe('review');
    expect(again.stability).toBeCloseTo(sameDayStability(lapsed.stability, 3), 10);
    expect(again.dueDate).toBeGreaterThanOrEqual(lapsed.dueDate + DAY);
  });
});

describe('Phase 6 — Glicko-2 puzzle rating', () => {
  it('reproduces Glickman’s worked example (1500/200 vs 1400/30 W, 1550/100 L, 1700/300 L)', () => {
    const next = updateGlicko2({ rating: 1500, rd: 200, volatility: 0.06 }, [
      { opponent: { rating: 1400, rd: 30 }, score: 1 },
      { opponent: { rating: 1550, rd: 100 }, score: 0 },
      { opponent: { rating: 1700, rd: 300 }, score: 0 },
    ]);
    expect(next.rating).toBeCloseTo(1464.06, 1);
    expect(next.rd).toBeCloseTo(151.52, 1);
    expect(next.volatility).toBeCloseTo(0.05999, 4);
  });

  it('a rating period without games only widens the deviation', () => {
    const next = updateGlicko2({ rating: 1500, rd: 200, volatility: 0.06 }, []);
    expect(next.rating).toBe(1500);
    expect(next.rd).toBeGreaterThan(200);
  });

  it('solving raises the rating, failing lowers it, more so against an easier puzzle', () => {
    const start = { ...DEFAULT_PLAYER };
    const win = ratePuzzleAttempt(start, 1500, true);
    const loss = ratePuzzleAttempt(start, 1500, false);
    expect(win.rating).toBeGreaterThan(1500);
    expect(loss.rating).toBeLessThan(1500);
    expect(1500 - ratePuzzleAttempt(start, 1000, false).rating).toBeGreaterThan(1500 - loss.rating);
  });

  it('keeps the deviation at or above its floor after many puzzles', () => {
    let r = { ...DEFAULT_PLAYER };
    for (let i = 0; i < 300; i++) r = ratePuzzleAttempt(r, 1500, i % 2 === 0);
    expect(r.rd).toBeGreaterThanOrEqual(MIN_PLAYER_RD);
    expect(Math.abs(r.rating - 1500)).toBeLessThan(60);
  });
});
