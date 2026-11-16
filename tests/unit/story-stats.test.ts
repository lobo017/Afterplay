import { describe, expect, it } from 'vitest';
import type { UserAccount } from '../../src/review/perspective';
import {
  BLITZ_BELOW_SECONDS,
  BULLET_BELOW_SECONDS,
  RAPID_BELOW_SECONDS,
  computeStoryStats,
  controlLabel,
  mainLineMoves,
  timeClassOf,
  type StoryStats,
} from '../../src/story/stats';
import { FOES, ME, OTHER_ME, game, run, utc } from './helpers/story-games';

const mine: UserAccount[] = [
  { site: 'chesscom', username: ME },
  { site: 'lichess', username: ME },
];
const stats = (records: Parameters<typeof computeStoryStats>[0], accounts = mine) =>
  computeStoryStats(records, accounts);

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
    expect(s.all.journeys).toEqual([]);
    expect(s.all.records).toBeNull();
    expect(s.all.upset).toBeNull();
    expect(s.all.controls).toEqual([]);
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
    expect(s.all.openings.black).toEqual([
      {
        name: 'Sicilian Defense',
        games: 5,
        wins: 0,
        losses: 0,
        draws: 5,
        topVariation: { name: 'Najdorf Variation', games: 5 },
      },
    ]);
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
      myRating: 1500,
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

describe('rating journey', () => {
  const monthly = (site: 'chesscom' | 'lichess', ratings: number[], tc = '180', startMonth = 1) =>
    ratings.map((rating, i) =>
      game({
        id: `${site}-${tc}-${i}`,
        source: site,
        at: utc(2025, startMonth + i),
        myElo: rating,
        tc,
        variantSalt: `${site}${tc}${i}`,
      }),
    );
  const climb = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i * 10);

  it('tells the first rating, the peak with its first month and the latest', () => {
    // 10 months: up to a peak in month 7 (reached twice, the first counts), then down
    const ratings = [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1500, 1600, 1450];
    const j = stats(monthly('chesscom', ratings)).all.journeys;
    expect(j).toHaveLength(1);
    expect(j[0]).toEqual({
      site: 'chesscom',
      timeClass: 'blitz',
      ratedGames: 10,
      first: { rating: ratings[0], month: '2025-01' },
      peak: {
        rating: Math.max(...ratings),
        month: `2025-${String(ratings.indexOf(Math.max(...ratings)) + 1).padStart(2, '0')}`,
      },
      latest: { rating: ratings[9], month: '2025-10' },
    });
  });

  it('follows playedAt, not the order of the records', () => {
    const records = monthly('chesscom', climb(1000, 12));
    expect(stats([...records].reverse()).all.journeys).toEqual(stats(records).all.journeys);
  });

  it('needs 10 rated games in a class', () => {
    expect(stats(monthly('chesscom', climb(1000, 9))).all.journeys).toEqual([]);
    expect(stats(monthly('chesscom', climb(1000, 10))).all.journeys).toHaveLength(1);
    // an unrated game does not count towards the ten
    const withHole = monthly('chesscom', climb(1000, 10)).map((g, i) =>
      i === 0 ? { ...g, whiteElo: null, blackElo: null } : g,
    );
    expect(stats(withHole).all.journeys).toEqual([]);
  });

  it('keeps a series per class, in class order, and never combines sites', () => {
    const s = stats([
      ...monthly('chesscom', climb(1000, 10), '900'),
      ...monthly('chesscom', climb(800, 10), '60'),
      ...monthly('lichess', climb(1600, 10), '900'),
    ]);
    expect(s.all.journeys.map((j) => [j.site, j.timeClass, j.first.rating])).toEqual([
      ['chesscom', 'bullet', 800],
      ['chesscom', 'rapid', 1000],
      ['lichess', 'rapid', 1600],
    ]);
    expect(s.chesscom.journeys.map((j) => j.site)).toEqual(['chesscom', 'chesscom']);
    expect(s.lichess.journeys.map((j) => j.site)).toEqual(['lichess']);
  });

  it('has no series without a classed game', () => {
    expect(stats(run(12, 'a', () => ({ tc: '-' }))).all.journeys).toEqual([]);
  });
});

