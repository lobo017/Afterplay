import { describe, expect, it } from 'vitest';
import { playedMoveSquares } from '../../src/trainers/puzzle-format';

// The move I played in the game, marked on a puzzle from it: the squares of `playedSan` from the puzzle position.
const START = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

describe('the squares of the move I played in the game', () => {
  it('plays the SAN from the puzzle position', () => {
    expect(playedMoveSquares(START, 'Qh5')).toEqual({ from: 'd1', to: 'h5' });
    expect(playedMoveSquares(START, 'Nf3')).toEqual({ from: 'g1', to: 'f3' });
  });

  it('reads a capture, a check mark and a castling move', () => {
    const fen = 'r3k2r/pppq1ppp/2n2n2/3pp3/3PP3/2N2N2/PPPQ1PPP/R3K2R w KQkq - 0 1';
    expect(playedMoveSquares(fen, 'dxe5')).toEqual({ from: 'd4', to: 'e5' });
    expect(playedMoveSquares(fen, 'Qd2+')).toBeNull(); // not legal there (the queen is on d2 already)
    expect(playedMoveSquares(fen, 'O-O-O')).toEqual({ from: 'e1', to: 'c1' });
  });

  it('is null with no played move, or a move that does not apply in the position', () => {
    expect(playedMoveSquares(START, undefined)).toBeNull();
    expect(playedMoveSquares(START, '')).toBeNull();
    expect(playedMoveSquares(START, 'Qxh7')).toBeNull();
    expect(playedMoveSquares(START, 'not a move')).toBeNull();
  });
});
