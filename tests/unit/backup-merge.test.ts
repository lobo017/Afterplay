import { describe, expect, it } from 'vitest';
import {
  outcomeOf,
  pickCard,
  pickEndgame,
  pickGame,
  pickPuzzle,
  pickRating,
  pickReleasePair,
  pickRepertoire,
  pickReview,
  pickRow,
  ratingDiffers,
  ratingStamp,
  settingKind,
  stamp,
} from '../../src/storage/backup-merge';
import type {
  StoredEndgameProgressRecord,
  StoredGameRecord,
  StoredPuzzleRecord,
  StoredRepertoireRecord,
  StoredReviewRecord,
  StoredSettingRecord,
  StoredSrsCardRecord,
} from '../../src/storage/db';

// Invented records, only the fields a rule reads.
const as = <T>(v: Record<string, unknown>): T => v as unknown as T;
const game = (v: Record<string, unknown>): StoredGameRecord => as({ id: 'g', pgn: '1. e4 1-0', updatedAt: 1, ...v });
const puzzle = (v: Record<string, unknown>): StoredPuzzleRecord => as({ id: 'p', attempts: 0, updatedAt: 1, ...v });
const card = (v: Record<string, unknown>): StoredSrsCardRecord => as({ id: 'c', reps: 0, updatedAt: 1, ...v });
const row = (key: string, value: unknown, updatedAt = 1): StoredSettingRecord => ({ key, value, updatedAt });
const analysed = (savedAt: number) => ({ preset: 'standard', savedAt, whiteAccuracy: 90, blackAccuracy: 80 });

describe('stamps and outcomes', () => {
  it('reads a time as a number and anything else as 0', () => {
    expect(stamp(5)).toBe(5);
    expect(stamp(undefined)).toBe(0);
    expect(stamp(null)).toBe(0);
    expect(stamp('7')).toBe(0);
    expect(stamp(NaN)).toBe(0);
    expect(stamp(Infinity)).toBe(0);
  });

  it('names what happened to a record', () => {
    expect(outcomeOf(false, 'file')).toBe('added');
    expect(outcomeOf(false, 'local')).toBe('added');
    expect(outcomeOf(true, 'file')).toBe('updated');
    expect(outcomeOf(true, 'local')).toBe('keptNewer');
    expect(outcomeOf(true, 'same')).toBe('unchanged');
  });
});

describe('reviews: the later updatedAt', () => {
  const review = (updatedAt: unknown) => as<StoredReviewRecord>({ id: 'g', updatedAt });
  it('newer wins, a tie keeps the one here, a missing time loses', () => {
    expect(pickReview(review(100), review(200))).toBe('file');
    expect(pickReview(review(200), review(100))).toBe('local');
    expect(pickReview(review(100), review(100))).toBe('same');
    expect(pickReview(review(100), review(undefined))).toBe('local');
    expect(pickReview(review(undefined), review(100))).toBe('file');
    expect(pickReview(review(undefined), review(undefined))).toBe('same');
  });
});

describe('games: the later review first, then the same game, then updatedAt (rule G)', () => {
  it('a review made here wins over a copy imported later without one', () => {
    const here = game({ updatedAt: 1000, analysis: analysed(5000) });
    const file = game({ updatedAt: 3000, analysis: null });
    expect(pickGame(here, file)).toBe('local');
  });

  it("the file's review wins over a copy here without one, even when the file's copy is older", () => {
    const here = game({ updatedAt: 3000, analysis: null });
    const file = game({ updatedAt: 1000, analysis: analysed(5000) });
    expect(pickGame(here, file)).toBe('file');
  });

  it('the later of two reviews wins', () => {
    expect(pickGame(game({ analysis: analysed(100) }), game({ analysis: analysed(200) }))).toBe('file');
    expect(pickGame(game({ analysis: analysed(200) }), game({ analysis: analysed(100) }))).toBe('local');
  });

  it('the same game with the same review is unchanged whatever its import time', () => {
    const a = game({ updatedAt: 10, analysis: analysed(100) });
    const b = game({ updatedAt: 99999, analysis: analysed(100) });
    expect(pickGame(a, b)).toBe('same');
    expect(pickGame(game({ updatedAt: 10, analysis: null }), game({ updatedAt: 99999, analysis: null }))).toBe('same');
    // An older file without the analysis field at all
    expect(pickGame(game({ updatedAt: 10 }), game({ updatedAt: 20, analysis: undefined }))).toBe('same');
  });

  it('another PGN with no review on either side: the later updatedAt, a tie keeps the one here', () => {
    expect(pickGame(game({ pgn: 'a', updatedAt: 10 }), game({ pgn: 'b', updatedAt: 20 }))).toBe('file');
    expect(pickGame(game({ pgn: 'a', updatedAt: 20 }), game({ pgn: 'b', updatedAt: 10 }))).toBe('local');
    expect(pickGame(game({ pgn: 'a', updatedAt: 10 }), game({ pgn: 'b', updatedAt: 10 }))).toBe('same');
  });

  it('an unusable review time counts as no review', () => {
    expect(pickGame(game({ analysis: { savedAt: 'x' } }), game({ analysis: analysed(5) }))).toBe('file');
  });
});

