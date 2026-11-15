import { describe, expect, it } from 'vitest';
import {
  MIN_QUARTER_GAMES,
  NO_QUARTER_TEXT,
  accuracyEnds,
  accuracyPointLabel,
  errorsEnds,
  errorsPointLabel,
  insightsSummary,
  needReviewsText,
  needsReviewedText,
  quarterFilter,
  quarterKey,
  quarterOfDay,
  quarterX,
  reviewQuarters,
  type QuarterPoint,
} from '../../src/library/insights-review';
import type { ReviewNumbers } from '../../src/library/review-numbers';
import type { UserAccount } from '../../src/review/perspective';
import { MIN_REVIEWED_GAMES, storyGames, type StoryGame } from '../../src/story/stats';
import { ME, game } from './helpers/story-games';
import { reviewed } from './helpers/story-reviews';

// Every date is built from LOCAL parts (noon, or a minute either side of midnight), so which quarter a game is in does
// not depend on the machine's time zone. Run it under another zone to see: TZ=Pacific/Auckland EXPECT_TZ=Pacific/Auckland
const noon = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12).getTime();
const mine: UserAccount[] = [{ site: 'chesscom', username: ME }];

const numbers = (o: Partial<ReviewNumbers> = {}): ReviewNumbers => ({
  accuracy: 80,
  plies: 60,
  moves: 30,
  inaccuracy: 2,
  mistake: 1,
  blunder: 1,
  miss: 0,
  brilliant: 0,
  great: 0,
  low: 40,
  drop: 20,
  source: 'advance',
  depth: 18,
  preset: null,
  ...o,
});
/** A counted game; `o` null is a game with no review. */
const sg = (playedAt: number | null, o: Partial<ReviewNumbers> | null = {}): StoryGame => ({
  playedAt,
  outcome: 'win',
  timeClass: 'blitz',
  color: 'w',
  review: o === null ? null : numbers(o),
});
/** `count` reviewed games in one month, one on each of the first days. */
const month = (y: number, m: number, count: number, o: (i: number) => Partial<ReviewNumbers> = () => ({})) =>
  Array.from({ length: count }, (_, i) => sg(noon(y, m, 1 + i), o(i)));

const point = (o: Partial<QuarterPoint> = {}): QuarterPoint => ({
  year: 2023,
  quarter: 2,
  label: '2023 Q2',
  from: '2023-04-01',
  to: '2023-06-30',
  games: 212,
  accuracy: 79.4,
  blundersPer10: 0.8,
  mistakesPer10: 1.7,
  ...o,
});

