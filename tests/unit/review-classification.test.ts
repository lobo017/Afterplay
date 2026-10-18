import { describe, expect, it } from 'vitest';
import type { MoveClassification } from '../../src/core/game-tree';
import {
  CLASS_THRESHOLDS,
  DECIDED_WIN_PERCENT,
  classFromWinDrop,
  classifyMove,
} from '../../src/review/classification';
import {
  classificationFixtures,
  classifyInputFor,
  recordedLine,
  resolveStartFen,
} from '../helpers/review-fixtures';

const ALL_CLASSES: MoveClassification[] = [
  'Best',
  'Excellent',
  'Good',
  'Inaccuracy',
  'Mistake',
  'Blunder',
  'Great',
  'Brilliant',
  'Book',
  'Miss',
];

describe('Phase 5 — move classification fixtures', () => {
  it('has at least one fixture for every class', () => {
    const covered = new Set(classificationFixtures.map((f) => f.expected));
    for (const c of ALL_CLASSES) expect(covered.has(c), c).toBe(true);
  });

  it('recorded engine results match the fixture lines (re-run npm run fixtures:review if not)', () => {
    for (const fixture of classificationFixtures) {
      const line = recordedLine(fixture);
      expect(line, fixture.id).toBeDefined();
      expect(line!.key, fixture.id).toBe(
        `${resolveStartFen(fixture)}|${fixture.moves.join(' ')}`,
      );
    }
  });

  for (const fixture of classificationFixtures) {
    it(`${fixture.id} → ${fixture.expected}`, () => {
      const result = classifyMove(classifyInputFor(fixture));
      expect(result, fixture.id).not.toBeNull();
      expect(
        result!.classification,
        `${fixture.id}: ${fixture.rationale} (win ${result!.winBefore.toFixed(1)} → ${result!.winAfter.toFixed(1)}, drop ${result!.winDrop.toFixed(1)})`,
      ).toBe(fixture.expected);
    });
  }

  it('decided positions never produce a Mistake or Blunder unless the result changes', () => {
    for (const fixture of classificationFixtures.filter((f) => f.id.startsWith('decided-'))) {
      const result = classifyMove(classifyInputFor(fixture))!;
      const decidedBefore =
        result.winBefore >= DECIDED_WIN_PERCENT || result.winBefore <= 100 - DECIDED_WIN_PERCENT;
      expect(decidedBefore, `${fixture.id} should start from a decided position`).toBe(true);
      const sameSideStillDecided =
        (result.winBefore >= DECIDED_WIN_PERCENT && result.winAfter >= DECIDED_WIN_PERCENT) ||
        result.winBefore <= 100 - DECIDED_WIN_PERCENT;
      if (sameSideStillDecided) {
        expect(['Mistake', 'Blunder']).not.toContain(result.classification);
      }
    }
  });

  it('maps win% drops onto the spec bands', () => {
    // Lichess's bands: Inaccuracy from 5, Mistake from 10, Blunder from 15 (inclusive)
    expect(CLASS_THRESHOLDS).toEqual({ excellent: 2, inaccuracy: 5, mistake: 10, blunder: 15 });
    expect(classFromWinDrop(0)).toBe('Excellent');
    expect(classFromWinDrop(2)).toBe('Excellent');
    expect(classFromWinDrop(2.01)).toBe('Good');
    expect(classFromWinDrop(4.99)).toBe('Good');
    expect(classFromWinDrop(5)).toBe('Inaccuracy');
    expect(classFromWinDrop(9.99)).toBe('Inaccuracy');
    expect(classFromWinDrop(10)).toBe('Mistake');
    expect(classFromWinDrop(14.99)).toBe('Mistake');
    expect(classFromWinDrop(15)).toBe('Blunder');
  });
});

