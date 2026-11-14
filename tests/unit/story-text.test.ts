import { describe, expect, it } from 'vitest';
import { computeStoryStats } from '../../src/story/stats';
import { monthLabel, notEnoughGames, storyCards, trendSentence } from '../../src/story/text';
import { FOES, ME, game, run, utc } from './helpers/story-games';

const NOW = utc(2026, 6, 20);
const accounts = [
  { site: 'chesscom' as const, username: ME },
  { site: 'lichess' as const, username: ME },
];
const stats = (records: Parameters<typeof computeStoryStats>[0]) => computeStoryStats(records, accounts, NOW);

const many = [
  ...run(30, 'a', (i) => ({
    foe: FOES[i % FOES.length]!,
    opening: i % 2 ? 'Ruy Lopez: Berlin Defense' : 'Sicilian Defense',
    color: i % 2 ? 'w' : 'b',
    outcome: i % 5 === 0 ? 'loss' : 'win',
    foeElo: 1400 + i * 10,
    myElo: 1500 + i,
    at: utc(2026, 1 + Math.floor(i / 6), 3 + (i % 6)),
  })),
  ...run(5, 'l', (i) => ({ source: 'lichess', variantSalt: `l${i}`, tc: '600+0' })),
  game({ id: 'paste', source: 'paste' }),
];

describe('story text', () => {
  it('writes the cards in a fixed order, with the Lichess card only when Lichess games are stored', () => {
    const ids = storyCards(stats(many)).map((c) => c.id);
    expect(ids).toEqual(['intro', 'totals', 'chesscom', 'lichess', 'openings', 'bestWin', 'trend', 'closing']);
    const ccOnly = storyCards(stats(many.filter((g) => g.source !== 'lichess'))).map((c) => c.id);
    expect(ccOnly).not.toContain('lichess');
  });

  it('is the same text for the same stats', () => {
    expect(storyCards(stats(many))).toEqual(storyCards(stats(many)));
  });

  it('puts numbers from the stats into the sentences', () => {
    const s = stats(many);
    const cards = Object.fromEntries(storyCards(s).map((c) => [c.id, c]));
    expect(cards.totals!.value).toBe(String(s.all.games));
    expect(cards.totals!.sentence).toContain(`${s.all.games} games`);
    expect(cards.totals!.notes.join(' ')).toContain('1 stored game was not counted');
    expect(cards.totals!.notes.join(' ')).toContain('one rule for both sites');
    expect(cards.chesscom!.value).toBe('30');
    expect(cards.bestWin!.value).toBe(s.all.bestWin!.opponentRating.toLocaleString('en-US'));
    expect(cards.openings!.sentence).toMatch(/^As White: Ruy Lopez \(15 games, /);
  });

  it('says how many games sit on both sites', () => {
    const records = [
      ...run(25, 'a', (i) => ({ variantSalt: `v${i}` })),
      ...run(2, 'l', (i) => ({ source: 'lichess', variantSalt: `v${i}` })),
    ];
    const totals = storyCards(stats(records)).find((c) => c.id === 'totals')!;
    expect(totals.notes.join(' ')).toContain('2 games are on both sites and are counted once.');
  });

  it('names no opponent, username or id', () => {
    const text = JSON.stringify(storyCards(stats(many))).toLowerCase();
    for (const name of [...FOES, ME]) expect(text).not.toContain(name.toLowerCase());
    expect(text).not.toContain('chesscom:');
  });

  it('shows the empty state with no counted games', () => {
    const cards = storyCards(stats([]));
    expect(cards[0]!.sentence).toBe('No games yet. Add your username and import.');
    expect(cards.find((c) => c.id === 'totals')!.value).toBe('');
    expect(cards.find((c) => c.id === 'chesscom')!.sentence).toBe('No Chess.com games are stored yet.');
    expect(cards.map((c) => c.id)).not.toContain('lichess');
  });

  it('reads "Not enough games yet (12 of 20)" below 20 games', () => {
    const cards = storyCards(stats(run(12, 'a')));
    expect(notEnoughGames(12)).toBe('Not enough games yet (12 of 20).');
    for (const id of ['openings', 'trend'] as const) {
      expect(cards.find((c) => c.id === id)!.sentence).toBe('Not enough games yet (12 of 20).');
    }
    // The intro, totals and best win stay
    expect(cards.find((c) => c.id === 'totals')!.value).toBe('12');
    expect(cards.find((c) => c.id === 'bestWin')!.sentence).toContain('best win');
    expect(cards.find((c) => c.id === 'chesscom')!.notes).toEqual(['Not enough games yet (12 of 20).']);
  });

  it('says there is no rated win yet', () => {
    const cards = storyCards(stats(run(3, 'a', () => ({ foeElo: null }))));
    expect(cards.find((c) => c.id === 'bestWin')!.sentence).toBe('No rated win yet.');
  });

  it('reads "No games since March 2024" when the window is empty', () => {
    const old = run(21, 'o', (i) => ({ at: utc(2024, 3, 1 + (i % 20), i) }));
    const s = stats(old);
    expect(trendSentence(s.all.trends[0]!)).toBe('No games since March 2024.');
    expect(storyCards(s).find((c) => c.id === 'trend')!.sentence).toBe('No games since March 2024.');
  });

  it('describes a trend, never across sites', () => {
    const months = [1, 2, 3, 4, 5].flatMap((m, mi) =>
      Array.from({ length: 4 }, (_, k) =>
        game({ id: `m${m}${k}`, at: utc(2026, m, 3 + k), myElo: 1400 + mi * 50, variantSalt: `${m}${k}` }),
      ),
    );
    const s = stats(months);
    expect(storyCards(s).find((c) => c.id === 'trend')!.sentence).toBe(
      'Your Chess.com blitz rating went from 1,400 in January 2026 to 1,600 in May 2026: up 200.',
    );
  });

  it('formats months', () => {
    expect(monthLabel('2024-03')).toBe('March 2024');
    expect(monthLabel('2026-12')).toBe('December 2026');
  });

  it('names a tie of favourites and gives the streaks only from 20 dated games', () => {
    const tie = storyCards(stats([...run(10, 'a', () => ({ tc: '180' })), ...run(10, 'b', () => ({ tc: '600' }))]));
    expect(tie.find((c) => c.id === 'totals')!.notes.join(' ')).toContain('blitz and rapid');
    const cards = storyCards(stats(many));
    expect(cards.find((c) => c.id === 'openings')!.notes.join(' ')).toMatch(/longest winning streak is \d+ games?/);
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
