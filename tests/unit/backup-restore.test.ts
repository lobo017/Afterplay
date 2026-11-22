import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { BackupRefusedError } from '../../src/storage/backup-restore';
import { checkBackup } from '../../src/storage/backup-validate';
import {
  LATEST_SCHEMA_VERSION,
  WizardChessStorage,
  deleteWizardChessDB,
  type BackupPayload,
  type StoredEndgameProgressRecord,
  type StoredGameRecord,
  type StoredPuzzleRecord,
  type StoredRepertoireRecord,
  type StoredSettingRecord,
  type StoredSrsCardRecord,
} from '../../src/storage/db';

// Invented data only: no real names, ids or games.
const DB = 'wizards-chess-backup-restore-test';
const OTHER = 'wizards-chess-backup-restore-test-other';

let storage: WizardChessStorage;

beforeEach(async () => {
  await deleteWizardChessDB(DB);
  await deleteWizardChessDB(OTHER);
  storage = await WizardChessStorage.create({ dbName: DB });
});

afterEach(async () => {
  storage.close();
  await deleteWizardChessDB(DB);
  await deleteWizardChessDB(OTHER);
});

const payload = (parts: Partial<BackupPayload>): BackupPayload => ({
  format: 'wizards-chess-backup',
  schemaVersion: LATEST_SCHEMA_VERSION,
  exportedAt: 9000,
  games: [],
  settings: [],
  puzzles: [],
  srsCards: [],
  repertoires: [],
  endgameProgress: [],
  reviews: [],
  ...parts,
});

const file = (parts: Partial<BackupPayload>): string => JSON.stringify(payload(parts));

/** Puts records into an empty database exactly as given (times included), by restoring a file. */
const seed = async (target: WizardChessStorage, parts: Partial<BackupPayload>): Promise<void> => {
  await target.importBackupJson(file(parts));
};

/** Everything a database holds, as comparable data (the export, without its own time). */
const snapshot = async (target: WizardChessStorage): Promise<Omit<BackupPayload, 'exportedAt'>> => {
  const { exportedAt: _t, ...rest } = JSON.parse(await target.exportBackupJson()) as BackupPayload;
  return rest;
};

const game = (id: string, patch: Partial<StoredGameRecord> = {}): StoredGameRecord => ({
  id,
  white: 'Alice',
  black: 'Bob',
  playerColor: 'w',
  result: '1-0',
  date: '2026.01.01',
  openingEco: '',
  openingName: '',
  accuracy: null,
  pgn: '1. e4 e5 1-0',
  tags: [],
  schemaVersion: LATEST_SCHEMA_VERSION,
  createdAt: 1000,
  updatedAt: 1000,
  analysis: null,
  ...patch,
});

const puzzle = (id: string, patch: Partial<StoredPuzzleRecord> = {}): StoredPuzzleRecord => ({
  id,
  source: 'personal',
  fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
  moves: ['a1a2', 'h1h2'],
  rating: 0,
  themes: [],
  dueDate: 5000,
  attempts: 0,
  solvedCount: 0,
  updatedAt: 1000,
  ...patch,
});

const card = (puzzleId: string, patch: Partial<StoredSrsCardRecord> = {}): StoredSrsCardRecord => ({
  id: `puzzle:${puzzleId}`,
  deck: 'puzzle',
  targetId: puzzleId,
  state: 'review',
  stability: 2,
  difficulty: 5,
  reps: 1,
  lapses: 0,
  dueDate: 5000,
  updatedAt: 1000,
  ...patch,
});

const setting = (key: string, value: unknown, updatedAt = 1000): StoredSettingRecord => ({ key, value, updatedAt });

const rating = (at: number[], r = 1500): StoredSettingRecord =>
  setting('puzzles.rating', {
    rating: r,
    rd: 100,
    volatility: 0.06,
    games: at.length,
    history: at.map((a) => ({ at: a, rating: r, puzzleId: 'x', solved: true })),
  });

const releaseState = (input: string, released: number): StoredSettingRecord =>
  setting('puzzles.fromHistory.state', {
    version: 1,
    slug: 'link',
    input,
    loadedDay: '2026-01-01',
    total: 100,
    released,
    lastDay: '2026-01-01',
    lastDayCount: 0,
  });

