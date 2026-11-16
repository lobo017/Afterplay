import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { parsePgn } from '../../src/core/pgn';
import { GameLibrary } from '../../src/library/library';
import { phaseBarText, phaseHint, reviewPhases } from '../../src/library/insights-review';
import { readReviewNumbers } from '../../src/library/review-numbers';
import { toSavedReview } from '../../src/library/saved-review';
import { phaseNumbers, readPhases, type PhaseNumbers } from '../../src/review/phase-numbers';
import { buildGameReview, mainLinePlies } from '../../src/review/review-game';
import type { ReviewRunResult } from '../../src/review/review-runner';
import { WizardChessStorage, deleteWizardChessDB } from '../../src/storage/db';
import { computeStoryStats, storyGames } from '../../src/story/stats';
import { endgameReachedSentence, phaseSlipSentence, phaseStrengthSentence, reviewCards } from '../../src/story/text';
import { lichessGame, lichessPositions } from '../helpers/lichess-fixture';
import { isBookFen } from '../helpers/review-fixtures';
import { ME } from './helpers/story-games';
import { batch } from './helpers/story-reviews';

// Invented games and numbers; only the Lichess fixture game is real.
const accounts = [{ site: 'chesscom' as const, username: ME }];
const P1: PhaseNumbers = [
  [10, 95, 0, 1, 0],
  [20, 80, 2, 2, 1],
  [5, 90, 1, 0, 0],
];
const P2: PhaseNumbers = [
  [10, 90, 1, 0, 1],
  [16, 70, 4, 1, 0],
  [0, 0, 0, 0, 0],
];
const round2 = (n: number) => Math.round(n * 100) / 100;

describe('reading the phases of a stored side', () => {
  const record = (phases: unknown, color: 'w' | 'b' = 'w') => {
    const [r] = batch(1, 'r', () => ({ game: { color }, review: { phases: P1 } }));
    const side = r!.analysis!.sides![color]!;
    return { ...r!, analysis: { ...r!.analysis!, sides: { [color]: { ...side, phases } } } };
  };

  it('reads valid phases for my side', () => {
    expect(readReviewNumbers(record(P1), 'w')?.phases).toEqual(P1);
    expect(readReviewNumbers(record(P2, 'b'), 'b')?.phases).toEqual(P2);
  });

  it('never reads the other side’s phases', () => {
    const r = record(P1, 'w');
    expect(readReviewNumbers(r, 'b')).toBeNull(); // the other side has no summary at all
    const both = {
      ...r,
      analysis: { ...r.analysis!, sides: { ...r.analysis!.sides, b: { ...r.analysis!.sides!.w!, phases: P2 } } },
    };
    expect(readReviewNumbers(both, 'w')?.phases).toEqual(P1);
  });

  it.each([
    ['no phases', undefined],
    ['two tuples', [P1[0], P1[1]]],
    ['a tuple of four', [[1, 2, 3, 4], P1[1], P1[2]]],
    ['a string', 'phases'],
    ['a negative count', [[10, 90, -1, 0, 0], P1[1], P1[2]]],
    ['NaN', [[10, NaN, 0, 0, 0], P1[1], P1[2]]],
    ['an accuracy above 100', [[10, 101, 0, 0, 0], P1[1], P1[2]]],
    ['half a move', [[10.5, 90, 0, 0, 0], P1[1], P1[2]]],
    ['a text number', [['10', 90, 0, 0, 0], P1[1], P1[2]]],
    ['an object', { opening: P1[0] }],
  ])('malformed (%s) means no phases and the rest is still read', (_name, phases) => {
    const numbers = readReviewNumbers(record(phases), 'w');
    expect(numbers).not.toBeNull();
    expect(numbers?.phases).toBeUndefined();
    expect(numbers?.accuracy).toBe(80);
    expect(readPhases(phases)).toBeNull();
  });
});

