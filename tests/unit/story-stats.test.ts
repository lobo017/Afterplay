import { describe, expect, it } from 'vitest';
import type { UserAccount } from '../../src/review/perspective';
import {
  BLITZ_BELOW_SECONDS,
  BULLET_BELOW_SECONDS,
  RAPID_BELOW_SECONDS,
  computeStoryStats,
  mainLineMoves,
  timeClassOf,
  trendWindow,
  type StoryStats,
} from '../../src/story/stats';
import { FOES, ME, OTHER_ME, game, run, utc } from './helpers/story-games';

const NOW = utc(2026, 6, 20);
const mine: UserAccount[] = [
  { site: 'chesscom', username: ME },
  { site: 'lichess', username: ME },
];
const stats = (records: Parameters<typeof computeStoryStats>[0], accounts = mine) =>
  computeStoryStats(records, accounts, NOW);

describe('time classes', () => {
  it('names the cutoffs', () => {
    expect([BULLET_BELOW_SECONDS, BLITZ_BELOW_SECONDS, RAPID_BELOW_SECONDS]).toEqual([180, 600, 1500]);
  });

  it.each([
    ['179', 'bullet'],
    ['180', 'blitz'],
    ['299', 'blitz'],
    ['300', 'blitz'],
    ['599', 'blitz'],
    ['600', 'rapid'],
    ['899', 'rapid'],
    ['900', 'rapid'],
    ['1499', 'rapid'],
    ['1500', 'classical'],
  ])('%s s is %s', (tc, expected) => {
    expect(timeClassOf(tc)).toBe(expected);
  });

  it('adds 40 × the increment', () => {
    expect(timeClassOf('60+1')).toBe('bullet'); // 100
    expect(timeClassOf('120+2')).toBe('blitz'); // 200
    expect(timeClassOf('300+5')).toBe('blitz'); // 500
    expect(timeClassOf('300+8')).toBe('rapid'); // 620
    expect(timeClassOf('900+10')).toBe('rapid'); // 1300
    expect(timeClassOf('900+15')).toBe('classical'); // 1500
    expect(timeClassOf('170+0')).toBe('bullet');
    expect(timeClassOf('170+1')).toBe('blitz'); // 210
  });

  it('keeps daily apart and leaves unreadable controls without a class', () => {
    expect(timeClassOf('1/86400')).toBe('daily');
    expect(timeClassOf('-')).toBeNull();
    expect(timeClassOf('')).toBeNull();
    expect(timeClassOf(undefined)).toBeNull();
    expect(timeClassOf('abc')).toBeNull();
  });
});

describe('counted games and exclusions', () => {
  it('counts only my finished standard games from the two sites, and says how many were left out', () => {
    const s = stats([
      game({ id: 'a' }),
      game({ id: 'b', source: 'lichess', outcome: 'loss' }),
      game({ id: 'paste', source: 'paste' }),
      game({ id: 'bot', source: 'play' }),
      game({ id: 'stranger', me: 'someoneelse' }),
      game({
        id: 'c960',
        headers: {
          Variant: 'Chess960',
          SetUp: '1',
          FEN: 'bqnb1rkr/pp3ppp/3ppn2/2p5/5P2/P2P4/NPP1P1PP/BQ1BNRKR w HFhf - 2 9',
        },
      }),
      game({ id: 'fen', headers: { SetUp: '1', FEN: '8/8/8/4k3/8/4K3/8/8 w - - 0 1' } }),
      game({ id: 'atomic', headers: { Variant: 'Atomic' } }),
      game({ id: 'open', outcome: 'unfinished' }),
    ]);
    expect(s.storedGames).toBe(9);
    expect(s.all.games).toBe(2);
    expect(s.excluded).toEqual({ total: 7, pastedOrBot: 2, notMine: 1, nonStandard: 3, unfinished: 1 });
    expect(s.chesscom.games).toBe(1);
    expect(s.lichess.games).toBe(1);
  });

  it('accepts a plain Variant "Standard" tag', () => {
    expect(stats([game({ id: 'a', headers: { Variant: 'Standard' } })]).all.games).toBe(1);
  });

  it('matches my name only on its own site', () => {
    const s = stats([game({ id: 'a', source: 'lichess' })], [{ site: 'chesscom', username: ME }]);
    expect(s.all.games).toBe(0);
    expect(s.excluded.notMine).toBe(1);
  });

  it('has empty, zeroed scopes without games', () => {
    const s = stats([]);
    expect(s.all.games).toBe(0);
    expect(s.all.byClass).toEqual([]);
    expect(s.all.favouriteClasses).toEqual([]);
    expect(s.all.bestWin).toBeNull();
    expect(s.all.trends).toEqual([]);
    expect(s.all.enough).toBe(false);
    expect(s.excluded.total).toBe(0);
  });

  it('counts several accounts, also on one site', () => {
    const accounts: UserAccount[] = [
      { site: 'chesscom', username: ME },
      { site: 'chesscom', username: OTHER_ME },
    ];
    const s = stats(
      [game({ id: 'a' }), game({ id: 'b', me: OTHER_ME, outcome: 'loss' }), game({ id: 'c', me: 'third' })],
      accounts,
    );
    expect(s.chesscom.games).toBe(2);
    expect(s.chesscom.wins).toBe(1);
    expect(s.chesscom.losses).toBe(1);
    expect(s.excluded.notMine).toBe(1);
  });
});