describe('how games end', () => {
  const ended = (termination: string | undefined, outcome: 'win' | 'loss' | 'draw', id: string, extra = {}) =>
    game({ id, outcome, headers: termination === undefined ? {} : { Termination: termination }, ...extra });
  const winName = `${FOES[1]} won`;

  it('reads Chess.com endings by their closing words, never by a name', () => {
    // A name with ending words in it must not change the reading: "won on time" in the player's own name
    const tricky = 'Resignation by checkmate';
    const s = stats([
      ended(`${ME} won by checkmate`, 'win', 'a'),
      ended(`${winName} by checkmate`, 'loss', 'b'),
      ended(`${ME} won by resignation`, 'win', 'c'),
      ended(`${tricky} won by resignation`, 'loss', 'd'),
      ended(`${ME} won on time`, 'win', 'e'),
      ended(`${FOES[2]} won on time`, 'loss', 'f'),
      ended(`${ME} won - game abandoned`, 'win', 'g'),
      ended(`${FOES[0]} won - game abandoned`, 'loss', 'h'),
      ended('Game drawn by repetition', 'draw', 'i'),
      ended('Game drawn by agreement', 'draw', 'j'),
      ended('Game drawn by stalemate', 'draw', 'k'),
      ended('Game drawn by insufficient material', 'draw', 'l'),
      ended('Game drawn by timeout vs insufficient material', 'draw', 'm'),
    ]);
    const e = s.all.endings;
    expect(e.win).toMatchObject({ checkmate: 1, resignation: 1, time: 1, left: 1, other: 0 });
    expect(e.loss).toMatchObject({ checkmate: 1, resignation: 1, time: 1, left: 1, other: 0 });
    expect(e.draw).toMatchObject({ repetition: 1, agreement: 1, stalemate: 1, insufficient: 1, other: 1 });
  });

  it('classifies a name spelled differently from the stored player name the same way', () => {
    const s = stats([ended('Some Other Spelling won by resignation', 'win', 'a')]);
    expect(s.all.endings.win.resignation).toBe(1);
  });

  // The move text of a game is replaced by one that ends the way the test needs
  const withMoves = (record: ReturnType<typeof game>, moves: string) => ({
    ...record,
    pgn: `${record.pgn.split('\n\n')[0]}\n\n${moves}`,
  });
  const MATE = '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# {[%clk 0:00:01]} 1-0';
  const NO_MATE = '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7 {[%clk 0:00:01]} 1-0';

  it('reads the Lichess words: Normal (a mate sign or not), Time forfeit, Abandoned', () => {
    const lichess = (id: string, outcome: 'win' | 'loss' | 'draw', termination: string, moves = NO_MATE) =>
      withMoves(ended(termination, outcome, id, { source: 'lichess' }), moves);
    const s = stats([
      lichess('m', 'win', 'Normal', MATE),
      lichess('r', 'loss', 'Normal'),
      lichess('t', 'win', 'Time forfeit'),
      lichess('x', 'loss', 'Abandoned'),
      lichess('d', 'draw', 'Normal'),
    ]);
    expect(s.lichess.endings.win).toMatchObject({ checkmate: 1, time: 1 });
    expect(s.lichess.endings.loss).toMatchObject({ resignation: 1, left: 1 });
    expect(s.lichess.endings.draw.other).toBe(1);
  });

  it('is "other" with no Termination header, a checkmate when the last move has a mate sign', () => {
    const s = stats([withMoves(ended(undefined, 'win', 'a'), NO_MATE), withMoves(ended(undefined, 'win', 'b'), MATE)]);
    expect(s.all.endings.win).toMatchObject({ other: 1, checkmate: 1 });
  });

  it('does not take an eval comment for a mate sign', () => {
    const g = withMoves(ended(undefined, 'win', 'a'), '1. e4 e5 2. Qh5 Nc6 { [%eval #3] [%clk 0:00:01] } 1-0');
    expect(stats([g]).all.endings.win.other).toBe(1);
  });

  it('sums to the games of each result in every scope', () => {
    const records = [
      ...run(5, 'w', () => ({ outcome: 'win', headers: { Termination: `${ME} won by resignation` } })),
      ...run(3, 'l', () => ({ outcome: 'loss', headers: { Termination: `${FOES[0]} won on time` }, variantSalt: 'l' })),
    ];
    const s = stats(records);
    const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
    for (const scope of [s.all, s.chesscom]) {
      expect([sum(scope.endings.win), sum(scope.endings.loss), sum(scope.endings.draw)]).toEqual([
        scope.wins,
        scope.losses,
        scope.draws,
      ]);
    }
    expect(sum(s.lichess.endings.win)).toBe(0);
  });
});

