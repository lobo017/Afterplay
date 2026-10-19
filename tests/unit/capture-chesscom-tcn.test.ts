import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePgn } from '../../src/core/pgn';
import { DEFAULT_POSITION } from '../../src/core/rules';
import { decodeTcn, tcnToSan } from '../../extension/src/extractors/chesscom-tcn';

const DIR = path.join(__dirname, '..', 'fixtures', 'capture', 'chesscom');

interface ArchiveGame {
  url: string;
  pgn: string;
  tcn: string;
  rules: string;
  initial_setup: string;
}

function archive(file: string): ArchiveGame[] {
  return (JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) as { games: ArchiveGame[] }).games;
}

const ALL = [...archive('archive-hikaru-2026-10.json'), ...archive('archive-erik-2026-10.json')];

describe("Phase 5b — Chess.com's TCN move format", () => {
  it('decodes squares, promotions and the direction of a promoting capture', () => {
    expect(decodeTcn('mC')).toEqual([{ from: 'e2', to: 'e4' }]);
    // '?' = h8, 'a' = a1
    expect(decodeTcn('?a')).toEqual([{ from: 'h8', to: 'a1' }]);
    // a7 (index 48) promoting: '{' queen capture-left, '~' queen straight, '}' queen capture-right
    expect(decodeTcn('W~')).toEqual([{ from: 'a7', to: 'a8', promotion: 'q' }]);
    expect(decodeTcn('X{')).toEqual([{ from: 'b7', to: 'a8', promotion: 'q' }]);
    expect(decodeTcn('X}')).toEqual([{ from: 'b7', to: 'c8', promotion: 'q' }]);
    // Underpromotions: '^' knight straight, '_' rook straight, '#' bishop straight
    expect(decodeTcn('W^')[0]!.promotion).toBe('n');
    expect(decodeTcn('W_')[0]!.promotion).toBe('r');
    expect(decodeTcn('W#')[0]!.promotion).toBe('b');
    // Black promotes towards rank 1: h2 (index 15)
    expect(decodeTcn('p~')).toEqual([{ from: 'h2', to: 'h1', promotion: 'q' }]);
    expect(() => decodeTcn('m')).toThrow();
    expect(() => decodeTcn('m%')).toThrow();
  });

  it(`reproduces Chess.com's own PGN for every recorded archive game (${ALL.length} games)`, () => {
    let promotions = 0;
    let castles = 0;
    let chess960 = 0;
    for (const game of ALL) {
      const tree = parsePgn(game.pgn);
      const expected = tree.getMainLine().map((n) => n.san);
      const is960 = game.rules === 'chess960';
      const start = game.initial_setup || DEFAULT_POSITION;
      // The archive's initial_setup for Chess960 carries KQkq; the PGN's FEN header has the rook files
      const fen = is960 ? (tree.getHeaders().FEN ?? start) : start;
      const sans = tcnToSan(game.tcn, fen, is960);
      expect(sans, game.url).toEqual(expected);
      promotions += sans.filter((s) => s.includes('=')).length;
      castles += sans.filter((s) => s.startsWith('O-O')).length;
      if (is960) chess960++;
    }
    // The fixtures cover what the decoder has to get right
    expect(promotions).toBeGreaterThan(5);
    expect(castles).toBeGreaterThan(20);
    expect(chess960).toBe(1);
  }, 30_000);

  it('rejects a move that is not legal in the position', () => {
    expect(() => tcnToSan('mCmC', DEFAULT_POSITION, false)).toThrow(/TCN move 2/);
  });
});
