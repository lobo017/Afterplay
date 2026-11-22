import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { BackupRefusedError, type RestoreList } from '../../src/storage/backup-restore';
import {
  BackupRestoreClient,
  RESTORE_WORKER_UNAVAILABLE_MESSAGE,
  type RestoreWorkerLike,
} from '../../src/storage/backup-restore-client';
import {
  runBackupRestoreRequest,
  type BackupRestoreRequest,
  type BackupRestoreResponse,
} from '../../src/storage/backup-restore-job';
import {
  LATEST_SCHEMA_VERSION,
  WizardChessStorage,
  deleteWizardChessDB,
  type BackupPayload,
  type StoredPuzzleRecord,
} from '../../src/storage/db';
import { restoreProgressText } from '../../src/ui/restore-text';

// Invented data only.
const DB = 'wizards-chess-backup-client-test';

let storage: WizardChessStorage;

beforeEach(async () => {
  await deleteWizardChessDB(DB);
  storage = await WizardChessStorage.create({ dbName: DB });
});

afterEach(async () => {
  storage.close();
  await deleteWizardChessDB(DB);
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

const backupFile = (parts: Partial<BackupPayload>): File =>
  new File(
    [
      JSON.stringify({
        format: 'wizards-chess-backup',
        schemaVersion: LATEST_SCHEMA_VERSION,
        exportedAt: 9000,
        games: [],
        settings: [],
        puzzles: [],
        ...parts,
      }),
    ],
    'backup.json',
  );

/** A stand-in for the Worker: runs the job as the worker file does, answering on a later turn like a real worker. */
const fakeWorker = (log: { terminated: number; requests: BackupRestoreRequest[] }): RestoreWorkerLike => {
  const listeners: Array<(e: MessageEvent<BackupRestoreResponse>) => void> = [];
  return {
    postMessage(message) {
      log.requests.push(message);
      void runBackupRestoreRequest(message, (response) =>
        setTimeout(
          () => listeners.forEach((listener) => listener({ data: response } as MessageEvent<BackupRestoreResponse>)),
          0,
        ),
      );
    },
    addEventListener(type: string, listener: unknown) {
      if (type === 'message') listeners.push(listener as (e: MessageEvent<BackupRestoreResponse>) => void);
    },
    terminate() {
      log.terminated++;
    },
  };
};

describe('the restore worker job', () => {
  const run = async (request: BackupRestoreRequest): Promise<BackupRestoreResponse[]> => {
    const out: BackupRestoreResponse[] = [];
    await runBackupRestoreRequest(request, (r) => out.push(r));
    return out;
  };

  it('inspects a file without writing anything', async () => {
    const out = await run({ id: 1, kind: 'inspect', file: backupFile({ puzzles: [puzzle('p1')] }) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1, kind: 'inspected', info: { games: 0, puzzles: 1, exportedAt: 9000 } });
    expect(await storage.getPuzzle('p1')).toBeUndefined();
  });

  it('answers a refusal with its kind and the words the dialog shows', async () => {
    const cases: Array<[string, File, string, string]> = [
      ['not json', new File(['nope'], 'a.json'), 'not-json', 'This file is not an Afterplay backup (not JSON).'],
      ['not a backup', new File(['{"a":1}'], 'a.json'), 'not-a-backup', 'This file is not an Afterplay backup.'],
      [
        'newer schema',
        backupFile({ schemaVersion: LATEST_SCHEMA_VERSION + 1 }),
        'newer-schema',
        'This backup was made by a newer version of Afterplay. Update the app, then try again.',
      ],
      ['damaged', backupFile({ puzzles: [puzzle('p1'), 7 as never] }), 'damaged', '1 record in this file is damaged.'],
    ];
    for (const [, file, refusal, message] of cases) {
      const out = await run({ id: 2, kind: 'inspect', file });
      expect(out).toEqual([{ id: 2, kind: 'error', refusal, message }]);
    }
  });

  it('restores in the named database, naming each list as it goes, and answers with the report only', async () => {
    const file = backupFile({ puzzles: [puzzle('p1', { attempts: 2, lastAttemptAt: 50 })] });
    const out = await run({ id: 3, kind: 'restore', file, dbName: DB });
    expect(out.map((r) => r.kind)).toEqual([
      'progress',
      'progress',
      'progress',
      'progress',
      'progress',
      'progress',
      'progress',
      'restored',
    ]);
    const lists = out.flatMap((r) => (r.kind === 'progress' ? [r.list] : []));
    expect(lists).toEqual(['settings', 'games', 'puzzles', 'srs_cards', 'repertoires', 'endgame_progress', 'reviews']);
    const restored = out.flatMap((r) => (r.kind === 'restored' ? [r.report] : []));
    expect(restored).toHaveLength(1);
    expect(restored[0]?.puzzles.added).toBe(1);
    expect((await storage.getPuzzle('p1'))?.attempts).toBe(2);
  });

  it('a refused restore changes nothing and says why', async () => {
    await storage.savePuzzle(puzzle('keep', { attempts: 5 }));
    const out = await run({
      id: 4,
      kind: 'restore',
      file: backupFile({ puzzles: [puzzle('keep', { attempts: 1 }), 7 as never] }),
      dbName: DB,
    });
    expect(out).toEqual([{ id: 4, kind: 'error', refusal: 'damaged', message: '1 record in this file is damaged.' }]);
    expect((await storage.getPuzzle('keep'))?.attempts).toBe(5);
  });

  it('a file that can no longer be read says so', async () => {
    const gone = { text: () => Promise.reject(new Error('gone')) } as unknown as Blob;
    const out = await run({ id: 5, kind: 'inspect', file: gone });
    expect(out).toEqual([{ id: 5, kind: 'error', message: 'The file could not be read. Choose it again.' }]);
  });
});

describe('the restore client', () => {
  it('inspects through a worker and ends the worker with the answer', async () => {
    const log = { terminated: 0, requests: [] as BackupRestoreRequest[] };
    const client = new BackupRestoreClient({ createWorker: () => fakeWorker(log) });
    const info = await client.inspect(backupFile({ puzzles: [puzzle('p1')] }));
    expect(info).toMatchObject({ puzzles: 1, hasBots: false });
    expect(log.terminated).toBe(1);
    expect(log.requests.map((r) => r.kind)).toEqual(['inspect']);
  });

  it('rejects with the refusal as a BackupRefusedError', async () => {
    const log = { terminated: 0, requests: [] as BackupRestoreRequest[] };
    const client = new BackupRestoreClient({ createWorker: () => fakeWorker(log) });
    const err = await client.inspect(new File(['nope'], 'a.json')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupRefusedError);
    expect((err as BackupRefusedError).kind).toBe('not-json');
    expect((err as Error).message).toBe('This file is not an Afterplay backup (not JSON).');
    expect(log.terminated).toBe(1);
  });

  it('restores, passes the progress on in order, and resolves with the report', async () => {
    const log = { terminated: 0, requests: [] as BackupRestoreRequest[] };
    const client = new BackupRestoreClient({ dbName: DB, createWorker: () => fakeWorker(log) });
    const seen: RestoreList[] = [];
    const report = await client.restore(backupFile({ puzzles: [puzzle('p1')] }), (list) => seen.push(list));
    expect(seen[0]).toBe('settings');
    expect(seen).toContain('puzzles');
    expect(report.puzzles.added).toBe(1);
    expect(log.requests[0]).toMatchObject({ kind: 'restore', dbName: DB });
    expect(log.terminated).toBe(1);
    expect((await storage.getPuzzle('p1'))?.id).toBe('p1');
  });

  it('has no fallback: with no worker the request fails and nothing is read or changed', async () => {
    expect(typeof Worker).toBe('undefined');
    await storage.savePuzzle(puzzle('keep', { attempts: 5 }));
    const client = new BackupRestoreClient({ dbName: DB });
    const file = backupFile({ puzzles: [puzzle('keep', { attempts: 1 })] });
    await expect(client.inspect(file)).rejects.toThrow(RESTORE_WORKER_UNAVAILABLE_MESSAGE);
    await expect(client.restore(file)).rejects.toThrow(RESTORE_WORKER_UNAVAILABLE_MESSAGE);
    expect((await storage.getPuzzle('keep'))?.attempts).toBe(5);
  });

  it('a worker that fails to load fails the request and is ended', async () => {
    let terminated = 0;
    let fail: (e: { message?: string }) => void = () => undefined;
    const client = new BackupRestoreClient({
      createWorker: () => ({
        postMessage: () => undefined,
        addEventListener(type: string, listener: unknown) {
          if (type === 'error') fail = listener as typeof fail;
        },
        terminate: () => void terminated++,
      }),
    });
    const pending = client.inspect(backupFile({}));
    fail({ message: 'x' });
    await expect(pending).rejects.toThrow(RESTORE_WORKER_UNAVAILABLE_MESSAGE);
    expect(terminated).toBe(1);
  });

  it('the failure line names what happened and says nothing was changed', async () => {
    const { restoreFailedText } = await import('../../src/ui/restore-text');
    expect(restoreFailedText(new Error(RESTORE_WORKER_UNAVAILABLE_MESSAGE))).toBe(
      'The restore failed: the browser would not start its background worker, so the backup could not be read. Nothing was changed.',
    );
  });
});

describe('the status line while a restore runs', () => {
  it('names every list', () => {
    const lists: RestoreList[] = [
      'settings',
      'games',
      'puzzles',
      'srs_cards',
      'repertoires',
      'endgame_progress',
      'reviews',
    ];
    expect(lists.map(restoreProgressText)).toEqual([
      'Restoring settings…',
      'Restoring games…',
      'Restoring puzzles…',
      'Restoring puzzle schedule…',
      'Restoring repertoires…',
      'Restoring endgame progress…',
      'Restoring reviews…',
    ]);
  });
});

describe('nothing of Restore runs on the page or at start-up', () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', file), 'utf8');

  it('the page starts the restore worker only through the client, and only when a file is chosen', () => {
    // app.ts holds the client (a worker is created inside a request) and never names the worker file
    expect(read('app.ts')).not.toMatch(/backup-restore\.worker/);
    const client = read('storage/backup-restore-client.ts');
    expect(client.match(/new Worker\(/g)).toHaveLength(1);
    // (created in `request`, i.e. per call; not in the constructor)
    expect(client).not.toMatch(/constructor\([^)]*\)\s*\{[^}]*new Worker/);
  });

  it('the Restore dialog never reads or parses a chosen file itself', () => {
    const section = read('ui/settings-data-section.ts');
    expect(section).not.toMatch(/file\.text\(\)/);
    expect(section).not.toMatch(/restoreBackupJson|importBackupJson/);
    // the one JSON.parse left in the file is `summarizeBackup`/`backupPreferences`, for the download and the tests
    expect(section.match(/JSON\.parse/g)?.length).toBe(2);
  });

  it('the client has no main-thread fallback: it imports the job as types only', () => {
    const client = read('storage/backup-restore-client.ts');
    expect(client).toMatch(
      /import type \{ BackupRestoreRequest, BackupRestoreResponse \} from '\.\/backup-restore-job'/,
    );
    expect(client).not.toMatch(/runBackupRestoreRequest/);
    expect(client).not.toMatch(/restoreBackup\(/);
  });

  it('the worker files make no network request', () => {
    for (const file of [
      'storage/backup-restore.worker.ts',
      'storage/backup-restore-job.ts',
      'storage/backup-restore-client.ts',
    ]) {
      expect(read(file)).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
    }
  });
});
