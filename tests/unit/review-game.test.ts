import { describe, expect, it } from 'vitest';
import { GameTree } from '../../src/core/game-tree';
import { parsePgn } from '../../src/core/pgn';
import {
  buildAnnotatedPgn,
  buildGameReview,
  findKeyMoments,
  mainLinePlies,
  whiteWinPercent,
} from '../../src/review/review-game';
import type { PositionAnalysis, ReviewedMove } from '../../src/review/types';
import {
  classificationFixtures,
  isBookFen,
  recordedLine,
  resolveStartFen,
} from '../helpers/review-fixtures';

/** A fixture line whose every position was recorded, as a game tree plus its analyses. */
function fixtureGame(id: string) {
  const fixture = classificationFixtures.find((f) => f.id === id)!;
  const line = recordedLine(fixture)!;
  const tree = new GameTree(resolveStartFen(fixture));
  for (const uci of fixture.moves) tree.addMove(uci);
  const positions: PositionAnalysis[] = [];
  for (const p of line.positions) {
    positions[p.ply] = {
      fen: p.fen,
      ...(p.terminal ? { terminal: p.terminal } : {}),
      lines: p.lines,
      depth: p.depth,
    };
  }
  expect(positions.length, `${id} must have every position recorded`).toBe(fixture.moves.length + 1);
  return { fixture, tree, positions };
}

function review(id: string, keep?: number) {
  const { tree, positions } = fixtureGame(id);
  const shown = keep === undefined ? positions : positions.map((p, i) => (i < keep ? p : undefined));
  return {
    tree,
    positions,
    review: buildGameReview({
      preset: null,
      budget: { depth: 18 },
      startFen: tree.root.fen,
      plies: mainLinePlies(tree),
      positions: shown,
      isBookPosition: isBookFen,
    }),
  };
}

