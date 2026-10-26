import { describe, expect, it } from 'vitest';
import type { GameTree } from '../../src/core/game-tree';
import { parsePgn } from '../../src/core/pgn';
import {
  stripEngineAnnotations,
  stripEngineComment,
  withReviewComment,
} from '../../src/review/annotations';
import {
  CLASSIFICATION_NAG,
  buildAnnotatedPgn,
  buildGameReview,
  mainLinePlies,
} from '../../src/review/review-game';
import type { PositionAnalysis } from '../../src/review/types';

/** As Lichess exports an analysed game (`evals=true&literate=true`), plus a human note. */
const LICHESS_ANNOTATED = `[Event "Rated Blitz game"]
[Site "https://lichess.org/abcdefgh"]
[White "white"]
[Black "black"]
[Result "0-1"]
[Annotator "lichess.org"]

1. e4 { [%eval 0.18] [%clk 0:05:00] } 1... e5 { [%eval 0.2] [%clk 0:05:00] } 2. Qh5?! { [%eval -0.4] [%clk 0:04:58] } { (0.20 → -0.40) Inaccuracy. Nf3 was best. } ( 2. Nf3 Nc6 3. Bb5 ) 2... Nc6 { [%eval -0.35] [%clk 0:04:57] } 3. Qxe5+?? { [%eval -8.1] [%clk 0:04:50] } { (-0.35 → -8.10) Blunder. Bc4 was best. } { My first blitz game! } ( 3. Bc4 g6 4. Qf3 ) 3... Nxe5 { [%eval -8.0] [%clk 0:04:55] } { Black wins. } 0-1`;

const line = (score: number, pv: string[]) => ({ multipv: 1, score: { type: 'cp' as const, value: score }, pv });

/** The app's own engine results for the game (side to move's view). */
function positionsFor(tree: GameTree): PositionAnalysis[] {
  const fens = [tree.root.fen, ...mainLinePlies(tree).map((p) => p.fenAfter)];
  const lines = [
    line(30, ['e2e4', 'e7e5']),
    line(-30, ['e7e5', 'g1f3']),
    line(30, ['g1f3', 'b8c6']), // 2. Qh5 costs about a point: Excellent here
    line(-20, ['b8c6', 'f1c4']),
    line(20, ['f1c4', 'g7g6', 'h5f3']), // 3. Qxe5+?? hangs the queen
    line(800, ['c6e5', 'b1c3']),
    line(-800, ['b1c3', 'e5c6']),
  ];
  return fens.map((fen, i) => ({ fen, depth: 16, lines: [lines[i]!] }));
}

function review(tree: GameTree) {
  const positions = positionsFor(tree);
  const r = buildGameReview({
    preset: 'quick',
    budget: { movetimeMs: 200 },
    startFen: tree.root.fen,
    plies: mainLinePlies(tree),
    positions,
    isBookPosition: () => false,
  });
  return { r, pgn: buildAnnotatedPgn(tree, r, positions, 'Stockfish 17.1') };
}

