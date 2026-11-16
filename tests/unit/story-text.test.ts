import { describe, expect, it } from 'vitest';
import { computeStoryStats } from '../../src/story/stats';
import {
  dayLabel,
  monthLabel,
  monthShort,
  notEnoughGames,
  storyCards,
  type StoryCard,
  type StoryCardId,
} from '../../src/story/text';
import { FOES, ME, game, run, utc } from './helpers/story-games';

const accounts = [
  { site: 'chesscom' as const, username: ME },
  { site: 'lichess' as const, username: ME },
];
const stats = (records: Parameters<typeof computeStoryStats>[0]) => computeStoryStats(records, accounts);
const cardsOf = (records: Parameters<typeof computeStoryStats>[0]): Partial<Record<StoryCardId, StoryCard>> =>
  Object.fromEntries(storyCards(stats(records)).map((c) => [c.id, c]));
const idsOf = (records: Parameters<typeof computeStoryStats>[0]) => storyCards(stats(records)).map((c) => c.id);
const n = (v: number) => v.toLocaleString('en-US');

const many = [
  ...run(30, 'a', (i) => ({
    foe: FOES[i % FOES.length]!,
    opening: i % 2 ? 'Ruy Lopez: Berlin Defense, Rio Gambit' : 'Sicilian Defense',
    color: i % 2 ? 'w' : 'b',
    outcome: i % 5 === 0 ? 'loss' : 'win',
    foeElo: 1400 + i * 10,
    myElo: 1500 + i,
    at: utc(2026, 1 + Math.floor(i / 6), 3 + (i % 6)),
    headers: { Termination: i % 5 === 0 ? `${FOES[0]} won by resignation` : `${ME} won by checkmate` },
  })),
  ...run(5, 'l', (i) => ({ source: 'lichess', variantSalt: `l${i}`, tc: '600+0' })),
  game({ id: 'paste', source: 'paste' }),
];

describe('story text', () => {
  it('writes the cards in a fixed order; the site cards come only when both sites have games', () => {
    expect(idsOf(many)).toEqual([
      'intro',
      'totals',
      'chesscom',
      'lichess',
      'hours',
      'journey',
      'time',
      'ends',
      'openings',
      'bestWin',
      'records',
      'closing',
    ]);
    const oneSite = idsOf(many.filter((g) => g.source !== 'lichess'));
    expect(oneSite).not.toContain('chesscom');
    expect(oneSite).not.toContain('lichess');
    expect(oneSite).toEqual([
      'intro',
      'totals',
      'hours',
      'journey',
      'time',
      'ends',
      'openings',
      'bestWin',
      'records',
      'closing',
    ]);
    // Lichess alone: its card would repeat the Total card too
    expect(idsOf(many.filter((g) => g.source === 'lichess'))).not.toContain('lichess');
  });

  it('is the same text for the same stats', () => {
    expect(storyCards(stats(many))).toEqual(storyCards(stats(many)));
  });

  it('puts numbers from the stats into the sentences', () => {
    const s = stats(many);
    const cards = cardsOf(many);
    expect(cards.totals!.value).toBe(String(s.all.games));
    expect(cards.totals!.sentence).toContain(`${s.all.games} games`);
    expect(cards.totals!.notes.join(' ')).toContain('1 pasted or bot game is left out');
    expect(cards.totals!.notes.join(' ')).toContain('one rule for both sites');
    expect(cards.chesscom!.value).toBe('30');
    expect(cards.bestWin!.value).toBe(n(s.all.bestWin!.opponentRating));
  });

  it('says how many games sit on both sites', () => {
    const records = [
      ...run(25, 'a', (i) => ({ variantSalt: `v${i}` })),
      ...run(2, 'l', (i) => ({ source: 'lichess', variantSalt: `v${i}` })),
    ];
    expect(cardsOf(records).totals!.notes.join(' ')).toContain('2 games are on both sites and are counted once.');
  });

  it('names no opponent, username or id', () => {
    const text = JSON.stringify(storyCards(stats(many))).toLowerCase();
    for (const name of [...FOES, ME]) expect(text).not.toContain(name.toLowerCase());
    expect(text).not.toContain('chesscom:');
  });

  it('formats months and days', () => {
    expect(monthLabel('2024-03')).toBe('March 2024');
    expect(monthLabel('2026-12')).toBe('December 2026');
    expect(monthShort('2025-09')).toBe('Sep 2025');
    expect(dayLabel('2023-08-18')).toBe('August 18, 2023');
    expect(dayLabel('2023-08-05')).toBe('August 5, 2023');
  });
});

