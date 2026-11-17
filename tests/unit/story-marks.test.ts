import { describe, expect, it } from 'vitest';
import type { StoredGameRecord } from '../../src/storage/db';
import { computeStoryStats, featuredGameId } from '../../src/story/stats';
import { OPEN_GAME_TEXT, brilliantSentence, mostBrilliantSentence, storyCards } from '../../src/story/text';
import { FOES, ME, game, utc, type GameSpec } from './helpers/story-games';
import { batch, reviewed, type ReviewSpec } from './helpers/story-reviews';

// The Brilliant and Great highlight card and the games a card can open. Every game here is invented.
const accounts = [
  { site: 'chesscom' as const, username: ME },
  { site: 'lichess' as const, username: ME },
];
const stats = (records: readonly StoredGameRecord[]) => computeStoryStats(records, accounts);
const cardsOf = (records: readonly StoredGameRecord[]) =>
  Object.fromEntries(storyCards(stats(records)).map((c) => [c.id, c]));

/** `count` reviewed Black losses with no Brilliant or Great move: they fill the Story without changing a pick. */
const pad = (count: number, prefix = 'pad') =>
  batch(count, prefix, () => ({ game: { color: 'b' as const, outcome: 'loss' as const }, review: { accuracy: 50 } }));
/** One reviewed game. */
const one = (spec: GameSpec, review: ReviewSpec) => reviewed(game(spec), review);
const marksOf = (records: readonly StoredGameRecord[]) => stats(records).all.review.marks;
const topId = (records: readonly StoredGameRecord[]) => featuredGameId(stats(records).all, 'marks');

describe('the most brilliant game', () => {
  it('is the game with the most Brilliant moves, with its date, color, result and time control', () => {
    const records = [
      ...pad(20),
      one({ id: 'two', at: utc(2024, 3, 14), color: 'b', outcome: 'draw', tc: '900+10' }, { brilliant: 2, great: 0 }),
      one({ id: 'three', at: utc(2023, 5, 2), color: 'w', outcome: 'win', tc: '600' }, { brilliant: 3, great: 1 }),
      one({ id: 'one', at: utc(2025, 1, 9) }, { brilliant: 1, great: 9 }),
    ];
    expect(marksOf(records).topGame).toEqual({
      brilliant: 3,
      great: 1,
      playedAt: utc(2023, 5, 2),
      color: 'w',
      outcome: 'win',
      timeClass: 'rapid',
      control: '10 min',
    });
    expect(topId(records)).toBe('chesscom:three');
  });

  it('breaks a tie by more Great moves, then the latest game, then the smaller id, in any input order', () => {
    const byGreat = [
      ...pad(20),
      one({ id: 'a', at: utc(2025, 6, 1) }, { brilliant: 2, great: 1 }),
      one({ id: 'b', at: utc(2021, 6, 1), variantSalt: 'b' }, { brilliant: 2, great: 4 }),
    ];
    expect(topId(byGreat)).toBe('chesscom:b');
    expect(topId([...byGreat].reverse())).toBe('chesscom:b');

    const byDate = [
      ...pad(20),
      one({ id: 'a', at: utc(2022, 6, 1) }, { brilliant: 2, great: 1 }),
      one({ id: 'b', at: utc(2024, 6, 1), variantSalt: 'b' }, { brilliant: 2, great: 1 }),
      // A game with no date counts as the oldest
      one({ id: 'c', at: null, variantSalt: 'c' }, { brilliant: 2, great: 1 }),
    ];
    expect(topId(byDate)).toBe('chesscom:b');
    expect(topId([...byDate].reverse())).toBe('chesscom:b');

    const byId = [
      ...pad(20),
      one({ id: 'n', at: utc(2024, 6, 1) }, { brilliant: 1 }),
      one({ id: 'm', at: utc(2024, 6, 1), variantSalt: 'm' }, { brilliant: 1 }),
    ];
    expect(topId(byId)).toBe('chesscom:m');
    expect(topId([...byId].reverse())).toBe('chesscom:m');
  });

  it('is null with no Brilliant move, and a game with only Great moves is never picked', () => {
    const records = [...pad(20), one({ id: 'g', at: utc(2024, 6, 1) }, { great: 7 })];
    expect(marksOf(records)).toEqual({ topGame: null, bestYear: null, latestAt: null });
    expect(topId(records)).toBeNull();
  });

  it('leaves out the time control when the game has none that can be read', () => {
    const records = [...pad(20), one({ id: 'x', at: utc(2024, 6, 1), tc: '-' }, { brilliant: 1 })];
    expect(marksOf(records).topGame).toMatchObject({ timeClass: null, control: null });
  });
});

