import { describe, expect, it } from 'vitest';
import {
  PERFORMANCE_ANCHORS,
  PERFORMANCE_MIN_COUNTED_MOVES,
  centipawnLoss,
  estimatePerformanceRating,
  formatPerformanceEstimate,
  gameAccuracy,
  harmonicMean,
  moveAccuracy,
  winPercentFromCp,
  winPercentFromScore,
} from '../../src/review/formulas';

describe('Phase 5 — win% (spec formula)', () => {
  it('is 50 at equality and symmetric around it', () => {
    expect(winPercentFromCp(0)).toBe(50);
    for (const cp of [35, 100, 300, 900]) {
      expect(winPercentFromCp(cp) + winPercentFromCp(-cp)).toBeCloseTo(100, 10);
    }
  });

  it('matches Win% = 50 + 50·(2/(1+e^(−0.00368208·cp)) − 1) at known points', () => {
    // Values computed by hand from the spec formula
    expect(winPercentFromCp(100)).toBeCloseTo(59.1, 1);
    expect(winPercentFromCp(300)).toBeCloseTo(75.11, 1);
    expect(winPercentFromCp(-500)).toBeCloseTo(13.7, 1);
  });

  it('counts a forced mate as 100 or 0', () => {
    expect(winPercentFromScore({ type: 'mate', value: 3 })).toBe(100);
    expect(winPercentFromScore({ type: 'mate', value: -1 })).toBe(0);
    // `mate 0`: the side to move is mated
    expect(winPercentFromScore({ type: 'mate', value: 0 })).toBe(0);
    expect(winPercentFromScore({ type: 'cp', value: 0 })).toBe(50);
  });
});

describe('Phase 5 — move accuracy (spec formula)', () => {
  it('is 100 for no drop or a gain, and clamped to 0–100', () => {
    expect(moveAccuracy(0)).toBe(100);
    expect(moveAccuracy(-12)).toBe(100);
    expect(moveAccuracy(100)).toBeGreaterThanOrEqual(0);
    expect(moveAccuracy(100)).toBeLessThan(1.5);
  });

  it('follows 103.1668·e^(−0.04354·drop) − 3.1669', () => {
    for (const drop of [1, 5, 10, 20, 40]) {
      expect(moveAccuracy(drop)).toBeCloseTo(103.1668 * Math.exp(-0.04354 * drop) - 3.1669, 10);
    }
    expect(moveAccuracy(10)).toBeCloseTo(63.58, 1);
  });

  it('decreases as the drop grows', () => {
    let previous = 101;
    for (let drop = 0; drop <= 60; drop += 3) {
      const a = moveAccuracy(drop);
      expect(a).toBeLessThan(previous);
      previous = a;
    }
  });
});

