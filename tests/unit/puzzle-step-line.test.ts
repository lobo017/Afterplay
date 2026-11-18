import { describe, expect, it } from 'vitest';
import { buildStepLine } from '../../src/trainers/puzzle-format';
import { numberedLine, numberedTokens } from '../../src/trainers/puzzle-trainer';

// The positions the step buttons show once a puzzle is over: step 0 is the puzzle position, step k the position after k
// moves of the printed line. Invented lines in standard positions.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MATE_IN_ONE = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

const epd = (fen: string) => fen.split(' ').slice(0, 4).join(' ');

describe('the line the step buttons walk', () => {
  it('has the puzzle position first and one position per move after it', () => {
    const line = buildStepLine(START, ['e4', 'e5', 'Nf3'], []);
    expect(line.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3']);
    expect(line.fens).toHaveLength(4);
    expect(line.fens[0]).toBe(START);
    expect(epd(line.fens[1]!)).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -');
    expect(epd(line.fens[3]!)).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -');
  });

  it('a move leads from the position before it to the position after it', () => {
    const line = buildStepLine(MATE_IN_ONE, ['Qxf7#'], []);
    expect(line.moves).toHaveLength(1);
    expect(line.moves[0]).toMatchObject({ from: 'h5', to: 'f7', color: 'w' });
    expect(epd(line.fens[1]!)).toBe('r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq -');
  });

  it('ends the line at a move that does not apply, keeping the moves before it', () => {
    const line = buildStepLine(START, ['e4', 'e5', 'Qxh7', 'Nf3'], []);
    expect(line.moves.map((m) => m.san)).toEqual(['e4', 'e5']);
    expect(line.fens).toHaveLength(3);
  });

  it('falls back to the puzzle’s own solution when the printed line applies not at all', () => {
    const line = buildStepLine(START, ['Qxh7'], ['e2e4', 'e7e5']);
    expect(line.moves.map((m) => m.san)).toEqual(['e4', 'e5']);
    expect(line.fens).toHaveLength(3);
  });

  it('has no moves when neither applies', () => {
    const line = buildStepLine(START, [], []);
    expect(line.moves).toEqual([]);
    expect(line.fens).toEqual([START]);
  });
});

describe('the printed line in pieces', () => {
  it('is the same text as the one-line form, one piece per move', () => {
    const sans = ['Nf6', 'Qxf7#'];
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
    expect(numberedTokens(fen, sans)).toEqual(['3… Nf6', '4. Qxf7#']);
    expect(numberedTokens(fen, sans).join(' ')).toBe(numberedLine(fen, sans));
    expect(numberedTokens(START, ['e4', 'e5', 'Nf3'])).toEqual(['1. e4', 'e5', '2. Nf3']);
  });
});
