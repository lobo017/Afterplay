import { beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { checkPgnText } from '../../src/capture/pgn-games';
import type { MoveClassification } from '../../src/core/game-tree';
import { buildGameRecord } from '../../src/library/game-record';
import { NO_FILTER, countUnreviewed, gameAccuracy, matchesFilter, sortRows, toRow } from '../../src/library/game-rows';
import { GameLibrary } from '../../src/library/library';
import type { SavedReview } from '../../src/library/saved-review';
import type { UserAccount } from '../../src/review/perspective';
import { summarizeReview } from '../../src/review/summary';
import type { GameReview, ReviewedMove, SideReviewSummary } from '../../src/review/types';
import {
  WizardChessStorage,
  deleteWizardChessDB,
  hasSavedReview,
  type GameAnalysisSummary,
  type StoredGameRecord,
} from '../../src/storage/db';
import { PuzzleStore } from '../../src/trainers/puzzle-store';

const DB = 'wizards-chess-review-summary-test';
const ME: UserAccount[] = [{ site: 'lichess', username: 'Tester' }];
const PGN =
  '[Event "T"]\n[White "Tester"]\n[Black "Rival"]\n[Result "1-0"]\n[Date "2026.01.02"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
const SECOND_PGN = PGN.replace('2026.01.02', '2026.01.03');

/** An invented review: White plays plies 1, 3, 5, 7; Black plies 2, 4, 6. Wins are the mover's, in %. */
function move(
  ply: number,
  classification: MoveClassification,
  winBefore: number,
  winAfter: number,
  cpLoss = 0,
): ReviewedMove {
  return {
    ply,
    nodeId: `n${ply}`,
    color: ply % 2 === 1 ? 'w' : 'b',
    moveNumber: Math.ceil(ply / 2),
    san: 'e4',
    uci: 'e2e4',
    fenBefore: '',
    fenAfter: '',
    winBefore,
    winAfter,
    whiteWinAfter: ply % 2 === 1 ? winAfter : 100 - winAfter,
    winDrop: Math.max(0, winBefore - winAfter),
    accuracy: 80,
    cpLoss,
    calibrationCpLoss: null,
    classification,
    bestMoveUci: null,
    bestMoveSan: null,
    bestLineSan: [],
    refutationSan: [],
    refutationUci: [],
    scoreBefore: null,
    scoreAfter: null,
    motifs: [],
    explanation: null,
  };
}

function counts(patch: Partial<Record<MoveClassification, number>>): Record<MoveClassification, number> {
  const zero = {
    Best: 0,
    Excellent: 0,
    Good: 0,
    Inaccuracy: 0,
    Mistake: 0,
    Blunder: 0,
    Great: 0,
    Brilliant: 0,
    Book: 0,
    Miss: 0,
  };
  return { ...zero, ...patch };
}

function side(accuracy: number, acpl: number, patch: Partial<Record<MoveClassification, number>>): SideReviewSummary {
  return { accuracy, acpl, botLevel: null, counts: counts(patch) };
}

function review(patch: Partial<GameReview> = {}): GameReview {
  const moves = [
    move(1, 'Best', 50, 52),
    move(2, 'Inaccuracy', 48, 42, 40),
    move(3, 'Blunder', 58, 20, 300),
    move(4, 'Great', 80, 79),
    move(5, 'Miss', 21, 9, 120),
    move(6, 'Brilliant', 91, 92),
    move(7, 'Best', 8, 8),
  ];
  return {
    preset: null,
    budget: { depth: 18 },
    startFen: '',
    moves,
    white: side(61.23456, 98.76, { Best: 2, Blunder: 1, Miss: 1 }),
    black: side(70, 12.04, { Inaccuracy: 1, Great: 1, Brilliant: 1 }),
    keyMoments: [],
    whiteWinSeries: [],
    analyzedPositions: 8,
    totalPositions: 8,
    complete: true,
    ...patch,
  };
}

describe('summarizeReview', () => {
  it('counts each side’s classes, lowest win%, largest drop and ply', () => {
    const s = summarizeReview(review());
    expect(s.plies).toBe(7);
    expect(s.depth).toBe(18);
    expect(s.sides.w).toEqual({
      moves: 4,
      acpl: 98.8,
      inaccuracy: 0,
      mistake: 0,
      blunder: 1,
      miss: 1,
      brilliant: 0,
      great: 0,
      low: 8, // White's own win% before ply 7
      drop: 38, // ply 3: 58 → 20
      dropPly: 3,
    });
    expect(s.sides.b).toEqual({
      moves: 3,
      acpl: 12,
      inaccuracy: 1,
      mistake: 0,
      blunder: 0,
      miss: 0,
      brilliant: 1,
      great: 1,
      low: 42,
      drop: 6,
      dropPly: 2,
    });
  });

  it('summarizes one side only when asked, and leaves the other out', () => {
    expect(Object.keys(summarizeReview(review(), { side: 'b' }).sides)).toEqual(['b']);
    expect(Object.keys(summarizeReview(review(), { side: 'w' }).sides)).toEqual(['w']);
  });

  it('has no depth for a timed review, and null numbers for a side with no move', () => {
    const timed = summarizeReview(review({ preset: 'quick', budget: { movetimeMs: 200 } }));
    expect('depth' in timed).toBe(false);
    const oneMove = summarizeReview(
      review({ moves: [move(1, 'Best', 50, 51)], black: { ...side(0, 0, {}), acpl: null, accuracy: null } }),
    );
    expect(oneMove.sides.b).toMatchObject({ moves: 0, acpl: null, low: null, drop: 0, dropPly: null });
  });

  it('stays small and JSON-safe', () => {
    const text = JSON.stringify(summarizeReview(review(), { side: 'w' }));
    expect(JSON.parse(text)).toEqual(summarizeReview(review(), { side: 'w' }));
    expect(text.length).toBeLessThan(300);
  });
});

function summaryOnly(accuracy: number | null, patch: Partial<GameAnalysisSummary> = {}): GameAnalysisSummary {
  return {
    preset: null,
    savedAt: 5,
    whiteAccuracy: accuracy,
    blackAccuracy: null,
    depth: 18,
    summaryOnly: true,
    plies: 7,
    sides: { w: summarizeReview(review(), { side: 'w' }).sides.w! },
    ...patch,
  };
}

function record(pgn: string, patch: Partial<StoredGameRecord> = {}): StoredGameRecord {
  const valid = checkPgnText(pgn).games[0]!;
  return { ...buildGameRecord(valid), schemaVersion: 4, createdAt: 1, updatedAt: 1, ...patch };
}

describe('hasSavedReview', () => {
  it('is true only for a stored full review', () => {
    expect(hasSavedReview({ analysis: undefined })).toBe(false);
    expect(hasSavedReview({ analysis: null })).toBe(false);
    // A record written before the new fields existed
    expect(hasSavedReview({ analysis: { preset: 'quick', savedAt: 1, whiteAccuracy: 90, blackAccuracy: 70 } })).toBe(
      true,
    );
    expect(hasSavedReview({ analysis: summaryOnly(87.3) })).toBe(false);
    expect(hasSavedReview({ analysis: { ...summaryOnly(87.3), summaryOnly: false } })).toBe(true);
  });
});

describe('summary-only games in the list', () => {
  const advance = () => record(PGN, { analysis: summaryOnly(87.3), accuracy: 87.3 });

  it('count as not analyzed for the filter, yet their accuracy filters and sorts', () => {
    const rows = [
      toRow(advance(), ME),
      toRow(
        record(SECOND_PGN, { analysis: { preset: 'quick', savedAt: 1, whiteAccuracy: 60, blackAccuracy: 50 } }),
        ME,
      ),
    ];
    const count = (f: Partial<typeof NO_FILTER>) => rows.filter((r) => matchesFilter(r, { ...NO_FILTER, ...f })).length;
    expect(count({ analyzed: 'analyzed' })).toBe(1);
    expect(count({ analyzed: 'not-analyzed' })).toBe(1);
    expect(rows[0]!.accuracy).toBe(87.3);
    expect(gameAccuracy(rows[0]!)).toBe(87.3);
    expect(count({ minAccuracy: 80 })).toBe(1);
    expect(sortRows([...rows].reverse(), 'accuracy').map((r) => r.accuracy)).toEqual([87.3, 60]);
  });
});

describe('the Today screen’s unreviewed count', () => {
  it('leaves out games reviewed in advance, and counts games with no review', () => {
    const full = record(PGN, { analysis: { preset: 'quick', savedAt: 1, whiteAccuracy: 90, blackAccuracy: 70 } });
    const advance = record(SECOND_PGN, { analysis: summaryOnly(87.3) });
    const none = record(PGN.replace('2026.01.02', '2026.01.04'), { analysis: null });
    const unset = record(PGN.replace('2026.01.02', '2026.01.05'));
    expect(countUnreviewed([full, advance, none, unset])).toBe(2);
    expect(countUnreviewed([advance])).toBe(0);
    expect(countUnreviewed([])).toBe(0);
  });
});

describe('library.saveReview', () => {
  let storage: WizardChessStorage;
  let library: GameLibrary;

  beforeEach(async () => {
    await deleteWizardChessDB(DB);
    storage = await WizardChessStorage.create({ dbName: DB });
    library = new GameLibrary(storage);
    await library.init();
    await library.setMyAccounts({ lichess: 'Tester', chesscom: '' });
  });

  const saved = (r: GameReview, preset: SavedReview['preset']): SavedReview => ({
    version: 1,
    preset,
    savedAt: 99,
    ucis: [],
    review: r,
    positions: [],
    stats: { timeMs: 1, meanDepth: 18, minDepth: 18, searches: 8, verifiedPositions: 0 },
  });

  it('writes both sides’ summary, and replaces a batch summary so the game has a full review', async () => {
    await library.importPgnText(PGN);
    const id = (await library.list())[0]!.id;
    const before = (await library.get(id))!;
    await storage.saveGame({ ...before, analysis: summaryOnly(87.3), accuracy: 87.3 });
    expect(hasSavedReview((await library.get(id))!)).toBe(false);

    await library.saveReview(id, saved(review({ preset: 'quick', budget: { movetimeMs: 200 } }), 'quick'));
    const after = (await library.get(id))!;
    expect(hasSavedReview(after)).toBe(true);
    expect(after.analysis?.summaryOnly).toBeUndefined();
    expect(after.analysis?.depth).toBeUndefined();
    expect(after.analysis?.plies).toBe(7);
    expect(after.analysis?.sides?.w?.blunder).toBe(1);
    expect(after.analysis?.sides?.b?.brilliant).toBe(1);
    expect(after.analysis).toMatchObject({ preset: 'quick', savedAt: 99, blackAccuracy: 70 });
    expect(after.accuracy).toBe(61.23456);
    storage.close();
  });

  it('keeps the fixed depth on a depth review and reads back through storage unchanged', async () => {
    await library.importPgnText(PGN);
    const id = (await library.list())[0]!.id;
    await library.saveReview(id, saved(review(), null));
    const stored = await storage.getGame(id);
    expect(stored?.analysis?.depth).toBe(18);
    expect(stored?.analysis?.preset).toBeNull();
    storage.close();
  });
});

describe('puzzle sync with summary-only games', () => {
  it('never asks for a stored review of a summary-only game, and leaves its sync state alone', async () => {
    await deleteWizardChessDB(DB);
    const storage = await WizardChessStorage.create({ dbName: DB });
    const store = new PuzzleStore(storage);
    const asked: string[] = [];
    const getReview = async (id: string) => {
      asked.push(id);
      return undefined;
    };
    const game = record(PGN, { analysis: summaryOnly(87.3) });
    expect(await store.syncAll([game], getReview, ME, 1000)).toBe(0);
    expect(asked).toEqual([]);
    expect(await store.listPuzzles('personal')).toEqual([]);
    storage.close();
  });
});
