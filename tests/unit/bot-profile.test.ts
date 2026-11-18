import { describe, expect, it } from 'vitest';
import { DEFAULT_POSITION, RulesAdapter } from '../../src/core/rules';
import {
  DEFAULT_PLIES_CAP,
  bookCoverage,
  buildBook,
  buildBookAsync,
  defaultMinCountByPly,
  lookupBook,
  parseBook,
  peakWindow,
  positionKey,
  serializeBook,
  type Book,
} from '../../src/engine/bot-profile';
import type { StoredGameRecord } from '../../src/storage/db';
import { playout, record, seeded } from './helpers/book-games';

const START = positionKey(DEFAULT_POSITION);

/** The key of the position after these moves. */
function keyAfter(sans: readonly string[]): string {
  const adapter = new RulesAdapter();
  for (const san of sans) adapter.move(san);
  return positionKey(adapter.fen());
}

const book = (entries: Book['entries'], pliesCap = 36): Book => ({ v: 1, pliesCap, entries });

describe('bot-profile: building a book from stored games', () => {
  it('counts the games behind each move and orders the moves most played first', () => {
    const games = [record(['e4', 'e5']), record(['e4', 'c5']), record(['d4', 'd5'])];
    const { book: own, stats } = buildBook(games, { side: 'own' });
    expect(own.entries[START]).toEqual([
      ['e2e4', 2],
      ['d2d4', 1],
    ]);
    expect(Object.keys(own.entries)).toHaveLength(1); // only White's own moves: one position each at ply 0
    expect(stats).toMatchObject({ gamesUsed: 3, positions: 1, entries: 2, pruned: 0, skipped: {} });

    const { book: opp } = buildBook(games, { side: 'opponent' });
    expect(opp.entries[keyAfter(['e4'])]).toEqual([
      ['c7c5', 1],
      ['e7e5', 1],
    ]);
    expect(opp.entries[keyAfter(['d4'])]).toEqual([['d7d5', 1]]);
  });

  it('chooses with weight proportional to the count', () => {
    const b = buildBook([record(['e4']), record(['e4']), record(['d4'])], { side: 'own' }).book;
    expect(lookupBook(b, DEFAULT_POSITION, () => 0.5)).toBe('e2e4'); // 1.5 of 3: inside e4's weight 2
    expect(lookupBook(b, DEFAULT_POSITION, () => 0.7)).toBe('d2d4'); // 2.1 of 3: past it
  });

  it('records only the first pliesCap plies (default 36)', () => {
    expect(DEFAULT_PLIES_CAP).toBe(36);
    const line = playout([], 8, 11);
    expect(line).toHaveLength(8);
    const own4 = buildBook([record(line)], { side: 'own', pliesCap: 4 });
    const opp4 = buildBook([record(line)], { side: 'opponent', pliesCap: 4 });
    expect(own4.book.pliesCap).toBe(4);
    expect(Object.keys(own4.book.entries)).toHaveLength(2); // plies 0 and 2
    expect(Object.keys(opp4.book.entries)).toHaveLength(2); // plies 1 and 3
    expect(Object.keys(buildBook([record(line)], { side: 'own', pliesCap: 5 }).book.entries)).toHaveLength(3);
    expect(() => buildBook([], { side: 'own', pliesCap: 0 })).toThrow(RangeError);
    expect(() => buildBook([], { side: 'own', pliesCap: 1000 })).toThrow(RangeError);
  });

  it('keeps a move seen once before ply 20 and needs two games from ply 20 on, unless told otherwise', () => {
    expect(defaultMinCountByPly(19)).toBe(1);
    expect(defaultMinCountByPly(20)).toBe(2);
    const line = playout([], 24, 1);
    expect(line).toHaveLength(24);
    const entries = (o: Parameters<typeof buildBook>[1], n: number): number =>
      buildBook(
        Array.from({ length: n }, () => record(line)),
        o,
      ).stats.entries;

    expect(entries({ side: 'own' }, 1)).toBe(10); // White's plies 0, 2 ... 18
    expect(entries({ side: 'opponent' }, 1)).toBe(10); // Black's plies 1 ... 19
    expect(entries({ side: 'own' }, 2)).toBe(12); // plies 0 ... 22: two games satisfy the threshold of 2
    expect(entries({ side: 'own', minCount: 2 }, 1)).toBe(0);
    expect(entries({ side: 'own', minCount: 1 }, 1)).toBe(12); // a constant 1 keeps every ply
    expect(entries({ side: 'own', minCount: 2 }, 2)).toBe(12);
    expect(entries({ side: 'own', minCountByPly: (ply) => (ply < 10 ? 1 : 99) }, 5)).toBe(5);
    // minCountByPly wins over the shorthand
    expect(entries({ side: 'own', minCount: 99, minCountByPly: () => 1 }, 1)).toBe(12);
  });

  it('prunes count-1 moves deepest first, then count-2 moves deepest first, and never before ply 12', () => {
    const a = playout([], 24, 5);
    expect(a).toHaveLength(24);
    let c: string[] = [];
    for (let seed = 1; seed < 50; seed++) {
      c = playout(a.slice(0, 14), 24, seed);
      if (c[14] !== a[14] && c.length === 24) break;
    }
    expect(c[14]).not.toBe(a[14]);
    const games = [record(a), record(a), record(c)];
    const full = buildBook(games, { side: 'own' });
    // White's plies 0..12 shared by three games (7), ply 14 two moves, 16 and 18 two moves each, 20 and 22 only a's
    expect(full.stats.entries).toBe(15);
    expect(full.stats.pruned).toBe(0);
    expect(full.stats.prunedByCount).toBeUndefined();

    const movesAt = (b: Book, sans: readonly string[]): string[] => (b.entries[keyAfter(sans)] ?? []).map(([u]) => u);
    const cUci = (ply: number): string => uciAt(c, ply);

    const pruned2 = buildBook(games, { side: 'own', maxEntries: 13 });
    expect(pruned2.stats).toMatchObject({ entries: 13, pruned: 2, prunedByCount: { '1': 2 } });
    expect(movesAt(pruned2.book, c.slice(0, 18))).not.toContain(cUci(18)); // c's deepest moves go first
    expect(movesAt(pruned2.book, c.slice(0, 16))).not.toContain(cUci(16));
    expect(movesAt(pruned2.book, c.slice(0, 14))).toContain(cUci(14));

    const pruned5 = buildBook(games, { side: 'own', maxEntries: 10 });
    expect(pruned5.stats).toMatchObject({ entries: 10, pruned: 5, prunedByCount: { '1': 3, '2': 2 } });
    expect(movesAt(pruned5.book, c.slice(0, 14))).not.toContain(cUci(14)); // all count-1 moves are gone
    expect(movesAt(pruned5.book, a.slice(0, 22))).toEqual([]); // then the deepest count-2 moves: ply 22 and ply 20
    expect(movesAt(pruned5.book, a.slice(0, 20))).toEqual([]);
    expect(movesAt(pruned5.book, a.slice(0, 18))).not.toEqual([]); // ply 18 (count 2) is still there

    const pruned0 = buildBook(games, { side: 'own', maxEntries: 0 });
    expect(pruned0.stats.entries).toBe(6); // White's plies 0..10: nothing before ply 12 is touched
    expect(pruned0.stats.pruned).toBe(9);
    expect(movesAt(pruned0.book, a.slice(0, 10))).toEqual([uciAt(a, 10)]);
    expect(movesAt(pruned0.book, a.slice(0, 12))).toEqual([]);
  });

  it('builds the opponent side from the other colour, for a user who played Black', () => {
    const line = playout([], 6, 3);
    const black = record(line, { playerColor: 'b' });
    const own = buildBook([black], { side: 'own' }).book;
    const opp = buildBook([black], { side: 'opponent' }).book;
    expect(Object.keys(own.entries)).toHaveLength(3);
    expect(Object.keys(opp.entries)).toHaveLength(3);
    for (const key of Object.keys(own.entries)) expect(key.split(' ')[1]).toBe('b'); // the user moves as Black
    for (const key of Object.keys(opp.entries)) expect(key.split(' ')[1]).toBe('w');
    expect(opp.entries[START]).toEqual([[uciOf(line[0]!), 1]]);
  });

  it('merges transpositions into one position', () => {
    const one = record(['Nf3', 'Nf6', 'Nc3', 'Nc6', 'e4']);
    const two = record(['Nc3', 'Nf6', 'Nf3', 'Nc6', 'e4']);
    const { book: own } = buildBook([one, two], { side: 'own' });
    expect(own.entries[keyAfter(['Nf3', 'Nf6', 'Nc3', 'Nc6'])]).toEqual([['e2e4', 2]]);
    expect(keyAfter(['Nf3', 'Nf6', 'Nc3', 'Nc6'])).toBe(keyAfter(['Nc3', 'Nf6', 'Nf3', 'Nc6']));
    expect(own.entries[START]).toEqual([
      ['b1c3', 1],
      ['g1f3', 1],
    ]);
  });

  it('skips a game whose colour is unknown, whose start is not the standard one, or that has no moves, and says why', () => {
    const good = record(['e4', 'e5']);
    const unknown = record(['e4', 'e5'], { playerColor: 'x' as never });
    const fenStart = record([], {
      pgn: '[Event "Test"]\n[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]\n\n1. e4 1-0',
    });
    const empty = record([], { pgn: '' });
    const { stats } = buildBook([good, unknown, fenStart, empty], { side: 'own' });
    expect(stats.gamesUsed).toBe(1);
    expect(stats.skipped).toEqual({ unknownColor: 1, nonStandardStart: 1, noMoves: 1 });

    // include() turns games away too, and the caller can supply the colour
    const only = buildBook([good, record(['d4'])], { side: 'own', include: (g) => g.pgn.includes('e4') });
    expect(only.stats).toMatchObject({ gamesUsed: 1, skipped: { excluded: 1 } });
    const byName = buildBook([record(['e4', 'e5'], { playerColor: 'w' })], { side: 'own', ownColor: () => 'b' });
    expect(Object.keys(byName.book.entries)).toEqual([keyAfter(['e4'])]);
    const noColor = buildBook([good], { side: 'own', ownColor: () => null });
    expect(noColor.stats.skipped).toEqual({ unknownColor: 1 });
  });

  it('finds the games near the peak rating, from the user own rating only', () => {
    const rated = (white: number | null, black: number | null, color: 'w' | 'b', tc = '600'): StoredGameRecord =>
      record(['e4'], { whiteElo: white, blackElo: black, playerColor: color, timeControl: tc });
    const games = [
      rated(1500, 2500, 'w'), // own rating 1500 (the opponent's 2500 must not count)
      rated(2500, 1700, 'b'), // own rating 1700: the peak
      rated(1650, 1200, 'w'),
      rated(1590, 1200, 'w'),
      rated(null, null, 'w'), // no rating: ignored
      rated(1690, 1200, 'w', '180+2'),
    ];
    const near = peakWindow(games);
    expect(games.map(near)).toEqual([false, true, true, false, false, true]);
    expect(games.map(peakWindow(games, { within: 200 }))).toEqual([true, true, true, true, false, true]);
    expect(games.map(peakWindow(games, { within: 0 }))).toEqual([false, true, false, false, false, false]);
    // one time class only: the peak among those games is 1650 here
    expect(games.map(peakWindow(games, { timeControl: '600' }))).toEqual([false, true, true, false, false, false]);
    expect(peakWindow([], {})(games[0]!)).toBe(false);
    // it plugs into buildBook
    expect(buildBook(games, { side: 'own', include: near }).stats.gamesUsed).toBe(3);
  });

  it('gives the same book from buildBookAsync as from buildBook, yielding as it goes', async () => {
    const games = Array.from({ length: 7 }, (_, i) =>
      record(playout([], 30, 100 + i), { playerColor: i % 2 ? 'b' : 'w' }),
    );
    let yields = 0;
    const sync = buildBook(games, { side: 'own', pliesCap: 20 });
    const asyncResult = await buildBookAsync(
      games,
      { side: 'own', pliesCap: 20 },
      { chunk: 2, yieldFn: async () => void yields++ },
    );
    expect(asyncResult).toEqual(sync);
    expect(yields).toBe(3);
    expect(await buildBookAsync(games, { side: 'own', pliesCap: 20 })).toEqual(sync); // the default yield works
  });
});

