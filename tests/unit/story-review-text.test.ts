import { describe, expect, it } from 'vitest';
import { MIN_REVIEWED_GAMES, computeStoryStats } from '../../src/story/stats';
import { YEAR_ROWS_SHOWN, earlierYearsNote, notEnoughReviewed, reviewCards, storyCards } from '../../src/story/text';
import { SHOWN_CARDS } from '../../src/story/view';
import { FOES, ME, game, run, utc, type GameSpec } from './helpers/story-games';
import { batch, reviewed } from './helpers/story-reviews';

const NOW = utc(2026, 6, 20);
const accounts = [
  { site: 'chesscom' as const, username: ME },
  { site: 'lichess' as const, username: ME },
];
const stats = (records: Parameters<typeof computeStoryStats>[0]) => computeStoryStats(records, accounts, NOW);
const cardsOf = (records: Parameters<typeof computeStoryStats>[0]) =>
  Object.fromEntries(storyCards(stats(records)).map((c) => [c.id, c]));

const FOOT_START =
  "Accuracy is the engine's measure (Lichess's formula, Stockfish 17.1 at depth 18); Chess.com's own accuracy can differ. ";
const FOOT_END =
  ' A game you review here replaces its earlier numbers, and a timed review can give a slightly different number for the same game.';
const footnote = (middle: string) => `${FOOT_START}${middle}.${FOOT_END}`;

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
      'chesscom',
      'openings',
      'bestWin',
      'trend',
      'closing',
    ]);
    expect(reviewCards(stats(records).all.review)).toEqual([]);
  });

  it('puts the four cards after the site cards and before the openings card', () => {
    expect(storyCards(stats(D)).map((c) => c.id)).toEqual([
      'intro',
      'totals',
      'chesscom',
      'accuracy',
      'mistakes',
      'swing',
      'bestGame',
      'openings',
      'bestWin',
      'trend',
      'closing',
    ]);
    const withLichess = [...D, ...run(2, 'l', (i) => ({ source: 'lichess' as const, variantSalt: `l${i}` }))];
    expect(
      storyCards(stats(withLichess))
        .map((c) => c.id)
        .slice(0, 5),
    ).toEqual(['intro', 'totals', 'chesscom', 'lichess', 'accuracy']);
  });

  it('shows the four cards in the view', () => {
    for (const id of ['accuracy', 'mistakes', 'swing', 'bestGame'] as const) expect(SHOWN_CARDS).toContain(id);
  });

  it('makes one "not enough" card from 1 to 19 reviewed games and all four from 20', () => {
    const idsFor = (count: number) => reviewCards(stats(pad(count)).all.review).map((c) => c.id);
    expect(idsFor(MIN_REVIEWED_GAMES - 1)).toEqual(['accuracy']);
    expect(idsFor(MIN_REVIEWED_GAMES)).toEqual(['accuracy', 'mistakes', 'swing', 'bestGame']);
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
      footnote('24 of 24 counted games have an engine review: 24 reviewed in advance'),
    ]);
  });

  it('leaves out the colour and the wins-and-losses notes below 10 games on one side', () => {
    const lopsided = [
      ...batch(12, 'w', () => ({ game: { color: 'w' as const, outcome: 'win' as const } })),
      ...batch(9, 'b', () => ({ game: { color: 'b' as const, outcome: 'loss' as const } })),
    ];
    const notes = cardsOf(lopsided).accuracy!.notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('have an engine review');
  });

  it('counts a game reviewed here in the footnote, and drops the device clause when there is none', () => {
    const mixed = [
      ...batch(21, 'a'),
      ...batch(3, 'dev', () => ({ review: { advance: false, preset: 'quick' as const } })),
      ...run(6, 'plain'),
    ];
    expect(cardsOf(mixed).accuracy!.notes.at(-1)).toBe(
      footnote(
        '24 of 30 counted games have an engine review: 21 reviewed in advance and 3 on this device with its timed review',
      ),
    );
    const onlyDevice = batch(25, 'o', () => ({ review: { advance: false, preset: 'quick' as const } }));
    expect(cardsOf(onlyDevice).accuracy!.notes.at(-1)).toBe(
      footnote('25 of 25 counted games have an engine review: 25 on this device with its timed review'),
    );
  });

  it('says "Not enough reviewed games yet (12 of 20)." with the footnote, and no number', () => {
    expect(notEnoughReviewed(12)).toBe('Not enough reviewed games yet (12 of 20).');
    const c12 = cardsOf([...batch(12, 'r'), ...run(3, 'plain')]).accuracy!;
    expect(c12.value).toBe('');
    expect(c12.sentence).toBe('Not enough reviewed games yet (12 of 20).');
    expect(c12.rows).toEqual([]);
    expect(c12.notes).toEqual([footnote('12 of 15 counted games have an engine review: 12 reviewed in advance')]);
  });

  it('uses the singular for one game', () => {
    const c1 = cardsOf(batch(1, 'r')).accuracy!;
    expect(c1.sentence).toBe('Not enough reviewed games yet (1 of 20).');
    expect(c1.notes[0]).toBe(footnote('1 of 1 counted game has an engine review: 1 reviewed in advance'));
  });

  it('does not repeat the footnote on the Mistakes card', () => {
    expect(JSON.stringify(cardsOf(D).mistakes)).not.toContain("Lichess's formula");
  });
});