describe('puzzles and cards: the later attempt, then the higher count', () => {
  it('the later lastAttemptAt wins whatever updatedAt says', () => {
    const here = puzzle({ lastAttemptAt: 2000, attempts: 3, updatedAt: 1 });
    const file = puzzle({ lastAttemptAt: 1000, attempts: 1, updatedAt: 99999 });
    expect(pickPuzzle(here, file)).toBe('local');
    expect(pickPuzzle(file, here)).toBe('file');
  });

  it('a puzzle never tried here loses to one tried in the file, and the other way round', () => {
    expect(pickPuzzle(puzzle({}), puzzle({ lastAttemptAt: 5, attempts: 1 }))).toBe('file');
    expect(pickPuzzle(puzzle({ lastAttemptAt: 5, attempts: 1 }), puzzle({}))).toBe('local');
  });

  it('a tie in time goes to more attempts, then stays here', () => {
    expect(pickPuzzle(puzzle({ attempts: 2 }), puzzle({ attempts: 4 }))).toBe('file');
    expect(pickPuzzle(puzzle({ attempts: 4 }), puzzle({ attempts: 2 }))).toBe('local');
    expect(pickPuzzle(puzzle({ attempts: 2 }), puzzle({ attempts: 2 }))).toBe('same');
    expect(pickPuzzle(puzzle({ updatedAt: 1 }), puzzle({ updatedAt: 2 }))).toBe('same');
  });

  it('cards: the later review, then more repetitions; a new card is time 0', () => {
    expect(pickCard(card({ lastReviewDate: 100, reps: 1 }), card({ lastReviewDate: 200, reps: 1 }))).toBe('file');
    expect(pickCard(card({ lastReviewDate: 200 }), card({ lastReviewDate: 100, reps: 9 }))).toBe('local');
    expect(pickCard(card({}), card({ lastReviewDate: 100 }))).toBe('file');
    expect(pickCard(card({ reps: 1 }), card({ reps: 3 }))).toBe('file');
    expect(pickCard(card({ reps: 3 }), card({ reps: 3 }))).toBe('same');
  });

  it('a puzzle and its card, written by one attempt, are decided alike', () => {
    const now = 4242;
    const here = { p: puzzle({ lastAttemptAt: now, attempts: 2 }), c: card({ lastReviewDate: now, reps: 2 }) };
    const file = {
      p: puzzle({ lastAttemptAt: now - 100, attempts: 1 }),
      c: card({ lastReviewDate: now - 100, reps: 1 }),
    };
    expect(pickPuzzle(here.p, file.p)).toBe(pickCard(here.c, file.c));
    expect(pickPuzzle(file.p, here.p)).toBe(pickCard(file.c, here.c));
  });
});

describe('repertoires and endgame drills', () => {
  it('repertoires: the later updatedAt', () => {
    const rep = (updatedAt: number) => as<StoredRepertoireRecord>({ id: 'r', updatedAt });
    expect(pickRepertoire(rep(1), rep(2))).toBe('file');
    expect(pickRepertoire(rep(2), rep(1))).toBe('local');
    expect(pickRepertoire(rep(2), rep(2))).toBe('same');
  });

  it('endgame progress: lastAttemptAt, else updatedAt, then attempts', () => {
    const eg = (v: Record<string, unknown>) => as<StoredEndgameProgressRecord>({ id: 'e', attempts: 1, ...v });
    expect(pickEndgame(eg({ lastAttemptAt: 10 }), eg({ lastAttemptAt: 20 }))).toBe('file');
    // An older record without lastAttemptAt: its updatedAt is the attempt time
    expect(pickEndgame(eg({ updatedAt: 30 }), eg({ lastAttemptAt: 20, updatedAt: 99 }))).toBe('local');
    expect(pickEndgame(eg({ updatedAt: 10 }), eg({ updatedAt: 20 }))).toBe('file');
    expect(pickEndgame(eg({ updatedAt: 10, attempts: 1 }), eg({ updatedAt: 10, attempts: 5 }))).toBe('file');
    expect(pickEndgame(eg({ updatedAt: 10 }), eg({ updatedAt: 10 }))).toBe('same');
  });
});