describe('the empty and thin states', () => {
  it('shows the empty state with no counted games, and none of the new cards', () => {
    const cards = storyCards(stats([]));
    expect(cards[0]!.sentence).toBe('No games yet. Add your username and import.');
    expect(cards.find((c) => c.id === 'totals')!.value).toBe('');
    expect(cards.map((c) => c.id)).toEqual(['intro', 'totals', 'closing']);
  });

  it('reads "Not enough games yet (12 of 20)" below 20 games, with one openings card and no other new card', () => {
    const cards = storyCards(stats(run(12, 'a')));
    expect(notEnoughGames(12)).toBe('Not enough games yet (12 of 20).');
    expect(cards.map((c) => c.id)).toEqual(['intro', 'totals', 'openings', 'closing']);
    expect(cards.find((c) => c.id === 'openings')!.sentence).toBe('Not enough games yet (12 of 20).');
    expect(cards.find((c) => c.id === 'totals')!.value).toBe('12');
    expect(cards.find((c) => c.id === 'totals')!.notes).toContain('Not enough games yet (12 of 20).');
  });

  it('leaves out the best win card when no win has an opponent rating', () => {
    expect(idsOf(run(25, 'a', () => ({ foeElo: null })))).not.toContain('bestWin');
  });
});

describe('the Total card', () => {
  it('has the result bar data, the colours and no class rows (they moved to the time card)', () => {
    const s = stats(many.filter((g) => g.source !== 'lichess'));
    const totals = storyCards(s).find((c) => c.id === 'totals')!;
    expect(totals.rows).toEqual([]);
    expect(totals.notes[0]).toBe(
      `You played ${s.all.white.games} games as White and ${s.all.black.games} games as Black.`,
    );
  });

  it('says "1 game" for one game as a colour', () => {
    const records = [...run(20, 'a', () => ({ color: 'b' })), game({ id: 'w1', variantSalt: 'w', color: 'w' })];
    expect(cardsOf(records).totals!.notes[0]).toBe('You played 1 game as White and 20 games as Black.');
  });
});

describe('the Time controls card', () => {
  const records = [
    ...run(12, 'a', () => ({ tc: '600' })),
    ...run(9, 'b', (i) => ({ tc: '900+10', variantSalt: `b${i}` })),
    ...run(3, 'c', (i) => ({ tc: '180+2', variantSalt: `c${i}` })),
  ];

  it('names the favourite class, lists the classes and gives the two most played exact controls', () => {
    const s = stats(records);
    const card = cardsOf(records).time!;
    expect(card.value).toBe('Rapid');
    expect(card.sentence).toBe('is your favorite: 21 games.');
    expect(card.rows.map((r) => r.label)).toEqual(['Blitz · 3 games', 'Rapid · 21 games']);
    expect(card.rows[1]!.detail).toBe(`${s.all.byClass[1]!.wins} W · 0 L · 0 D · 100% won`);
    expect(card.notes).toEqual(['Most played: 10 min (12 games), then 15+10 (9 games).']);
  });

  it('names both favourites on a tie, and shows one control alone', () => {
    const tie = cardsOf([...run(10, 'a', () => ({ tc: '180' })), ...run(10, 'b', () => ({ tc: '600' }))]).time!;
    expect(tie.value).toBe('Blitz and Rapid');
    expect(tie.sentence).toBe('is your favorite: 10 games each.');
    expect(tie.notes).toEqual(['Most played: 3 min (10 games), then 10 min (10 games).']);
    const one = cardsOf(run(25, 'a', () => ({ tc: '600' }))).time!;
    expect(one.notes).toEqual(['Most played: 10 min (25 games).']);
  });

  it('is left out when no game has a time control', () => {
    expect(idsOf(run(25, 'a', () => ({ tc: '-' })))).not.toContain('time');
  });
});

