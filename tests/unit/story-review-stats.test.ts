import { describe, expect, it } from 'vitest';
import { MIN_REVIEWED_PLIES, readReviewNumbers } from '../../src/library/review-numbers';
import type { UserAccount } from '../../src/review/perspective';
import type { GameAnalysisSummary, SideAnalysisSummary, StoredGameRecord } from '../../src/storage/db';
import {
  MIN_MOVES_FOR_BEST_GAME,
  MIN_REVIEWED_GAMES,
  MIN_REVIEWED_ROW,
  STATS_VERSION,
  computeStoryStats,
} from '../../src/story/stats';
import { FOES, ME, game, run, utc } from './helpers/story-games';

const mine: UserAccount[] = [
  { site: 'chesscom', username: ME },
  { site: 'lichess', username: ME },
];
const stats = (records: StoredGameRecord[]) => computeStoryStats(records, mine);

interface Numbers {
  accuracy?: number;
  moves?: number;
  plies?: number;
  inaccuracy?: number;
  mistake?: number;
  blunder?: number;
  brilliant?: number;
  great?: number;
  low?: number | null;
  /** A batch summary (default) or a review made on this device. */
  advance?: boolean;
  /** A device review holds both sides; the opponent's side gets other numbers. */
  bothSides?: boolean;
  preset?: 'quick' | null;
}

function side(n: Numbers): SideAnalysisSummary {
  return {
    moves: n.moves ?? 30,
    acpl: 40,
    inaccuracy: n.inaccuracy ?? 2,
    mistake: n.mistake ?? 1,
    blunder: n.blunder ?? 1,
    miss: 0,
    brilliant: n.brilliant ?? 0,
    great: n.great ?? 0,
    low: n.low === undefined ? 40 : n.low,
    drop: 20,
    dropPly: 11,
  };
}

/** A copy of the record with a review summary, written for the side I actually sit on in it. */
function reviewed(record: StoredGameRecord, n: Numbers = {}): StoredGameRecord {
  const mineIsBlack = record.black === ME;
  const accuracy = n.accuracy ?? 80;
  const advance = n.advance ?? true;
  const sides: GameAnalysisSummary['sides'] = {};
  sides[mineIsBlack ? 'b' : 'w'] = side(n);
  if (n.bothSides) sides[mineIsBlack ? 'w' : 'b'] = side({ blunder: 9, moves: 31 });
  const theirs = n.bothSides ? 55 : null;
  const analysis: GameAnalysisSummary = {
    preset: n.preset ?? null,
    savedAt: 5,
    whiteAccuracy: mineIsBlack ? theirs : accuracy,
    blackAccuracy: mineIsBlack ? accuracy : theirs,
    ...(advance ? { depth: 18, summaryOnly: true } : {}),
    plies: n.plies ?? 60,
    sides,
  };
  return { ...record, analysis, accuracy };
}

