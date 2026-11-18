import { RulesAdapter, type Color } from '../../../src/core/rules';
import type { StoredGameRecord } from '../../../src/storage/db';

/** A small seeded random source (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A line of SAN moves: `prefix`, then random legal moves (from the seed) until it has `plies` moves or the game is over.
 * Invented games only: nothing here comes from a real game.
 */
export function playout(prefix: readonly string[], plies: number, seed: number): string[] {
  const rng = seeded(seed);
  const adapter = new RulesAdapter();
  const line: string[] = [];
  for (const san of prefix) {
    adapter.move(san);
    line.push(san);
  }
  while (line.length < plies && !adapter.isGameOver()) {
    const moves = adapter.sanMoves();
    const san = moves[Math.floor(rng() * moves.length)]!;
    adapter.move(san);
    line.push(san);
  }
  return line;
}

/** "1. e4 e5 2. Nf3" from a SAN list. */
export function movetext(sans: readonly string[]): string {
  const parts: string[] = [];
  sans.forEach((san, i) => {
    if (i % 2 === 0) parts.push(`${i / 2 + 1}.`);
    parts.push(san);
  });
  return parts.join(' ');
}

let counter = 0;

/** A stored game record for an invented game. `playerColor` defaults to White. */
export function record(sans: readonly string[], overrides: Partial<StoredGameRecord> = {}): StoredGameRecord {
  counter++;
  return {
    id: `synthetic:${counter}`,
    white: 'White',
    black: 'Black',
    playerColor: 'w' as Color,
    result: '1-0',
    date: '2026.01.01',
    openingEco: '',
    openingName: '',
    accuracy: null,
    pgn: `[Event "Test"]\n[Result "1-0"]\n\n${movetext(sans)} 1-0`,
    tags: [],
    schemaVersion: 4,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}
