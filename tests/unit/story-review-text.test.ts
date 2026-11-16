import { describe, expect, it } from 'vitest';
import type { StoredGameRecord } from '../../src/storage/db';
import { MIN_REVIEWED_GAMES, computeStoryStats } from '../../src/story/stats';
import {
  CLASS_ROWS_SHOWN,
  YEAR_ROWS_SHOWN,
  earlierYearsNote,
  notEnoughReviewed,
  reviewCards,
  storyCards,
} from '../../src/story/text';
import { FOES, ME, game, run, utc, type GameSpec } from './helpers/story-games';
import { batch, reviewed } from './helpers/story-reviews';

const accounts = [
  { site: 'chesscom' as const, username: ME },
  { site: 'lichess' as const, username: ME },
];
const stats = (records: Parameters<typeof computeStoryStats>[0]) => computeStoryStats(records, accounts);
const cardsOf = (records: Parameters<typeof computeStoryStats>[0]) =>
  Object.fromEntries(storyCards(stats(records)).map((c) => [c.id, c]));

const FOOT_START = "Accuracy here is measured by the app, so it can differ a little from Chess.com's number. ";
const FOOT_END =
  ' A game you review here replaces its earlier numbers, and a timed review can give a slightly different number for the same game.';
/** The footnote: the last sentence (a game reviewed here replaces its numbers) only when a game was reviewed on the device. */
const footnote = (middle: string, onDevice = false) => `${FOOT_START}${middle}.${onDevice ? FOOT_END : ''}`;

/** 24 reviewed games: 12 older White wins at 70% with 2 blunders, 12 newer Black losses at 80% with 1. */
const D = batch(24, 'd', (i) => ({
  game: i < 12 ? { color: 'w' as const, outcome: 'win' as const } : { color: 'b' as const, outcome: 'loss' as const },
  review: {
    accuracy: i < 12 ? 70 : 80,
    blunder: i < 12 ? 2 : 1,
    mistake: 3,
    inaccuracy: 4,
    moves: 28,
    brilliant: i < 2 ? 1 : 0,
    great: i === 5 ? 5 : 0,
  },
}));

/** `count` reviewed Black losses at 50% (they change no win-based number). */
const pad = (count: number, moves = 30) =>
  batch(count, 'pad', () => ({
    game: { color: 'b' as const, outcome: 'loss' as const },
    review: { accuracy: 50, moves },
  }));

describe('which review cards are made', () => {
  it('makes none without reviewed games, so the card list is the one it was', () => {
    const records = run(30, 'a');
    expect(storyCards(stats(records)).map((c) => c.id)).toEqual([
      'intro',
      'totals',
      'hours',
      'journey',
      'time',
      'ends',
      'bestWin',
      'records',
      'closing',
    ]);
    expect(reviewCards(stats(records).all.review)).toEqual([]);
  });

  it('puts the review cards after how the games end and before the best win; the comebacks follow the best win', () => {
    expect(storyCards(stats(D)).map((c) => c.id)).toEqual([
      'intro',
      'totals',
      'hours',
      'journey',
      'time',
      'ends',
      'accuracy',
      'mistakes',
      'marks',
      'bestGame',
      'bestWin',
      'records',
      'closing',
    ]);
    const withLichess = [...D, ...run(2, 'l', (i) => ({ source: 'lichess' as const, variantSalt: `l${i}` }))];
    expect(
      storyCards(stats(withLichess))
        .map((c) => c.id)
        .slice(0, 5),
    ).toEqual(['intro', 'totals', 'chesscom', 'lichess', 'hours']);
  });

  it('makes one "not enough" card from 1 to 19 reviewed games and the full set from 20', () => {
    const idsFor = (count: number, extra: StoredGameRecord[] = []) =>
      reviewCards(stats([...pad(count), ...extra]).all.review).map((c) => c.id);
    expect(idsFor(MIN_REVIEWED_GAMES - 1)).toEqual(['accuracy']);
    // Padding games have no Brilliant or Great move and no win: the marks and comebacks cards are left out
    expect(idsFor(MIN_REVIEWED_GAMES)).toEqual(['accuracy', 'mistakes', 'bestGame']);
    const win = reviewed(game({ id: 'w', at: utc(2024, 3, 10) }), { low: 3, brilliant: 1 });
    expect(idsFor(MIN_REVIEWED_GAMES, [win])).toEqual(['accuracy', 'mistakes', 'marks', 'bestGame', 'comebacks']);
  });
});

