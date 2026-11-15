import { describe, expect, it } from 'vitest';
import type { UserAccount } from '../../src/review/perspective';
import { computeStoryStats, storyGames } from '../../src/story/stats';
import { FOES, ME, game, run, utc } from './helpers/story-games';
import { batch, reviewed } from './helpers/story-reviews';

const NOW = utc(2026, 6, 20);
const mine: UserAccount[] = [
  { site: 'chesscom', username: ME },
  { site: 'lichess', username: ME },
];

// Games the Story counts, and one of each kind it leaves out
const counted = [
  reviewed(game({ id: 'a', at: utc(2026, 1, 5) }), { accuracy: 70 }),
  reviewed(game({ id: 'b', color: 'b', outcome: 'loss', at: utc(2026, 2, 5), tc: '600' }), { accuracy: 80 }),
  game({ id: 'c', outcome: 'draw', at: utc(2026, 3, 5), tc: '1/86400' }),
  game({ id: 'd', at: null }),
];
const left = [
  game({ id: 'paste', source: 'paste' }),
  game({ id: 'bot', source: 'play' }),
  game({ id: 'stranger', me: 'someoneelse' }),
  game({ id: 'open', outcome: 'unfinished' }),
  game({ id: 'c960', headers: { Variant: 'Chess960' } }),
  game({ id: 'setup', headers: { FEN: '8/8/8/8/8/8/8/K6k w - - 0 1', SetUp: '1' } }),
];

describe('storyGames', () => {
  it('leaves out pasted games, games played here, other people’s games, unfinished games and Chess960 or set-up games', () => {
    const games = storyGames([...counted, ...left], mine);
    expect(games).toHaveLength(counted.length);
    expect(computeStoryStats([...counted, ...left], mine, NOW).excluded.total).toBe(left.length);
  });

  it('reads the outcome, my colour, the time class, the date and the review of each counted game', () => {
    const games = storyGames(counted, mine);
    expect(games.map((g) => g.outcome)).toEqual(['win', 'loss', 'draw', 'win']);
    expect(games.map((g) => g.color)).toEqual(['w', 'b', 'w', 'w']);
    expect(games.map((g) => g.timeClass)).toEqual(['blitz', 'rapid', 'daily', 'blitz']);
    expect(games.map((g) => g.playedAt)).toEqual([utc(2026, 1, 5), utc(2026, 2, 5), utc(2026, 3, 5), null]);
    expect(games.map((g) => g.review?.accuracy ?? null)).toEqual([70, 80, null, null]);
  });

  it('counts a game found on both sites once, and two different games twice', () => {
    const chesscom = game({ id: 'same', source: 'chesscom' });
    const lichess = game({ id: 'same', source: 'lichess' });
    expect(storyGames([chesscom, lichess], mine)).toHaveLength(1);
    expect(storyGames([chesscom, game({ id: 'other', source: 'lichess', variantSalt: 'x' })], mine)).toHaveLength(2);
  });

  it('keeps the copy that carries a review when the Chess.com copy has one', () => {
    const chesscom = reviewed(game({ id: 'same', source: 'chesscom' }), { accuracy: 91 });
    const lichess = game({ id: 'same', source: 'lichess' });
    const games = storyGames([chesscom, lichess], mine);
    expect(games).toHaveLength(1);
    expect(games[0]!.review?.accuracy).toBe(91);
  });

  it('holds no id, name, link or source', () => {
    const games = storyGames([...counted, ...batch(3, 'r', () => ({ game: { foe: FOES[1]! } }))], mine);
    for (const g of games)
      expect(Object.keys(g).sort()).toEqual(['color', 'outcome', 'playedAt', 'review', 'timeClass']);
    const text = JSON.stringify(games);
    for (const word of [ME, ...FOES, 'chesscom', 'lichess', 'http']) expect(text).not.toContain(word);
  });

  it('gives the same games and numbers as the Story’s "all" scope', () => {
    const records = [
      ...counted,
      ...left,
      ...batch(12, 'rv', (i) => ({
        game: { outcome: i % 3 === 0 ? ('loss' as const) : ('win' as const), at: utc(2025, 1 + (i % 12), 3) },
        review: { accuracy: 60 + i },
      })),
      game({ id: 'dup', source: 'chesscom', variantSalt: 'dup' }),
      game({ id: 'dup', source: 'lichess', variantSalt: 'dup' }),
    ];
    const all = computeStoryStats(records, mine, NOW).all;
    const games = storyGames(records, mine);
    expect(games).toHaveLength(all.games);
    expect(games.filter((g) => g.outcome === 'win')).toHaveLength(all.wins);
    expect(games.filter((g) => g.outcome === 'loss')).toHaveLength(all.losses);
    expect(games.filter((g) => g.outcome === 'draw')).toHaveLength(all.draws);
    expect(games.filter((g) => g.review !== null)).toHaveLength(all.review.reviewed);
    const accuracies = games.flatMap((g) => (g.review ? [g.review.accuracy] : []));
    expect(accuracies.reduce((a, b) => a + b, 0) / accuracies.length).toBeCloseTo(all.review.accuracy!, 10);
  });

  it('is empty for no records and for records that are nobody’s', () => {
    expect(storyGames([], mine)).toEqual([]);
    expect(
      storyGames(
        run(3, 'x', () => ({ me: 'someoneelse' })),
        mine,
      ),
    ).toEqual([]);
  });
});