describe('Phase 5 — game review assembly', () => {
  it('classifies, explains and summarizes a reviewed line', () => {
    const { review: r } = review('miss-ignores-hanging-knight');
    expect(r.complete).toBe(true);
    expect(r.analyzedPositions).toBe(3);
    expect(r.moves.map((m) => [m.san, m.classification])).toEqual([
      ['Nd4', 'Blunder'],
      ['h6', 'Miss'],
    ]);
    const [nd4, h6] = r.moves as [ReviewedMove, ReviewedMove];
    expect(nd4.explanation).toBe('Hangs the knight on d4 to exd4.');
    expect(nd4.refutationSan[0]).toBe('exd4');
    expect(nd4.bestMoveSan).toBe('a4');
    expect(h6.explanation).toBe('Misses exd4, which wins the knight on d4.');
    expect(h6.color).toBe('b');
    expect(r.white.counts.Blunder).toBe(1);
    expect(r.black.counts.Miss).toBe(1);
    // White's win% after each move, from the analysis of the following position
    expect(nd4.whiteWinAfter).toBeCloseTo(r.whiteWinSeries[1]!, 6);
    expect(h6.whiteWinAfter).toBeCloseTo(r.whiteWinSeries[2]!, 6);
    expect(r.whiteWinSeries[1]!).toBeLessThan(20);
    // Too few counted moves for a performance estimate
    expect(r.white.performance).toBeNull();
    expect(r.white.countedMoves).toBe(1);
    expect(r.white.acpl).toBeGreaterThan(300);
  });

  it('gives White and Black win% the right sign for a Black-to-move position', () => {
    const { review: r, positions } = review('miss-ignores-hanging-knight');
    // After Nd4 Black is to move and winning: the engine's +417 is from Black's view
    expect(positions[1]!.lines[0]!.score).toEqual({ type: 'cp', value: 417 });
    expect(whiteWinPercent(positions[1])).toBeLessThan(20);
    expect(r.moves[0]!.scoreAfter).toEqual({ type: 'cp', value: -417 });
  });

  it('a partial review classifies only moves with both positions analyzed', () => {
    const { review: r } = review('miss-ignores-hanging-knight', 2);
    expect(r.complete).toBe(false);
    expect(r.analyzedPositions).toBe(2);
    expect(r.moves).toHaveLength(1);
    expect(r.whiteWinSeries[2]).toBeNull();
    expect(r.white.accuracy).not.toBeNull();
  });

  it('handles a game that ends in checkmate', () => {
    const { review: r } = review('best-second-mate-in-one');
    expect(r.moves[0]!.classification).toBe('Best');
    expect(r.whiteWinSeries).toEqual([100, 100]);
    // A position beyond ±650 cp doesn't count toward ACPL
    expect(r.moves[0]!.cpLoss).toBeNull();
    expect(r.white.accuracy).toBeCloseTo(100, 6);
  });

  it('marks Book only for the unbroken run of dataset positions from the start', () => {
    const tree = new GameTree();
    for (const uci of ['e2e4', 'e7e5', 'g1f3']) tree.addMove(uci);
    const plies = mainLinePlies(tree);
    const flat = (fen: string): PositionAnalysis => ({
      fen,
      depth: 10,
      lines: [{ multipv: 1, score: { type: 'cp', value: 0 }, pv: ['a2a3'] }],
    });
    const positions = [tree.root.fen, ...plies.map((p) => p.fenAfter)].map(flat);
    const bookAfter = new Set([plies[0]!.fenAfter, plies[2]!.fenAfter]);
    const r = buildGameReview({
      preset: 'quick',
      budget: { movetimeMs: 200 },
      startFen: tree.root.fen,
      plies,
      positions,
      isBookPosition: (fen) => bookAfter.has(fen),
    });
    expect(r.moves.map((m) => m.classification)).toEqual(['Book', 'Excellent', 'Excellent']);
  });

  it('key moments are the 3–5 biggest swings, in game order', () => {
    const move = (ply: number, color: 'w' | 'b', winBefore: number, winAfter: number) =>
      ({
        ply,
        nodeId: `n${ply}`,
        color,
        moveNumber: Math.ceil(ply / 2),
        san: `m${ply}`,
        winBefore,
        winAfter,
        whiteWinAfter: color === 'w' ? winAfter : 100 - winAfter,
        classification: 'Good',
      }) as ReviewedMove;
    const moves = [
      move(1, 'w', 50, 49),
      move(2, 'b', 51, 30), // White +21
      move(3, 'w', 70, 40), // White −30
      move(4, 'b', 60, 58),
      move(5, 'w', 42, 35), // −7
      move(6, 'b', 65, 60), // +5
      move(7, 'w', 40, 10), // −30
      move(8, 'b', 90, 89),
    ];
    const moments = findKeyMoments(moves);
    expect(moments.map((m) => m.ply)).toEqual([2, 3, 5, 6, 7]);
    expect(moments[1]!.swing).toBeCloseTo(-30, 6);
    expect(moments[0]!.label).toBe('1... m2 — Good');
    // A quiet game still gets its three biggest swings
    const quiet = [move(1, 'w', 50, 48), move(2, 'b', 52, 51), move(3, 'w', 49, 46), move(4, 'b', 54, 53)];
    expect(findKeyMoments(quiet).map((m) => m.ply)).toEqual([1, 2, 3]);
  });

  it('writes an annotated PGN that parses back with evals, NAGs, comments and the best line', () => {
    const { tree, positions, review: r } = review('miss-ignores-hanging-knight');
    const pgn = buildAnnotatedPgn(tree, r, positions, 'Stockfish 17.1');
    expect(pgn).toContain('[Annotator "Wizard\'s Chess review (Stockfish 17.1, depth 18)"]');
    const parsed = parsePgn(pgn);
    const main = parsed.getMainLine().filter((n) => n.parentId !== null);
    expect(main.map((n) => n.san)).toEqual(['Nd4', 'h6']);
    expect(main[0]!.nags).toContain(4);
    expect(main[1]!.nags).toContain(2);
    expect(main[0]!.eval).toEqual({ cp: -417, depth: 18 });
    expect(main[0]!.comment).toContain('Blunder. Hangs the knight on d4 to exd4. Best was a4.');
    // The engine's best line hangs off the parent as a variation
    const root = parsed.root;
    expect(root.children.map((c) => c.san)).toEqual(['Nd4', 'a4']);
    expect(root.comment).toMatch(/^White accuracy \d+\.\d%, ACPL \d+, performance —\. Black accuracy/);
    // The original tree is untouched
    expect(tree.getMainLine()[1]!.classification).toBeUndefined();
  });
});
