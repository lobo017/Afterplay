import { describe, expect, it } from 'vitest';
import puzzlesJson from '../../data/puzzles.json';
import type { PuzzleEntry } from '../../src/core/datasets';
import { RulesAdapter } from '../../src/core/rules';
import { PuzzleFormatError, preparePuzzle, sameMove } from '../../src/trainers/puzzle-format';
import { PuzzleSession } from '../../src/trainers/puzzle-session';

const puzzles = puzzlesJson as PuzzleEntry[];

/** The FEN piece letter on a square ("e1"), or null. */
function pieceAt(board: string, square: string): string | null {
  const file = square.charCodeAt(0) - 97;
  const row = board.split('/')[8 - Number(square[1])] ?? '';
  let f = 0;
  for (const ch of row) {
    if (/\d/.test(ch)) f += Number(ch);
    else if (f++ === file) return ch;
    if (f > file) return null;
  }
  return null;
}
const byId = (id: string) => {
  const p = puzzles.find((x) => x.id === id);
  if (!p) throw new Error(`missing dataset puzzle ${id}`);
  return p;
};

// Lichess puzzle CSV: FEN is the position BEFORE the opponent's move; the first move in
// Moves is the opponent's, and the solution starts at the second move.
describe('Phase 6 — puzzle loader: the first move is the opponent’s', () => {
  it('plays moves[0] for the opponent and starts the puzzle after it (0ND4A)', () => {
    const entry = byId('0ND4A');
    // White to move in the stored FEN; e1f1 (Rxf1, taking the queen) is White's move
    expect(entry.fen).toBe('5rk1/pp6/2p1R3/3n2pp/P7/6P1/6NP/4Rq1K w - - 2 40');
    expect(entry.moves).toEqual(['e1f1', 'f8f1']);

    const p = preparePuzzle(entry);
    expect(p.setupFen).toBe(entry.fen);
    expect(p.setupMove.color).toBe('w');
    expect(p.setupMove.san).toBe('Rxf1');
    // The player is Black: the side to move after the opponent's move
    expect(p.playerColor).toBe('b');
    expect(p.startFen.split(' ')[1]).toBe('b');
    const afterOpponent = new RulesAdapter(entry.fen);
    afterOpponent.move({ from: 'e1', to: 'f1' });
    expect(p.startFen).toBe(afterOpponent.fen());
    expect(p.solution).toEqual(['f8f1']);
    expect(p.solutionSan).toEqual(['Rxf1#']);
    expect(p.endsInMate).toBe(true);
  });

  it('expects the second move from the player, and the opponent’s move is not the player’s to make', () => {
    const p = preparePuzzle(byId('0ND4A'));
    // Treating moves[0] as the player's first move would be wrong: it isn't even legal now
    const asIfPlayers = new PuzzleSession(p).play('e1f1');
    expect(asIfPlayers.kind).toBe('illegal');
    // The real first player move is moves[1]
    const s = new PuzzleSession(p);
    expect(s.expectedMove).toBe('f8f1');
    expect(s.play('f8f1')).toEqual({ kind: 'correct', uci: 'f8f1', reply: null, solved: true });
    expect(s.outcome?.solved).toBe(true);
  });

  it('alternates player moves and opponent replies after the setup move (multi-move puzzle)', () => {
    const entry = byId('1yy9U'); // b1c1 (White) | c8c1 e6e1 c1e1 (Black, White, Black#)
    const p = preparePuzzle(entry);
    expect(p.setupMove.color).toBe('w');
    expect(p.playerColor).toBe('b');
    expect(p.solution).toEqual(['c8c1', 'e6e1', 'c1e1']);
    const s = new PuzzleSession(p);
    expect(s.play('c8c1')).toEqual({ kind: 'correct', uci: 'c8c1', reply: 'e6e1', solved: false });
    expect(s.fen.split(' ')[1]).toBe('b');
    expect(s.play('c1e1')).toEqual({ kind: 'correct', uci: 'c1e1', reply: null, solved: true });
    expect(s.movesPlayed).toEqual(['c8c1', 'e6e1', 'c1e1']);
  });

  it('rejects puzzles whose solution would end on the opponent’s move, or with illegal moves', () => {
    expect(() => preparePuzzle({ id: 'x', fen: byId('0ND4A').fen, moves: ['e1f1'] })).toThrow(PuzzleFormatError);
    expect(() => preparePuzzle({ id: 'x', fen: byId('1yy9U').fen, moves: ['b1c1', 'c8c1', 'e6e1'] })).toThrow(
      /end on the player/,
    );
    expect(() => preparePuzzle({ id: 'x', fen: byId('0ND4A').fen, moves: ['f8f1', 'e1f1'] })).toThrow(
      /Illegal move f8f1/,
    );
  });

  it('all 20,000 bundled puzzles: moves[0] moves a piece of the FEN’s side to move, the solution ends on a player move', () => {
    // Structural, without move generation (chess.js needs ~1 ms per puzzle): the piece on
    // moves[0]'s from-square belongs to the side to move in the FEN, so the first move is
    // the opponent's, and an even number of moves leaves an odd-length solution.
    expect(puzzles.length).toBe(20000);
    for (const entry of puzzles) {
      const [board, side] = entry.fen.split(' ');
      const piece = pieceAt(board!, entry.moves[0]!.slice(0, 2));
      expect(piece, entry.id).not.toBeNull();
      expect(piece === piece!.toUpperCase() ? 'w' : 'b', entry.id).toBe(side);
      expect(entry.moves.length % 2, entry.id).toBe(0);
    }
  });

  it('a fixed sample of 2,000 bundled puzzles loads: legal, player opposite the FEN’s side, mate puzzles end in mate', async () => {
    let mates = 0;
    for (let i = 0; i < puzzles.length; i += 10) {
      const entry = puzzles[i]!;
      const p = preparePuzzle(entry);
      const fenSide = entry.fen.split(' ')[1];
      expect(p.setupMove.color, entry.id).toBe(fenSide);
      expect(p.playerColor, entry.id).not.toBe(fenSide);
      expect(p.solution.length % 2, entry.id).toBe(1);
      if (entry.themes.includes('mate')) {
        expect(p.endsInMate, entry.id).toBe(true);
        mates++;
      }
      // Let the test runner's messages through during the long loop
      if (i % 500 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    expect(mates).toBeGreaterThan(300);
  }, 60_000);

  it('matches moves by the position they reach (castling written two ways, promotion piece)', () => {
    const castle = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    expect(sameMove(castle, 'e1g1', 'e1g1')).toBe(true);
    expect(sameMove(castle, 'e1g1', 'e1c1')).toBe(false);
    const promo = '8/4P3/8/8/8/8/k7/4K3 w - - 0 1';
    expect(sameMove(promo, 'e7e8q', 'e7e8q')).toBe(true);
    expect(sameMove(promo, 'e7e8q', 'e7e8n')).toBe(false);
  });
});