describe('the phase numbers over the games the Story counts', () => {
  /** 24 games: 12 as White with P1, 12 as Black with P2, and 3 older reviewed games with no phases. */
  const games = [
    ...batch(12, 'w', () => ({ game: { color: 'w' as const }, review: { phases: P1 } })),
    ...batch(12, 'b', () => ({ game: { color: 'b' as const }, review: { phases: P2 } })),
    ...batch(3, 'old', () => ({ game: { color: 'w' as const }, review: {} })),
  ];
  const phasesOf = (records: typeof games) => computeStoryStats(records, accounts).all.review.phases;

  it('weights accuracy by moves, counts per 10 moves, and skips games without phases', () => {
    const ph = phasesOf(games)!;
    expect(ph.games).toBe(24);
    const expected = (k: number) => {
      const moves = 12 * P1[k]![0] + 12 * P2[k]![0];
      const acc = (12 * P1[k]![0] * P1[k]![1] + 12 * P2[k]![0] * P2[k]![1]) / moves;
      const blunders = 12 * P1[k]![2] + 12 * P2[k]![2];
      return { moves, acc, blunders };
    };
    ph.items.forEach((item, k) => {
      const e = expected(k);
      expect(item.moves).toBe(e.moves);
      expect(item.accuracy).toBeCloseTo(e.acc, 10);
      expect(item.blunders).toBe(e.blunders);
      expect(item.blundersPer10).toBeCloseTo((e.blunders / e.moves) * 10, 10);
      expect(item.mistakes).toBe(12 * P1[k]![3] + 12 * P2[k]![3]);
      expect(item.misses).toBe(12 * P1[k]![4] + 12 * P2[k]![4]);
    });
    expect(ph.items.map((i) => i.phase)).toEqual(['opening', 'middlegame', 'endgame']);
    // The endgame was reached in the 12 White games only
    expect(ph.items[2]!.games).toBe(12);
    expect(computeStoryStats(games, accounts).all.review.reviewed).toBe(27);
  });

  it('is null when no counted game has phases, and the card is not made', () => {
    const none = batch(24, 'n', () => ({ review: {} }));
    const stats = computeStoryStats(none, accounts);
    expect(stats.all.review.phases).toBeNull();
    expect(reviewCards(stats.all.review).map((c) => c.id)).not.toContain('phases');
  });

  it('has no endgame games when none reached one: zero moves, no accuracy, no rate', () => {
    const noEnd: PhaseNumbers = [
      [10, 90, 1, 0, 0],
      [20, 80, 2, 0, 0],
      [0, 0, 0, 0, 0],
    ];
    const stats = computeStoryStats(
      batch(24, 'z', () => ({ review: { phases: noEnd } })),
      accounts,
    );
    const end = stats.all.review.phases!.items[2]!;
    expect(end).toMatchObject({ moves: 0, accuracy: null, blundersPer10: null, games: 0 });
    const card = reviewCards(stats.all.review).find((c) => c.id === 'phases')!;
    expect(card.rows[2]).toEqual({ label: 'Endgame', detail: 'no moves' });
    expect(card.notes).toContain('0 of 24 games reached an endgame.');
  });

  it('works for one game (the numbers are made; the card waits for enough reviewed games)', () => {
    const one = batch(1, 'o', () => ({ game: { color: 'b' as const }, review: { phases: P2 } }));
    const stats = computeStoryStats(one, accounts);
    expect(stats.all.review.phases?.games).toBe(1);
    expect(stats.all.review.phases?.items[0]).toMatchObject({ moves: 10, accuracy: 90, blundersPer10: (1 / 10) * 10 });
    expect(reviewCards(stats.all.review).map((c) => c.id)).toEqual(['accuracy']);
    expect(storyGames(one, accounts)[0]!.review?.phases).toEqual(P2);
  });

  it('every scope gets its own numbers', () => {
    const mixed = [
      ...batch(12, 'c', () => ({ game: { source: 'chesscom' as const }, review: { phases: P1 } })),
      ...batch(12, 'l', () => ({ game: { source: 'lichess' as const, variantSalt: 'l' }, review: { phases: P2 } })),
    ];
    const both = [
      { site: 'chesscom' as const, username: ME },
      { site: 'lichess' as const, username: ME },
    ];
    const s = computeStoryStats(mixed, both);
    expect(s.chesscom.review.phases!.items[0]!.accuracy).toBe(95);
    expect(s.lichess.review.phases!.items[0]!.accuracy).toBe(90);
    expect(s.all.review.phases!.games).toBe(24);
  });
});