describe('the Accuracy card', () => {
  const c = cardsOf(D).accuracy!;

  it('gives the mean, a row per time class, the colour note, the wins and losses note, then the footnote', () => {
    expect(c.value).toBe('75.0%');
    expect(c.sentence).toBe('Your average accuracy is 75.0% over 24 reviewed games.');
    expect(c.rows).toEqual([{ label: 'Blitz · 24 games', detail: '75.0% average accuracy' }]);
    expect(c.notes).toEqual([
      'As White 70.0% over 12 games; as Black 80.0% over 12 games.',
      'Your accuracy averaged 70.0% in the 12 games you won and 80.0% in the 12 games you lost.',
      footnote('Based on 24 of your 24 games'),
    ]);
  });

  it('leaves out the colour and the wins-and-losses notes below 10 games on one side', () => {
    const lopsided = [
      ...batch(12, 'w', () => ({ game: { color: 'w' as const, outcome: 'win' as const } })),
      ...batch(9, 'b', () => ({ game: { color: 'b' as const, outcome: 'loss' as const } })),
    ];
    const notes = cardsOf(lopsided).accuracy!.notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Based on');
  });

  it('counts a game reviewed here in the footnote, and drops the device clause when there is none', () => {
    const mixed = [
      ...batch(21, 'a'),
      ...batch(3, 'dev', () => ({ review: { advance: false, preset: 'quick' as const } })),
      ...run(6, 'plain'),
    ];
    expect(cardsOf(mixed).accuracy!.notes.at(-1)).toBe(footnote('Based on 24 of your 30 games', true));
    const onlyDevice = batch(25, 'o', () => ({ review: { advance: false, preset: 'quick' as const } }));
    expect(cardsOf(onlyDevice).accuracy!.notes.at(-1)).toBe(footnote('Based on 25 of your 25 games', true));
  });

  it('says that a game reviewed here replaces its numbers only when one was reviewed on the device', () => {
    const REPLACES = 'A game you review here replaces its earlier numbers';
    expect(cardsOf(D).accuracy!.notes.join(' ')).not.toContain(REPLACES);
    const mixed = [
      ...batch(21, 'a'),
      ...batch(3, 'dev', () => ({ review: { advance: false, preset: 'quick' as const } })),
    ];
    expect(cardsOf(mixed).accuracy!.notes.at(-1)).toContain(REPLACES);
    // The "not enough" card follows the same rule
    const fewDevice = [
      ...batch(10, 'a'),
      ...batch(2, 'dev', () => ({ review: { advance: false, preset: 'quick' as const } })),
    ];
    const few = cardsOf(fewDevice).accuracy!;
    expect(few.sentence).toBe('Not enough reviewed games yet (12 of 20).');
    expect(few.notes).toEqual([footnote('Based on 12 of your 12 games', true)]);
    expect(cardsOf(batch(12, 'r')).accuracy!.notes.join(' ')).not.toContain(REPLACES);
  });

  it('says "Not enough reviewed games yet (12 of 20)." with the footnote, and no number', () => {
    expect(notEnoughReviewed(12)).toBe('Not enough reviewed games yet (12 of 20).');
    const c12 = cardsOf([...batch(12, 'r'), ...run(3, 'plain')]).accuracy!;
    expect(c12.value).toBe('');
    expect(c12.sentence).toBe('Not enough reviewed games yet (12 of 20).');
    expect(c12.rows).toEqual([]);
    expect(c12.notes).toEqual([footnote('Based on 12 of your 15 games')]);
  });

  it('uses the singular for one game', () => {
    const c1 = cardsOf(batch(1, 'r')).accuracy!;
    expect(c1.sentence).toBe('Not enough reviewed games yet (1 of 20).');
    expect(c1.notes[0]).toBe(footnote('Based on 1 of your 1 game'));
  });

  it('does not repeat the footnote on the Mistakes card', () => {
    expect(JSON.stringify(cardsOf(D).mistakes)).not.toContain("Lichess's formula");
  });
});

