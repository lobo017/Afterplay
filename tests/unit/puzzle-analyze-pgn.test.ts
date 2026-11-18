import { describe, expect, it } from 'vitest';
import { parsePgn } from '../../src/core/pgn';
import { preparePuzzle } from '../../src/trainers/puzzle-format';
import { numberedLine, puzzlePgn } from '../../src/trainers/puzzle-trainer';

// "Analyze the position" hands the puzzle to the analysis board as a PGN. It used to write Black's first move as "3… Nf6"
// (a Unicode ellipsis), which the PGN reader refuses, so the action did nothing for every puzzle whose setup move is
// Black's (the player is White). Invented positions.
const epd = (fen: string) => fen.split(' ').slice(0, 4).join(' ');

const WHITE_TO_SOLVE = {
  id: 'w',
  fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3',
  moves: ['g8f6', 'h5f7'],
};
const BLACK_TO_SOLVE = {
  id: 'b',
  fen: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2',
  moves: ['g2g4', 'd8h4'],
};

describe('the puzzle as a PGN for the analysis board', () => {
  for (const [name, source] of [
    ['a puzzle for White (Black’s setup move first)', WHITE_TO_SOLVE],
    ['a puzzle for Black (White’s setup move first)', BLACK_TO_SOLVE],
  ] as const) {
    it(`reads back: ${name}`, () => {
      const prepared = preparePuzzle(source);
      const line = parsePgn(puzzlePgn(prepared, 'Puzzle from my game as White · 2026-11-10')).getMainLine();
      expect(line.map((n) => n.san)).toEqual([prepared.setupMove.san, ...prepared.solutionSan]);
      // Ply 1 is the puzzle position, where the player is to move
      expect(epd(line[0]!.fen)).toBe(epd(prepared.startFen));
    });
  }

  it('numbers a Black move with "…" on screen and "..." in a PGN', () => {
    const fen = WHITE_TO_SOLVE.fen;
    expect(numberedLine(fen, ['Nf6', 'Qxf7#'])).toBe('3… Nf6 4. Qxf7#');
    expect(numberedLine(fen, ['Nf6', 'Qxf7#'], '...')).toBe('3... Nf6 4. Qxf7#');
  });
});