describe('Phase 5 — classification rule edges (hand-set engine scores)', () => {
  const cp = (value: number) => ({ type: 'cp' as const, value });
  const analysis = (fen: string, lines: Array<[string, number]>) => ({
    fen,
    depth: 20,
    lines: lines.map(([move, value], i) => ({ multipv: i + 1, score: cp(value), pv: [move] })),
  });

  const legalFen = 'rn1qkbnr/ppp2p1p/3p2p1/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5';
  const legalAfter = 'rn1qkbnr/ppp2p1p/3p2p1/4N3/2B1P1b1/2N5/PPPP1PPP/R1BQK2R b KQkq - 0 5';

  it('a queen sacrifice that is best in a balanced position is Brilliant', () => {
    const result = classifyMove({
      fenBefore: legalFen,
      uci: 'f3e5',
      before: analysis(legalFen, [['f3e5', 150], ['d2d4', 90]]),
      after: analysis(legalAfter, [['d6e5', -150]]),
      isBook: false,
    });
    expect(result?.classification).toBe('Brilliant');
  });

  it('is not Brilliant when the alternative already wins trivially (≥ 95%)', () => {
    const result = classifyMove({
      fenBefore: legalFen,
      uci: 'f3e5',
      before: analysis(legalFen, [['f3e5', 1500], ['d2d4', 900]]),
      after: analysis(legalAfter, [['d6e5', -1500]]),
      isBook: false,
    });
    expect(result?.classification).toBe('Best');
  });

  it('is not Brilliant when the mover is worse after the sacrifice', () => {
    const result = classifyMove({
      fenBefore: legalFen,
      uci: 'f3e5',
      before: analysis(legalFen, [['f3e5', -60], ['d2d4', -120]]),
      after: analysis(legalAfter, [['d6e5', 60]]),
      isBook: false,
    });
    expect(result?.classification).toBe('Best');
  });

  it('saving the queen from a fork is not a sacrifice of the rook that was lost anyway', () => {
    // Black's knight on e3 forks Qd1 and Rf1; Qb3 saves the queen and the rook falls.
    const fen = '6k1/5ppp/8/8/8/4n3/6PP/3Q1RK1 w - - 0 1';
    const after = '6k1/5ppp/8/8/8/1Q2n3/6PP/5RK1 b - - 1 1';
    const result = classifyMove({
      fenBefore: fen,
      uci: 'd1b3',
      before: analysis(fen, [['d1b3', 100], ['d1d4', 60]]),
      after: analysis(after, [['e3f1', -90]]),
      isBook: false,
    });
    expect(result?.classification).toBe('Best');
  });

  it('a second line with the same score counts as a top move; one centipawn less does not', () => {
    const fen = 'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2PP1N2/PP3PPP/RNBQ1RK1 w - - 0 7';
    const after = 'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2PP1N1P/PP3PP1/RNBQ1RK1 b - - 0 7';
    const tie = classifyMove({
      fenBefore: fen,
      uci: 'h2h3',
      before: analysis(fen, [['a2a4', 25], ['h2h3', 25]]),
      after: analysis(after, [['a7a6', -25]]),
      isBook: false,
    });
    expect(tie?.classification).toBe('Best');
    const below = classifyMove({
      fenBefore: fen,
      uci: 'h2h3',
      before: analysis(fen, [['a2a4', 25], ['h2h3', 24]]),
      after: analysis(after, [['a7a6', -24]]),
      isBook: false,
    });
    expect(below?.classification).toBe('Excellent');
  });

  it('a forced move (no second line) is Best, never Great', () => {
    const fen = '7k/8/8/8/8/8/1r6/K7 w - - 0 1';
    const after = '7k/8/8/8/8/8/1K6/8 b - - 0 1';
    const result = classifyMove({
      fenBefore: fen,
      uci: 'a1b2',
      before: analysis(fen, [['a1b2', 0]]),
      after: analysis(after, [['h8g7', 0]]),
      isBook: false,
    });
    expect(result?.classification).toBe('Best');
  });

  it('returns null until both positions are analyzed', () => {
    const fen = '7k/8/8/8/8/8/1r6/K7 w - - 0 1';
    expect(
      classifyMove({
        fenBefore: fen,
        uci: 'a1b2',
        before: analysis(fen, []),
        after: analysis(fen, [['h8g7', 0]]),
        isBook: false,
      }),
    ).toBeNull();
  });
});