describe('readReviewNumbers', () => {
  it('reads my side of a batch summary', () => {
    const rec = reviewed(game({ id: 'a' }), { accuracy: 81.5, blunder: 3, low: 12.3 });
    expect(readReviewNumbers(rec, 'w')).toEqual({
      accuracy: 81.5,
      plies: 60,
      moves: 30,
      inaccuracy: 2,
      mistake: 1,
      blunder: 3,
      miss: 0,
      brilliant: 0,
      great: 0,
      low: 12.3,
      drop: 20,
      source: 'advance',
      depth: 18,
      preset: null,
    });
  });

  it('reads a device review from the side asked for, and calls it a device review', () => {
    const rec = reviewed(game({ id: 'b', color: 'b' }), {
      advance: false,
      bothSides: true,
      preset: 'quick',
      accuracy: 70,
    });
    expect(readReviewNumbers(rec, 'b')).toMatchObject({
      accuracy: 70,
      blunder: 1,
      source: 'device',
      depth: null,
      preset: 'quick',
    });
    expect(readReviewNumbers(rec, 'w')).toMatchObject({ accuracy: 55, blunder: 9 });
  });

  it('accepts exactly MIN_REVIEWED_PLIES plies', () => {
    expect(readReviewNumbers(reviewed(game({ id: 'c' }), { plies: MIN_REVIEWED_PLIES }), 'w')).not.toBeNull();
    expect(readReviewNumbers(reviewed(game({ id: 'c' }), { plies: MIN_REVIEWED_PLIES - 1 }), 'w')).toBeNull();
  });

  const base = (): GameAnalysisSummary => reviewed(game({ id: 'x' })).analysis!;
  const withSide = (patch: Partial<SideAnalysisSummary>): GameAnalysisSummary => ({
    ...base(),
    sides: { w: { ...side({}), ...patch } },
  });
  it.each<[string, GameAnalysisSummary | null | undefined]>([
    ['no analysis', undefined],
    ['null analysis', null],
    ['an old record without sides', { ...base(), sides: undefined }],
    ['empty sides', { ...base(), sides: {} }],
    ['only the other side', { ...base(), sides: { b: side({}) } }],
    ['no accuracy', { ...base(), whiteAccuracy: null }],
    ['a NaN accuracy', { ...base(), whiteAccuracy: Number.NaN }],
    ['an accuracy above 100', { ...base(), whiteAccuracy: 101 }],
    ['a negative accuracy', { ...base(), whiteAccuracy: -1 }],
    ['no plies', { ...base(), plies: undefined }],
    ['no moves of mine', withSide({ moves: 0 })],
    ['a negative count', withSide({ blunder: -1 })],
    ['a NaN count', withSide({ mistake: Number.NaN })],
    ['a drop that is not a number', withSide({ drop: undefined as unknown as number })],
  ])('is null for %s', (_name, analysis) => {
    expect(readReviewNumbers({ analysis }, 'w')).toBeNull();
  });

  it('keeps the numbers when only the lowest win% is unusable', () => {
    expect(readReviewNumbers({ analysis: withSide({ low: undefined as unknown as null }) }, 'w')?.low).toBeNull();
  });
});