describe('the How your games end card', () => {
  const win = (i: number, how: string) => ({
    outcome: 'win' as const,
    variantSalt: `${i}`,
    headers: { Termination: `${ME} won ${how}` },
  });
  const loss = (i: number, how: string) => ({
    outcome: 'loss' as const,
    variantSalt: `${i}`,
    headers: { Termination: `${FOES[0]} won ${how}` },
  });
  const records = [
    ...run(6, 'wr', (i) => win(i, 'by resignation')),
    ...run(3, 'wc', (i) => win(100 + i, 'by checkmate')),
    ...run(2, 'wt', (i) => win(200 + i, 'on time')),
    ...run(1, 'wl', (i) => win(300 + i, '- game abandoned')),
    ...run(4, 'lr', (i) => loss(400 + i, 'by resignation')),
    ...run(3, 'll', (i) => loss(500 + i, '- game abandoned')),
    ...run(1, 'lc', (i) => loss(600 + i, 'by checkmate')),
    ...run(2, 'dr', (i) => ({
      outcome: 'draw' as const,
      variantSalt: `${700 + i}`,
      headers: { Termination: 'Game drawn by repetition' },
    })),
    ...run(1, 'da', (i) => ({
      outcome: 'draw' as const,
      variantSalt: `${800 + i}`,
      headers: { Termination: 'Game drawn by agreement' },
    })),
  ];

  it('makes one list of bars for the wins and one for the losses, biggest first, shares of that result', () => {
    const [wins, losses] = cardsOf(records).ends!.meters;
    expect(wins).toEqual({
      title: 'You won 12',
      rows: [
        { label: 'They resigned', count: 6, share: 6 / 12 },
        { label: 'You checkmated them', count: 3, share: 3 / 12 },
        { label: 'They ran out of time', count: 2, share: 2 / 12 },
        { label: 'They left', count: 1, share: 1 / 12 },
      ],
    });
    // Leaving a game is a resignation in all but name: one row
    expect(losses).toEqual({
      title: 'You lost 8',
      rows: [
        { label: 'You resigned or left', count: 7, share: 7 / 8 },
        { label: 'You were checkmated', count: 1, share: 1 / 8 },
      ],
    });
  });

  it('says how many of the "resigned or left" losses were by leaving, and lists the draws in a line', () => {
    expect(cardsOf(records).ends!.notes).toEqual([
      '3 of the 7 "resigned or left" games were by leaving.',
      'You drew 3 games: 2 by repetition and 1 by agreement.',
    ]);
  });

  it('says "game was" for one, leaves out the leaving line with none, and names a lone draw kind', () => {
    const one = cardsOf([
      ...run(3, 'a', (i) => loss(i, '- game abandoned')),
      ...run(20, 'b', (i) => win(50 + i, 'by resignation')),
    ]).ends!;
    expect(one.notes[0]).toBe('3 of the 3 "resigned or left" games were by leaving.');
    const single = cardsOf([
      ...run(1, 'a', (i) => loss(i, '- game abandoned')),
      ...run(20, 'b', (i) => win(50 + i, 'by resignation')),
    ]).ends!;
    expect(single.notes[0]).toBe('1 of the 1 "resigned or left" game was by leaving.');
    const none = cardsOf([
      ...run(3, 'a', (i) => loss(i, 'by resignation')),
      ...run(20, 'b', (i) => win(50 + i, 'by resignation')),
    ]).ends!;
    expect(none.notes).toEqual([]);
    const draw = cardsOf([
      ...run(1, 'd', () => ({ outcome: 'draw', headers: { Termination: 'Game drawn by stalemate' } })),
      ...run(20, 'b', (i) => win(50 + i, 'by resignation')),
    ]).ends!;
    expect(draw.notes).toEqual(['You drew 1 game: 1 by stalemate.']);
  });

  it('has no list for a result that never happened', () => {
    const only = cardsOf(run(25, 'a', (i) => win(i, 'by checkmate'))).ends!;
    expect(only.meters.map((m) => m.title)).toEqual(['You won 25']);
    expect(only.notes).toEqual([]);
  });
});