const releasePending = (input: string, ids: string[]): StoredSettingRecord =>
  setting('puzzles.fromHistory.pending', {
    version: 1,
    input,
    entries: ids.map((id) => ({ id, ply: 1, moves: ['a', 'b'] })),
  });

describe('Restore keeps newer progress', () => {
  it('restoring an older backup over newer puzzle progress keeps the newer record', async () => {
    await storage.savePuzzle(puzzle('p1', { attempts: 3, solvedCount: 2, lastAttemptAt: 2000, lastSolved: true }));
    await storage.saveSrsCard(card('p1', { reps: 3, lastReviewDate: 2000, dueDate: 9000 }));

    await storage.importBackupJson(
      file({
        puzzles: [puzzle('p1', { attempts: 1, solvedCount: 0, lastAttemptAt: 1000, lastSolved: false })],
        srsCards: [card('p1', { reps: 1, lastReviewDate: 1000, dueDate: 3000 })],
      }),
    );

    expect(await storage.getPuzzle('p1')).toMatchObject({ attempts: 3, solvedCount: 2, lastAttemptAt: 2000 });
    expect(await storage.getSrsCard('puzzle:p1')).toMatchObject({ reps: 3, lastReviewDate: 2000, dueDate: 9000 });
  });

  it("a review made here after the backup keeps its game summary even when the file's copy of the game was imported later", async () => {
    // Here: imported at 1000, reviewed at 5000 (saving a review does not change the game's updatedAt)
    await storage.saveGame(
      game('g1', {
        updatedAt: 1000,
        accuracy: 91.5,
        analysis: { preset: 'standard', savedAt: 5000, whiteAccuracy: 91.5, blackAccuracy: 60 },
      }),
    );
    await storage.saveReview('g1', { version: 1, preset: 'standard', savedAt: 5000 } as never);

    // The file: the same game imported later (3000) on a device that never reviewed it
    await storage.importBackupJson(file({ games: [game('g1', { updatedAt: 3000, accuracy: null, analysis: null })] }));

    const kept = await storage.getGame('g1');
    expect(kept?.analysis?.savedAt).toBe(5000);
    expect(kept?.accuracy).toBe(91.5);
    expect(await storage.getReview('g1')).toBeDefined();
  });

  it('records only in the file are added, older ones are updated, newer ones are kept, and the report counts each', async () => {
    await seed(storage, {
      puzzles: [
        puzzle('older', { attempts: 1, lastAttemptAt: 100 }),
        puzzle('newer', { attempts: 2, lastAttemptAt: 900 }),
        puzzle('same', { attempts: 1, lastAttemptAt: 500 }),
      ],
      reviews: [{ id: 'g1', review: { savedAt: 100 } as never, updatedAt: 100 }],
    });
    const report = await storage.restoreBackupJson(
      file({
        puzzles: [
          puzzle('older', { attempts: 3, lastAttemptAt: 400 }),
          puzzle('newer', { attempts: 1, lastAttemptAt: 300 }),
          puzzle('same', { attempts: 1, lastAttemptAt: 500 }),
          puzzle('fresh', { attempts: 1, lastAttemptAt: 50 }),
        ],
        reviews: [{ id: 'g1', review: { savedAt: 700 } as never, updatedAt: 700 }],
      }),
    );
    expect(report.puzzles).toEqual({ added: 1, updated: 1, keptNewer: 1, unchanged: 1 });
    expect(report.reviews).toEqual({ added: 0, updated: 1, keptNewer: 0, unchanged: 0 });
    expect(await storage.getPuzzle('older')).toMatchObject({ attempts: 3 });
    expect(await storage.getPuzzle('newer')).toMatchObject({ attempts: 2 });
    expect(await storage.getPuzzle('fresh')).toBeDefined();
    expect((await storage.listPuzzles()).map((p) => p.id).sort()).toEqual(['fresh', 'newer', 'older', 'same']);
  });

  it('restoring the same file twice writes nothing the second time, and a tie keeps the record here', async () => {
    const text = file({
      games: [game('g1'), game('g2', { updatedAt: 5 })],
      puzzles: [puzzle('p1', { attempts: 2, lastAttemptAt: 300 })],
      srsCards: [card('p1', { lastReviewDate: 300, reps: 2 })],
      reviews: [{ id: 'g1', review: { savedAt: 1 } as never, updatedAt: 10 }],
      settings: [setting('viz.guess', { g: { hits: 1, total: 2, at: 1 } }, 10)],
    });
    const first = await storage.restoreBackupJson(text);
    expect(first.games.added).toBe(2);
    expect(first.puzzles.added).toBe(1);
    const before = await snapshot(storage);

    const second = await storage.restoreBackupJson(text);
    for (const key of ['games', 'reviews', 'puzzles', 'srsCards'] as const) {
      expect(second[key].added + second[key].updated, key).toBe(0);
    }
    expect(second.games.unchanged).toBe(2);
    expect(second.progressSettings.added + second.progressSettings.updated).toBe(0);
    expect(await snapshot(storage)).toEqual(before);

    // A tie in time but another body: the one here stays
    await storage.restoreBackupJson(
      file({ puzzles: [puzzle('p1', { attempts: 2, lastAttemptAt: 300, solvedCount: 9 })] }),
    );
    expect((await storage.getPuzzle('p1'))?.solvedCount).toBe(0);
  });

  it('half-solved set: two devices that solved different halves of the same twenty restore to all twenty, both ways', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `set-${i}`);
    const solved = (id: string, at: number) =>
      puzzle(id, { attempts: 1, solvedCount: 1, lastAttemptAt: at, lastSolved: true });
    const untried = (id: string) => puzzle(id);
    const cardOf = (id: string, at: number) => card(id, { lastReviewDate: at, reps: 1 });
    const newCard = (id: string) => card(id, { state: 'new', reps: 0 });

    const phone = await WizardChessStorage.create({ dbName: OTHER });
    try {
      // This device (laptop) did the first ten, the phone the other ten
      await seed(storage, {
        puzzles: ids.map((id, i) => (i < 10 ? solved(id, 1000 + i) : untried(id))),
        srsCards: ids.map((id, i) => (i < 10 ? cardOf(id, 1000 + i) : newCard(id))),
      });
      await seed(phone, {
        puzzles: ids.map((id, i) => (i >= 10 ? solved(id, 2000 + i) : untried(id))),
        srsCards: ids.map((id, i) => (i >= 10 ? cardOf(id, 2000 + i) : newCard(id))),
      });

      const phoneFile = await phone.exportBackupJson();
      const laptopFile = await storage.exportBackupJson();
      await storage.restoreBackupJson(phoneFile);
      await phone.restoreBackupJson(laptopFile);

      for (const target of [storage, phone]) {
        const puzzles = await target.listPuzzles();
        expect(puzzles).toHaveLength(20);
        expect(puzzles.every((p) => p.attempts === 1 && p.solvedCount === 1)).toBe(true);
        const cards = await target.listSrsCards('puzzle');
        expect(cards.every((c) => c.state === 'review' && c.reps === 1)).toBe(true);
      }
    } finally {
      phone.close();
    }
  });

  it('the same puzzle on both devices: the later attempt wins whole, its row and its card together', async () => {
    await seed(storage, {
      puzzles: [puzzle('x', { attempts: 2, solvedCount: 1, lastAttemptAt: 2000, lastSolved: false })],
      srsCards: [card('x', { reps: 2, lastReviewDate: 2000, lapses: 1, dueDate: 7000 })],
    });
    await storage.restoreBackupJson(
      file({
        puzzles: [puzzle('x', { attempts: 3, solvedCount: 3, lastAttemptAt: 3000, lastSolved: true })],
        srsCards: [card('x', { reps: 3, lastReviewDate: 3000, lapses: 0, dueDate: 9000 })],
      }),
    );
    expect(await storage.getPuzzle('x')).toMatchObject({ attempts: 3, solvedCount: 3, lastSolved: true });
    expect(await storage.getSrsCard('puzzle:x')).toMatchObject({ reps: 3, lapses: 0, dueDate: 9000 });
  });

  it("the release schedule is taken as a pair, and another puzzle file keeps this device's", async () => {
    await seed(storage, { settings: [releaseState('file-a', 50), releasePending('file-a', ['l1', 'l2'])] });

    // More released in the file: both rows come from the file
    let report = await storage.restoreBackupJson(
      file({ settings: [releaseState('file-a', 70), releasePending('file-a', ['f1'])] }),
    );
    expect(report.progressSettings.updated).toBe(2);
    expect(await storage.getSetting<{ released: number }>('puzzles.fromHistory.state')).toMatchObject({ released: 70 });
    expect(await storage.getSetting<{ entries: unknown[] }>('puzzles.fromHistory.pending')).toMatchObject({
      entries: [{ id: 'f1' }],
    });

    // Fewer released in the file: neither row is touched, not even the pending list
    report = await storage.restoreBackupJson(
      file({ settings: [releaseState('file-a', 10), releasePending('file-a', ['o1', 'o2', 'o3'])] }),
    );
    expect(report.progressSettings).toEqual({ added: 0, updated: 0, keptNewer: 2, unchanged: 0 });
    expect(await storage.getSetting<{ released: number }>('puzzles.fromHistory.state')).toMatchObject({ released: 70 });
    expect(await storage.getSetting<{ entries: unknown[] }>('puzzles.fromHistory.pending')).toMatchObject({
      entries: [{ id: 'f1' }],
    });

    // Another puzzle file with more released: still this device's pair
    await storage.restoreBackupJson(file({ settings: [releaseState('file-b', 99), releasePending('file-b', ['z'])] }));
    expect(await storage.getSetting<{ input: string }>('puzzles.fromHistory.state')).toMatchObject({ input: 'file-a' });
    expect(await storage.getSetting<{ input: string }>('puzzles.fromHistory.pending')).toMatchObject({
      input: 'file-a',
    });
  });

  it("a device with no release schedule takes the file's pair", async () => {
    const report = await storage.restoreBackupJson(
      file({ settings: [releaseState('file-a', 50), releasePending('file-a', ['f1'])] }),
    );
    expect(report.progressSettings.added).toBe(2);
    expect(await storage.getSetting('puzzles.fromHistory.state')).toBeDefined();
  });

  it('the puzzle rating: the later rated attempt wins, and the report says which one stayed', async () => {
    await seed(storage, { settings: [rating([100, 200], 1480)] });

    // Older in the file: this device's stays
    let report = await storage.restoreBackupJson(file({ settings: [rating([50], 1300)] }));
    expect(report.rating).toBe('this-device');
    expect((await storage.getSetting<{ rating: number }>('puzzles.rating'))?.rating).toBe(1480);

    // Newer in the file: the file's is taken
    report = await storage.restoreBackupJson(file({ settings: [rating([100, 200, 300], 1550)] }));
    expect(report.rating).toBe('file');
    expect((await storage.getSetting<{ rating: number }>('puzzles.rating'))?.rating).toBe(1550);

    // The same rating: nothing to say
    report = await storage.restoreBackupJson(file({ settings: [rating([100, 200, 300], 1550)] }));
    expect(report.rating).toBe('same');

    // No rating in the file
    expect((await storage.restoreBackupJson(file({}))).rating).toBe('none');
  });

  it('drill statistics, repertoires and endgame progress: the later stamp wins', async () => {
    const rep = (id: string, updatedAt: number, name: string): StoredRepertoireRecord => ({
      id,
      name,
      color: 'w',
      pgn: '',
      tree: {} as never,
      updatedAt,
    });
    const eg = (id: string, patch: Partial<StoredEndgameProgressRecord>): StoredEndgameProgressRecord => ({
      id,
      category: 'c',
      completed: 1,
      attempts: 1,
      bestMoves: null,
      optimalMoves: null,
      updatedAt: 100,
      ...patch,
    });
    await seed(storage, {
      settings: [setting('viz.coordinates', { rounds: 5, best: 20, history: [] }, 500)],
      repertoires: [rep('white', 500, 'here')],
      endgameProgress: [eg('a', { lastAttemptAt: 500, bestMoves: 9 }), eg('b', { updatedAt: 100 })],
    });
    await storage.restoreBackupJson(
      file({
        settings: [setting('viz.coordinates', { rounds: 2, best: 8, history: [] }, 100)],
        repertoires: [rep('white', 100, 'older file')],
        endgameProgress: [eg('a', { lastAttemptAt: 100, bestMoves: 20 }), eg('b', { updatedAt: 900, bestMoves: 4 })],
      }),
    );
    expect(await storage.getSetting('viz.coordinates')).toMatchObject({ rounds: 5 });
    expect((await storage.getRepertoire('white'))?.name).toBe('here');
    expect((await storage.getEndgameProgress('a'))?.bestMoves).toBe(9);
    expect((await storage.getEndgameProgress('b'))?.bestMoves).toBe(4);

    await storage.restoreBackupJson(
      file({
        settings: [setting('viz.coordinates', { rounds: 9, best: 30, history: [] }, 900)],
        repertoires: [rep('white', 900, 'newer file')],
      }),
    );
    expect(await storage.getSetting('viz.coordinates')).toMatchObject({ rounds: 9 });
    expect((await storage.getRepertoire('white'))?.name).toBe('newer file');
  });

  it('settings, usernames, profile, bots and books are replaced by the file even when newer here', async () => {
    await seed(storage, {
      settings: [
        setting('app.preferences', { version: 1, app: { sound: true } }, 9000),
        setting('library.myAccounts', { lichess: '', chesscom: 'here' }, 9000),
        setting('bots.book.me', 'book-here', 9000),
        setting('bots.preset.rook', 'preset-here', 9000),
        setting('sync.chesscom', { months: 'here' }, 9000),
        setting('story.import', { status: 'here' }, 9000),
        setting('only-here', 1, 9000),
      ],
    });
    const report = await storage.restoreBackupJson(
      file({
        settings: [
          setting('app.preferences', { version: 1, app: { sound: false } }, 10),
          setting('library.myAccounts', { lichess: '', chesscom: 'file' }, 10),
          setting('bots.book.me', 'book-file', 10),
          setting('bots.preset.rook', 'preset-file', 10),
          setting('sync.chesscom', { months: 'file' }, 10),
          setting('story.import', { status: 'file' }, 10),
        ],
      }),
    );
    expect(await storage.getSetting('app.preferences')).toEqual({ version: 1, app: { sound: false } });
    expect(await storage.getSetting('library.myAccounts')).toEqual({ lichess: '', chesscom: 'file' });
    expect(await storage.getSetting('bots.book.me')).toBe('book-file');
    expect(await storage.getSetting('bots.preset.rook')).toBe('preset-file');
    expect(await storage.getSetting('sync.chesscom')).toEqual({ months: 'file' });
    expect(await storage.getSetting('story.import')).toEqual({ status: 'file' });
    // A row that is not in the file is never removed
    expect(await storage.getSetting('only-here')).toBe(1);
    expect(report.overwrittenSettings).toBe(6);
    expect(report.preferences).toEqual({ version: 1, app: { sound: false } });
    expect(report.progressSettings).toEqual({ added: 0, updated: 0, keptNewer: 0, unchanged: 0 });
  });

  it('bookkeeping rows derived on each device stay when this device has them', async () => {
    await seed(storage, { settings: [setting('puzzles.personalSync', { accountsKey: 'here', games: {} })] });
    const report = await storage.restoreBackupJson(
      file({
        settings: [
          setting('puzzles.personalSync', { accountsKey: 'file', games: {} }, 99999),
          setting('puzzles.fromHistory.miss', { slug: 'x', day: '2026-01-01' }),
        ],
      }),
    );
    expect(await storage.getSetting('puzzles.personalSync')).toMatchObject({ accountsKey: 'here' });
    expect(await storage.getSetting('puzzles.fromHistory.miss')).toBeDefined();
    expect(report.progressSettings).toEqual({ added: 1, updated: 0, keptNewer: 0, unchanged: 1 });
  });
});

