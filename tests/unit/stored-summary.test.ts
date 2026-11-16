import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { parsePgn } from '../../src/core/pgn';
import { countUnreviewed, gamesSummary, reviewedInAdvance, toRow } from '../../src/library/game-rows';
import { GameLibrary } from '../../src/library/library';
import { readReviewNumbers } from '../../src/library/review-numbers';
import { toSavedReview } from '../../src/library/saved-review';
import {
  CANCELED_STATUS,
  FAILED_STATUS,
  REVIEW_BUTTON_TEXT,
  STORED_PHASES_TITLE,
  STORED_TITLE,
  reviewFailedText,
  reviewHelpText,
  reviewRunningText,
  storedIdleStatus,
  storedNumbersFor,
  storedSummaryView,
} from '../../src/library/stored-summary';
import type { PhaseNumbers } from '../../src/review/phase-numbers';
import { buildGameReview, mainLinePlies } from '../../src/review/review-game';
import type { ReviewRunResult } from '../../src/review/review-runner';
import { WizardChessStorage, deleteWizardChessDB, hasSavedReview } from '../../src/storage/db';
import { computeStoryStats } from '../../src/story/stats';
import { lichessGame, lichessPositions } from '../helpers/lichess-fixture';
import { isBookFen } from '../helpers/review-fixtures';
import { ME } from './helpers/story-games';
import { batch } from './helpers/story-reviews';

// Invented games and numbers; only the Lichess fixture game is real.
const accounts = [{ site: 'chesscom' as const, username: ME }];
const PHASES: PhaseNumbers = [
  [10, 93.14, 0, 1, 0],
  [18, 81.5, 1, 1, 1],
  [4, 90, 0, 0, 0],
];
const NO_ENDGAME: PhaseNumbers = [
  [10, 95, 0, 0, 0],
  [12, 70.04, 2, 0, 0],
  [0, 0, 0, 0, 0],
];

/** A game of mine with a summary made in advance; `phases` null gives an older summary without them. */
const advance = (color: 'w' | 'b' = 'w', phases: PhaseNumbers | null = PHASES) =>
  batch(1, 'adv', () => ({
    game: { color },
    review: {
      accuracy: 87.34,
      mistake: 2,
      blunder: 1,
      brilliant: 0,
      great: 1,
      moves: 32,
      ...(phases ? { phases } : {}),
    },
  }))[0]!;

describe('my stored numbers for a game opened from the Games list', () => {
  it('reads my side of a review made in advance, for White and for Black', () => {
    for (const color of ['w', 'b'] as const) {
      const n = storedNumbersFor(advance(color), accounts)!;
      expect(n).not.toBeNull();
      expect(n.source).toBe('advance');
      expect([n.accuracy, n.mistake, n.blunder, n.brilliant, n.great]).toEqual([87.34, 2, 1, 0, 1]);
      expect(n.phases).toEqual(PHASES);
    }
  });

  it('with no usernames saved, takes the one side the summary holds', () => {
    expect(storedNumbersFor(advance('b'), [])?.accuracy).toBe(87.34);
  });

  it('never shows the other side: usernames that name a side the summary does not hold give nothing', () => {
    const r = advance('w');
    // The summary is written for White (me); move it to Black's entry only
    const moved = { ...r, analysis: { ...r.analysis!, sides: { b: r.analysis!.sides!.w! } } };
    expect(storedNumbersFor(moved, accounts)).toBeNull();
  });

  it('gives nothing when it cannot tell which side is mine (two sides stored, no usernames)', () => {
    const [r] = batch(1, 'two', () => ({ review: { bothSides: true } }));
    expect(storedNumbersFor(r!, [])).toBeNull();
    expect(storedNumbersFor(r!, accounts)).not.toBeNull();
  });

  it('gives nothing for a game with no review, or one reviewed on this device (it opens as a full review)', () => {
    const r = advance('w');
    expect(storedNumbersFor({ ...r, analysis: null }, accounts)).toBeNull();
    expect(storedNumbersFor({ ...r, analysis: undefined }, accounts)).toBeNull();
    const [device] = batch(1, 'dev', () => ({ review: { advance: false, preset: 'quick' } }));
    expect(hasSavedReview(device!)).toBe(true);
    expect(storedNumbersFor(device!, accounts)).toBeNull();
  });

  it('gives nothing for numbers the readers refuse (a too-short game, a broken accuracy)', () => {
    const r = advance('w');
    expect(storedNumbersFor({ ...r, analysis: { ...r.analysis!, plies: 8 } }, accounts)).toBeNull();
    expect(storedNumbersFor({ ...r, analysis: { ...r.analysis!, whiteAccuracy: 140 } }, accounts)).toBeNull();
  });
});