describe('the best year and the latest Brilliant move', () => {
  const spread = [
    ...pad(20),
    one({ id: 'y22a', at: utc(2022, 2, 1) }, { brilliant: 1 }),
    one({ id: 'y22b', at: utc(2022, 11, 30), variantSalt: 'b' }, { brilliant: 1 }),
    one({ id: 'y23', at: utc(2023, 7, 4), variantSalt: 'c' }, { brilliant: 3 }),
    one({ id: 'y24', at: utc(2024, 8, 18), variantSalt: 'd' }, { brilliant: 1 }),
    one({ id: 'y25', at: utc(2025, 3, 3), variantSalt: 'e' }, { great: 2 }),
  ];

  it('groups by calendar year (UTC): the year with the most Brilliant moves, and its games with one', () => {
    expect(marksOf(spread).bestYear).toEqual({ year: 2023, brilliant: 3, games: 1 });
    // The pad games are from 2026, the latest Brilliant move from 2024: a later game without one changes nothing
    expect(marksOf(spread).latestAt).toBe(utc(2024, 8, 18));
  });

  it('gives a tie to the later year', () => {
    const tie = [...spread, one({ id: 'y24b', at: utc(2024, 9, 1), variantSalt: 'f' }, { brilliant: 2 })];
    expect(marksOf(tie).bestYear).toEqual({ year: 2024, brilliant: 3, games: 2 });
    expect(marksOf([...tie].reverse()).bestYear).toEqual({ year: 2024, brilliant: 3, games: 2 });
  });

  it('puts a game just before midnight UTC on December 31 in the old year', () => {
    const edge = [
      ...pad(20),
      one({ id: 'old', at: Date.UTC(2023, 11, 31, 23, 59) }, { brilliant: 2 }),
      one({ id: 'new', at: Date.UTC(2024, 0, 1, 0, 0), variantSalt: 'n' }, { brilliant: 1 }),
    ];
    expect(marksOf(edge).bestYear).toEqual({ year: 2023, brilliant: 2, games: 1 });
  });

  it('has no best year when every dated reviewed game is from one year, and none without a dated Brilliant move', () => {
    const oneYear = batch(24, 'o', (i) => ({ review: { brilliant: i === 3 ? 2 : 0 } }));
    expect(marksOf(oneYear).bestYear).toBeNull();
    expect(marksOf(oneYear).latestAt).not.toBeNull();
    const undated = [...pad(20), one({ id: 'u', at: null }, { brilliant: 2 })];
    expect(marksOf(undated)).toMatchObject({ bestYear: null, latestAt: null });
    expect(marksOf(undated).topGame).toMatchObject({ brilliant: 2, playedAt: null });
  });
});

describe('the Brilliant and Great card', () => {
  it('fills every line the data supports', () => {
    const c = cardsOf([
      ...pad(20),
      one({ id: 'a', at: utc(2023, 5, 2), color: 'w', outcome: 'win', tc: '600' }, { brilliant: 3, great: 1 }),
      one({ id: 'b', at: utc(2024, 3, 14), color: 'b', outcome: 'loss', variantSalt: 'b' }, { brilliant: 1 }),
      one({ id: 'c', at: utc(2024, 4, 1), variantSalt: 'c' }, { great: 2 }),
    ]).marks!;
    expect(c.label).toBe('Brilliant and Great');
    expect(c.figures).toEqual([
      { key: 'brilliant', value: '4', label: 'Brilliant moves' },
      { key: 'great', value: '3', label: 'Great moves' },
    ]);
    expect(c.sentence).toBe('You played a Brilliant move in 2 of your 23 reviewed games, about one every 12 games.');
    expect(c.rows).toEqual([
      { label: 'Most in one game', detail: '3 Brilliant · 1 Great' },
      { label: 'Best year', detail: '2023 · 3 Brilliant' },
      { label: 'Latest Brilliant move', detail: 'March 14, 2024' },
      { label: 'Games with a Great move', detail: '2 of 23' },
    ]);
    expect(c.notes).toEqual(['Your most brilliant game: a rapid win as White on May 2, 2023 (10 min).']);
    expect(c.open).toEqual([{ key: 'marks', text: OPEN_GAME_TEXT, name: 'Open your most brilliant game' }]);
  });

  it('hides every Brilliant line and the button with no Brilliant move', () => {
    const c = cardsOf([...pad(20), one({ id: 'g', at: utc(2024, 4, 1) }, { great: 2 })]).marks!;
    expect(c.figures.map((f) => f.value)).toEqual(['0', '2']);
    expect(c.sentence).toBe('No Brilliant move yet in your 21 reviewed games.');
    expect(c.rows).toEqual([{ label: 'Games with a Great move', detail: '1 of 21' }]);
    expect(c.notes).toEqual([]);
    expect(c.open).toEqual([]);
  });

  it('hides the date lines of an undated game and the Great row with no Great move', () => {
    const c = cardsOf([...pad(20), one({ id: 'u', at: null, tc: '-' }, { brilliant: 1 })]).marks!;
    expect(c.figures).toEqual([
      { key: 'brilliant', value: '1', label: 'Brilliant move' },
      { key: 'great', value: '0', label: 'Great moves' },
    ]);
    expect(c.rows).toEqual([{ label: 'Most in one game', detail: '1 Brilliant' }]);
    expect(c.notes).toEqual(['Your most brilliant game: a win as White.']);
  });

  it('is left out when no counted game has review numbers, or too few have them', () => {
    expect(cardsOf(batch(24, 'z')).marks).toBeUndefined();
    expect(cardsOf(batch(19, 'few', () => ({ review: { brilliant: 1 } }))).marks).toBeUndefined();
  });

  it('writes the sentences', () => {
    expect(brilliantSentence({ reviewed: 4535, brilliantGames: 12 })).toBe(
      'You played a Brilliant move in 12 of your 4,535 reviewed games, about one every 378 games.',
    );
    // "about one every 1 games" would say nothing
    expect(brilliantSentence({ reviewed: 30, brilliantGames: 21 })).toBe(
      'You played a Brilliant move in 21 of your 30 reviewed games.',
    );
    expect(brilliantSentence({ reviewed: 30, brilliantGames: 0 })).toBe(
      'No Brilliant move yet in your 30 reviewed games.',
    );
    expect(
      mostBrilliantSentence({
        brilliant: 2,
        great: 0,
        playedAt: utc(2025, 12, 31),
        color: 'b',
        outcome: 'draw',
        timeClass: 'blitz',
        control: '3+2',
      }),
    ).toBe('Your most brilliant game: a blitz draw as Black on December 31, 2025 (3+2).');
  });
});