describe('the Game phases card', () => {
  const games = [
    ...batch(12, 'w', () => ({ game: { color: 'w' as const }, review: { phases: P1 } })),
    ...batch(12, 'b', () => ({ game: { color: 'b' as const }, review: { phases: P2 } })),
  ];
  const review = computeStoryStats(games, accounts).all.review;
  const ids = reviewCards(review).map((c) => c.id);

  it('comes after Mistakes and before the Brilliant and Great card', () => {
    expect(ids.indexOf('phases')).toBe(ids.indexOf('mistakes') + 1);
    const withMarks = computeStoryStats(
      batch(24, 'm', () => ({ review: { phases: P1, brilliant: 1 } })),
      accounts,
    ).all.review;
    const order = reviewCards(withMarks).map((c) => c.id);
    expect(order.slice(order.indexOf('mistakes'), order.indexOf('mistakes') + 3)).toEqual([
      'mistakes',
      'phases',
      'marks',
    ]);
  });

  it('shows each phase with accuracy and blunders per 10 moves, computed from the numbers', () => {
    const card = reviewCards(review).find((c) => c.id === 'phases')!;
    const items = review.phases!.items;
    expect(card.rows.map((r) => r.label)).toEqual(['Opening', 'Middlegame', 'Endgame']);
    items.forEach((p, i) => {
      expect(card.rows[i]!.detail).toBe(
        `${p.accuracy!.toFixed(1)}% accuracy · ${p.blundersPer10!.toFixed(2)} blunders per 10 moves`,
      );
    });
    const best = items.reduce((a, b) => (b.accuracy! > a.accuracy! ? b : a));
    const worst = items.reduce((a, b) => (b.accuracy! < a.accuracy! ? b : a));
    expect(card.sentence).toBe(
      `You play best in the ${best.phase} (${best.accuracy!.toFixed(1)}%) and worst in the ${worst.phase} (${worst.accuracy!.toFixed(1)}%).`,
    );
    expect(card.notes).toContain(phaseSlipSentence(items));
    const rate = (i: number) => items[i]!.blundersPer10!;
    const most = [0, 1, 2].reduce((a, b) => (rate(b) > rate(a) ? b : a));
    const least = [0, 1, 2].reduce((a, b) => (rate(b) < rate(a) ? b : a));
    expect(phaseSlipSentence(items)).toBe(
      `You blunder most in the ${items[most]!.phase}: ${rate(most).toFixed(2)} per 10 moves, against ${rate(least).toFixed(2)} in the ${items[least]!.phase}.`,
    );
    expect(card.notes).toContain(`${items[2]!.games} of 24 games reached an endgame.`);
  });

  it('says "game" for one and "games" for more, and leaves out the sentences that have nothing to compare', () => {
    expect(endgameReachedSentence(1, 1)).toBe('1 of 1 game reached an endgame.');
    expect(endgameReachedSentence(0, 24)).toBe('0 of 24 games reached an endgame.');
    expect(endgameReachedSentence(2084, 4535)).toBe('2,084 of 4,535 games reached an endgame.');
    const one = [
      {
        phase: 'opening' as const,
        moves: 5,
        accuracy: 90,
        blunders: 0,
        mistakes: 0,
        misses: 0,
        blundersPer10: 0,
        games: 1,
      },
    ];
    expect(phaseStrengthSentence(one)).toBe('');
    expect(phaseSlipSentence(one)).toBe('');
  });

  it('says how many reviewed games it is based on only when some have no phases', () => {
    const mixed = computeStoryStats([...games, ...batch(3, 'old', () => ({ review: {} }))], accounts).all.review;
    const card = reviewCards(mixed).find((c) => c.id === 'phases')!;
    expect(card.notes).toContain('Based on 24 of your 27 reviewed games.');
    expect(
      reviewCards(review)
        .find((c) => c.id === 'phases')!
        .notes.join(' '),
    ).not.toContain('Based on');
  });
});

describe('Insights: accuracy by game phase from the summaries', () => {
  const games = storyGames(
    [
      ...batch(5, 'w', () => ({ game: { color: 'w' as const }, review: { phases: P1 } })),
      ...batch(5, 'b', () => ({ game: { color: 'b' as const }, review: { phases: P2 } })),
      ...batch(2, 'old', () => ({ review: {} })),
    ],
    accounts,
  );

  it('uses the counted games that have phases', () => {
    const r = reviewPhases(games)!;
    expect(r.games).toBe(10);
    const moves = 5 * P1[1]![0] + 5 * P2[1]![0];
    expect(r.bars[1]).toMatchObject({ phase: 'middlegame', moves });
    expect(r.bars[1]!.accuracy).toBeCloseTo((5 * 20 * 80 + 5 * 16 * 70) / moves, 10);
    expect(r.bars[1]!.blundersPer10).toBeCloseTo(((5 * 2 + 5 * 4) / moves) * 10, 10);
    expect(phaseBarText(r.bars[2]!)).toBe(`90.0% accuracy · ${((5 / 25) * 10).toFixed(2)} blunders per 10 moves`);
    expect(
      reviewPhases(
        storyGames(
          batch(3, 'x', () => ({ review: {} })),
          accounts,
        ),
      ),
    ).toBeNull();
  });

  it('promises a click only when a game was reviewed on this device', () => {
    expect(phaseHint({ reviewedGames: 10, clickable: false, tap: 'Tap' })).toBe(
      'How well you play each part of the game, over 10 reviewed games.',
    );
    expect(phaseHint({ reviewedGames: 1, clickable: false, tap: 'Tap' })).toContain('over 1 reviewed game.');
    expect(phaseHint({ reviewedGames: null, clickable: false, tap: 'Tap' })).toBe(
      'How well you play each part of the game.',
    );
    const clickable = phaseHint({ reviewedGames: 10, clickable: true, tap: 'Click' });
    expect(clickable).toBe(
      'How well you play each part of the game. Click a bar to see your moves from games you reviewed here, worst first.',
    );
  });
});