describe('bot-profile: looking a move up', () => {
  const startBook = (entries: [string, number][]): Book => book({ [START]: entries });

  it('is deterministic for a seeded rng, and draws once on a hit and not at all on a miss', () => {
    const b = startBook([
      ['e2e4', 5],
      ['d2d4', 3],
      ['c2c4', 2],
    ]);
    const run = (seed: number): (string | null)[] => {
      const rng = seeded(seed);
      return Array.from({ length: 12 }, () => lookupBook(b, DEFAULT_POSITION, rng));
    };
    expect(run(9)).toEqual(run(9));
    expect(new Set(run(9)).size).toBeGreaterThan(1);
    let draws = 0;
    const counting = (): number => {
      draws++;
      return 0.3;
    };
    lookupBook(b, DEFAULT_POSITION, counting);
    expect(draws).toBe(1);
    expect(lookupBook(b, keyAfterFen(['d4']), counting)).toBeNull();
    expect(draws).toBe(1);
  });

  it('treats a recorded move that is not legal here as missing', () => {
    const illegalOnly = startBook([['e2e5', 9]]);
    expect(lookupBook(illegalOnly, DEFAULT_POSITION, () => 0)).toBeNull();
    const mixed = startBook([
      ['e2e5', 9],
      ['d2d4', 1],
    ]);
    for (const r of [0, 0.5, 0.99]) expect(lookupBook(mixed, DEFAULT_POSITION, () => r)).toBe('d2d4');
    // an illegal-only first book falls through to the next
    expect(lookupBook([illegalOnly, startBook([['g1f3', 1]])], DEFAULT_POSITION, () => 0)).toBe('g1f3');
    expect(lookupBook(mixed, 'not a fen', () => 0)).toBeNull();
  });

  it('tries the books in order and stops at the first that has a legal move', () => {
    const peak = startBook([['d2d4', 1]]);
    const me = book({ [START]: [['e2e4', 5]], [keyAfter(['e4'])]: [['e7e5', 2]] });
    const after4 = new RulesAdapter();
    after4.move('e4');
    expect(lookupBook([peak, me], DEFAULT_POSITION, () => 0)).toBe('d2d4');
    expect(lookupBook([me, peak], DEFAULT_POSITION, () => 0)).toBe('e2e4');
    expect(lookupBook([peak, me], after4.fen(), () => 0)).toBe('e7e5'); // peak has nothing here: me answers
    expect(lookupBook([peak, me], keyAfterFen(['c4']), () => 0)).toBeNull();
    expect(lookupBook([], DEFAULT_POSITION, () => 0)).toBeNull();
  });

  it('weights by count ** alpha: 0 is uniform, below 1 flattens toward the rarer lines', () => {
    const b = startBook([
      ['a2a3', 9],
      ['h2h3', 1],
    ]);
    expect(lookupBook(b, DEFAULT_POSITION, () => 0.6)).toBe('a2a3'); // 5.4 of 10, inside the first 9
    expect(lookupBook(b, DEFAULT_POSITION, () => 0.6, { alpha: 0 })).toBe('h2h3'); // 1.2 of 2
    expect(lookupBook(b, DEFAULT_POSITION, () => 0.8)).toBe('a2a3'); // 7.2 of 10
    expect(lookupBook(b, DEFAULT_POSITION, () => 0.8, { alpha: 0.5 })).toBe('h2h3'); // 3.2 of 4: weights 3 and 1
    expect(lookupBook(b, DEFAULT_POSITION, () => 0.5, { alpha: 0.5 })).toBe('a2a3');
  });
});

