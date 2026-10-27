import { describe, expect, it } from 'vitest';
import { RulesAdapter, type Piece, type Square } from '../../src/core/rules';
import {
  applyPremoveToSquares,
  boardSquaresFromAdapter,
  computePremoveTargetsOnSquares,
  planPieceTransitions,
} from '../../src/render/board-renderer';

const board = (fen: string) => boardSquaresFromAdapter(new RulesAdapter(fen));
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('Phase 3 — premove queue on a hypothetical board', () => {
  it('plans each premove on the board where earlier premoves were played and the opponent passed', () => {
    const squares = board('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    applyPremoveToSquares(squares, { from: 'g1', to: 'f3' });
    expect(squares.get('g1')).toBeUndefined();
    expect(squares.get('f3')).toEqual({ color: 'w', type: 'n' });

    // The same knight can be premoved again from where premove 1 left it
    const targets = computePremoveTargetsOnSquares(squares, 'f3', 'w');
    expect(targets.sort()).toEqual(['d4', 'e5', 'g5', 'h4', 'g1', 'e1', 'd2', 'h2'].sort());
    // ...and the original square has nothing left to premove
    expect(computePremoveTargetsOnSquares(squares, 'g1', 'w')).toEqual([]);
  });

  it('allows pawn diagonals onto empty squares and squares held by your own pieces', () => {
    const squares = board(START);
    expect(computePremoveTargetsOnSquares(squares, 'e2', 'w').sort()).toEqual(['d3', 'e3', 'e4', 'f3']);
    // Rook sliding through its own pieces: geometry only, blockers ignored
    const rook = computePremoveTargetsOnSquares(squares, 'a1', 'w');
    expect(rook).toContain('a2');
    expect(rook).toContain('a8');
    expect(rook).toContain('h1');
    // Not your piece: no premoves
    expect(computePremoveTargetsOnSquares(squares, 'e7', 'w')).toEqual([]);
  });

  it('offers castling toward own rooks on the home rank and moves the rook too', () => {
    const squares = board('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
    const king = computePremoveTargetsOnSquares(squares, 'e1', 'w');
    expect(king).toContain('g1');
    expect(king).toContain('c1');

    applyPremoveToSquares(squares, { from: 'e1', to: 'g1' });
    expect(squares.get('g1')).toEqual({ color: 'w', type: 'k' });
    expect(squares.get('f1')).toEqual({ color: 'w', type: 'r' });
    expect(squares.get('h1')).toBeUndefined();
  });

  it('promotes a premoved pawn to the chosen piece (queen by default)', () => {
    const squares = board('7k/P7/8/8/8/8/8/K7 b - - 0 1');
    applyPremoveToSquares(squares, { from: 'a7', to: 'a8', promotion: 'n' });
    expect(squares.get('a8')).toEqual({ color: 'w', type: 'n' });

    const again = board('7k/P7/8/8/8/8/8/K7 b - - 0 1');
    applyPremoveToSquares(again, { from: 'a7', to: 'a8' });
    expect(again.get('a8')).toEqual({ color: 'w', type: 'q' });
  });

  it('skips a premove whose piece is no longer on its square', () => {
    const squares = board(START);
    const before = new Map(squares);
    applyPremoveToSquares(squares, { from: 'e4', to: 'e5' });
    expect(squares).toEqual(before);
  });
});

describe('Phase 4 — board-diff animation planner', () => {
  const map = (entries: Array<[Square, Piece]>) => new Map<Square, Piece>(entries);
  const P = (color: 'w' | 'b', type: Piece['type']): Piece => ({ color, type });

  it('slides the moved piece forward, and the same piece back when stepping backward', () => {
    const before = board(START);
    const after = board('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    expect(planPieceTransitions(before, after)).toEqual([{ from: 'e2', to: 'e4' }]);
    expect(planPieceTransitions(after, before)).toEqual([{ from: 'e4', to: 'e2' }]);
  });

  it('moves the rook with the king when castling, in both directions', () => {
    const before = board('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const after = board('r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1');
    const forward = planPieceTransitions(before, after);
    expect(forward).toContainEqual({ from: 'e1', to: 'g1' });
    expect(forward).toContainEqual({ from: 'h1', to: 'f1' });
    const backward = planPieceTransitions(after, before);
    expect(backward).toContainEqual({ from: 'g1', to: 'e1' });
    expect(backward).toContainEqual({ from: 'f1', to: 'h1' });
  });

  it('a capture slides the capturer; un-capturing slides it back and the victim reappears in place', () => {
    const before = map([
      ['d4', P('w', 'n')],
      ['e6', P('b', 'p')],
    ]);
    const after = map([['e6', P('w', 'n')]]);
    expect(planPieceTransitions(before, after)).toEqual([{ from: 'd4', to: 'e6' }]);
    // Stepping back: knight returns, the pawn on e6 has no partner, so it simply appears
    expect(planPieceTransitions(after, before)).toEqual([{ from: 'e6', to: 'd4' }]);
  });

  it('pairs a promoted piece with its pawn, forward and backward', () => {
    const before = map([['a7', P('w', 'p')]]);
    const after = map([['a8', P('w', 'q')]]);
    expect(planPieceTransitions(before, after)).toEqual([{ from: 'a7', to: 'a8' }]);
    expect(planPieceTransitions(after, before)).toEqual([{ from: 'a8', to: 'a7' }]);
  });

  it('matches each appearing piece with the nearest vanished piece of the same kind', () => {
    // Two white rooks swap roles: a1→d1 and h1→e1 (nearest-first, never crossing)
    const before = map([
      ['a1', P('w', 'r')],
      ['h1', P('w', 'r')],
    ]);
    const after = map([
      ['d1', P('w', 'r')],
      ['e1', P('w', 'r')],
    ]);
    const plan = planPieceTransitions(before, after);
    expect(plan).toContainEqual({ from: 'a1', to: 'd1' });
    expect(plan).toContainEqual({ from: 'h1', to: 'e1' });
  });

  it('plans nothing when the board is unchanged (an executed premove that was already shown)', () => {
    const squares = board(START);
    expect(planPieceTransitions(squares, new Map(squares))).toEqual([]);
  });
});