describe('the review block of the stats', () => {
  it('is empty with no reviewed game, and counts the games of the scope', () => {
    const r = stats(run(5, 'g')).all.review;
    expect(r).toMatchObject({
      counted: 5,
      reviewed: 0,
      inAdvance: 0,
      onDevice: 0,
      enough: false,
      accuracy: null,
      perGame: null,
      brilliant: 0,
      great: 0,
      brilliantGames: 0,
      greatGames: 0,
      byClass: [],
      white: null,
      black: null,
      wins: null,
      losses: null,
      halves: null,
      byYear: [],
      comebacks: null,
      bestGame: null,
    });
    expect(STATS_VERSION).toBe(3);
    expect(stats([]).version).toBe(3);
  });

  it('averages accuracy and counts per game, and splits the sources', () => {
    const games = run(3, 'g');
    const s = stats([
      reviewed(games[0]!, { accuracy: 70, blunder: 1, mistake: 2, inaccuracy: 3, moves: 20, brilliant: 1 }),
      reviewed(games[1]!, { accuracy: 80, blunder: 2, mistake: 3, inaccuracy: 4, moves: 30, great: 1 }),
      reviewed(games[2]!, {
        accuracy: 90,
        blunder: 3,
        mistake: 4,
        inaccuracy: 5,
        moves: 40,
        brilliant: 2,
        great: 1,
        advance: false,
        preset: 'quick',
      }),
      ...run(2, 'plain'),
    ]).all.review;
    expect(s).toMatchObject({
      counted: 5,
      reviewed: 3,
      inAdvance: 2,
      onDevice: 1,
      accuracy: 80,
      brilliant: 3,
      great: 2,
    });
    expect(s.perGame).toEqual({ blunder: 2, mistake: 3, inaccuracy: 4, moves: 30 });
  });

  it('makes the review cards from MIN_REVIEWED_GAMES reviewed games', () => {
    const some = (n: number) => run(n, 'g').map((r) => reviewed(r));
    expect(stats(some(MIN_REVIEWED_GAMES - 1)).all.review.enough).toBe(false);
    expect(stats(some(MIN_REVIEWED_GAMES)).all.review.enough).toBe(true);
  });

  it('lists a time class only from MIN_REVIEWED_ROW reviewed games, and leaves unreviewed games out of it', () => {
    const blitz = run(MIN_REVIEWED_ROW, 'bl', () => ({ tc: '180+2' })).map((r, i) => reviewed(r, { accuracy: 60 + i }));
    const rapid = run(MIN_REVIEWED_ROW - 1, 'ra', () => ({ tc: '600' })).map((r) => reviewed(r));
    const bullet = run(4, 'bu', () => ({ tc: '60' }));
    const s = stats([...blitz, ...rapid, ...bullet]).all.review;
    expect(s.byClass).toEqual([{ timeClass: 'blitz', games: MIN_REVIEWED_ROW, accuracy: 64.5 }]);
  });

  it('gives a colour or an outcome only from MIN_REVIEWED_ROW reviewed games', () => {
    const white = run(12, 'w', () => ({ color: 'w', outcome: 'win' })).map((r) => reviewed(r, { accuracy: 70 }));
    const black = run(MIN_REVIEWED_ROW - 1, 'b', () => ({ color: 'b', outcome: 'loss' })).map((r) =>
      reviewed(r, { accuracy: 90 }),
    );
    const s = stats([...white, ...black]).all.review;
    expect(s.white).toEqual({ games: 12, accuracy: 70 });
    expect(s.black).toBeNull();
    expect(s.wins).toEqual({ games: 12, accuracy: 70 });
    expect(s.losses).toBeNull();
    const more = stats([
      ...white,
      ...black,
      reviewed(game({ id: 'b-extra', color: 'b', outcome: 'loss' }), { accuracy: 90 }),
    ]).all.review;
    expect(more.black).toEqual({ games: MIN_REVIEWED_ROW, accuracy: 90 });
    expect(more.losses).toEqual({ games: MIN_REVIEWED_ROW, accuracy: 90 });
  });

  it('uses my side from the usernames, not the record’s playerColor, and never the other side', () => {
    const asBlack = reviewed(game({ id: 'k', color: 'b' }), { accuracy: 66, bothSides: true });
    expect(asBlack.playerColor).toBe('w');
    expect(stats([asBlack]).all.review.accuracy).toBe(66);
    // A summary that holds only the opponent's side is not a review of mine
    const wrongSide: StoredGameRecord = {
      ...reviewed(game({ id: 'm' })),
      analysis: { ...reviewed(game({ id: 'm' })).analysis!, sides: { b: side({}) } },
    };
    expect(stats([wrongSide]).all.review.reviewed).toBe(0);
  });

  it('counts only counted games: not pasted, not someone else’s, not unfinished', () => {
    const s = stats([
      reviewed(game({ id: 'ok' })),
      reviewed(game({ id: 'paste', source: 'paste' })),
      reviewed(game({ id: 'stranger', me: 'someoneelse' })),
      reviewed(game({ id: 'open', outcome: 'unfinished' })),
    ]).all.review;
    expect(s).toMatchObject({ counted: 1, reviewed: 1 });
  });

  it('counts a game found on both sites once in all, and in each site', () => {
    const cc = reviewed(game({ id: 'd', source: 'chesscom' }));
    const li = reviewed(game({ id: 'd', source: 'lichess' }));
    const s = stats([cc, li]);
    expect(s.onBothSites).toBe(1);
    expect(s.all.review).toMatchObject({ counted: 1, reviewed: 1 });
    expect(s.chesscom.review.reviewed).toBe(1);
    expect(s.lichess.review.reviewed).toBe(1);
  });

  describe('the halves', () => {
    const dated = (n: number, extra: (i: number) => Partial<Parameters<typeof game>[0]> = () => ({})) =>
      run(n, 'h', extra).map((r, i) => reviewed(r, { accuracy: i < n / 2 ? 70 : 80, blunder: i < n / 2 ? 2 : 1 }));

    it('compares the first and the second half of the dated reviewed games', () => {
      const h = stats(dated(MIN_REVIEWED_GAMES)).all.review.halves!;
      expect(h.first).toEqual({ games: 10, accuracy: 70, blundersPerGame: 2, endMonth: '2026-01' });
      expect(h.second).toEqual({ games: 10, accuracy: 80, blundersPerGame: 1 });
    });

    it('needs MIN_REVIEWED_GAMES dated games: undated ones do not count', () => {
      expect(stats(dated(MIN_REVIEWED_GAMES - 1)).all.review.halves).toBeNull();
      const withUndated = dated(MIN_REVIEWED_GAMES, (i) => (i < 5 ? { at: null } : {}));
      const s = stats(withUndated).all.review;
      expect(s.reviewed).toBe(MIN_REVIEWED_GAMES);
      expect(s.halves).toBeNull();
    });
  });

  it('lists the years with at least MIN_REVIEWED_ROW reviewed games, oldest first', () => {
    const inYear = (year: number, n: number, accuracy: number, blunder: number) =>
      Array.from({ length: n }, (_, i) =>
        reviewed(game({ id: `y${year}-${i}`, at: utc(year, 3, 1 + i) }), { accuracy, blunder }),
      );
    const s = stats([...inYear(2025, 10, 80, 1), ...inYear(2023, 9, 50, 5), ...inYear(2024, 12, 70, 2)]).all.review;
    expect(s.byYear).toEqual([
      { year: 2024, games: 12, accuracy: 70, blundersPerGame: 2 },
      { year: 2025, games: 10, accuracy: 80, blundersPerGame: 1 },
    ]);
  });

  describe('the comebacks', () => {
    it('is the reviewed win with the lowest win%, then the highest opponent rating, then the latest game; counts the wins from under 5% and the others that tie', () => {
      const win = (id: string, month: number, low: number | null, tc = '180+2') =>
        reviewed(game({ id, at: utc(2025, month), tc }), { low });
      const s = stats([
        win('a', 1, 30),
        win('c', 3, 5, '600'),
        win('b', 2, 5),
        win('n', 4, null),
        reviewed(game({ id: 'lost', at: utc(2025, 5), outcome: 'loss' }), { low: 1 }),
      ]).all.review.comebacks!;
      expect(s.reviewedWins).toBe(3);
      expect(s.count).toBe(0); // 5 is not under 5
      expect(s.alsoLow).toBe(1);
      // 'b' (February, blitz) and 'c' (March, rapid) tie at 5 with the same opponent rating: the later game, 'c'
      expect(s.game).toMatchObject({ low: 5, timeClass: 'rapid', outcome: 'win', source: 'advance', depth: 18 });
      expect(new Date(s.game.playedAt!).getUTCMonth()).toBe(2);
    });

    it('breaks a tie at the lowest win% by the higher opponent rating, then the later game, whatever the input order', () => {
      const w = (id: string, month: number, foeElo: number | null) =>
        reviewed(game({ id, at: utc(2025, month), foeElo, variantSalt: id }), { low: 2.5 });
      const records = [
        w('early-high', 1, 1900),
        w('late-low', 6, 1500),
        w('late-high', 3, 1900),
        w('unrated', 8, null),
      ];
      for (const order of [records, [...records].reverse()]) {
        const c = stats(order).all.review.comebacks!;
        expect(c.game.opponentRating).toBe(1900);
        expect(new Date(c.game.playedAt!).getUTCMonth()).toBe(2); // March: the later of the two at 1900
        expect(c.alsoLow).toBe(3);
        expect(c.count).toBe(4);
      }
    });

    it('counts the wins from under 5%', () => {
      const w = (id: string, low: number) => reviewed(game({ id, at: utc(2025, 2), variantSalt: id }), { low });
      expect(stats([w('a', 4.99), w('b', 0), w('c', 5), w('d', 60)]).all.review.comebacks!.count).toBe(2);
    });

    it('is null with no reviewed win', () => {
      expect(stats([reviewed(game({ id: 'l', outcome: 'loss' }))]).all.review.comebacks).toBeNull();
    });
  });

  describe('the most accurate game', () => {
    it('is chosen among games of at least MIN_MOVES_FOR_BEST_GAME moves, the earliest on a tie', () => {
      const g = (id: string, month: number, accuracy: number, moves: number, extra = {}) =>
        reviewed(game({ id, at: utc(2025, month), ...extra }), { accuracy, moves });
      const s = stats([
        g('short', 1, 99, MIN_MOVES_FOR_BEST_GAME - 1),
        g('y', 2, 95, MIN_MOVES_FOR_BEST_GAME),
        g('z', 1, 95, 40, { foeElo: 1640, outcome: 'draw' }),
        g('w', 3, 90, 30),
      ]).all.review.bestGame!;
      expect(s.eligible).toBe(3);
      expect(s.game).toMatchObject({ accuracy: 95, moves: 40, outcome: 'draw', opponentRating: 1640 });
      expect(new Date(s.game.playedAt!).getUTCMonth()).toBe(0);
    });

    it('is null when no reviewed game is long enough', () => {
      expect(
        stats([reviewed(game({ id: 's' }), { moves: MIN_MOVES_FOR_BEST_GAME - 1 })]).all.review.bestGame,
      ).toBeNull();
    });
  });

  it('holds no id, link or name', () => {
    const text = JSON.stringify(stats(run(25, 'g', () => ({ foe: FOES[1]! })).map((r) => reviewed(r))).all.review);
    for (const word of [ME, ...FOES, 'chesscom', 'lichess', 'http']) expect(text).not.toContain(word);
  });
});