describe('exact time controls', () => {
  it('counts each control, most played first, with a readable label', () => {
    const s = stats([
      ...run(5, 'a', () => ({ tc: '600' })),
      ...run(3, 'b', () => ({ tc: '900+10', variantSalt: 'b' })),
      ...run(2, 'c', () => ({ tc: '180+2', variantSalt: 'c' })),
      ...run(1, 'd', () => ({ tc: '1/86400', variantSalt: 'd' })),
      ...run(1, 'e', () => ({ tc: '-', variantSalt: 'e' })),
    ]);
    expect(s.all.controls.map((c) => [c.label, c.games, c.timeClass])).toEqual([
      ['10 min', 5, 'rapid'],
      ['15+10', 3, 'rapid'],
      ['3+2', 2, 'blitz'],
    ]);
    expect(s.all.controls.map((c) => c.control)).toEqual(['600', '900+10', '180+2']);
  });

  it('labels whole minutes, seconds, increments and days', () => {
    expect(controlLabel('60')).toBe('1 min');
    expect(controlLabel('30')).toBe('30 sec');
    expect(controlLabel('90')).toBe('90 sec');
    expect(controlLabel('300+0')).toBe('5 min');
    expect(controlLabel('300+5')).toBe('5+5');
    expect(controlLabel('600+5')).toBe('10+5');
    expect(controlLabel('1/86400')).toBe('1 day');
    expect(controlLabel('1/259200')).toBe('3 days');
  });

  it('breaks a tie on the faster control, whatever the input order', () => {
    const a = run(2, 'a', () => ({ tc: '900+10' }));
    const b = run(2, 'b', () => ({ tc: '600', variantSalt: 'b' }));
    expect(stats([...a, ...b]).all.controls.map((c) => c.control)).toEqual(['600', '900+10']);
    expect(stats([...b, ...a]).all.controls.map((c) => c.control)).toEqual(['600', '900+10']);
  });

  it('keeps at most three', () => {
    const s = stats(
      ['60', '120', '180', '300', '600'].flatMap((tc, i) => run(2, `c${tc}`, () => ({ tc, variantSalt: `${i}` }))),
    );
    expect(s.all.controls).toHaveLength(3);
  });
});

describe('opening variations', () => {
  it('names the most-played variation of a family: the text between ":" and the first ","', () => {
    const s = stats([
      ...run(4, 'a', () => ({ opening: 'Sicilian Defense: Alapin Variation, Smith-Morra Gambit' })),
      ...run(2, 'b', () => ({ opening: 'Sicilian Defense: Najdorf Variation', variantSalt: 'b' })),
      ...run(1, 'c', () => ({ opening: 'Sicilian Defense', variantSalt: 'c' })),
    ]);
    expect(s.all.openings.white[0]).toMatchObject({
      name: 'Sicilian Defense',
      games: 7,
      topVariation: { name: 'Alapin Variation', games: 4 },
    });
  });

  it('has no variation for a family whose games have none, and breaks a tie by name', () => {
    const none = stats(run(6, 'a', () => ({ opening: 'Vienna Game' })));
    expect(none.all.openings.white[0]!.topVariation).toBeNull();
    const tie = stats([
      ...run(3, 'a', () => ({ opening: 'French Defense: Winawer Variation' })),
      ...run(3, 'b', () => ({ opening: 'French Defense: Advance Variation', variantSalt: 'b' })),
    ]);
    expect(tie.all.openings.white[0]!.topVariation).toEqual({ name: 'Advance Variation', games: 3 });
  });
});

