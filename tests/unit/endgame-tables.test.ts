import { Chess } from 'chess.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { EndgameTables, type TableKind } from '../../src/trainers/endgame-tables';
import { ENDGAMES } from '../../src/trainers/endgames';
import { ensureOracle, exactMateDistance, longestMate } from '../helpers/dtm-oracle';
import { bestAttackerMove, mateAfterReply } from '../helpers/dtm-play';

/**
 * The app's solver (src/trainers/endgame-tables.ts) against the independent slow solver in
 * tests/helpers/dtm-oracle.ts, and the defence it plays against chess.js's move list plus that
 * oracle: whatever the defender plays must be a legal move that is DTM-optimal.
 */

const tables = new EndgameTables();
const KINDS: TableKind[] = ['q', 'r', 'p'];
const PIECE: Record<TableKind, string> = { q: 'Q', r: 'R', p: 'P' };

/** A small seeded generator (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fenOf(wk: number, bk: number, x: number, kind: TableKind, turn: 'w' | 'b'): string {
  const cells: string[] = Array(64).fill('');
  cells[wk] = 'K';
  cells[bk] = 'k';
  cells[x] = PIECE[kind];
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const c = cells[f + 8 * r]!;
      if (c === '') empty++;
      else {
        if (empty) row += empty;
        empty = 0;
        row += c;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} ${turn} - - 0 1`;
}

const adjacent = (a: number, b: number) => a !== b && Math.abs((a & 7) - (b & 7)) <= 1 && Math.abs((a >> 3) - (b >> 3)) <= 1;

/** Random positions with the kings apart and a legal pawn rank; the side not to move is not in check. */
function samples(kind: TableKind, turn: 'w' | 'b', count: number, seed: number): string[] {
  const next = rng(seed);
  const out: string[] = [];
  while (out.length < count) {
    const wk = Math.floor(next() * 64);
    const bk = Math.floor(next() * 64);
    const x = Math.floor(next() * 64);
    if (wk === bk || wk === x || bk === x || adjacent(wk, bk)) continue;
    if (kind === 'p' && ((x >> 3) < 1 || (x >> 3) > 6)) continue;
    const fen = fenOf(wk, bk, x, kind, turn);
    let chess: Chess;
    try {
      chess = new Chess(fen);
    } catch {
      continue; // chess.js refuses it (e.g. the side not to move is in check)
    }
    if (chess.moves().length === 0) continue;
    out.push(fen);
  }
  return out;
}

describe('endgame tables: the solver', () => {
  it('finds the known longest mates (K+Q v K 10, K+R v K 16, K+P v K 28)', () => {
    expect(tables.longestMate('q')).toBe(10);
    expect(tables.longestMate('r')).toBe(16);
    expect(tables.longestMate('p')).toBe(28);
  }, 60_000);

  it('agrees with the independent solver on every kind', async () => {
    await ensureOracle();
    expect(longestMate('q')).toBe(10);
    for (const kind of KINDS) {
      for (const fen of samples(kind, 'w', 2500, kind.charCodeAt(0))) {
        expect(tables.mateDistance(fen), fen).toBe(exactMateDistance(fen));
      }
    }
  }, 120_000);

  it('gives the drill positions their stored mate counts', () => {
    for (const entry of ENDGAMES) {
      if (entry.optimalMoves === null) continue;
      expect(tables.mateDistance(entry.fen), entry.id).toBe(entry.optimalMoves);
    }
  });

  it('knows nothing of other positions', () => {
    expect(tables.mateDistance('4k3/8/8/8/8/8/8/R3K2R w - - 0 1')).toBeNull(); // two rooks
    expect(tables.mateDistance('4k3/8/8/8/8/8/p7/4K3 w - - 0 1')).toBeNull(); // no White piece
    expect(tables.mateDistance('1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1')).toBeNull(); // Lucena
    expect(tables.covers('4k3/8/8/8/8/8/8/R3K2R b - - 0 1')).toBeNull();
    expect(tables.defend('1K1k4/1P6/8/8/8/8/r7/2R5 b - - 0 1')).toBeNull();
    expect(tables.covers('8/8/8/4k3/8/8/8/3QK3 b - - 0 1')).toBe('q');
  });
});

describe('endgame tables: the defender is DTM-optimal', () => {
  beforeAll(() => ensureOracle(), 120_000);

  for (const kind of KINDS) {
    it(`K+${PIECE[kind]} v K: every reply is legal and keeps the mate as far away as any legal reply`, () => {
      for (const fen of samples(kind, 'b', 1500, 7 + kind.charCodeAt(0))) {
        const chess = new Chess(fen);
        const legal = chess.moves({ verbose: true });
        const best = Math.max(...legal.map((m) => mateAfterReply(chess, m.from, m.to)));
        const d = tables.defend(fen);
        expect(d, fen).not.toBeNull();
        const mv = legal.find((m) => m.from + m.to === d!.move);
        expect(mv, `${fen}: ${d!.move} is not a legal move`).toBeDefined();
        const value = mateAfterReply(chess, mv!.from, mv!.to);
        expect(value, `${fen}: ${d!.move}`).toBe(best);
        expect(d!.stillWon, fen).toBe(best !== Infinity);
        expect(d!.mateIn, fen).toBe(best === Infinity ? null : best);
      }
    }, 120_000);
  }

  it('takes an unprotected piece when it can', () => {
    expect(tables.defend('8/8/8/8/8/2k5/2Q5/7K b - - 0 1')?.move).toBe('c3c2');
    // Protected by the king: not taken
    expect(tables.defend('8/8/8/8/8/2k5/2Q5/1K6 b - - 0 1')?.move).not.toBe('c3c2');
  });

  it('returns null when Black has no move', () => {
    expect(tables.defend('7k/7Q/6K1/8/8/8/8/8 b - - 0 1')).toBeNull(); // mate
    expect(tables.defend('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')).toBeNull(); // stalemate
  });

  it('mates every drill position in exactly the best possible number of moves against the defender', () => {
    for (const entry of ENDGAMES) {
      if (entry.optimalMoves === null) continue;
      const game = new Chess(entry.fen);
      let moves = 0;
      while (!game.isGameOver() && moves < 40) {
        // The attacker plays the move that gives the shortest mate against the best defence
        const pick = bestAttackerMove(game.fen());
        game.move(pick.san);
        moves++;
        if (game.isGameOver()) break;
        const d = tables.defend(game.fen());
        expect(d, game.fen()).not.toBeNull();
        game.move({ from: d!.move.slice(0, 2), to: d!.move.slice(2, 4), ...(d!.move.length > 4 ? { promotion: d!.move[4] } : {}) });
      }
      expect(game.isCheckmate(), entry.id).toBe(true);
      expect(moves, entry.id).toBe(entry.optimalMoves);
    }
  }, 120_000);
});
