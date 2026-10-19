import { beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import puzzlesJson from '../../data/puzzles.json';
import type { PuzzleEntry } from '../../src/core/datasets';
import { parsePgn } from '../../src/core/pgn';
import { checkPgnText } from '../../src/capture/pgn-games';
import { buildGameRecord } from '../../src/library/game-record';
import { toSavedReview, type SavedReview } from '../../src/library/saved-review';
import { buildGameReview, mainLinePlies } from '../../src/review/review-game';
import type { UserAccount } from '../../src/review/perspective';
import type { PositionAnalysis } from '../../src/review/types';
import { WizardChessStorage, deleteWizardChessDB, type StoredGameRecord } from '../../src/storage/db';
import { RELEARN_DELAY_MS } from '../../src/trainers/fsrs';
import { personalPuzzleId, scanPersonalPuzzles } from '../../src/trainers/personal-puzzles';
import { preparePuzzle } from '../../src/trainers/puzzle-format';
import { PuzzleStore, cardId } from '../../src/trainers/puzzle-store';
import type { AttemptOutcome } from '../../src/trainers/puzzle-session';
import { lichessGame, lichessPositions } from '../helpers/lichess-fixture';
import { isBookFen } from '../helpers/review-fixtures';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 19, 12);
const ME: UserAccount[] = [{ site: 'lichess', username: 'Lobo017' }];

/** The reference Lichess game (Lobo017 is Black) as a stored record. */
function gameRecord(): StoredGameRecord {
  const { games } = checkPgnText(lichessGame.pgn);
  return { ...buildGameRecord(games[0]!), schemaVersion: 4, createdAt: NOW, updatedAt: NOW };
}

/**
 * A saved review of it from Lichess's own evaluations. Lichess gives one line per position;
 * `secondLineLoss` adds a second-best line that much worse (cp, side to move's view).
 */
const reviewCache = new Map<number | null, SavedReview>();
function savedReview(secondLineLoss: number | null): SavedReview {
  const cached = reviewCache.get(secondLineLoss);
  if (cached) return structuredClone(cached);
  const built = buildSavedReview(secondLineLoss);
  reviewCache.set(secondLineLoss, built);
  return structuredClone(built);
}

function buildSavedReview(secondLineLoss: number | null): SavedReview {
  const tree = parsePgn(lichessGame.pgn);
  const positions: PositionAnalysis[] = lichessPositions(tree).map((p) => {
    const best = p.lines[0];
    if (secondLineLoss === null || !best || best.score.type !== 'cp') return p;
    return { ...p, lines: [best, { multipv: 2, score: { type: 'cp', value: best.score.value - secondLineLoss }, pv: ['a2a3'] }] };
  });
  const plies = mainLinePlies(tree);
  const review = buildGameReview({
    preset: 'standard',
    budget: { movetimeMs: 600 },
    startFen: tree.root.fen,
    plies,
    positions,
    isBookPosition: isBookFen,
  });
  const saved = toSavedReview(
    { review, positions, plies, cancelled: false, stats: { timeMs: 1, meanDepth: 20, minDepth: 20, searches: 1, verifiedPositions: 0 } },
    NOW,
  );
  if (!saved) throw new Error('incomplete review');
  return saved;
}

const outcome = (o: Partial<AttemptOutcome>): AttemptOutcome => ({ solved: true, hintUsed: false, mistakes: 0, timeMs: 20_000, grade: 3, ...o });