describe('totals, splits and duplicates', () => {
  const same = { at: utc(2026, 4, 2, 9), outcome: 'win' as const, color: 'w' as const };

  it('counts a game on both sites once in the total and in both sections', () => {
    const s = stats([
      game({ id: 'x', ...same }),
      game({ id: 'x', source: 'lichess', ...same }),
      game({ id: 'only-cc', at: utc(2026, 4, 3), variantSalt: 'c' }),
      game({ id: 'only-li', source: 'lichess', at: utc(2026, 4, 4), outcome: 'loss' }),
    ]);
    expect(s.chesscom.games).toBe(2);
    expect(s.lichess.games).toBe(2);
    expect(s.onBothSites).toBe(1);
    expect(s.all.games).toBe(s.chesscom.games + s.lichess.games - s.onBothSites);
    expect(s.all.games).toBe(3);
    expect(s.all.wins + s.all.losses + s.all.draws).toBe(3);
    expect(s.all.wins).toBe(2);
    expect(s.all.losses).toBe(1);
  });

  it('keeps total = splits − duplicates for any mix', () => {
    const records = [
      ...run(7, 'cc', (i) => ({ variantSalt: String(i) })),
      ...run(7, 'li', (i) => ({ source: 'lichess', variantSalt: String(i < 3 ? i : i + 100) })),
    ];
    const s = stats(records);
    expect(s.onBothSites).toBe(3);
    expect(s.all.games).toBe(s.chesscom.games + s.lichess.games - s.onBothSites);
    expect(s.all.games).toBe(11);
  });

  it('does not merge short games, other days, other results, other colours or other moves', () => {
    const base = { id: 'g', ...same };
    const cases = [
      [game({ ...base, plies: 19 }), game({ ...base, plies: 19, source: 'lichess' })],
      [game(base), game({ ...base, source: 'lichess', at: utc(2026, 4, 3, 9) })],
      [game(base), game({ ...base, source: 'lichess', outcome: 'loss' })],
      [game(base), game({ ...base, source: 'lichess', color: 'b' })],
      [game(base), game({ ...base, source: 'lichess', variantSalt: 'z' })],
    ];
    for (const pair of cases) {
      const s = stats(pair);
      expect(s.onBothSites).toBe(0);
      expect(s.all.games).toBe(2);
    }
  });

  it('merges games of exactly 20 plies, and the same UTC day at different hours', () => {
    const s = stats([
      game({ id: 'g', plies: 20, at: utc(2026, 4, 2, 0) }),
      game({ id: 'g', plies: 20, source: 'lichess', at: utc(2026, 4, 2, 23) }),
    ]);
    expect(s.onBothSites).toBe(1);
    expect(s.all.games).toBe(1);
  });

  it('pairs one to one, never more than the Chess.com side holds', () => {
    const s = stats([
      game({ id: 'g1', ...same }),
      game({ id: 'l1', source: 'lichess', ...same }),
      game({ id: 'l2', source: 'lichess', ...same }),
    ]);
    expect(s.onBothSites).toBe(1);
    expect(s.all.games).toBe(2);
  });

  it('reads the main line only: comments, variations and annotations do not change the key', () => {
    expect(mainLineMoves('[A "b"]\n\n1. e4 {hi} e5 (1... c5 2. Nf3 (2. c3)) 2. Nf3! $1 Nc6+ ; rest\n1-0')).toEqual([
      'e4',
      'e5',
      'Nf3',
      'Nc6',
    ]);
  });
});