describe('bot-profile: the stored form', () => {
  const sample = (): Book =>
    buildBook([record(playout([], 20, 7)), record(playout([], 20, 8))], { side: 'own', pliesCap: 20 }).book;

  it('round-trips through JSON text, and the same book is always the same text', () => {
    const b = sample();
    const text = serializeBook(b);
    expect(parseBook(text)).toEqual(b);
    expect(serializeBook(parseBook(text)!)).toBe(text);
    const shuffled: Book = { ...b, entries: Object.fromEntries(Object.entries(b.entries).reverse()) };
    expect(serializeBook(shuffled)).toBe(text);
  });

  it('rejects anything that is not a valid book', () => {
    const good = JSON.parse(serializeBook(sample())) as Record<string, unknown>;
    const withEntries = (entries: unknown): string => JSON.stringify({ ...good, entries });
    const bad: string[] = [
      '',
      'not json',
      '[]',
      'null',
      '"book"',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, v: undefined }),
      JSON.stringify({ ...good, pliesCap: 0 }),
      JSON.stringify({ ...good, pliesCap: 36.5 }),
      JSON.stringify({ ...good, pliesCap: 5000 }),
      JSON.stringify({ ...good, entries: [] }),
      JSON.stringify({ ...good, entries: null }),
      withEntries({ 'not a position': [['e2e4', 1]] }),
      withEntries({ [START]: [] }),
      withEntries({ [START]: 'e2e4' }),
      withEntries({ [START]: [['e2e9', 1]] }),
      withEntries({ [START]: [['E2E4', 1]] }),
      withEntries({ [START]: [['e2e4', 0]] }),
      withEntries({ [START]: [['e2e4', 1.5]] }),
      withEntries({ [START]: [['e2e4', '1']] }),
      withEntries({ [START]: [['e2e4', 1, 2]] }),
      withEntries({ [START]: [null] }),
    ];
    for (const text of bad) expect(parseBook(text), text.slice(0, 60)).toBeNull();
    expect(parseBook(withEntries({ [START]: [['e2e4', 1]] }))).not.toBeNull();
  });
});