describe('the Mistakes card', () => {
  const c = cardsOf(D).mistakes!;

  it('gives blunders a game, the other classes, the halves, and a row per year', () => {
    expect(c.value).toBe('1.5');
    expect(c.sentence).toBe('You blundered 1.5 times a game over 24 reviewed games.');
    expect(c.rows).toEqual([{ label: '2026 · 24 games', detail: '75.0% accuracy · 1.5 blunders a game' }]);
    expect(c.notes).toEqual([
      'Mistakes: 3.0 a game. Inaccuracies: 4.0 a game.',
      'Early on: 70.0% accuracy and 2.0 blunders a game. Lately: 80.0% and 1.0.',
    ]);
  });

  it('leaves out the halves note and the year rows for undated games', () => {
    const undated = cardsOf(batch(24, 'u', () => ({ game: { at: null }, review: { brilliant: 1 } }))).mistakes!;
    expect(undated.rows).toEqual([]);
    expect(undated.notes).toHaveLength(1);
    expect(undated.notes.join(' ')).not.toContain('Early on');
  });

  it('holds no Brilliant or Great note any more: that is the card of its own', () => {
    expect(cardsOf(D).mistakes!.notes.join(' ')).not.toContain('Brilliant');
  });
});

describe('the Brilliant and Great card', () => {
  it('gives both counts in a sentence and the games each came in as rows', () => {
    // D: 2 games with a Brilliant move (1 each), 1 game with 5 Great moves
    const c = cardsOf(D).marks!;
    expect(c.sentence).toBe('2 Brilliant moves and 5 Great moves.');
    expect(c.rows).toEqual([
      { label: 'Brilliant', detail: '2 moves in 2 games' },
      { label: 'Great', detail: '5 moves in 1 game' },
    ]);
    expect(c.value).toBe('');
  });

  it('says "move" for one, "none" for a zero row, and is left out when both counts are zero', () => {
    const onlyGreat = cardsOf(batch(24, 'z', (i) => ({ review: { great: i === 0 ? 1 : 0 } }))).marks!;
    expect(onlyGreat.sentence).toBe('0 Brilliant moves and 1 Great move.');
    expect(onlyGreat.rows).toEqual([
      { label: 'Brilliant', detail: 'none' },
      { label: 'Great', detail: '1 move in 1 game' },
    ]);
    const onlyBrilliant = cardsOf(batch(24, 'z', () => ({ review: { brilliant: 1 } }))).marks!;
    expect(onlyBrilliant.sentence).toBe('24 Brilliant moves and 0 Great moves.');
    expect(cardsOf(batch(24, 'z')).marks).toBeUndefined();
  });
});

describe('the Comebacks card', () => {
  const win = (id: string, low: number | null, extra: Partial<GameSpec> = {}) =>
    reviewed(game({ id, at: utc(2024, 3, 10), tc: '180+2', ...extra }), { low });

  it('counts the wins from under 5%, names the most unlikely one, with its class and month', () => {
    const c = cardsOf([
      ...pad(20),
      win('w1', 3),
      win('w2', 4.9, { variantSalt: '2' }),
      win('w3', 5, { variantSalt: '3' }),
    ]).comebacks!;
    expect(c.value).toBe('2');
    expect(c.sentence).toBe('wins from a position where you had under a 5% chance.');
    expect(c.notes).toEqual(['Your most unlikely win: you had only a 3% chance, a blitz game in March 2024.']);
  });

  it('says "win" for one comeback', () => {
    const c = cardsOf([...pad(20), win('w1', 3)]).comebacks!;
    expect(c.value).toBe('1');
    expect(c.sentence).toBe('win from a position where you had under a 5% chance.');
  });

  it('rounds the chance and says "less than a 1% chance" below 1', () => {
    for (const [low, text] of [
      [2.5, 'only a 3% chance'],
      [4.4, 'only a 4% chance'],
      [0.99, 'less than a 1% chance'],
      [0, 'less than a 1% chance'],
    ] as const) {
      expect(cardsOf([...pad(20), win('w1', low)]).comebacks!.notes[0]).toBe(
        `Your most unlikely win: you had ${text}, a blitz game in March 2024.`,
      );
    }
  });

  it('says how many other wins fell that low, in the singular and the plural', () => {
    const two = cardsOf([...pad(20), win('a', 3), win('b', 3, { variantSalt: 'b' })]).comebacks!;
    expect(two.notes.slice(1)).toEqual(['1 other win fell that low.']);
    const three = cardsOf([
      ...pad(20),
      win('a', 3),
      win('b', 3, { variantSalt: 'b' }),
      win('c', 3, { variantSalt: 'c' }),
    ]).comebacks!;
    expect(three.notes.slice(1)).toEqual(['2 other wins fell that low.']);
  });

  it('names a review made on this device by its preset', () => {
    const dev = reviewed(game({ id: 'd', at: utc(2024, 3, 10) }), { low: 3, advance: false, preset: 'quick' });
    expect(cardsOf([...pad(20), dev]).comebacks!.notes.at(-1)).toBe('This game was reviewed on this device (Quick).');
  });

  it('builds the clause from what the game has: class and date, date only, class only, neither', () => {
    const sentence = (extra: Partial<GameSpec>) => cardsOf([...pad(20), win('w1', 3, extra)]).comebacks!.notes[0];
    expect(sentence({})).toBe('Your most unlikely win: you had only a 3% chance, a blitz game in March 2024.');
    expect(sentence({ tc: '-' })).toBe('Your most unlikely win: you had only a 3% chance, a game in March 2024.');
    expect(sentence({ at: null })).toBe('Your most unlikely win: you had only a 3% chance, a blitz game.');
    expect(sentence({ at: null, tc: '-' })).toBe('Your most unlikely win: you had only a 3% chance.');
  });

  it('is left out with no comeback: no reviewed win, or none from under 5%', () => {
    expect(cardsOf(pad(20)).comebacks).toBeUndefined();
    expect(cardsOf([...pad(20), win('w1', 5)]).comebacks).toBeUndefined();
    expect(cardsOf([...pad(20), win('w1', null)]).comebacks).toBeUndefined();
  });
});