describe('Phase 5 — game accuracy (Lichess-style)', () => {
  it('a game with no drops is 100% for both sides', () => {
    const result = gameAccuracy([50, 52, 51, 53, 52, 54]);
    expect(result.white).toBeCloseTo(100, 6);
    expect(result.black).toBeCloseTo(100, 6);
  });

  it('a single move: weighted mean and harmonic mean agree on that move', () => {
    // White drops 10 (accuracy 63.58); Black's move loses nothing
    const result = gameAccuracy([50, 40, 40]);
    expect(result.white).toBeCloseTo(moveAccuracy(10), 6);
    expect(result.black).toBeCloseTo(100, 6);
  });

  it('weights each move by the volatility around it (Lichess windows and clamps)', () => {
    // 20 moves, so the window is 2 positions and a move's weight is half its own swing,
    // clamped to 0.5–12. White's 6th move drops 50 → 30; every other move is flat.
    const series = Array.from({ length: 21 }, (_, i) => (i <= 10 ? 50 : 30));
    const blunder = moveAccuracy(20);
    const weighted = (9 * 0.5 * 100 + 10 * blunder) / (9 * 0.5 + 10);
    const harmonic = 10 / (9 / 100 + 1 / blunder);
    const result = gameAccuracy(series);
    expect(result.white).toBeCloseTo((weighted + harmonic) / 2, 6);
    expect(result.black).toBeCloseTo(100, 6);
    // Unweighted, the same game would score far higher
    expect(result.white!).toBeLessThan((9 * 100 + blunder) / 10 - 15);
  });

  it('the harmonic mean pulls a side down for one very bad move', () => {
    const steady = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50];
    const blunder = [...steady];
    for (let i = 5; i < blunder.length; i++) blunder[i] = 5;
    const a = gameAccuracy(blunder);
    // White blundered on move index 4 (5th position): its accuracy falls far below the
    // plain mean of its five moves (four at 100, one near 0, mean ~80)
    expect(a.white!).toBeLessThan(65);
    expect(a.black).toBeCloseTo(100, 6);
  });

  it('respects the first mover when the game starts with Black to move', () => {
    const result = gameAccuracy([50, 60, 60], 'b');
    // Black moved first and White's win% went up 10: Black dropped 10
    expect(result.black).toBeCloseTo(moveAccuracy(10), 6);
    expect(result.white).toBeCloseTo(100, 6);
  });

  it('returns null for an empty game', () => {
    expect(gameAccuracy([50])).toEqual({ white: null, black: null });
  });

  it('harmonic mean floors each value at 1', () => {
    expect(harmonicMean([])).toBeNull();
    expect(harmonicMean([0, 100])).toBeCloseTo(2 / (1 + 0.01), 6);
  });
});

describe('Phase 5 — centipawn loss and performance rating', () => {
  const base = { legalMoveCount: 20, playedBest: false, deliveredMate: false };

  it('counts only positions within ±650 cp with two or more legal moves, capped at 420', () => {
    expect(centipawnLoss({ ...base, bestCp: 30, playedCp: -20 })).toBe(50);
    expect(centipawnLoss({ ...base, bestCp: 700, playedCp: 100 })).toBeNull();
    expect(centipawnLoss({ ...base, bestCp: 30, playedCp: -900 })).toBe(420);
    expect(centipawnLoss({ ...base, legalMoveCount: 1, bestCp: 30, playedCp: -900 })).toBeNull();
    expect(centipawnLoss({ ...base, playedBest: true, bestCp: 30, playedCp: 10 })).toBe(0);
    expect(centipawnLoss({ ...base, bestCp: 30, playedCp: 60 })).toBe(0);
  });

  it('maps the calibrated ACPL anchors exactly onto their bot ratings', () => {
    for (const anchor of PERFORMANCE_ANCHORS.slice(1, -1)) {
      expect(estimatePerformanceRating(anchor.acpl, 20)).toEqual({
        rating: anchor.rating,
        clamped: null,
      });
    }
  });

  it('interpolates between anchors and gets better as ACPL falls', () => {
    const r1 = estimatePerformanceRating(50, 20)!;
    const r2 = estimatePerformanceRating(30, 20)!;
    expect(r1.rating).toBeGreaterThan(1000);
    expect(r1.rating).toBeLessThan(1400);
    expect(r2.rating).toBeGreaterThan(r1.rating);
  });

  it('clamps outside the calibrated range and needs enough counted moves', () => {
    expect(estimatePerformanceRating(400, 20)).toEqual({ rating: 400, clamped: 'low' });
    expect(estimatePerformanceRating(1, 20)).toEqual({ rating: 2400, clamped: 'high' });
    expect(estimatePerformanceRating(30, PERFORMANCE_MIN_COUNTED_MOVES - 1)).toBeNull();
    expect(estimatePerformanceRating(null, 20)).toBeNull();
    expect(formatPerformanceEstimate({ rating: 400, clamped: 'low' })).toBe('≤400');
    expect(formatPerformanceEstimate({ rating: 2400, clamped: 'high' })).toBe('2400+');
    expect(formatPerformanceEstimate(null)).toBe('—');
  });
});
