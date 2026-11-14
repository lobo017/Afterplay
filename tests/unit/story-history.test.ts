import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { GameLibrary } from '../../src/library/library';
import { loadHistoryFile, type HistoryGame } from '../../src/preset/first-run';
import {
  HISTORY_BATCH_SIZE,
  STORY_IMPORT_SETTING,
  parseImportRecord,
  readImportRecord,
  storeHistory,
  type HistoryStore,
} from '../../src/story/history-loader';
import { STORY_LANDING_KEY, landingScreen, readLanding, writeLanding } from '../../src/story/landing';
import { WizardChessStorage, deleteWizardChessDB } from '../../src/storage/db';
import { game, run } from './helpers/story-games';

const asHistory = (records: ReturnType<typeof run>): HistoryGame[] => records as unknown as HistoryGame[];

const response = (status: number, body: string, type = 'application/json'): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? type : null) },
    text: async () => body,
  }) as unknown as Response;

const backup = (games: unknown[], settings: unknown[] = []) =>
  JSON.stringify({ format: 'wizards-chess-backup', schemaVersion: 4, exportedAt: 0, games, settings });

describe('the landing value', () => {
  const store = (initial?: string) => {
    const data = new Map<string, string>(initial === undefined ? [] : [[STORY_LANDING_KEY, initial]]);
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };

  it('is wc.story.v1', () => {
    expect(STORY_LANDING_KEY).toBe('wc.story.v1');
  });

  it.each([
    [undefined, 'new', 'form'],
    ['new', 'new', 'form'],
    ['importing', 'importing', 'story'],
    ['ready', 'ready', 'story'],
    ['skipped', 'skipped', 'play'],
    ['seen', 'seen', 'play'],
    ['nonsense', 'new', 'form'],
  ] as const)('%s reads as %s and opens %s', (stored, value, screen) => {
    const v = readLanding(store(stored));
    expect(v).toBe(value);
    expect(landingScreen(v)).toBe(screen);
  });

  it('writes the value, and reports a blocked storage', () => {
    const s = store();
    expect(writeLanding('seen', s)).toBe(true);
    expect(s.data.get(STORY_LANDING_KEY)).toBe('seen');
    expect(
      writeLanding('seen', {
        getItem: () => null,
        setItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe(false);
    expect(readLanding(null)).toBe('new');
  });
});

describe('the history file', () => {
  const load = (res: Response | Error) =>
    loadHistoryFile({
      slug: 'sample',
      fetchFile: async () => {
        if (res instanceof Error) throw res;
        return res;
      },
    });

  it('asks for history.json beside the link, once, from the same origin', async () => {
    const urls: string[] = [];
    await loadHistoryFile({
      slug: 'sample',
      fetchFile: async (url) => {
        urls.push(url);
        return response(404, '');
      },
    });
    expect(urls).toEqual(['/start/sample/history.json']);
  });

  it('reads the games and the sync month record, and nothing else of the file', async () => {
    const month = { version: 1, player: 'storytester', months: { '2026-01': { at: 1, games: 2 } } };
    const result = await load(
      response(
        200,
        backup(
          [...run(2, 'h'), { id: '', pgn: 'x' }, { pgn: 'no id' }, 'junk'],
          [
            { key: 'sync.chesscom', value: month, updatedAt: 0 },
            { key: 'library.myAccounts', value: { chesscom: 'someone', lichess: '' }, updatedAt: 0 },
            { key: 'decoy.setting', value: {}, updatedAt: 0 },
          ],
        ),
      ),
    );
    expect(result.kind).toBe('loaded');
    if (result.kind !== 'loaded') return;
    expect(result.games.map((g) => g.id)).toEqual(['chesscom:h0', 'chesscom:h1']);
    expect(result.ignored).toBe(3);
    expect(result.monthRecord).toEqual({ key: 'sync.chesscom', value: month });
  });

  it('is "none" for a 404, for a page answered in its place, and for a file that is not a restore file', async () => {
    expect((await load(response(404, 'no'))).kind).toBe('none');
    expect((await load(response(200, '<!doctype html><title>app</title>', 'text/html'))).kind).toBe('none');
    expect((await load(response(200, '{"hello":1}'))).kind).toBe('none');
  });

  it('is "failed" (paused, with Continue) when the request or the reading stops', async () => {
    expect((await load(new TypeError('network'))).kind).toBe('failed');
    expect((await load(response(503, 'busy'))).kind).toBe('failed');
    expect((await load(response(200, '{"format": "wizards-chess-backup", "games": [{"id"'))).kind).toBe('failed');
  });
});

/** A library-shaped store in memory: games by id, settings by key; ids already there are never overwritten. */
function memoryStore(failOnBatch = -1) {
  const games = new Map<string, string>();
  const settings = new Map<string, unknown>();
  let batches = 0;
  const batchSizes: number[] = [];
  const store: HistoryStore = {
    listIds: async () => [...games.keys()],
    saveSyncedGames: async (records) => {
      if (batches++ === failOnBatch) throw new Error('storage full');
      batchSizes.push(records.length);
      const saved: string[] = [];
      for (const r of records) {
        if (games.has(r.id)) continue;
        games.set(r.id, r.pgn);
        saved.push(r.id);
      }
      return saved;
    },
    readSetting: async <T>(key: string) => settings.get(key) as T | undefined,
    writeSetting: async (key, value) => void settings.set(key, value),
  };
  return { store, games, settings, batchSizes };
}

describe('storing a history', () => {
  const month = { key: 'sync.chesscom', value: { version: 1, player: 'storytester', months: {} } };

  it('stores in batches of 200 and reports progress "n of total"', async () => {
    const m = memoryStore();
    const progress: Array<[number, number]> = [];
    const { state, added } = await storeHistory({
      slug: 'sample',
      games: asHistory(run(450, 'b')),
      monthRecord: month,
      store: m.store,
      onProgress: (l, t) => progress.push([l, t]),
    });
    expect(HISTORY_BATCH_SIZE).toBe(200);
    expect(m.batchSizes).toEqual([200, 200, 50]);
    expect(progress).toEqual([
      [0, 450],
      [200, 450],
      [400, 450],
      [450, 450],
    ]);
    expect(added).toBe(450);
    expect(state).toMatchObject({ status: 'done', loaded: 450, total: 450, slug: 'sample' });
    expect(m.settings.get('sync.chesscom')).toEqual(month.value);
    expect(m.settings.get(STORY_IMPORT_SETTING)).toMatchObject({ file: { status: 'done' } });
  });

  it('keeps a month record the device already has', async () => {
    const m = memoryStore();
    const mine = { version: 1, player: 'storytester', months: { '2026-02': { at: 9, games: 4 } } };
    m.settings.set('sync.chesscom', mine);
    await storeHistory({ slug: 'sample', games: asHistory(run(3, 'k')), monthRecord: month, store: m.store });
    expect(m.settings.get('sync.chesscom')).toBe(mine);
  });

  it('stops part-way as "partial" with the month record unwritten; resuming skips what is stored', async () => {
    const m = memoryStore(1); // the second batch fails
    const games = asHistory(run(450, 'r'));
    const first = await storeHistory({ slug: 'sample', games, monthRecord: month, store: m.store });
    expect(first.state.status).toBe('partial');
    expect(first.state.failure).toContain('storage full');
    expect(m.games.size).toBe(200);
    // The month record waits: a half-loaded file must not make the first sync skip months whose games are missing
    expect(m.settings.has('sync.chesscom')).toBe(false);
    expect(await readImportRecord(m.store)).toMatchObject({ file: { status: 'partial', loaded: 200, total: 450 } });

    const before = new Map(m.games);
    m.batchSizes.length = 0;
    const second = await storeHistory({ slug: 'sample', games, monthRecord: month, store: m.store });
    expect(second.state.status).toBe('done');
    expect(second.added).toBe(250);
    expect(m.batchSizes).toEqual([200, 50]);
    expect(m.games.size).toBe(450);
    for (const [id, pgn] of before) expect(m.games.get(id)).toBe(pgn);
    expect(m.settings.get('sync.chesscom')).toEqual(month.value);
  });

  it('never overwrites a stored game', async () => {
    const m = memoryStore();
    m.games.set('chesscom:o0', 'MY OWN COPY');
    await storeHistory({ slug: 'sample', games: asHistory(run(3, 'o')), monthRecord: null, store: m.store });
    expect(m.games.get('chesscom:o0')).toBe('MY OWN COPY');
    expect(m.games.size).toBe(3);
  });

  it('counts a "running" record found at start-up as partial, and flags it as interrupted', () => {
    const running = parseImportRecord({ version: 1, file: { status: 'running', loaded: 5, total: 9, slug: 's' } });
    expect(running.file).toMatchObject({ status: 'partial', loaded: 5, total: 9, slug: 's', interrupted: true });
    const partial = parseImportRecord({ version: 1, file: { status: 'partial', failure: 'offline' } });
    expect(partial.file.interrupted).toBeUndefined();
    expect(parseImportRecord(undefined).file.status).toBe('never');
    expect(parseImportRecord({ file: { status: 'done', loaded: -4, total: 'x' } }).file).toMatchObject({
      status: 'done',
      loaded: 0,
      total: 0,
    });
  });
});

describe('the library takes a history without touching stored games', () => {
  const DB = 'wizards-chess-story-history-test';
  beforeEach(async () => {
    await deleteWizardChessDB(DB);
  });
  afterEach(async () => {
    await deleteWizardChessDB(DB);
  });

  it('adds new games, leaves a stored game and its review summary as they are, and keeps the month record', async () => {
    const storage = await WizardChessStorage.create({ dbName: DB });
    const library = new GameLibrary(storage);
    await library.init();
    const mine = game({ id: 'x0', myElo: 1234 });
    await storage.saveGame({
      ...mine,
      analysis: { preset: 'quick', savedAt: 1, whiteAccuracy: 90, blackAccuracy: 80 },
    });
    await library.writeSetting('sync.chesscom', {
      version: 1,
      player: 'storytester',
      months: { '2026-05': { at: 1, games: 1 } },
    });

    const file = [game({ id: 'x0', myElo: 999 }), ...run(2, 'x1')] as unknown as HistoryGame[];
    const { state } = await storeHistory({
      slug: 'sample',
      games: file,
      monthRecord: { key: 'sync.chesscom', value: { version: 1, player: 'other', months: {} } },
      store: library,
    });
    expect(state.status).toBe('done');
    expect((await library.listIds()).sort()).toEqual(['chesscom:x0', 'chesscom:x10', 'chesscom:x11']);
    const kept = await library.get('chesscom:x0');
    expect(kept?.whiteElo).toBe(1234);
    expect(kept?.analysis?.whiteAccuracy).toBe(90);
    expect(await library.readSetting<{ player: string }>('sync.chesscom')).toMatchObject({ player: 'storytester' });
    storage.close();
  });
});