describe('the Most accurate game card', () => {
  const best = (extra: Partial<GameSpec> = {}) =>
    reviewed(game({ id: 'best', at: utc(2022, 6, 10), tc: '600', foeElo: 1640, ...extra }), {
      accuracy: 97.8,
      moves: 34,
    });

  it('names the result, class, the opponent’s rating, month and moves, then notes the pool and the review', () => {
    const c = cardsOf([...pad(20), best()]).bestGame!;
    expect(c.value).toBe('97.8%');
    expect(c.sentence).toBe(
      'Your most accurate game was 97.8%: a rapid win against a player rated 1,640, in June 2022, over 34 of your moves.',
    );
    expect(c.notes).toEqual(['Out of 21 games of 25 moves or more.']);
  });

  it('says draw or loss, and leaves out what the game does not have', () => {
    expect(cardsOf([...pad(20), best({ outcome: 'draw' })]).bestGame!.sentence).toContain(': a rapid draw against');
    expect(cardsOf([...pad(20), best({ outcome: 'loss' })]).bestGame!.sentence).toContain(': a rapid loss against');
    const bare = cardsOf([...pad(20), best({ foeElo: null, at: null, tc: '-' })]).bestGame!;
    expect(bare.sentence).toBe('Your most accurate game was 97.8%: a win, over 34 of your moves.');
  });

  it('uses the singular for a pool of one', () => {
    expect(cardsOf([...pad(20, 20), best()]).bestGame!.notes[0]).toBe('Out of 1 game of 25 moves or more.');
  });

  it('is left out when no reviewed game has 25 moves', () => {
    const ids = storyCards(stats(pad(20, 24))).map((c) => c.id);
    expect(ids).toContain('mistakes');
    expect(ids).not.toContain('bestGame');
  });
});

describe('what the review cards never hold', () => {
  it('names no opponent, username, id or link', () => {
    const records = [
      ...batch(25, 'g', (i) => ({ game: { foe: FOES[i % FOES.length]!, foeElo: 1500 + i } })),
      reviewed(game({ id: 'x', foe: FOES[0]! }), { low: 2 }),
    ];
    const text = JSON.stringify(storyCards(stats(records))).toLowerCase();
    for (const name of [...FOES, ME]) expect(text).not.toContain(name.toLowerCase());
    expect(text).not.toContain('chesscom:');
    expect(text).not.toContain('http');
  });

  it('is the same text for the same stats, and the personal text still goes on the first and last card only', () => {
    expect(storyCards(stats(D))).toEqual(storyCards(stats(D)));
    const withText = storyCards(stats(D), { intro: 'Hello 1', closing: 'Bye 2' });
    expect(withText.filter((c) => c.personal !== null).map((c) => c.id)).toEqual(['intro', 'closing']);
  });
});