describe('the time zone of this run', () => {
  it('is the one asked for, when one was', () => {
    const want = process.env.EXPECT_TZ;
    if (want) expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(want);
    else expect(typeof Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('string');
  });
});

describe('quarterOfDay', () => {
  it.each([
    ['2023-01-01', 1],
    ['2023-03-31', 1],
    ['2023-04-01', 2],
    ['2023-06-30', 2],
    ['2023-07-01', 3],
    ['2023-09-30', 3],
    ['2023-10-01', 4],
    ['2023-12-31', 4],
    ['2024-02-29', 1],
  ])('puts %s in quarter %i', (day, quarter) => {
    expect(quarterOfDay(day)).toEqual({ year: Number(day.slice(0, 4)), quarter });
  });

  it.each(['', 'x', '2023-13-01', '2023-00-10', '2023-5-1', '23-05-01', '2023-05-01T10:00'])(
    'is null for %j',
    (text) => {
      expect(quarterOfDay(text)).toBeNull();
    },
  );

  it('keys and places a quarter on a time axis that keeps gaps', () => {
    expect(quarterKey({ year: 2023, quarter: 2 })).toBe('2023-Q2');
    expect(quarterX({ year: 2023, quarter: 2 }) - quarterX({ year: 2022, quarter: 4 })).toBe(2);
    expect(quarterX({ year: 2024, quarter: 1 }) - quarterX({ year: 2023, quarter: 4 })).toBe(1);
  });
});

describe('reviewQuarters: which quarter a game is in', () => {
  it('writes the first and last day and the label of each quarter', () => {
    const games = [2, 5, 8, 11].flatMap((m) => month(2023, m, MIN_QUARTER_GAMES));
    const { points } = reviewQuarters(games);
    expect(points.map((p) => [p.label, p.from, p.to])).toEqual([
      ['2023 Q1', '2023-01-01', '2023-03-31'],
      ['2023 Q2', '2023-04-01', '2023-06-30'],
      ['2023 Q3', '2023-07-01', '2023-09-30'],
      ['2023 Q4', '2023-10-01', '2023-12-31'],
    ]);
  });

  it('splits at 31 March and 1 April, by the local day', () => {
    const at = (m: number, d: number, h: number, min: number) => new Date(2023, m - 1, d, h, min).getTime();
    const games = [
      ...Array.from({ length: 10 }, () => sg(at(3, 31, 12, 0))),
      ...Array.from({ length: 10 }, () => sg(at(3, 31, 23, 59))),
      ...Array.from({ length: 12 }, () => sg(at(4, 1, 0, 1))),
      ...Array.from({ length: 10 }, () => sg(at(4, 1, 12, 0))),
    ];
    const { points } = reviewQuarters(games);
    expect(points.map((p) => [p.label, p.games])).toEqual([
      ['2023 Q1', 20],
      ['2023 Q2', 22],
    ]);
  });

  it('puts 29 February in the first quarter and 31 December in the last', () => {
    const games = [
      ...Array.from({ length: 10 }, () => sg(noon(2024, 2, 29))),
      ...Array.from({ length: 10 }, () => sg(noon(2024, 12, 31))),
    ];
    expect(reviewQuarters(games).points.map((p) => p.label)).toEqual(['2024 Q1', '2024 Q4']);
  });

  it('lists the quarters oldest first, and keeps the gaps between them on the time axis', () => {
    const games = [...month(2024, 2, 10), ...month(2022, 11, 10), ...month(2023, 5, 10)];
    const { points } = reviewQuarters(games);
    expect(points.map((p) => p.label)).toEqual(['2022 Q4', '2023 Q2', '2024 Q1']);
    const x = points.map(quarterX);
    expect([x[1]! - x[0]!, x[2]! - x[1]!]).toEqual([2, 3]);
  });

  it('counts a game with no date as reviewed, but in no quarter', () => {
    const games = [...month(2023, 5, 10), ...Array.from({ length: 10 }, () => sg(null))];
    const r = reviewQuarters(games);
    expect(r.reviewed).toBe(20);
    expect(r.enough).toBe(true);
    expect(r.points.map((p) => [p.label, p.games])).toEqual([['2023 Q2', 10]]);
  });
});

describe('reviewQuarters: which quarters are points, and their numbers', () => {
  it('needs MIN_QUARTER_GAMES reviewed games: 9 is no point, 10 is one', () => {
    expect(MIN_QUARTER_GAMES).toBe(10);
    const games = [...month(2023, 2, 9), ...month(2023, 5, 10)];
    expect(reviewQuarters(games).points.map((p) => [p.label, p.games])).toEqual([['2023 Q2', 10]]);
    expect(reviewQuarters(month(2023, 2, 9)).points).toEqual([]);
  });

  it('takes the mean accuracy, and blunders and mistakes per 10 moves over the quarter’s moves together', () => {
    // Five short games (10 moves, 1 blunder, 3 mistakes) and five long ones (30 moves, 2 blunders, 1 mistake): the
    // blunders per 10 moves are 15 / 200 × 10, not the mean of the games' own rates (which would be about 0.83)
    const games = month(2023, 5, 10, (i) =>
      i < 5
        ? { accuracy: 60 + i, moves: 10, blunder: 1, mistake: 3 }
        : { accuracy: 60 + i, moves: 30, blunder: 2, mistake: 1 },
    );
    const p = reviewQuarters(games).points[0]!;
    expect(p.games).toBe(10);
    expect(p.accuracy).toBeCloseTo(64.5, 10);
    expect(p.blundersPer10).toBeCloseTo(0.75, 10);
    expect(p.mistakesPer10).toBeCloseTo(1.0, 10);
  });

  it('ignores games with no review', () => {
    const games = [...month(2023, 5, 10), ...Array.from({ length: 5 }, (_, i) => sg(noon(2023, 5, 15 + i), null))];
    const r = reviewQuarters(games);
    expect(r.reviewed).toBe(10);
    expect(r.points[0]!.games).toBe(10);
  });

  it('draws the charts from 20 reviewed games: not at 19', () => {
    expect(MIN_REVIEWED_GAMES).toBe(20);
    const r19 = reviewQuarters(month(2023, 5, 19));
    expect(r19).toMatchObject({ reviewed: 19, enough: false });
    expect(r19.points).toHaveLength(1); // the quarter qualifies; whether to draw is `enough`
    expect(reviewQuarters(month(2023, 5, 20))).toMatchObject({ reviewed: 20, enough: true });
  });

  it('can have 20 reviewed games and no quarter with 10', () => {
    // Four games in each of five quarters
    const games = [
      ...month(2022, 2, 4),
      ...month(2022, 5, 4),
      ...month(2022, 8, 4),
      ...month(2022, 11, 4),
      ...month(2023, 2, 4),
    ];
    expect(reviewQuarters(games)).toEqual({ reviewed: 20, enough: true, points: [] });
  });

  it('is empty for no games', () => {
    expect(reviewQuarters([])).toEqual({ reviewed: 0, enough: false, points: [] });
  });
});

describe('reviewQuarters on the games the Story counts', () => {
  const records = (review: (i: number) => Parameters<typeof reviewed>[1]) =>
    Array.from({ length: 12 }, (_, i) =>
      reviewed(game({ id: `r${i}`, at: noon(2023, 5, 1 + i), variantSalt: `r${i}` }), review(i)),
    );
  const quarters = (rs: ReturnType<typeof records>) => reviewQuarters(storyGames(rs, mine));

  it('counts a review made on this device like a batch summary', () => {
    const numbersOf = (i: number) => ({ accuracy: 60 + i, blunder: i % 3, mistake: 1 + (i % 2), moves: 20 + i });
    const batch = quarters(records((i) => ({ ...numbersOf(i), advance: true })));
    const device = quarters(records((i) => ({ ...numbersOf(i), advance: false, preset: 'quick' as const })));
    expect(batch.points).toHaveLength(1);
    expect(device).toEqual(batch);
  });

  it('reads my side only: the opponent’s numbers in a device review change nothing', () => {
    const numbersOf = (i: number) => ({ accuracy: 70 + i, blunder: 1, mistake: 2, moves: 25 });
    const mineOnly = quarters(records((i) => ({ ...numbersOf(i), advance: false, preset: 'quick' as const })));
    const both = quarters(
      records((i) => ({ ...numbersOf(i), advance: false, preset: 'quick' as const, bothSides: true })),
    );
    expect(both).toEqual(mineOnly);
    expect(both.points[0]!.blundersPer10).toBeCloseTo(0.4, 10); // 1 blunder in 25 moves, not the opponent's 9 in 31
  });

  it('leaves out games that are not reviewed', () => {
    const rs = [
      ...records(() => ({})),
      ...Array.from({ length: 6 }, (_, i) =>
        game({ id: `plain${i}`, at: noon(2023, 5, 20 + i), variantSalt: `p${i}` }),
      ),
    ];
    expect(quarters(rs)).toMatchObject({ reviewed: 12, points: [{ games: 12 }] });
  });
});

describe('quarterFilter', () => {
  it('asks the Games list for the quarter’s days and for games that have an accuracy', () => {
    expect(quarterFilter(point())).toStrictEqual({ from: '2023-04-01', to: '2023-06-30', minAccuracy: 0 });
    const p = reviewQuarters(month(2024, 11, 10)).points[0]!;
    expect(quarterFilter(p)).toStrictEqual({ from: '2024-10-01', to: '2024-12-31', minAccuracy: 0 });
  });
});

describe('the texts', () => {
  it('says what the charts need', () => {
    expect(needsReviewedText(4)).toBe('Needs 20 reviewed games (4 so far).');
    expect(needsReviewedText(0)).toBe('Needs 20 reviewed games (0 so far).');
    expect(needsReviewedText(19)).toBe('Needs 20 reviewed games (19 so far).');
    expect(NO_QUARTER_TEXT).toBe('No quarter has 10 reviewed games yet.');
  });

  it('writes the point labels', () => {
    expect(accuracyPointLabel(point())).toBe('2023 Q2: 79.4% over 212 games');
    expect(accuracyPointLabel(point({ games: 1248, accuracy: 80 }))).toBe('2023 Q2: 80.0% over 1,248 games');
    expect(errorsPointLabel(point())).toBe('2023 Q2: 0.8 blunders and 1.7 mistakes per 10 moves over 212 games');
    expect(errorsPointLabel(point({ games: 10, blundersPer10: 0, mistakesPer10: 12.34 }))).toBe(
      '2023 Q2: 0.0 blunders and 12.3 mistakes per 10 moves over 10 games',
    );
  });

  it('writes the first and last quarter, and nothing for fewer than two points', () => {
    const first = point({
      year: 2021,
      quarter: 4,
      label: '2021 Q4',
      accuracy: 74.3,
      blundersPer10: 2.6,
      mistakesPer10: 3.1,
    });
    const last = point({
      year: 2026,
      quarter: 2,
      label: '2026 Q2',
      accuracy: 80.1,
      blundersPer10: 1.3,
      mistakesPer10: 2,
    });
    expect(accuracyEnds([first, point(), last])).toBe('From 2021 Q4 (74.3%) to 2026 Q2 (80.1%).');
    expect(errorsEnds([first, point(), last])).toBe(
      'From 2021 Q4 (2.6 blunders, 3.1 mistakes) to 2026 Q2 (1.3 blunders, 2.0 mistakes), per 10 moves.',
    );
    for (const ends of [accuracyEnds, errorsEnds]) {
      expect(ends([])).toBeNull();
      expect(ends([first])).toBeNull();
    }
  });

  it('writes the header, with the in-advance count only when there is one, in the singular and the plural', () => {
    expect(insightsSummary({ reviewed: 2, inAdvance: 0, mine: 2 })).toBe(
      '2 reviewed games of yours · 2 of yours in all',
    );
    expect(insightsSummary({ reviewed: 1, inAdvance: 0, mine: 5 })).toBe(
      '1 reviewed game of yours · 5 of yours in all',
    );
    expect(insightsSummary({ reviewed: 0, inAdvance: 0, mine: 0 })).toBe(
      '0 reviewed games of yours · 0 of yours in all',
    );
    expect(insightsSummary({ reviewed: 0, inAdvance: 4535, mine: 4623 })).toBe(
      '0 reviewed games of yours · 4,535 reviewed in advance · 4,623 of yours in all',
    );
    expect(insightsSummary({ reviewed: 3, inAdvance: 1, mine: 4 })).toBe(
      '3 reviewed games of yours · 1 reviewed in advance · 4 of yours in all',
    );
  });

  it('writes the empty text of the old cards, in the singular and the plural', () => {
    expect(needReviewsText({ inAdvance: 4535, noneMarked: false })).toBe(
      'These need a game reviewed on this device (Games › Analyze). 4,535 games were reviewed in advance; their numbers are below.',
    );
    expect(needReviewsText({ inAdvance: 1, noneMarked: false })).toBe(
      'These need a game reviewed on this device (Games › Analyze). 1 game was reviewed in advance; its numbers are below.',
    );
    // With nothing reviewed in advance the text is the one the cards always had
    expect(needReviewsText({ inAdvance: 0, noneMarked: false })).toBe(
      'Review some of your games (Games › Analyze) to see this.',
    );
    expect(needReviewsText({ inAdvance: 0, noneMarked: true })).toBe(
      'Review some of your games (Games › Analyze) to see this. None of your games are marked yours yet: set your usernames in Settings › Your games.',
    );
    // Games reviewed in advance are games of mine, so "not marked yours" cannot be true with them
    expect(needReviewsText({ inAdvance: 2, noneMarked: true })).not.toContain('None of your games');
  });
});