describe('win / loss / draw per class', () => {
  it('splits by class, shows a percentage from 10 games, and names the favourite and the colour split', () => {
    const s = stats([
      ...run(9, 'bl', () => ({ tc: '180', outcome: 'win' })),
      ...run(10, 'ra', (i) => ({
        tc: '600+0',
        outcome: i < 5 ? 'win' : i < 8 ? 'loss' : 'draw',
        color: i % 2 ? 'b' : 'w',
      })),
      game({ id: 'cl', tc: '1800' }),
      game({ id: 'dy', tc: '1/86400', outcome: 'loss' }),
      game({ id: 'un', tc: '-' }),
    ]);
    const by = Object.fromEntries(s.all.byClass.map((c) => [c.timeClass, c]));
    expect(Object.keys(by)).toEqual(['blitz', 'rapid', 'classical', 'daily']);
    expect(by.blitz).toMatchObject({ games: 9, wins: 9, showPercent: false });
    expect(by.rapid).toMatchObject({ games: 10, wins: 5, losses: 3, draws: 2, showPercent: true });
    expect(by.daily).toMatchObject({ games: 1, losses: 1 });
    expect(s.all.unclassified).toBe(1);
    expect(s.all.games).toBe(22);
    expect(s.all.favouriteClasses).toEqual(['rapid']);
    expect(s.all.white.games + s.all.black.games).toBe(22);
    expect(s.all.black.games).toBe(5);
  });

  it('names both classes on a tie', () => {
    const s = stats([game({ id: 'a', tc: '180' }), game({ id: 'b', tc: '600' })]);
    expect(s.all.favouriteClasses).toEqual(['blitz', 'rapid']);
  });
});

describe('streaks', () => {
  type O = 'win' | 'loss' | 'draw';
  const outcomes = (list: O[], reverse = false) => {
    const records = list.map((outcome, i) => game({ id: `s${i}`, outcome, at: utc(2026, 2, 1) + i * 3_600_000 }));
    return reverse ? [...records].reverse() : records;
  };

  it('follows playedAt, not the order of the records, and a draw ends both', () => {
    const list: O[] = ['win', 'win', 'win', 'draw', 'win', 'loss', 'loss', 'win', ...Array<O>(12).fill('draw')];
    for (const reverse of [false, true]) {
      const s = stats(outcomes(list, reverse));
      expect(s.all.streaks).toMatchObject({ datedGames: 20, enough: true, longestWin: 3, longestLoss: 2 });
    }
  });

  it('counts a long unbroken run', () => {
    const s = stats(outcomes(Array<O>(25).fill('loss')));
    expect(s.all.streaks).toMatchObject({ longestWin: 0, longestLoss: 25 });
  });

  it('needs 20 dated games', () => {
    expect(stats(outcomes(Array<O>(19).fill('win'))).all.streaks.enough).toBe(false);
    expect(stats(outcomes(Array<O>(20).fill('win'))).all.streaks.enough).toBe(true);
  });

  it('leaves out games without a date', () => {
    const undated = Array.from({ length: 5 }, (_, i) => game({ id: `u${i}`, at: null }));
    const s = stats([...outcomes(Array<O>(19).fill('win')), ...undated]);
    expect(s.all.games).toBe(24);
    expect(s.all.streaks.datedGames).toBe(19);
    expect(s.all.streaks.enough).toBe(false);
  });
});