describe('the newest years on the Mistakes card', () => {
  /** `count` years from 2020, 10 reviewed games each: year k has accuracy 60 + 5k and 5 - k blunders a game. */
  const years = (count: number) =>
    Array.from({ length: count }, (_, k) =>
      batch(10, `y${k}-`, (i) => ({
        game: { at: utc(2020 + k, 3, 1 + i) },
        review: { accuracy: 60 + 5 * k, blunder: 5 - k },
      })),
    ).flat();
  const labels = (count: number) => cardsOf(years(count)).mistakes!.rows.map((r) => r.label);

  it('lists three years', () => {
    expect(YEAR_ROWS_SHOWN).toBe(3);
  });

  it('lists exactly three years in full, with no note', () => {
    const c = cardsOf(years(3)).mistakes!;
    expect(c.rows.map((r) => r.label)).toEqual(['2020 · 10 games', '2021 · 10 games', '2022 · 10 games']);
    expect(c.notes.join(' ')).not.toContain('not listed');
    expect(c.notes[0]).toMatch(/^Mistakes: /);
  });

  it('says "The earliest year is not listed." for four years, and lists the newest three, oldest first', () => {
    const c = cardsOf(years(4)).mistakes!;
    expect(c.notes[0]).toBe('The earliest year is not listed.');
    expect(c.rows.map((r) => r.label)).toEqual(['2021 · 10 games', '2022 · 10 games', '2023 · 10 games']);
  });

  it('says how many earlier years are not listed, from the second one on', () => {
    expect(cardsOf(years(5)).mistakes!.notes[0]).toBe('The 2 earlier years are not listed.');
    const six = cardsOf(years(6)).mistakes!;
    expect(six.notes[0]).toBe('The 3 earlier years are not listed.');
    expect(six.rows).toEqual([
      { label: '2023 · 10 games', detail: '75.0% accuracy · 2.0 blunders a game' },
      { label: '2024 · 10 games', detail: '80.0% accuracy · 1.0 blunders a game' },
      { label: '2025 · 10 games', detail: '85.0% accuracy · 0.0 blunders a game' },
    ]);
    expect(labels(6)).toHaveLength(YEAR_ROWS_SHOWN);
  });

  it('writes the singular and plural forms of the note', () => {
    expect(earlierYearsNote(1)).toBe('The earliest year is not listed.');
    expect(earlierYearsNote(2)).toBe('The 2 earlier years are not listed.');
    expect(earlierYearsNote(3)).toBe('The 3 earlier years are not listed.');
    expect(earlierYearsNote(12)).toBe('The 12 earlier years are not listed.');
  });

  it('puts the note first, before the other notes', () => {
    const notes = cardsOf(years(6)).mistakes!.notes;
    expect(notes[0]).toBe('The 3 earlier years are not listed.');
    expect(notes[1]).toMatch(/^Mistakes: /);
  });

  it('leaves the overall numbers and the halves note covering every year', () => {
    const cards = cardsOf(years(6));
    // All 60 games: blunders 5,4,3,2,1,0 over six equal years, accuracy 60 to 85
    expect(cards.mistakes!.value).toBe('2.5');
    expect(cards.mistakes!.sentence).toBe('You blundered 2.5 times a game over 60 reviewed games.');
    expect(cards.accuracy!.value).toBe('72.5%');
    // The first 30 games are the years 2020 to 2022 (the last of them on 10 March 2022), the other 30 the newest three
    expect(cards.mistakes!.notes.at(-1)).toBe(
      'Early on: 65.0% accuracy and 4.0 blunders a game. Lately: 80.0% and 1.0.',
    );
  });
});

describe('the classes listed on the Accuracy card', () => {
  const inClass = (tc: string, count: number) =>
    batch(count, `k${tc}`.replace('/', '-'), (i) => ({ game: { tc, variantSalt: `${tc}${i}` } }));

  it('lists the three most reviewed classes, in class order, and no more', () => {
    const records = [
      ...inClass('60', 10),
      ...inClass('180', 14),
      ...inClass('600', 30),
      ...inClass('1500', 11),
      ...inClass('1/86400', 12),
    ];
    expect(CLASS_ROWS_SHOWN).toBe(3);
    expect(cardsOf(records).accuracy!.rows.map((r) => r.label)).toEqual([
      'Blitz · 14 games',
      'Rapid · 30 games',
      'Daily · 12 games',
    ]);
  });

  it('lists every class when there are three or fewer', () => {
    expect(cardsOf([...inClass('180', 12), ...inClass('600', 12)]).accuracy!.rows).toHaveLength(2);
  });
});