describe('bot-profile: coverage', () => {
  /** A book that holds both sides of one line. */
  const bothSides = (sans: string[], pliesCap: number): Book => {
    const own = buildBook([record(sans)], { side: 'own', pliesCap }).book;
    const opp = buildBook([record(sans)], { side: 'opponent', pliesCap }).book;
    return book({ ...own.entries, ...opp.entries }, pliesCap);
  };

  it('reports where the bot leaves its book, in an exact small case', () => {
    const line = bothSides(['e4', 'e5', 'Nf3', 'Nc6'], 8);
    const c = bookCoverage(line, line, { games: 10, rng: seeded(1) });
    // as White the bot runs out at ply 4; as Black the opponent runs out first at ply 4
    expect(c).toEqual({
      games: 10,
      outcomes: { botLeft: 5, opponentLeft: 5, capReached: 0 },
      botLeavesAtPly: { min: 4, p10: 4, median: 4, p90: 4 },
      shareLeavingBefore: { ply10: 0.5, ply16: 0.5, ply24: 0.5 },
      distinctSequences: 1,
    });
  });

  it('reaches the cap when the books go on long enough', () => {
    const line = bothSides(playout([], 12, 4), 8);
    const c = bookCoverage(line, line, { games: 6, rng: seeded(2) });
    expect(c.outcomes).toEqual({ botLeft: 0, opponentLeft: 0, capReached: 6 });
    expect(c.botLeavesAtPly).toBeNull();
    expect(c.shareLeavingBefore).toEqual({ ply10: 0, ply16: 0, ply24: 0 });
    expect(c.distinctSequences).toBe(1);
  });

  it('is deterministic for a seeded rng and has an ordered, consistent shape on a branching synthetic book', () => {
    const games = Array.from({ length: 20 }, (_, i) =>
      record(playout([], 30, 200 + i), { playerColor: i % 2 ? 'b' : 'w' }),
    );
    const mine = buildBook(games, { side: 'own', pliesCap: 20 }).book;
    const theirs = buildBook(games, { side: 'opponent', pliesCap: 20 }).book;
    const merged = book({ ...mine.entries, ...theirs.entries }, 20);
    const first = bookCoverage(merged, merged, { games: 40, rng: seeded(5) });
    expect(bookCoverage(merged, merged, { games: 40, rng: seeded(5) })).toEqual(first);
    expect(first.games).toBe(40);
    expect(first.outcomes.botLeft + first.outcomes.opponentLeft + first.outcomes.capReached).toBe(40);
    expect(first.distinctSequences).toBeGreaterThanOrEqual(1);
    expect(first.distinctSequences).toBeLessThanOrEqual(40);
    const { ply10, ply16, ply24 } = first.shareLeavingBefore;
    expect(ply10).toBeLessThanOrEqual(ply16);
    expect(ply16).toBeLessThanOrEqual(ply24);
    if (first.botLeavesAtPly) {
      const { min, p10, median, p90 } = first.botLeavesAtPly;
      expect(min).toBeLessThanOrEqual(p10);
      expect(p10).toBeLessThanOrEqual(median);
      expect(median).toBeLessThanOrEqual(p90);
    }
    expect(bookCoverage(merged, merged, { games: 0, rng: seeded(1) }).games).toBe(0);
  });
});

/** The FEN after these moves (the lookup takes a full FEN). */
function keyAfterFen(sans: readonly string[]): string {
  const adapter = new RulesAdapter();
  for (const san of sans) adapter.move(san);
  return adapter.fen();
}

/** The UCI of a SAN move at the start position. */
function uciOf(san: string): string {
  return new RulesAdapter().move(san).uci;
}

/** The UCI of the move at `ply` of a line. */
function uciAt(line: readonly string[], ply: number): string {
  const adapter = new RulesAdapter();
  let last = '';
  for (let i = 0; i <= ply; i++) last = adapter.move(line[i]!).uci;
  return last;
}