describe('Restore is all or nothing', () => {
  const populated = (): Partial<BackupPayload> => ({
    games: [game('g1'), game('g2')],
    puzzles: [puzzle('p1', { attempts: 1, lastAttemptAt: 100 })],
    srsCards: [card('p1', { lastReviewDate: 100 })],
    settings: [setting('app.preferences', { version: 1 }, 5), rating([10])],
    reviews: [{ id: 'g1', review: { savedAt: 1 } as never, updatedAt: 1 }],
  });

  it('a damaged record anywhere in the file changes nothing and says how many', async () => {
    await seed(storage, populated());
    const before = await snapshot(storage);
    const bad = {
      ...payload({
        games: [game('g3'), game('g1', { pgn: 'changed' })],
        puzzles: [puzzle('p9', { attempts: 5, lastAttemptAt: 900 })],
        settings: [setting('app.preferences', { version: 1, changed: true }, 900)],
      }),
    } as Record<string, unknown>;
    (bad.reviews as unknown[]) = [{ id: 'g1', updatedAt: 'yesterday' }, null, { updatedAt: 3 }];

    const err = await storage.restoreBackupJson(JSON.stringify(bad)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupRefusedError);
    expect((err as BackupRefusedError).kind).toBe('damaged');
    expect((err as BackupRefusedError).message).toBe('3 records in this file are damaged.');
    expect(await snapshot(storage)).toEqual(before);
  });

  it('a file from a newer version of the app is refused and changes nothing', async () => {
    await seed(storage, populated());
    const before = await snapshot(storage);
    const err = await storage
      .restoreBackupJson(file({ schemaVersion: LATEST_SCHEMA_VERSION + 1, games: [game('g9')] }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupRefusedError);
    expect((err as BackupRefusedError).kind).toBe('newer-schema');
    expect((err as Error).message).toBe(
      'This backup was made by a newer version of Afterplay. Update the app, then try again.',
    );
    expect(await snapshot(storage)).toEqual(before);
  });

  it('a truncated file, text that is not JSON and a file that is not a backup change nothing', async () => {
    await seed(storage, populated());
    const before = await snapshot(storage);
    const whole = file({ games: [game('g9')] });
    const cases: Array<[string, string, string]> = [
      ['truncated', whole.slice(0, Math.floor(whole.length / 2)), 'not-json'],
      ['text', 'hello', 'not-json'],
      ['other object', '{"hello":1}', 'not-a-backup'],
      ['array', '[]', 'not-a-backup'],
      ['bad version', JSON.stringify({ ...JSON.parse(whole), schemaVersion: 'four' }), 'not-a-backup'],
    ];
    for (const [name, text, kind] of cases) {
      const err = await storage.restoreBackupJson(text).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(BackupRefusedError);
      expect((err as BackupRefusedError).kind, name).toBe(kind);
    }
    expect(await snapshot(storage)).toEqual(before);
  });

  it('a failure inside the transaction rolls back every store', async () => {
    await seed(storage, populated());
    const before = await snapshot(storage);
    // Passes the checks, then cannot be stored (a function does not survive structured cloning): the settings, games,
    // puzzles and cards in front of it are written first and must be undone
    const parsed = payload({
      games: [
        game('g7'),
        game('g1', {
          pgn: 'changed',
          analysis: { preset: 'standard', savedAt: 9, whiteAccuracy: 1, blackAccuracy: 1 },
        }),
      ],
      puzzles: [puzzle('p1', { attempts: 9, lastAttemptAt: 900 }), puzzle('p8')],
      srsCards: [card('p8')],
      settings: [setting('app.preferences', { version: 1, changed: true }, 900)],
      reviews: [{ id: 'g7', review: (() => 1) as never, updatedAt: 5 }],
    });
    await expect(storage.restoreBackup(parsed)).rejects.toBeDefined();
    expect(await snapshot(storage)).toEqual(before);
    // And the database is still usable
    await storage.restoreBackupJson(file({ games: [game('g7')] }));
    expect(await storage.getGame('g7')).toBeDefined();
  });

  it('an old backup without reviews, cards, repertoires or drills restores', async () => {
    const old = {
      format: 'wizards-chess-backup',
      schemaVersion: 2,
      exportedAt: 1,
      games: [{ id: 'old-1', white: 'A', black: 'B', pgn: '1. e4 *' }],
      settings: [],
    };
    const report = await storage.restoreBackupJson(JSON.stringify(old));
    expect(report.games.added).toBe(1);
    expect((await storage.getGame('old-1'))?.white).toBe('A');
    // No schemaVersion at all is an old file too
    const { schemaVersion: _v, ...noVersion } = old;
    expect((await storage.restoreBackupJson(JSON.stringify(noVersion))).games.unchanged).toBe(1);
  });

  it('importBackupJson keeps its seven counts, now of the records written, and an export restores losslessly', async () => {
    await seed(storage, populated());
    const exported = await storage.exportBackupJson();

    const copy = await WizardChessStorage.create({ dbName: OTHER });
    try {
      const counts = await copy.importBackupJson(exported);
      expect(Object.keys(counts).sort()).toEqual([
        'endgameProgressImported',
        'gamesImported',
        'puzzlesImported',
        'repertoiresImported',
        'reviewsImported',
        'settingsImported',
        'srsCardsImported',
      ]);
      expect(counts).toEqual({
        gamesImported: 2,
        settingsImported: 2,
        puzzlesImported: 1,
        srsCardsImported: 1,
        repertoiresImported: 0,
        endgameProgressImported: 0,
        reviewsImported: 1,
      });
      expect(await snapshot(copy)).toEqual(await snapshot(storage));
      // Written, not "in the file": the same file again writes the progress records 0 times
      const again = await copy.importBackupJson(exported);
      expect(again.gamesImported + again.puzzlesImported + again.srsCardsImported + again.reviewsImported).toBe(0);
    } finally {
      copy.close();
    }
  });
});

describe('the backup check', () => {
  const good = (over: Record<string, unknown> = {}) => ({ ...payload({}), ...over });

  it('counts what a file holds and finds the preferences and bot rows without reading them', () => {
    const check = checkBackup(
      good({
        games: [game('a'), game('b')],
        settings: [setting('app.preferences', {}), setting('bots.book.me', 'x'), setting('other', 1)],
        puzzles: [puzzle('p')],
      }),
      LATEST_SCHEMA_VERSION,
    );
    expect(check.refusal).toBeNull();
    expect(check.counts).toMatchObject({ games: 2, settings: 3, puzzles: 1, reviews: 0 });
    expect(check.hasPreferencesRow).toBe(true);
    expect(check.hasBotRows).toBe(true);
    expect(check.damagedTotal).toBe(0);
  });

  it('counts the problems under the rule that found them', () => {
    const check = checkBackup(
      good({
        games: [game('a'), game('a'), null, { white: 'no id' }, game('', {}), game('c', { updatedAt: '1' as never })],
        puzzles: 'not a list',
        srsCards: [card('p', { lastReviewDate: 'x' as never })],
        reviews: [{ id: 'r', updatedAt: null }],
      }),
      LATEST_SCHEMA_VERSION,
    );
    expect(check.damaged).toEqual({
      'field-type': 1,
      'record-not-object': 1,
      'record-key': 2,
      'stamp-type': 2,
      'duplicate-key': 1,
    });
    expect(check.damagedTotal).toBe(7);
  });

  it('refuses what is not a backup and what is from a newer version, before looking at records', () => {
    expect(checkBackup(null, 4).refusal).toBe('not-a-backup');
    expect(checkBackup({ format: 'other' }, 4).refusal).toBe('not-a-backup');
    expect(checkBackup(good({ schemaVersion: 5 }), 4).refusal).toBe('newer-schema');
    expect(checkBackup(good({ schemaVersion: 'x' }), 4).refusal).toBe('not-a-backup');
    expect(checkBackup(good({ schemaVersion: undefined }), 4).refusal).toBeNull();
    expect(checkBackup(good({ schemaVersion: 1 }), 4).refusal).toBeNull();
  });
});

describe('the restore code uses no network', () => {
  it('has no fetch, XMLHttpRequest, WebSocket or sendBeacon', () => {
    for (const name of ['backup-merge', 'backup-validate', 'backup-restore']) {
      const text = fs.readFileSync(`src/storage/${name}.ts`, 'utf8');
      expect(text, name).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
    }
    expect(fs.readFileSync('src/ui/restore-text.ts', 'utf8')).not.toMatch(/\bfetch\s*\(/);
  });
});