describe('what the block shows', () => {
  it('accuracy with one decimal, then mistakes, blunders, brilliant and great moves, singular for one', () => {
    const view = storedSummaryView(storedNumbersFor(advance('w'), accounts)!);
    expect(view.accuracy).toBe('87.3%');
    expect(view.tiles).toEqual([
      { key: 'mistake', value: 2, label: 'mistakes' },
      { key: 'blunder', value: 1, label: 'blunder' },
      { key: 'brilliant', value: 0, label: 'brilliant moves' },
      { key: 'great', value: 1, label: 'great move' },
    ]);
  });

  it('accuracy by game phase in game order, each with one decimal and a bar share', () => {
    const view = storedSummaryView(storedNumbersFor(advance('w'), accounts)!);
    expect(view.phases).toEqual([
      { phase: 'opening', label: 'Opening', accuracy: '93.1%', share: 0.9314 },
      { phase: 'middlegame', label: 'Middlegame', accuracy: '81.5%', share: 0.815 },
      { phase: 'endgame', label: 'Endgame', accuracy: '90.0%', share: 0.9 },
    ]);
  });

  it('leaves out a phase with none of my moves', () => {
    const view = storedSummaryView(storedNumbersFor(advance('b', NO_ENDGAME), accounts)!);
    expect(view.phases.map((p) => p.phase)).toEqual(['opening', 'middlegame']);
    expect(view.phases[1]!.accuracy).toBe('70.0%');
  });

  it('has no phase rows for an older summary without phase numbers', () => {
    const view = storedSummaryView(storedNumbersFor(advance('w', null), accounts)!);
    expect(view.phases).toEqual([]);
    expect(view.tiles).toHaveLength(4);
  });
});

describe('the texts', () => {
  it('the button and the line under it: a time only for Quick, never "a few seconds"', () => {
    expect(REVIEW_BUTTON_TEXT).toBe('Review this game');
    expect(reviewHelpText('quick')).toBe(
      'Checks every move and shows where the game turned. Takes about 10 to 20 seconds on a phone (longer for very long games).',
    );
    for (const p of ['standard', 'deep'] as const) {
      expect(reviewHelpText(p)).toBe('Checks every move and shows where the game turned. Takes longer at this speed.');
      expect(reviewHelpText(p)).not.toMatch(/\d/);
    }
    for (const p of ['quick', 'standard', 'deep'] as const) expect(reviewHelpText(p)).not.toMatch(/few seconds/i);
  });

  it('the button shows progress while the review runs', () => {
    expect(reviewRunningText(3, 21)).toBe('Reviewing… move 3 of 21');
    expect(reviewRunningText(0, 0)).toBe('Reviewing… move 0 of …');
  });

  it('the status line before a review uses Tap or Click as the helper gives it', () => {
    expect(storedIdleStatus(true, 'Tap')).toBe('Tap Review this game to see every move.');
    expect(storedIdleStatus(false, 'Click')).toBe('Not reviewed yet. Click Review this game.');
  });

  it('a canceled or failed review says so plainly and keeps the numbers', () => {
    expect(CANCELED_STATUS).toBe('Review canceled. Nothing was changed.');
    expect(FAILED_STATUS).toBe('Review not finished');
    expect(reviewFailedText(true)).toBe(
      'The review could not finish. Your numbers above are unchanged. You can try again.',
    );
    expect(reviewFailedText(false)).toBe('The review could not finish. You can try again.');
  });

  it('plain American wording: "reviewed", never "analyzed", "cancelled" or per-move claims in the numbers block', () => {
    const all = [
      STORED_TITLE,
      STORED_PHASES_TITLE,
      REVIEW_BUTTON_TEXT,
      reviewHelpText('quick'),
      CANCELED_STATUS,
      FAILED_STATUS,
      reviewFailedText(true),
      storedIdleStatus(true, 'Tap'),
      storedIdleStatus(false, 'Tap'),
    ].join(' ');
    expect(all).not.toMatch(/analy[sz]/i);
    expect(all).not.toMatch(/cancelled/i);
    expect(`${STORED_TITLE} ${STORED_PHASES_TITLE}`).not.toMatch(/move-by-move|each move|best move/i);
  });
});