describe('Phase 6 — puzzles from my mistakes', () => {
  const record = gameRecord();

  it('the reference game is a captured Lichess game with Lobo017 as Black', () => {
    expect(record.source).toBe('lichess');
    expect(record.black).toBe('Lobo017');
  });

  it('makes a puzzle of each of my Mistakes, Blunders and Misses, set up from the opponent’s previous move', () => {
    const saved = savedReview(600);
    const scan = scanPersonalPuzzles(record, saved, ME);
    expect(scan.color).toBe('b');
    const mine = saved.review.moves.filter((m) => m.color === 'b' && ['Mistake', 'Blunder', 'Miss'].includes(m.classification));
    expect(mine.length).toBeGreaterThan(0);
    expect(scan.puzzles.map((p) => p.ply)).toEqual(mine.map((m) => m.ply));
    for (const p of scan.puzzles) {
      const move = saved.review.moves.find((m) => m.ply === p.ply)!;
      const previous = saved.review.moves.find((m) => m.ply === p.ply! - 1)!;
      expect(p.id).toBe(personalPuzzleId(record.id, p.ply!));
      expect(p.fen).toBe(previous.fenBefore);
      expect(p.moves).toEqual([previous.uci, move.bestMoveUci]);
      expect(p.classification).toBe(move.classification);
      expect(p.sourceGameId).toBe(record.id);
      // The bundled puzzles' loader: the opponent's move first, then mine as Black
      const prepared = preparePuzzle(p);
      expect(prepared.setupMove.color).toBe('w');
      expect(prepared.playerColor).toBe('b');
      expect(prepared.startFen).toBe(move.fenBefore);
    }
  });

  it('never makes puzzles of the opponent’s errors', () => {
    const saved = savedReview(600);
    const whiteErrors = saved.review.moves.filter((m) => m.color === 'w' && ['Mistake', 'Blunder', 'Miss'].includes(m.classification));
    const plies = scanPersonalPuzzles(record, saved, ME).puzzles.map((p) => p.ply!);
    for (const m of whiteErrors) expect(plies).not.toContain(m.ply);
    expect(plies.every((ply) => ply % 2 === 0)).toBe(true);
  });

  it('makes none when no username of mine matches the game (or matches on another site)', () => {
    const saved = savedReview(600);
    expect(scanPersonalPuzzles(record, saved, [{ site: 'lichess', username: 'someone-else' }]).puzzles).toEqual([]);
    expect(scanPersonalPuzzles(record, saved, [{ site: 'chesscom', username: 'Lobo017' }]).color).toBeNull();
    expect(scanPersonalPuzzles(record, saved, [{ site: 'chesscom', username: 'Lobo017' }]).puzzles).toEqual([]);
  });

  it('rejects positions where the second-best move is nearly as good, or unknown', () => {
    const nearly = scanPersonalPuzzles(record, savedReview(30), ME);
    expect(nearly.puzzles).toEqual([]);
    expect(nearly.skipped.length).toBeGreaterThan(0);
    expect(nearly.skipped.every((s) => s.reason === 'not-clear' || s.reason === 'no-best')).toBe(true);
    // Lichess's analysis has one line per position: no second-best to compare
    expect(scanPersonalPuzzles(record, savedReview(null), ME).puzzles).toEqual([]);
  });
});