describe('streaks, unbeaten', () => {
  it('counts wins and draws without a loss', () => {
    type O = 'win' | 'loss' | 'draw';
    const list: O[] = ['win', 'draw', 'draw', 'win', 'loss', 'win', 'win', 'win', ...Array<O>(12).fill('loss')];
    const records = list.map((outcome, i) => game({ id: `u${i}`, outcome, at: utc(2026, 2, 1) + i * 3_600_000 }));
    expect(stats(records).all.streaks).toMatchObject({ longestWin: 3, longestLoss: 12, longestUnbeaten: 4 });
  });
});

describe('best win and the biggest upset', () => {
  it('keeps my rating beside the opponent, and finds the biggest gap among wins', () => {
    const s = stats([
      game({ id: 'a', myElo: 1500, foeElo: 1900, at: utc(2026, 2) }),
      game({ id: 'b', myElo: 1000, foeElo: 1450, at: utc(2026, 3), variantSalt: 'b' }),
      game({ id: 'c', myElo: 1500, foeElo: 1400, at: utc(2026, 4), variantSalt: 'c' }),
      game({ id: 'd', myElo: 800, foeElo: 1600, outcome: 'loss', at: utc(2026, 5), variantSalt: 'd' }),
      game({ id: 'e', myElo: null, foeElo: 2200, at: utc(2026, 6), variantSalt: 'e' }),
    ]);
    expect(s.all.bestWin).toMatchObject({ opponentRating: 2200, myRating: null });
    expect(s.all.upset).toEqual({
      points: 450,
      opponentRating: 1450,
      myRating: 1000,
      timeClass: 'blitz',
      playedAt: utc(2026, 3),
    });
    // a, b won against higher ratings; c did not; the loss and the unrated games do not count
    expect(s.all.higherRatedWins).toBe(2);
  });

  it('has no upset when every win was against a lower or equal rating', () => {
    const s = stats([
      game({ id: 'a', myElo: 1500, foeElo: 1500 }),
      game({ id: 'b', myElo: 1500, foeElo: 1200, variantSalt: 'b' }),
    ]);
    expect(s.all.upset).toBeNull();
    expect(s.all.higherRatedWins).toBe(0);
  });
});