describe('the Mistakes card', () => {
  const c = cardsOf(D).mistakes!;

  it('gives blunders a game, the other classes, Brilliant and Great, the halves, and a row per year', () => {
    expect(c.value).toBe('1.5');
    expect(c.sentence).toBe('You blundered 1.5 times a game over 24 reviewed games.');
    expect(c.rows).toEqual([{ label: '2026 · 24 games', detail: '75.0% accuracy · 1.5 blunders a game' }]);
    expect(c.notes).toEqual([
      'Mistakes: 3.0 a game. Inaccuracies: 4.0 a game. Your reviewed games average 28 of your moves.',
      'The engine marked 2 of your moves Brilliant and 5 Great.',
      'In the first half of your reviewed games (to January 2026) your accuracy was 70.0% and you blundered 2.0 times a game; in the second half, 80.0% and 1.0.',
    ]);
  });

  it('leaves out the halves note and the year rows for undated games', () => {
    const undated = cardsOf(batch(24, 'u', () => ({ game: { at: null }, review: { brilliant: 1 } }))).mistakes!;
    expect(undated.rows).toEqual([]);
    expect(undated.notes).toHaveLength(2);
    expect(undated.notes.join(' ')).not.toContain('first half');
  });

  it('leaves out the Brilliant and Great note when both counts are zero, and keeps it when either is above zero', () => {
    const none = cardsOf(batch(24, 'z')).mistakes!;
    expect(none.notes.join(' ')).not.toContain('Brilliant');
    expect(none.notes).toHaveLength(2); // the classes note and the halves note
    const onlyBrilliant = cardsOf(batch(24, 'z', () => ({ review: { brilliant: 1 } }))).mistakes!;
    expect(onlyBrilliant.notes).toContain('The engine marked 24 of your moves Brilliant and 0 Great.');
    const onlyGreat = cardsOf(batch(24, 'z', (i) => ({ review: { great: i === 0 ? 1 : 0 } }))).mistakes!;
    expect(onlyGreat.notes).toContain('The engine marked 0 of your moves Brilliant and 1 Great.');
  });
});