describe('a review made on this device', () => {
  const DB = 'wizards-chess-story-phases-test';
  let storage: WizardChessStorage;
  let library: GameLibrary;
  beforeEach(async () => {
    await deleteWizardChessDB(DB);
    storage = await WizardChessStorage.create({ dbName: DB });
    library = new GameLibrary(storage);
    await library.init();
  });
  afterEach(async () => {
    storage.close();
    await deleteWizardChessDB(DB);
  });

  function lichessRunResult(): ReviewRunResult {
    const tree = parsePgn(lichessGame.pgn);
    const positions = lichessPositions(tree);
    const plies = mainLinePlies(tree);
    const review = buildGameReview({
      preset: 'standard',
      budget: { movetimeMs: 600 },
      startFen: tree.root.fen,
      plies,
      positions,
      isBookPosition: isBookFen,
    });
    return {
      review,
      positions,
      plies,
      cancelled: false,
      stats: { timeMs: 1000, meanDepth: 20, minDepth: 20, searches: positions.length, verifiedPositions: 0 },
    };
  }

  /** What the history script gives: win% rounded to 2 decimals, one class letter a move, the position before each move. */
  function scriptNumbers(result: ReviewRunResult, color: 'w' | 'b') {
    const letter: Record<string, string> = { Blunder: 'X', Mistake: 'M', Miss: 'S' };
    const r = result.review;
    return phaseNumbers({
      win: [r.whiteWinSeries[0]!, ...r.moves.map((m) => m.whiteWinAfter)].map(round2),
      classes: r.moves.map((m) => letter[m.classification] ?? 'B').join(''),
      fensBefore: r.moves.map((m) => m.fenBefore),
      color,
    })!;
  }

  it('stores the phases the history script would give, for both sides, and the reader finds them', async () => {
    await library.setMyAccounts({ lichess: 'Lobo017', chesscom: '' });
    await library.importPgnText(lichessGame.pgn);
    const result = lichessRunResult();
    await library.saveReview('lichess:Bjl39T9x', toSavedReview(result, 1234)!);

    const record = (await library.get('lichess:Bjl39T9x'))!;
    expect(record.analysis?.sides?.w?.phases).toEqual(scriptNumbers(result, 'w'));
    expect(record.analysis?.sides?.b?.phases).toEqual(scriptNumbers(result, 'b'));
    const mine = readReviewNumbers(record, 'b')!;
    expect(mine.source).toBe('device');
    expect(mine.phases).toEqual(scriptNumbers(result, 'b'));
    // Every one of my moves is in exactly one phase
    expect(mine.phases!.reduce((n, t) => n + t[0], 0)).toBe(mine.moves);
    expect(mine.phases!.reduce((n, t) => n + t[2], 0)).toBe(mine.blunder);
  });

  it('keeps the field through a backup export and import', async () => {
    await library.setMyAccounts({ lichess: 'Lobo017', chesscom: '' });
    await library.importPgnText(lichessGame.pgn);
    const result = lichessRunResult();
    await library.saveReview('lichess:Bjl39T9x', toSavedReview(result, 1234)!);
    const json = await storage.exportBackupJson();

    const OTHER = `${DB}-copy`;
    await deleteWizardChessDB(OTHER);
    const copy = await WizardChessStorage.create({ dbName: OTHER });
    try {
      await copy.importBackupJson(json);
      const record = await copy.getGame('lichess:Bjl39T9x');
      expect(record?.analysis?.sides?.b?.phases).toEqual(scriptNumbers(result, 'b'));
      expect(record?.analysis?.sides?.w?.phases).toEqual(scriptNumbers(result, 'w'));
    } finally {
      copy.close();
      await deleteWizardChessDB(OTHER);
    }
  });
});