describe('the Openings card', () => {
  const records = [
    ...run(14, 'a', (i) => ({
      color: 'w',
      opening: 'Vienna Game: Vienna Gambit',
      outcome: i < 7 ? 'win' : 'loss',
      variantSalt: `a${i}`,
    })),
    ...run(6, 'b', (i) => ({ color: 'w', opening: 'Vienna Game', variantSalt: `b${i}` })),
    ...run(5, 'c', (i) => ({
      color: 'w',
      opening: 'English Opening: Symmetrical Variation, Anglo-Indian',
      variantSalt: `c${i}`,
    })),
    ...run(5, 'd', (i) => ({ color: 'w', opening: 'Bird Opening', variantSalt: `d${i}` })),
    ...run(8, 'e', (i) => ({
      color: 'b',
      opening: 'Caro-Kann Defense: Advance Variation, Short Variation',
      variantSalt: `e${i}`,
    })),
  ];

  it('lists the top two openings per colour with the win rate and the most-played variation', () => {
    const rows = cardsOf(records).openings!.rows;
    expect(rows).toEqual([
      {
        label: 'White · Vienna Game · 20 games',
        detail: `${Math.round(((7 + 6) / 20) * 100)}% won · mostly Vienna Gambit`,
      },
      { label: 'White · Bird Opening · 5 games', detail: '5 W · 0 L · 0 D' },
      { label: 'Black · Caro-Kann Defense · 8 games', detail: '8 W · 0 L · 0 D · mostly Advance Variation' },
    ]);
  });

  it('counts the games with no named opening, once', () => {
    const card = cardsOf([...records, ...run(3, 'n', (i) => ({ variantSalt: `n${i}` }))]).openings!;
    expect(card.notes).toEqual(['3 games had no named opening.']);
    expect(cardsOf([...records, ...run(1, 'n', () => ({ variantSalt: 'n' }))]).openings!.notes).toEqual([
      '1 game had no named opening.',
    ]);
  });

  it('is left out when no opening has 5 games', () => {
    expect(idsOf(run(25, 'a', (i) => ({ opening: `Opening ${i}`, variantSalt: `${i}` })))).not.toContain('openings');
  });
});

describe('the Best win card', () => {
  it('names the best win, my rating then, the biggest upset and the number of wins against higher ratings', () => {
    const records = [
      ...run(20, 'f', (i) => ({ foeElo: 1400, myElo: 1500, variantSalt: `f${i}` })),
      game({ id: 'best', foeElo: 1900, myElo: 1700, at: utc(2026, 5, 20), tc: '600', variantSalt: 'best' }),
      game({ id: 'up', foeElo: 1500, myElo: 1000, at: utc(2026, 6, 20), tc: '900+10', variantSalt: 'up' }),
    ];
    const card = cardsOf(records).bestWin!;
    expect(card.value).toBe('1,900');
    expect(card.sentence).toBe(
      'Your best win was against a player rated 1,900, in a rapid game in May 2026. You were rated 1,700.',
    );
    expect(card.notes).toEqual([
      'Biggest upset: a rapid win in June 2026 against a player 500 points above you (1,500 against your 1,000).',
      'You have beaten a higher-rated player 2 times.',
    ]);
  });

  it('says "1 time" and "1 point", and leaves out both notes when no win was against a higher rating', () => {
    const one = cardsOf([
      ...run(20, 'f', (i) => ({ foeElo: 1400, myElo: 1500, variantSalt: `f${i}` })),
      game({ id: 'up', foeElo: 1501, myElo: 1500, variantSalt: 'up' }),
    ]).bestWin!;
    expect(one.notes[0]).toContain('a player 1 point above you');
    expect(one.notes[1]).toBe('You have beaten a higher-rated player 1 time.');
    const none = cardsOf(run(25, 'f', (i) => ({ foeElo: 1400, myElo: 1500, variantSalt: `f${i}` }))).bestWin!;
    expect(none.notes).toEqual([]);
  });
});

