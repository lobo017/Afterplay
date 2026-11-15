import { describe, expect, it } from 'vitest';
import type { UserAccount } from '../../src/review/perspective';
import type { StoredGameRecord } from '../../src/storage/db';
import { computeStoryStats, mainLineMoves, storyGames } from '../../src/story/stats';
import { ME, game, utc } from './helpers/story-games';

// The both-sites duplicate key tokenises the whole game, so it is built only when games from both sites are counted.
// What the Story counts must not depend on that: these tests compare it with the rule written out here.
const NOW = utc(2026, 6, 20);
const mine: UserAccount[] = [
  { site: 'chesscom', username: ME },
  { site: 'lichess', username: ME },
];

/** The pairing rule, written out from the definition: a Lichess game pairs with an unpaired Chess.com game of the same key. */
function referenceDuplicates(records: readonly StoredGameRecord[]): number {
  const key = (r: StoredGameRecord): string | null => {
    const moves = mainLineMoves(r.pgn);
    const day = new Date(r.playedAt!).toISOString().slice(0, 10);
    return moves.length >= 20 ? `${moves.join(' ')}|${r.result}|${r.black === ME ? 'b' : 'w'}|${day}` : null;
  };
  const open = new Map<string, number>();
  for (const r of records.filter((x) => x.source === 'chesscom')) {
    const k = key(r);
    if (k) open.set(k, (open.get(k) ?? 0) + 1);
  }
  let pairs = 0;
  for (const r of records.filter((x) => x.source === 'lichess').sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const k = key(r);
    const left = k ? (open.get(k) ?? 0) : 0;
    if (left > 0) {
      open.set(k!, left - 1);
      pairs++;
    }
  }
  return pairs;
}

/** The records with every read of `pgn` counted. */
function countingReads(records: readonly StoredGameRecord[]): { records: StoredGameRecord[]; reads: () => number } {
  let reads = 0;
  const wrapped = records.map((r) => {
    const copy = { ...r };
    Object.defineProperty(copy, 'pgn', {
      enumerable: true,
      get() {
        reads++;
        return r.pgn;
      },
    });
    return copy as StoredGameRecord;
  });
  return { records: wrapped, reads: () => reads };
}

const chesscom = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, i) =>
    game({ id: `${prefix}${i}`, at: utc(2026, 1, 1 + (i % 20)), variantSalt: `${prefix}${i}` }),
  );

describe('the both-sites duplicate key', () => {
  it('still counts a game found on both sites once', () => {
    const shared = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`,
      at: utc(2026, 2, 1 + i),
      variantSalt: `s${i}`,
    }));
    const records = [
      ...chesscom(20, 'c'),
      ...shared.map((s) => game({ ...s, source: 'chesscom' })),
      ...shared.map((s) => game({ ...s, source: 'lichess' })),
      ...Array.from({ length: 13 }, (_, i) =>
        game({ id: `l${i}`, source: 'lichess', at: utc(2026, 3, 1 + i), variantSalt: `l${i}` }),
      ),
    ];
    const s = computeStoryStats(records, mine, NOW);
    expect(referenceDuplicates(records)).toBe(7);
    expect(s.onBothSites).toBe(7);
    expect(s.chesscom.games).toBe(27);
    expect(s.lichess.games).toBe(20);
    expect(s.all.games).toBe(27 + 20 - 7);
    expect(storyGames(records, mine)).toHaveLength(s.all.games);
  });

  it('gives the same numbers for one site only, where nothing can pair', () => {
    // Two Chess.com games alike in every way are two games: only a Lichess copy pairs with a Chess.com game
    const records = [
      ...chesscom(30, 'c'),
      game({ id: 'twin-a', variantSalt: 'twin' }),
      game({ id: 'twin-b', variantSalt: 'twin' }),
    ];
    const s = computeStoryStats(records, mine, NOW);
    expect(referenceDuplicates(records)).toBe(0);
    expect(s.onBothSites).toBe(0);
    expect(s.all.games).toBe(32);
    expect({ ...s.all, scope: 'chesscom' }).toEqual(s.chesscom);
    expect(storyGames(records, mine)).toHaveLength(32);
    const lichessOnly = records.map((r) => ({ ...r, source: 'lichess' as const }));
    const l = computeStoryStats(lichessOnly, mine, NOW);
    expect(l.onBothSites).toBe(0);
    expect(l.all.games).toBe(32);
  });

  it('gives the same numbers when the second site has games but none is a duplicate', () => {
    const records = [
      ...chesscom(20, 'c'),
      ...Array.from({ length: 10 }, (_, i) =>
        game({ id: `l${i}`, source: 'lichess', at: utc(2026, 4, 1 + i), variantSalt: `other${i}` }),
      ),
      // Alike in moves and colour but on another day, and alike in everything but the result: not duplicates either
      game({ id: 'near-a', source: 'chesscom', at: utc(2026, 5, 1), variantSalt: 'near' }),
      game({ id: 'near-a', source: 'lichess', at: utc(2026, 5, 2), variantSalt: 'near' }),
      game({ id: 'near-b', source: 'chesscom', at: utc(2026, 5, 3), variantSalt: 'near2', outcome: 'win' }),
      game({ id: 'near-b', source: 'lichess', at: utc(2026, 5, 3), variantSalt: 'near2', outcome: 'loss' }),
    ];
    const s = computeStoryStats(records, mine, NOW);
    expect(referenceDuplicates(records)).toBe(0);
    expect(s.onBothSites).toBe(0);
    expect(s.all.games).toBe(s.chesscom.games + s.lichess.games);
    expect(s.all.games).toBe(34);
  });

  it('builds no key without games from both sites, and builds them when both are counted', () => {
    const one = countingReads(chesscom(25, 'c'));
    computeStoryStats(one.records, mine, NOW);
    expect(one.reads()).toBe(25); // each game is read once, for its headers

    const lichessOnly = countingReads(chesscom(25, 'l').map((r) => ({ ...r, source: 'lichess' as const })));
    storyGames(lichessOnly.records, mine);
    expect(lichessOnly.reads()).toBe(25);

    const both = countingReads([
      ...chesscom(25, 'c'),
      ...chesscom(5, 'x').map((r) => ({ ...r, id: `lichess:${r.id}`, source: 'lichess' as const })),
    ]);
    computeStoryStats(both.records, mine, NOW);
    expect(both.reads()).toBe(2 * 30); // read for its headers and again for its key
  });

  it('does not count a game of the second site that is not mine as a reason to build keys', () => {
    const records = [...chesscom(20, 'c'), game({ id: 'stranger', source: 'lichess', me: 'someoneelse' })];
    const counting = countingReads(records);
    const s = computeStoryStats(counting.records, mine, NOW);
    expect(s.excluded.notMine).toBe(1);
    expect(s.all.games).toBe(20);
    expect(counting.reads()).toBe(20); // one read each for the games that are mine, no key; the stranger's is not read
  });
});