describe('a review made on this device replaces the one made in advance', () => {
  const DB = 'wizards-chess-stored-summary-test';
  const GAME = 'lichess:Bjl39T9x';
  const lichessMe = [{ site: 'lichess' as const, username: 'Lobo017' }];
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
      preset: 'quick',
      budget: { movetimeMs: 200 },
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
      stats: { timeMs: 1000, meanDepth: 12, minDepth: 10, searches: positions.length, verifiedPositions: 0 },
    };
  }

  /** The fixture game with an invented summary made in advance for my side (Black). */
  async function storeInAdvance(): Promise<void> {
    await library.setMyAccounts({ lichess: 'Lobo017', chesscom: '' });
    await library.importPgnText(lichessGame.pgn);
    const record = (await library.get(GAME))!;
    const plies = mainLinePlies(parsePgn(record.pgn)).length;
    const mine = advance('b').analysis!.sides!.b!;
    await storage.saveGame({
      ...record,
      accuracy: 90,
      analysis: {
        preset: null,
        savedAt: 1,
        depth: 18,
        summaryOnly: true,
        plies,
        whiteAccuracy: null,
        blackAccuracy: 90,
        sides: { b: mine },
      },
    });
  }

  const counts = async () => {
    const records = await library.list();
    const rows = records.map((r) => toRow(r, lichessMe));
    const story = computeStoryStats(records, lichessMe).all.review;
    return {
      footer: gamesSummary({
        games: records.length,
        analyzed: records.filter((r) => hasSavedReview(r)).length,
        inAdvance: rows.filter(reviewedInAdvance).length,
      }),
      unreviewed: countUnreviewed(records),
      story: { reviewed: story.reviewed, inAdvance: story.inAdvance, onDevice: story.onDevice },
    };
  };

  it('the stored numbers show before; after the save the game opens as a saved review, and every count stays the same', async () => {
    await storeInAdvance();
    const before = (await library.get(GAME))!;
    expect(hasSavedReview(before)).toBe(false);
    expect(storedNumbersFor(before, library.getUserAccounts())?.accuracy).toBe(90);
    expect(await counts()).toEqual({
      footer: '1 game · 1 reviewed',
      unreviewed: 0,
      story: { reviewed: 1, inAdvance: 1, onDevice: 0 },
    });

    await library.saveReview(GAME, toSavedReview(lichessRunResult(), 1234)!);
    const after = (await library.get(GAME))!;
    expect(hasSavedReview(after)).toBe(true);
    expect(after.analysis?.summaryOnly).toBeUndefined();
    expect(storedNumbersFor(after, library.getUserAccounts())).toBeNull();
    expect(await library.getReview(GAME)).toBeDefined();
    // The Story reads the device numbers now, phases included
    const mine = readReviewNumbers(after, 'b')!;
    expect(mine.source).toBe('device');
    expect(mine.phases).toBeDefined();
    expect(await counts()).toEqual({
      footer: '1 game · 1 reviewed',
      unreviewed: 0,
      story: { reviewed: 1, inAdvance: 0, onDevice: 1 },
    });
  });
});