describe('the Records card', () => {
  it('shows the longest streak as the value, and the other records as rows', () => {
    type O = 'win' | 'loss' | 'draw';
    const list: O[] = [
      'win',
      'win',
      'win',
      'win',
      'draw',
      'win',
      ...Array<O>(5).fill('loss'),
      'win',
      'win',
      ...Array<O>(10).fill('draw'),
    ];
    const records = list.map((outcome, i) =>
      game({ id: `r${i}`, outcome, at: utc(2026, 2, 1) + i * 3_600_000, variantSalt: `${i}` }),
    );
    const card = cardsOf(records).records!;
    expect(card.value).toBe('4');
    expect(card.sentence).toBe('wins in a row: your longest streak.');
    expect(card.rows).toEqual([
      { label: 'Losses in a row', detail: '5' },
      { label: 'Games without a loss', detail: '12' },
    ]);
  });

  it('says "win" for a streak of one, and leaves the card out below 20 dated games and no review', () => {
    type O = 'win' | 'loss' | 'draw';
    const list: O[] = ['win', ...Array<O>(24).fill('loss')];
    const records = list.map((outcome, i) =>
      game({ id: `r${i}`, outcome, at: utc(2026, 2, 1) + i * 3_600_000, variantSalt: `${i}` }),
    );
    expect(cardsOf(records).records!.sentence).toBe('win in a row: your longest streak.');
    const undated = run(25, 'u', (i) => ({ at: null, variantSalt: `${i}` }));
    expect(idsOf(undated)).not.toContain('records');
  });
});

describe('the Time at the board card', () => {
  const live = (id: string, day: number, start: string, end: string) =>
    game({
      id,
      at: utc(2026, 3, day),
      variantSalt: id,
      headers: {
        UTCDate: `2026.03.${String(day).padStart(2, '0')}`,
        UTCTime: start,
        EndDate: `2026.03.${String(day).padStart(2, '0')}`,
        EndTime: end,
      },
    });

  it('gives the hours as the value and the days, the run, the busiest month, year and day as lines', () => {
    // 4 games of 30 minutes on 3 days, two of them on the 6th; 20 more games without clocks
    const records = [
      live('a', 4, '10:00:00', '10:30:00'),
      live('b', 5, '10:00:00', '10:30:00'),
      live('c', 6, '10:00:00', '10:30:00'),
      live('d', 6, '12:00:00', '12:30:00'),
      ...run(20, 'x', (i) => ({ at: utc(2026, 3, 20), variantSalt: `x${i}` })),
    ];
    const card = cardsOf(records).hours!;
    expect(card.value).toBe('2');
    expect(card.sentence).toBe('hours at the board in live games, over 4 days.');
    expect(card.notes).toEqual([
      'Your longest run: 3 days in a row.',
      'Busiest month: March 2026, 24 games.',
      'Busiest year: 2026, 24 games.',
      'Busiest day: 20 games, on March 20, 2026.',
    ]);
  });

  it('says "1 hour" and "1 day", and leaves out a run of one day and a busiest day of one game', () => {
    const records = [
      live('a', 4, '10:00:00', '10:20:00'),
      ...run(19, 'p', (i) => ({ at: null, variantSalt: `p${i}`, headers: {} })),
      ...run(5, 'q', () => ({ at: null, variantSalt: 'q' })),
    ];
    // only one dated game: the hours card says what it has
    const card = cardsOf(records).hours!;
    expect(card.value).toBe('1');
    expect(card.sentence).toBe('hour at the board in live games, over 1 day.');
    expect(card.notes).toEqual(['Busiest month: March 2026, 1 game.', 'Busiest year: 2026, 1 game.']);
  });

  it('tells the days when no game has a start and an end time', () => {
    const records = run(22, 'a', (i) => ({ at: utc(2026, 1, 1 + i), variantSalt: `${i}` }));
    const card = cardsOf(records).hours!;
    expect(card.value).toBe('22');
    expect(card.sentence).toBe('days with a game.');
  });
});