describe('openings', () => {
  it('lists the top 3 per colour from 5 games, by family, and counts games without one', () => {
    const records = [
      ...run(6, 'wa', () => ({ color: 'w', opening: 'Italian Game: Giuoco Piano' })),
      ...run(4, 'wb', () => ({ color: 'w', opening: 'Italian Game: Two Knights Defense', outcome: 'loss' })),
      ...run(7, 'wc', () => ({ color: 'w', opening: 'Queens Gambit' })),
      ...run(5, 'wd', () => ({ color: 'w', opening: 'English Opening' })),
      ...run(5, 'we', () => ({ color: 'w', opening: 'Vienna Game' })),
      ...run(4, 'wf', () => ({ color: 'w', opening: 'Bird Opening' })),
      ...run(5, 'bd', () => ({ color: 'b', opening: 'Sicilian Defense: Najdorf Variation', outcome: 'draw' })),
      ...run(2, 'bx', () => ({ color: 'b', opening: 'Caro-Kann Defense' })),
      ...run(3, 'none', () => ({ color: 'b' })),
    ];
    const s = stats(records);
    expect(s.all.openings.white.map((o) => [o.name, o.games])).toEqual([
      ['Italian Game', 10],
      ['Queens Gambit', 7],
      ['English Opening', 5],
    ]);
    expect(s.all.openings.white[0]).toMatchObject({ wins: 6, losses: 4, draws: 0 });
    expect(s.all.openings.black).toEqual([{ name: 'Sicilian Defense', games: 5, wins: 0, losses: 0, draws: 5 }]);
    expect(s.all.openings.withoutOpening).toBe(3);
  });

  it('lists nothing below 5 games', () => {
    expect(stats(run(4, 'a', () => ({ opening: 'Ruy Lopez' }))).all.openings.white).toEqual([]);
  });
});

describe('best win', () => {
  it('is the win with the highest opponent rating; losses, draws and unrated wins do not count', () => {
    const s = stats([
      game({ id: 'a', foeElo: 1700, at: utc(2026, 2, 1), tc: '600', opening: 'Ruy Lopez: Berlin' }),
      game({ id: 'b', foeElo: 1900, at: utc(2026, 3, 1), outcome: 'loss' }),
      game({ id: 'c', foeElo: 2100, outcome: 'draw' }),
      game({ id: 'd', foeElo: null, at: utc(2026, 4, 1) }),
      game({ id: 'e', foeElo: 1800, at: utc(2026, 5, 1), tc: '300', opening: 'Vienna Game' }),
    ]);
    expect(s.all.bestWin).toEqual({
      opponentRating: 1800,
      playedAt: utc(2026, 5, 1),
      timeClass: 'blitz',
      opening: 'Vienna Game',
      gameId: 'chesscom:e',
    });
  });

  it('is null without a rated win', () => {
    const s = stats([game({ id: 'a', foeElo: null }), game({ id: 'b', outcome: 'loss', foeElo: 2000 })]);
    expect(s.all.bestWin).toBeNull();
  });

  it('is computed per scope', () => {
    const s = stats([
      game({ id: 'a', foeElo: 1700 }),
      game({ id: 'b', source: 'lichess', foeElo: 1900, variantSalt: 'q' }),
    ]);
    expect(s.chesscom.bestWin?.opponentRating).toBe(1700);
    expect(s.lichess.bestWin?.opponentRating).toBe(1900);
    expect(s.all.bestWin?.opponentRating).toBe(1900);
  });

  it('breaks a tie on the earlier game, whatever the input order', () => {
    const a = game({ id: 'a', foeElo: 1800, at: utc(2026, 2, 1) });
    const b = game({ id: 'b', foeElo: 1800, at: utc(2026, 3, 1) });
    expect(stats([b, a]).all.bestWin?.gameId).toBe('chesscom:a');
    expect(stats([a, b]).all.bestWin?.gameId).toBe('chesscom:a');
  });
});

describe('thin states', () => {
  it('marks fewer than 20 games as not enough, and 20 as enough', () => {
    expect(stats(run(19, 'a')).all.enough).toBe(false);
    expect(stats(run(20, 'a')).all.enough).toBe(true);
  });
});