describe('the Biggest swing card', () => {
  const win = (id: string, low: number | null, extra: Partial<GameSpec> = {}) =>
    reviewed(game({ id, at: utc(2024, 3, 10), tc: '180+2', ...extra }), { low });

  it('names the lowest win%, the class and month, then notes the pool and how the game was reviewed', () => {
    const c = cardsOf([...pad(20), win('w1', 3)]).swing!;
    expect(c.value).toBe('3%');
    expect(c.sentence).toBe('You won a game the engine had at 3% for you, a blitz game in March 2024.');
    expect(c.notes).toEqual(['Chosen from 1 reviewed win.', 'This game was reviewed in advance at depth 18.']);
  });

  it('rounds the percentage and says "under 1%" below 1', () => {
    for (const [low, text] of [
      [2.5, '3%'],
      [14.4, '14%'],
      [1, '1%'],
      [0.99, 'under 1%'],
      [0, 'under 1%'],
    ] as const) {
      expect(cardsOf([...pad(20), win('w1', low)]).swing!.value).toBe(text);
    }
    expect(cardsOf([...pad(20), win('w1', 0.4)]).swing!.sentence).toBe(
      'You won a game the engine had at under 1% for you, a blitz game in March 2024.',
    );
  });

  it('puts the pool first, then how many other wins fell that low, in the singular and the plural', () => {
    const two = cardsOf([...pad(20), win('a', 3), win('b', 3)]).swing!;
    expect(two.notes).toEqual([
      'Chosen from 2 reviewed wins.',
      '1 other win also fell that low.',
      'This game was reviewed in advance at depth 18.',
    ]);
    const three = cardsOf([...pad(20), win('a', 3), win('b', 3), win('c', 3)]).swing!;
    expect(three.notes.slice(0, 2)).toEqual(['Chosen from 3 reviewed wins.', '2 other wins also fell that low.']);
  });

  it('names a review made on this device by its preset', () => {
    const dev = reviewed(game({ id: 'd', at: utc(2024, 3, 10) }), { low: 3, advance: false, preset: 'quick' });
    expect(cardsOf([...pad(20), dev]).swing!.notes).toEqual([
      'Chosen from 1 reviewed win.',
      'This game was reviewed on this device (Quick).',
    ]);
  });

  it('builds the clause from what the game has: class and date, date only, class only, neither', () => {
    const sentence = (extra: Partial<GameSpec>) => cardsOf([...pad(20), win('w1', 3, extra)]).swing!.sentence;
    expect(sentence({})).toBe('You won a game the engine had at 3% for you, a blitz game in March 2024.');
    expect(sentence({ tc: '-' })).toBe('You won a game the engine had at 3% for you, a game in March 2024.');
    expect(sentence({ at: null })).toBe('You won a game the engine had at 3% for you, a blitz game.');
    expect(sentence({ at: null, tc: '-' })).toBe('You won a game the engine had at 3% for you.');
  });

  it('says "No reviewed win yet." with no value and no notes when no reviewed game was won', () => {
    const c = cardsOf(pad(20)).swing!;
    expect(c.sentence).toBe('No reviewed win yet.');
    expect(c.value).toBe('');
    expect(c.notes).toEqual([]);
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
    expect(c.notes).toEqual([
      'Chosen from 21 reviewed games of 25 moves or more.',
      'This game was reviewed in advance at depth 18.',
    ]);
  });

  it('says draw or loss, and leaves out what the game does not have', () => {
    expect(cardsOf([...pad(20), best({ outcome: 'draw' })]).bestGame!.sentence).toContain(': a rapid draw against');
    expect(cardsOf([...pad(20), best({ outcome: 'loss' })]).bestGame!.sentence).toContain(': a rapid loss against');
    const bare = cardsOf([...pad(20), best({ foeElo: null, at: null, tc: '-' })]).bestGame!;
    expect(bare.sentence).toBe('Your most accurate game was 97.8%: a win, over 34 of your moves.');
  });

  it('uses the singular for a pool of one', () => {
    expect(cardsOf([...pad(20, 20), best()]).bestGame!.notes[0]).toBe(
      'Chosen from 1 reviewed game of 25 moves or more.',
    );
  });

  it('is left out when no reviewed game has 25 moves', () => {
    const ids = storyCards(stats(pad(20, 24))).map((c) => c.id);
    expect(ids).toContain('swing');
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
      'In the first half of your reviewed games (to March 2022) your accuracy was 65.0% and you blundered 4.0 times a game; in the second half, 80.0% and 1.0.',
    );
  });
});