describe('Phase 6 — puzzle store', () => {
  const DB = 'wizards-chess-puzzle-store-test';
  let storage: WizardChessStorage;
  let store: PuzzleStore;
  const record = gameRecord();
  const analyzed: StoredGameRecord = {
    ...record,
    analysis: { preset: 'standard', savedAt: NOW, whiteAccuracy: 80, blackAccuracy: 70 },
  };

  beforeEach(async () => {
    await deleteWizardChessDB(DB);
    storage = await WizardChessStorage.create({ dbName: DB });
    store = new PuzzleStore(storage);
  });

  it('adds my game’s puzzles as new cards, shown on Today', async () => {
    const ids = await store.syncReviewedGame(analyzed, savedReview(600), ME, NOW);
    expect(ids.length).toBeGreaterThan(0);
    const today = await store.todaySummary(NOW);
    expect(today.newPersonal).toBe(ids.length);
    expect(today.totalPersonal).toBe(ids.length);
    expect(today.dueReviews).toEqual({ personal: 0, lichess: 0 });
    const queue = await store.dueQueue(NOW);
    expect(queue.fresh.map((c) => c.targetId).sort()).toEqual([...ids].sort());
  });

  it('a solved personal puzzle is scheduled by FSRS and leaves the rating alone', async () => {
    const [id] = await store.syncReviewedGame(analyzed, savedReview(600), ME, NOW);
    const puzzle = (await store.getPuzzle(id!))!;
    const res = await store.recordAttempt(puzzle, 'personal', outcome({ grade: 3 }), NOW);
    expect(res.rated).toBe(false);
    expect(res.ratingAfter).toBe(res.ratingBefore);
    expect(res.card).toMatchObject({ state: 'review', reps: 1 });
    expect(Math.round((res.card!.dueDate - NOW) / DAY)).toBe(3);
    expect(res.record).toMatchObject({ attempts: 1, solvedCount: 1, lastSolved: true });
    const today = await store.todaySummary(NOW);
    expect(today.newPersonal).toBe((await store.listPuzzles('personal')).length - 1);
    // Due again in 3 days
    expect((await store.todaySummary(NOW + 3 * DAY)).dueReviews.personal).toBe(1);
  });

  it('a bundled puzzle: the first attempt is rated; a failure comes back in 10 minutes; a clean solve gets no card', async () => {
    const entries = puzzlesJson as PuzzleEntry[];
    const failed = entries.find((p) => p.rating >= 1500)!;
    const res = await store.recordAttempt(failed, 'lichess', outcome({ solved: false, grade: 1 }), NOW);
    expect(res.rated).toBe(true);
    expect(res.ratingAfter).toBeLessThan(1500);
    expect(res.card).toMatchObject({ state: 'learning', dueDate: NOW + RELEARN_DELAY_MS });
    expect((await store.todaySummary(NOW + RELEARN_DELAY_MS)).dueReviews.lichess).toBe(1);

    // Its second attempt is not rated again
    const again = await store.recordAttempt(failed, 'lichess', outcome({ grade: 3 }), NOW + RELEARN_DELAY_MS);
    expect(again.rated).toBe(false);
    expect(again.card?.state).toBe('review');

    const solved = entries.find((p) => p.rating >= 1500 && p.id !== failed.id)!;
    const ok = await store.recordAttempt(solved, 'lichess', outcome({ grade: 4 }), NOW);
    expect(ok.rated).toBe(true);
    expect(ok.ratingAfter).toBeGreaterThan(ok.ratingBefore);
    expect(ok.card).toBeNull();
    expect(await store.getCard(solved.id)).toBeUndefined();

    // A hint makes it unrated (and it comes back)
    const hinted = entries.find((p) => p.rating >= 1500 && p.id !== failed.id && p.id !== solved.id)!;
    const h = await store.recordAttempt(hinted, 'lichess', outcome({ hintUsed: true, grade: 2 }), NOW);
    expect(h.rated).toBe(false);
    expect(h.card).not.toBeNull();

    const rating = await store.getRating();
    expect(rating.games).toBe(2);
    expect(rating.history.map((e) => e.puzzleId)).toEqual([failed.id, solved.id]);
    expect((await store.todaySummary(NOW)).ratedToday).toBe(2);
    expect((await store.todaySummary(NOW)).ratedSolvedToday).toBe(1);
    expect((await store.triedBundledIds()).sort()).toEqual([failed.id, solved.id, hinted.id].sort());
  });

  it('syncs every reviewed game once, re-scans when my accounts change, and drops puzzles that no longer apply', async () => {
    const saved = savedReview(600);
    const getReview = async () => saved;
    expect(await store.syncAll([analyzed], getReview, ME, NOW)).toBe(1);
    const count = (await store.listPuzzles('personal')).length;
    expect(count).toBeGreaterThan(0);
    // Unchanged: nothing scanned
    expect(await store.syncAll([analyzed], getReview, ME, NOW)).toBe(0);
    // Progress survives a re-scan of the same review
    const first = (await store.listPuzzles('personal'))[0]!;
    await store.recordAttempt(first, 'personal', outcome({}), NOW);
    expect(await store.syncAll([analyzed], getReview, [...ME, { site: 'chesscom', username: 'x' }], NOW)).toBe(1);
    expect((await store.getPuzzle(first.id))?.attempts).toBe(1);
    // Another username only: not my game any more → its puzzles and cards go
    expect(await store.syncAll([analyzed], getReview, [{ site: 'lichess', username: 'other' }], NOW)).toBe(1);
    expect(await store.listPuzzles('personal')).toEqual([]);
    expect(await store.getCard(first.id)).toBeUndefined();
    expect(await storage.getSrsCard(cardId(first.id))).toBeUndefined();
  });
});