describe('the Rating journey card', () => {
  const climb = (site: 'chesscom' | 'lichess', tc: string, from: number, count: number) =>
    run(count, `${site}${tc}`, (i) => ({
      source: site,
      tc,
      myElo: from + i * 10,
      at: utc(2025, 1 + Math.floor(i / 2), 5 + (i % 2)),
      variantSalt: `${site}${tc}${i}`,
    }));

  it('gives the highest rating as the value and one row per class with the start, the peak and the latest', () => {
    const records = [...climb('chesscom', '600', 1000, 12), ...climb('chesscom', '180', 800, 10)];
    const card = cardsOf(records).journey!;
    expect(card.value).toBe('1,110');
    expect(card.sentence).toBe('is your rapid peak, in June 2025.');
    expect(card.rows).toEqual([
      { label: 'Blitz', detail: 'Started 800 · peak and latest 890, May 2025' },
      { label: 'Rapid', detail: 'Started 1,000 · peak and latest 1,110, Jun 2025' },
    ]);
    expect(card.notes).toEqual([]);
  });

  it('shows the peak and the latest apart when the rating fell', () => {
    const rated = [1000, 1100, 1200, 1300, 1400, 1500, 1400, 1300, 1200, 1100];
    const records = rated
      .map(
        (rating, i) => game({ id: `j${i}`, myElo: rating, at: utc(2025, 1 + i), variantSalt: `${i}` }),
        // Twenty games make a Story; ten of them are unrated
      )
      .concat(run(10, 'u', (i) => ({ myElo: null, variantSalt: `u${i}` })));
    expect(cardsOf(records).journey!.rows).toEqual([
      { label: 'Blitz', detail: 'Started 1,000 · peak 1,500, Jun 2025 · latest 1,100, Oct 2025' },
    ]);
  });

  it('lists the four most played classes of five, in class order', () => {
    const records = [
      ...climb('chesscom', '60', 800, 10),
      ...climb('chesscom', '180', 800, 11),
      ...climb('chesscom', '600', 800, 12),
      ...climb('chesscom', '1500', 800, 13),
      ...climb('chesscom', '1/86400', 800, 14),
    ];
    expect(cardsOf(records).journey!.rows.map((r) => r.label)).toEqual(['Blitz', 'Rapid', 'Classical', 'Daily']);
  });

  it('names the site on each row and says ratings are never combined, with two sites', () => {
    const card = cardsOf([...climb('chesscom', '600', 1000, 12), ...climb('lichess', '600', 1500, 12)]).journey!;
    expect(card.rows.map((r) => r.label)).toEqual(['Rapid · Chess.com', 'Rapid · Lichess']);
    expect(card.notes).toEqual(['Ratings are never combined across sites.']);
  });

  it('is left out with fewer than 10 rated games in every class', () => {
    expect(
      idsOf(climb('chesscom', '600', 1000, 9).concat(run(20, 'u', (i) => ({ myElo: null, variantSalt: `u${i}` })))),
    ).not.toContain('journey');
  });
});

describe('the personal text', () => {
  it('goes on the first and last card only, and changes no number or number sentence', () => {
    const s = stats(many);
    const plain = storyCards(s);
    const withText = storyCards(s, {
      intro: 'Happy birthday. 99 reasons to play.',
      closing: '  See you at 1000 rating.  ',
    });
    expect(withText.find((c) => c.id === 'intro')!.personal).toBe('Happy birthday. 99 reasons to play.');
    expect(withText.find((c) => c.id === 'closing')!.personal).toBe('See you at 1000 rating.');
    expect(withText.filter((c) => c.personal !== null).map((c) => c.id)).toEqual(['intro', 'closing']);
    const strip = (cards: typeof plain) => cards.map((c) => ({ ...c, personal: null }));
    expect(strip(withText)).toEqual(strip(plain));
  });

  it('is not read for numbers: stats come from games alone, so two profiles give identical stats', () => {
    const a = stats(many);
    const b = stats(many);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain('Happy birthday');
  });

  it('treats empty text as none', () => {
    const cards = storyCards(stats(many), { intro: '   ', closing: null });
    expect(cards.every((c) => c.personal === null)).toBe(true);
  });
});

describe('the notes about how the two sites differ', () => {
  it('are left out with one site', () => {
    const one = cardsOf(run(25, 'a'));
    expect(one.totals!.notes.join(' ')).not.toContain('one rule for both sites');
    expect(one.journey?.notes.join(' ') ?? '').not.toContain('never combined');
  });

  it('are shown with games from both sites (invented, different games on each)', () => {
    const both = cardsOf([
      ...run(20, 'c', (i) => ({ foe: FOES[i % FOES.length]!, variantSalt: `c${i}`, tc: '600+0' })),
      ...run(20, 'x', (i) => ({ source: 'lichess', foe: FOES[i % FOES.length]!, variantSalt: `x${i}`, tc: '600+0' })),
    ]);
    expect(both.chesscom!.value).toBe('20');
    expect(both.lichess!.value).toBe('20');
    expect(both.totals!.notes.join(' ')).toContain(
      'Time classes follow one rule for both sites, so a few games may be labeled differently on Chess.com or Lichess.',
    );
    expect(both.journey!.notes).toEqual(['Ratings are never combined across sites.']);
  });
});