describe('settings rows', () => {
  it('sorts every settings key into how a restore treats it', () => {
    expect(settingKind('puzzles.rating')).toBe('rating');
    expect(settingKind('puzzles.fromHistory.state')).toBe('release-pair');
    expect(settingKind('puzzles.fromHistory.pending')).toBe('release-pair');
    expect(settingKind('puzzles.fromHistory.miss')).toBe('keep-local');
    expect(settingKind('puzzles.personalSync')).toBe('keep-local');
    expect(settingKind('viz.coordinates')).toBe('newest-row');
    expect(settingKind('viz.blindfold')).toBe('newest-row');
    expect(settingKind('viz.guess')).toBe('newest-row');
    for (const key of [
      'app.preferences',
      'library.myAccounts',
      'library.moreAccounts',
      'library.autoAnalyze',
      'sync.chesscom',
      'story.import',
      'story.import.chesscom',
      'bots.book.me',
      'bots.preset.anything',
      'something.new',
    ]) {
      expect(settingKind(key), key).toBe('overwrite');
    }
  });

  it('viz rows: the later updatedAt', () => {
    expect(pickRow(row('viz.guess', {}, 1), row('viz.guess', {}, 2))).toBe('file');
    expect(pickRow(row('viz.guess', {}, 2), row('viz.guess', {}, 1))).toBe('local');
    expect(pickRow(row('viz.guess', {}, 2), row('viz.guess', {}, 2))).toBe('same');
  });

  it('puzzle rating: the later rated attempt, else the row time', () => {
    const rating = (at: number[], updatedAt = 1, games = at.length, r = 1500) =>
      row(
        'puzzles.rating',
        { rating: r, games, history: at.map((a) => ({ at: a, rating: r, puzzleId: 'x', solved: true })) },
        updatedAt,
      );
    expect(ratingStamp(rating([10, 30, 20]))).toBe(30);
    expect(ratingStamp(rating([], 77))).toBe(77);
    expect(pickRating(rating([10]), rating([20]))).toBe('file');
    expect(pickRating(rating([20]), rating([10]))).toBe('local');
    expect(pickRating(rating([20]), rating([20]))).toBe('same');
    // More rated puzzles but an older last attempt loses: newest wins, whatever the count
    expect(pickRating(rating([100, 200, 300, 400]), rating([500], 1, 1))).toBe('file');
    expect(pickRating(rating([], 50), rating([], 40))).toBe('local');
    expect(ratingDiffers(rating([1], 1, 1, 1500), rating([1], 1, 1, 1500))).toBe(false);
    expect(ratingDiffers(rating([1], 1, 1, 1500), rating([1], 1, 1, 1520))).toBe(true);
    expect(ratingDiffers(rating([1], 1, 1), rating([1, 2], 1, 2))).toBe(true);
  });

  it('release schedule: more released wins for the same puzzle file, as a pair', () => {
    const state = (input: string, released: number) =>
      row('puzzles.fromHistory.state', { version: 1, slug: 's', input, loadedDay: '2026-01-01', total: 100, released });
    expect(pickReleasePair(state('a', 50), state('a', 70))).toBe('file');
    expect(pickReleasePair(state('a', 70), state('a', 50))).toBe('local');
    expect(pickReleasePair(state('a', 50), state('a', 50))).toBe('same');
    // Another puzzle file: never mixed, this device's stays
    expect(pickReleasePair(state('a', 10), state('b', 90))).toBe('local');
    // Only one side has a schedule
    expect(pickReleasePair(undefined, state('a', 5))).toBe('file');
    expect(pickReleasePair(state('a', 5), undefined)).toBe('local');
    expect(pickReleasePair(undefined, undefined)).toBe('same');
    // A damaged state counts as none
    expect(pickReleasePair(row('puzzles.fromHistory.state', { released: 'x' }), state('a', 1))).toBe('file');
    expect(pickReleasePair(state('a', 1), row('puzzles.fromHistory.state', null))).toBe('local');
  });
});