describe('rating trend', () => {
  it('lists the 12 months ending with the current one', () => {
    const w = trendWindow(NOW);
    expect(w).toHaveLength(12);
    expect(w[0]).toBe('2025-07');
    expect(w[11]).toBe('2026-06');
    expect(trendWindow(utc(2026, 1, 31))[0]).toBe('2025-02');
  });

  const monthly = (site: 'chesscom' | 'lichess', months: number[], perMonth = 1, tc = '180') =>
    months.flatMap((m, mi) =>
      Array.from({ length: perMonth }, (_, k) =>
        game({
          id: `${site}-${m}-${k}`,
          source: site,
          at: utc(2026, m, 5 + k),
          myElo: 1400 + mi * 10 + k,
          tc,
          variantSalt: `${site}${m}${k}`,
        }),
      ),
    );

  it('takes my rating from the last game of each month', () => {
    const t = stats(monthly('chesscom', [1, 2, 3, 4, 5], 2)).chesscom.trends[0]!;
    expect(t).toMatchObject({ site: 'chesscom', timeClass: 'blitz', ratedGames: 10, enough: true, anyInWindow: true });
    expect(t.points).toEqual([
      { month: '2026-01', rating: 1401 },
      { month: '2026-02', rating: 1411 },
      { month: '2026-03', rating: 1421 },
      { month: '2026-04', rating: 1431 },
      { month: '2026-05', rating: 1441 },
    ]);
  });

  it('needs 10 rated games in 2 months', () => {
    expect(stats(monthly('chesscom', [1, 2, 3, 4], 2)).chesscom.trends[0]!.enough).toBe(false); // 8 games
    expect(stats(monthly('chesscom', [1], 10)).chesscom.trends[0]!.enough).toBe(false); // one month
    expect(stats(monthly('chesscom', [1, 2], 5)).chesscom.trends[0]!.enough).toBe(true);
    const unrated = monthly('chesscom', [1, 2], 5).map((g, i) =>
      i < 2 ? { ...g, whiteElo: null, blackElo: null } : g,
    );
    expect(stats(unrated).chesscom.trends[0]!.enough).toBe(false); // 8 rated of 10
  });

  it("never combines sites, and uses each site's most-played class", () => {
    const s = stats([
      ...monthly('chesscom', [1, 2], 3, '180'),
      ...monthly('chesscom', [3], 1, '900'),
      ...monthly('lichess', [1, 2], 3, '900'),
    ]);
    expect(s.all.trends.map((t) => [t.site, t.timeClass])).toEqual([
      ['chesscom', 'blitz'],
      ['lichess', 'rapid'],
    ]);
    expect(s.chesscom.trends).toHaveLength(1);
    expect(s.lichess.trends).toHaveLength(1);
    expect(s.lichess.trends[0]!.points).toHaveLength(2);
  });

  it('leaves out months outside the window and says when the last game was', () => {
    const old = [
      game({ id: 'old1', at: utc(2024, 3, 5) }),
      game({ id: 'old2', at: utc(2024, 3, 6), variantSalt: '2' }),
    ];
    const t = stats(old).chesscom.trends[0]!;
    expect(t.anyInWindow).toBe(false);
    expect(t.points).toEqual([]);
    expect(t.lastGameMonth).toBe('2024-03');
    const mixed = stats([...old, game({ id: 'new', at: utc(2026, 6, 1), variantSalt: '3' })]).chesscom.trends[0]!;
    expect(mixed.points).toEqual([{ month: '2026-06', rating: 1500 }]);
    expect(mixed.ratedGames).toBe(1);
    // 12 months back is out, 11 months back is in
    const edge = stats([
      game({ id: 'e1', at: utc(2025, 6, 30) }),
      game({ id: 'e2', at: utc(2025, 7, 1), variantSalt: 'x' }),
    ]);
    expect(edge.chesscom.trends[0]!.points.map((p) => p.month)).toEqual(['2025-07']);
  });

  it('has no series for a site without a classed game', () => {
    expect(stats([game({ id: 'a', tc: '-' })]).all.trends).toEqual([]);
  });
});

describe('what the stats hold', () => {
  const records = [
    ...run(25, 'a', (i) => ({
      foe: FOES[i % FOES.length]!,
      opening: 'Ruy Lopez',
      outcome: i % 3 ? 'win' : 'loss',
      foeElo: 1500 + i,
    })),
    ...run(4, 'b', (i) => ({ source: 'lichess', foe: FOES[i % FOES.length]!, variantSalt: `l${i}` })),
  ];

  it('has no opponent name and no username anywhere in the serialised output', () => {
    const json = JSON.stringify(stats(records)).toLowerCase();
    for (const name of [...FOES, ME, OTHER_ME]) expect(json).not.toContain(name.toLowerCase());
  });

  it('is plain data: it survives a JSON round trip unchanged', () => {
    const s = stats(records);
    expect(JSON.parse(JSON.stringify(s)) as StoryStats).toEqual(s);
  });

  it('does not depend on the order of the records', () => {
    expect(stats([...records].reverse())).toEqual(stats(records));
  });
});