describe('time at the board', () => {
  const live = (id: string, at: number, start: string, end: string, extra = {}) =>
    game({
      id,
      at,
      variantSalt: id,
      headers: {
        UTCDate: new Date(at).toISOString().slice(0, 10).replace(/-/g, '.'),
        UTCTime: start,
        EndDate: new Date(at).toISOString().slice(0, 10).replace(/-/g, '.'),
        EndTime: end,
      },
      ...extra,
    });

  it('adds up the length of live games from the UTC start and end clocks', () => {
    const s = stats([
      live('a', utc(2026, 3, 10), '10:00:00', '10:10:30'),
      live('b', utc(2026, 3, 11), '23:50:00', '23:59:59'),
      // across midnight: the end date is the next day
      game({
        id: 'c',
        at: utc(2026, 3, 12),
        variantSalt: 'c',
        headers: { UTCDate: '2026.03.12', UTCTime: '23:55:00', EndDate: '2026.03.13', EndTime: '00:05:00' },
      }),
    ]);
    const want = 10 * 60 + 30 + (9 * 60 + 59) + 10 * 60;
    expect(s.all.activity.liveSeconds).toBe(want);
    expect(s.all.activity.timedGames).toBe(3);
  });

  it('leaves out daily games, games without clocks and clocks that make no sense', () => {
    const s = stats([
      live('a', utc(2026, 3, 10), '10:00:00', '10:10:00', { tc: '1/86400' }),
      game({ id: 'b', at: utc(2026, 3, 11), variantSalt: 'b' }),
      live('c', utc(2026, 3, 12), '10:30:00', '10:00:00'),
      live('d', utc(2026, 3, 13), '01:00:00', '23:00:00'), // 22 h: not a live game
      live('e', utc(2026, 3, 14), '10:00:00', '10:05:00'),
    ]);
    expect(s.all.activity.timedGames).toBe(1);
    expect(s.all.activity.liveSeconds).toBe(300);
  });

  it('counts days, the longest run of days, and the busiest day, month and year', () => {
    // days: 3 in a row (mar 1-3), a gap, 2 in a row (mar 6-7); the 7th has 3 games; also one game in each of 2025 and 2024
    const days = [1, 2, 3, 6, 7, 7, 7];
    const records = [
      ...days.map((d, i) => game({ id: `m${i}`, at: utc(2026, 3, d, 10 + i), variantSalt: `m${i}` })),
      game({ id: 'y25', at: utc(2025, 12, 31), variantSalt: 'y25' }),
      game({ id: 'y24', at: utc(2024, 1, 1), variantSalt: 'y24' }),
    ];
    const a = stats(records).all.activity;
    expect(a.datedGames).toBe(9);
    expect(a.days).toBe(new Set([...days, 'y25', 'y24']).size);
    expect(a.longestRun).toBe(3);
    expect(a.busiestDay).toEqual({ day: '2026-03-07', games: 3 });
    expect(a.busiestMonth).toEqual({ month: '2026-03', games: days.length });
    expect(a.busiestYear).toEqual({ year: 2026, games: days.length });
  });

  it('counts a run across a month and year end, and breaks a tie on the earlier period', () => {
    const records = [
      game({ id: 'a', at: utc(2025, 12, 30), variantSalt: 'a' }),
      game({ id: 'b', at: utc(2025, 12, 31), variantSalt: 'b' }),
      game({ id: 'c', at: utc(2026, 1, 1), variantSalt: 'c' }),
      game({ id: 'd', at: utc(2026, 1, 2), variantSalt: 'd' }),
    ];
    const a = stats(records).all.activity;
    expect(a.longestRun).toBe(4);
    expect(a.busiestMonth).toEqual({ month: '2025-12', games: 2 });
    expect(a.busiestYear).toEqual({ year: 2025, games: 2 });
    expect(a.busiestDay).toEqual({ day: '2025-12-30', games: 1 });
  });

  it('is empty without games', () => {
    expect(stats([]).all.activity).toEqual({
      datedGames: 0,
      liveSeconds: 0,
      timedGames: 0,
      days: 0,
      longestRun: 0,
      busiestDay: null,
      busiestMonth: null,
      busiestYear: null,
    });
  });
});

describe('one site or two', () => {
  it('gives "all" the numbers of the only site, under its own scope name', () => {
    const s = stats(run(25, 'a', (i) => ({ opening: 'Ruy Lopez', outcome: i % 2 ? 'win' : 'loss' })));
    expect({ ...s.all, scope: 'chesscom' }).toEqual(s.chesscom);
    expect(s.all.scope).toBe('all');
  });

  it('counts a game on both sites once in "all" and in each site', () => {
    const moves = { plies: 30 };
    const a = game({ id: 'x', ...moves, headers: { Termination: `${ME} won by resignation` } });
    const b = game({ id: 'x', source: 'lichess', ...moves, headers: { Termination: 'Normal' } });
    const s = stats([a, b, ...run(3, 'o', () => ({ variantSalt: 'o' }))]);
    expect(s.onBothSites).toBe(1);
    expect(s.all.games).toBe(s.chesscom.games + s.lichess.games - 1);
    const sum = (c: Record<string, number>) => Object.values(c).reduce((x, y) => x + y, 0);
    expect(sum(s.all.endings.win)).toBe(s.all.wins);
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