describe('Phase 5 — earlier engine annotations never mix with a review', () => {
  it('recognises Lichess analysis comments and the app’s own review text', () => {
    expect(stripEngineComment('[%clk 0:04:58] (0.20 → -0.40) Inaccuracy. Nf3 was best.')).toEqual({
      human: '[%clk 0:04:58]',
      bestMoves: ['Nf3'],
    });
    expect(stripEngineComment('(#3 → 2.10) Lost forced checkmate sequence. Qxf7# was best. Nice try')).toEqual({
      human: 'Nice try',
      bestMoves: ['Qxf7#'],
    });
    expect(stripEngineComment('(-1.20 → #-2) Checkmate is now unavoidable. Kg1 was best.').human).toBe('');
    const own = withReviewComment('Plan: Nf5 next.', 'Blunder. Hangs the knight on d4 to exd4. Best: a4.');
    expect(own).toBe('Plan: Nf5 next. — Review: Blunder. Hangs the knight on d4 to exd4. Best: a4.');
    expect(stripEngineComment(own)).toEqual({ human: 'Plan: Nf5 next.', bestMoves: ['d4', 'exd4', 'a4'] });
    // Plain human comments are left alone
    expect(stripEngineComment('A real mistake by me, I was in time trouble.').human).toBe(
      'A real mistake by me, I was in time trouble.',
    );
  });

  it('strips evals, quality NAGs, engine comments and their variations from the main line', () => {
    const tree = parsePgn(LICHESS_ANNOTATED);
    const result = stripEngineAnnotations(tree);
    expect(result).toEqual({ evals: 6, nags: 2, comments: 2, variations: 2, own: 0 });
    const main = tree.getMainLine();
    expect(main.every((n) => n.eval === undefined && n.nags.length === 0)).toBe(true);
    expect(main.map((n) => n.comment)).toEqual([
      '[%clk 0:05:00]',
      '[%clk 0:05:00]',
      '[%clk 0:04:58]',
      '[%clk 0:04:57]',
      '[%clk 0:04:50] My first blitz game!',
      '[%clk 0:04:55] Black wins.',
    ]);
    // Only the main line is left: Lichess's "best" variations are gone
    expect(main.every((n) => tree.getNode(n.parentId!)!.children.length === 1)).toBe(true);
  });

  it('counts only what an imported PGN brought: the app’s own evals and review text go uncounted', () => {
    const tree = parsePgn('1. e4 e5 2. Nf3 Nc6 *');
    const [m1, m2, m3] = tree.getMainLine();
    // What live analysis and an earlier review leave behind
    tree.setEval(m1!.id, { cp: 20, depth: 18, app: true });
    tree.setEval(m2!.id, { cp: -15, depth: 18, app: true });
    tree.setComment(m3!.id, withReviewComment('', 'Good move.'));
    expect(stripEngineAnnotations(tree)).toEqual({ evals: 0, nags: 0, comments: 0, variations: 0, own: 3 });
    expect(tree.getMainLine().every((n) => n.eval === undefined && n.comment === '')).toBe(true);
    // A plain eval from a PGN is imported
    const imported = parsePgn('1. e4 { [%eval 0.2] } e5 { [%eval 0.1] } *');
    expect(stripEngineAnnotations(imported)).toMatchObject({ evals: 2, own: 0 });
  });

  it('a reviewed Lichess PGN exports with exactly one consistent annotation per move', () => {
    const tree = parsePgn(LICHESS_ANNOTATED);
    const { r, pgn } = review(tree);
    const byNode = new Map(r.moves.map((m) => [m.nodeId, m]));
    expect(r.moves.map((m) => [m.san, m.classification])).toEqual([
      ['e4', 'Best'],
      ['e5', 'Best'],
      ['Qh5', 'Excellent'],
      ['Nc6', 'Best'],
      ['Qxe5+', 'Blunder'],
      ['Nxe5', 'Best'],
    ]);

    // No Lichess analysis text survives; the human note and clocks do
    expect(pgn).not.toMatch(/was best|Inaccuracy\./);
    // The app's own sentences may quote an evaluation change; nothing else may
    expect(pgn.replace(/Review:[^}]*/g, '')).not.toMatch(/→/);
    expect(pgn).toContain('My first blitz game! — Review: Blunder.');
    expect(pgn).toContain('[%clk 0:04:50]');
    expect(pgn.match(/\[%eval/g)).toHaveLength(6);

    const exported = parsePgn(pgn);
    const main = exported.getMainLine();
    expect(main.map((n) => n.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Qxe5+', 'Nxe5']);
    const originalIds = mainLinePlies(tree).map((p) => p.nodeId);
    main.forEach((node, i) => {
      const move = byNode.get(originalIds[i]!)!;
      // Every NAG on a move is the app's own classification NAG, and only that
      const expectedNag = CLASSIFICATION_NAG[move.classification];
      expect(node.nags, node.san).toEqual(expectedNag === undefined ? [] : [expectedNag]);
      // One eval, the app's (depth 16), not Lichess's
      expect(node.eval?.depth, node.san).toBe(16);
      // At most one review text per move
      expect((node.comment.match(/Review:/g) ?? []).length).toBeLessThanOrEqual(1);
    });
    expect(main[2]!.nags).toEqual([]); // Lichess's ?! on Qh5 is gone: the app calls it Excellent
    expect(main[4]!.eval).toEqual({ cp: -800, depth: 16 });

    // One "best" variation for the blunder, the app's own; none for Qh5
    const siblings = (i: number) => exported.getNode(main[i]!.parentId!)!.children.map((c) => c.san);
    expect(siblings(2)).toEqual(['Qh5']);
    expect(siblings(4)).toEqual(['Qxe5+', 'Bc4']);
    expect(main[4]!.comment).toBe(
      '[%clk 0:04:50] My first blitz game! — Review: Blunder. Gives up the queen on e5 for a pawn; Nxe5 takes it. Best: Bc4.',
    );
  });

  it('reviewing an exported review again gives the same PGN (no duplicates pile up)', () => {
    const first = review(parsePgn(LICHESS_ANNOTATED)).pgn;
    const second = review(parsePgn(first)).pgn;
    expect(second).toBe(first);
  });
});