describe('the games a card can open', () => {
  /** 20 fillers plus a short accurate win, a long loss, a win from 2%, and a win against the highest rating. */
  const records = [
    ...pad(20),
    one({ id: 'accurate', at: utc(2024, 1, 5), outcome: 'win', foeElo: 1400 }, { accuracy: 99, plies: 60, low: 45 }),
    one(
      { id: 'long', at: utc(2024, 2, 5), outcome: 'loss', variantSalt: 'l' },
      { accuracy: 60, plies: 240, moves: 120 },
    ),
    one(
      { id: 'longwin', at: utc(2024, 2, 9), outcome: 'win', foeElo: 1450, variantSalt: 'w' },
      { accuracy: 61, plies: 180, moves: 90, low: 30 },
    ),
    one({ id: 'comeback', at: utc(2024, 3, 5), outcome: 'win', foeElo: 1300, variantSalt: 'c' }, { low: 2 }),
    one({ id: 'giant', at: utc(2024, 4, 5), outcome: 'win', foeElo: 2100, variantSalt: 'g' }, { low: 50 }),
  ];

  it('are kept by id in one place, each the game its card describes', () => {
    expect(stats(records).all.featured).toEqual({
      bestGame: 'chesscom:accurate',
      bestWin: 'chesscom:giant',
      comebacks: 'chesscom:comeback',
      longest: 'chesscom:long',
      longestWin: 'chesscom:longwin',
    });
    expect(featuredGameId(stats(records).all, 'marks')).toBeNull();
  });

  it('give each card its button, with a name that says which game', () => {
    const cards = cardsOf(records);
    expect(cards.bestGame!.open).toEqual([
      { key: 'bestGame', text: 'Open this game', name: 'Open your most accurate game' },
    ]);
    expect(cards.bestWin!.open).toEqual([{ key: 'bestWin', text: 'Open this game', name: 'Open your best win' }]);
    expect(cards.comebacks!.open).toEqual([
      { key: 'comebacks', text: 'Open this game', name: 'Open your most unlikely win' },
    ]);
    expect(cards.records!.open).toEqual([
      { key: 'longest', text: 'Open longest game', name: 'Open your longest game' },
      { key: 'longestWin', text: 'Open longest win', name: 'Open your longest win' },
    ]);
    // Cards about many games have none
    for (const id of ['intro', 'totals', 'hours', 'journey', 'time', 'ends', 'accuracy', 'mistakes', 'closing']) {
      expect(cards[id]!.open).toEqual([]);
    }
  });

  it('Records has one button when the longest game is the longest win, and none without reviewed games', () => {
    const win = [...pad(20), one({ id: 'w', at: utc(2024, 2, 5), outcome: 'win' }, { plies: 300, moves: 150 })];
    expect(cardsOf(win).records!.open).toEqual([
      { key: 'longest', text: 'Open this game', name: 'Open your longest game' },
    ]);
    const plain = Array.from({ length: 24 }, (_, i) => game({ id: `p${i}`, at: utc(2024, 1, 1 + i) }));
    expect(cardsOf(plain).records!.open).toEqual([]);
    expect(stats(plain).all.featured).toEqual({ bestWin: expect.any(String) as string });
  });

  it('never put an id, a name or a link in a card or in the review numbers', () => {
    const all = records.map((r) => ({ ...r, url: 'https://www.chess.com/game/live/1' }));
    const cards = JSON.stringify(storyCards(stats(all))).toLowerCase();
    const review = JSON.stringify(stats(all).all.review).toLowerCase();
    for (const text of [cards, review]) {
      for (const word of [ME, ...FOES, 'chesscom:', 'http']) expect(text).not.toContain(word.toLowerCase());
    }
  });
});
