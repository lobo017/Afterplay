import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { WizardChessStorage, deleteWizardChessDB, type StoredGameRecord } from '../../src/storage/db';
import { loadPuzzleFile, syncHistoryPuzzles } from '../../src/trainers/history-puzzle-file';
import { FIRST_BATCH, localDay, type HistoryPuzzleEntry } from '../../src/trainers/history-puzzles';
import { PuzzleStore, cardId } from '../../src/trainers/puzzle-store';
import { puzzlesUrl } from '../../src/preset/start-path';

// Every game, name and id here is invented.
const DB = 'history-puzzles-store-test';
const SLUG = 'ada-sample';
const AT = (day: number, hour = 9) => new Date(2026, 10, day, hour, 30).getTime(); // November `day`, local time
const ME = [{ site: 'chesscom' as const, username: 'ada' }];

const TEMPLATES = [
  {
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3',
    moves: ['g8f6', 'h5f7'] as [string, string],
    bestLineSan: ['Qxf7#'],
    playedSan: 'Nxe4',
    class: 'Blunder' as const,
    mateIn: 1,
    loss: 61.4,
    ply: 21,
  },
  {
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2',
    moves: ['g2g4', 'd8h4'] as [string, string],
    bestLineSan: ['Qh4#'],
    playedSan: 'Nc6',
    class: 'Blunder' as const,
    mateIn: 1,
    loss: 55,
    ply: 22,
  },
  {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves: ['e2e4', 'e7e5'] as [string, string],
    bestLineSan: ['e5'],
    playedSan: 'a6',
    class: 'Mistake' as const,
    mateIn: null,
    loss: 12.34,
    ply: 24,
  },
];

/** `n` puzzles, one per game g1..gn (game gK was played K days after 2026-01-01, so a higher K is newer). */
function entries(n: number): HistoryPuzzleEntry[] {
  return Array.from({ length: n }, (_, i) => ({ id: `chesscom:g${i + 1}`, ...TEMPLATES[i % 3]! }));
}

/** The library's games for those puzzles: dates by number, and names that must never reach a puzzle. */
function games(n: number): StoredGameRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(Date.UTC(2026, 0, 1 + i + 1));
    const p = (x: number) => String(x).padStart(2, '0');
    return {
      id: `chesscom:g${i + 1}`,
      white: i % 2 === 0 ? 'ada' : 'Opponent Ann',
      black: i % 2 === 0 ? 'Opponent Ben' : 'ada',
      playerColor: i % 2 === 0 ? 'w' : 'b',
      result: '1-0',
      date: `${day.getUTCFullYear()}.${p(day.getUTCMonth() + 1)}.${p(day.getUTCDate())}`,
      source: 'chesscom',
      pgn: '',
      openingEco: '',
      openingName: '',
      accuracy: null,
      tags: [],
      schemaVersion: 4,
      createdAt: 0,
      updatedAt: 0,
    } as StoredGameRecord;
  });
}

let storage: WizardChessStorage;
let store: PuzzleStore;
let library: StoredGameRecord[];
const getGame = async (id: string) => library.find((g) => g.id === id);

beforeEach(async () => {
  await deleteWizardChessDB(DB);
  storage = await WizardChessStorage.create({ dbName: DB });
  store = new PuzzleStore(storage);
  library = games(120);
});
afterEach(() => storage.close());

const FILE = { input: '0123456789ab' };

describe('loading the puzzle file into the store', () => {
  it('keeps the puzzles as one pending blob, newest source game first, and writes no puzzle yet', async () => {
    expect(await store.loadHistoryPuzzles({ ...FILE, entries: entries(120) }, SLUG, library, AT(17))).toBe(true);
    expect(await storage.listPuzzles()).toEqual([]);
    expect(await storage.listSrsCards()).toEqual([]);
    const state = await store.historyPuzzleState();
    expect(state).toEqual({
      version: 1,
      slug: SLUG,
      input: FILE.input,
      loadedDay: '2026-11-17',
      total: 120,
      released: 0,
      lastDay: '2026-11-17',
      lastDayCount: 0,
    });
    const blob = (await storage.getSetting<{ entries: HistoryPuzzleEntry[] }>('puzzles.fromHistory.pending'))!;
    expect(blob.entries).toHaveLength(120);
    expect(blob.entries[0]!.id).toBe('chesscom:g120');
    expect(blob.entries[119]!.id).toBe('chesscom:g1');
  });

  it('is a no-op the second time: a re-import never starts over, resets the count or adds a puzzle twice', async () => {
    await store.loadHistoryPuzzles({ ...FILE, entries: entries(120) }, SLUG, library, AT(17));
    expect(await store.releaseHistoryPuzzles(getGame, AT(17))).toBe(50);
    expect(await store.loadHistoryPuzzles({ ...FILE, entries: entries(120) }, SLUG, library, AT(17, 20))).toBe(false);
    expect(await store.loadHistoryPuzzles({ input: 'ffffffffffff', entries: entries(3) }, SLUG, library, AT(20))).toBe(
      false,
    );
    expect((await store.historyPuzzleState())!.released).toBe(50);
    expect(await store.releaseHistoryPuzzles(getGame, AT(17, 22))).toBe(0);
    expect(await storage.listPuzzles('personal')).toHaveLength(50);
    expect(await storage.listSrsCards('puzzle')).toHaveLength(50);
  });
});

describe('releasing puzzles', () => {
  beforeEach(async () => {
    await store.loadHistoryPuzzles({ ...FILE, entries: entries(120) }, SLUG, library, AT(17));
  });

  it('releases 50 on the first day (the newest games), 20 the next day, 20 more after days away, never more per day', async () => {
    const changes: number[] = [];
    store.onChange(() => changes.push(1));
    expect(await store.releaseHistoryPuzzles(getGame, AT(17))).toBe(50);
    expect(changes).toHaveLength(1);
    let ids = (await storage.listPuzzles('personal')).map((p) => p.sourceGameId!.replace('chesscom:g', '')).map(Number);
    expect(Math.min(...ids)).toBe(71);
    expect(Math.max(...ids)).toBe(120);

    // Opening again the same day, at any hour, releases nothing
    expect(await store.releaseHistoryPuzzles(getGame, AT(17, 23))).toBe(0);
    expect(changes).toHaveLength(1);

    expect(await store.releaseHistoryPuzzles(getGame, AT(18, 0))).toBe(20);
    expect(await store.releaseHistoryPuzzles(getGame, AT(18, 12))).toBe(0);
    ids = (await storage.listPuzzles('personal')).map((p) => Number(p.sourceGameId!.replace('chesscom:g', '')));
    expect(ids).toHaveLength(70);
    expect(Math.min(...ids)).toBe(51);

    // Away until the 23rd: five days are owed, but one day holds 20
    expect(await store.releaseHistoryPuzzles(getGame, AT(23))).toBe(20);
    expect(await store.releaseHistoryPuzzles(getGame, AT(23, 20))).toBe(0);
    expect(await store.releaseHistoryPuzzles(getGame, AT(24))).toBe(20);
    expect(await store.releaseHistoryPuzzles(getGame, AT(25))).toBe(10); // only 10 are left
    expect(await store.releaseHistoryPuzzles(getGame, AT(26))).toBe(0);
    expect(await storage.listPuzzles('personal')).toHaveLength(120);
    const blob = (await storage.getSetting<{ entries: unknown[] }>('puzzles.fromHistory.pending'))!;
    expect(blob.entries).toEqual([]);
    expect((await store.historyPuzzleState())!.released).toBe(120);
  });

  it('makes a normal personal puzzle and a new card for each, the same ones every time', async () => {
    await store.releaseHistoryPuzzles(getGame, AT(17));
    const puzzles = await storage.listPuzzles('personal');
    const cards = await storage.listSrsCards('puzzle');
    expect(puzzles).toHaveLength(50);
    expect(cards).toHaveLength(50);
    for (const p of puzzles) {
      expect(p.id).toBe(`personal:${p.sourceGameId}:${p.ply}`);
      expect(p.source).toBe('personal');
      expect(p.origin).toBe('history');
      expect(p.rating).toBe(0);
      expect(p.attempts).toBe(0);
      expect(p.solvedCount).toBe(0);
      expect(p.dueDate).toBe(AT(17));
      const card = await store.getCard(p.id);
      expect(card?.id).toBe(cardId(p.id));
      expect(card?.state).toBe('new');
      expect(card?.dueDate).toBe(AT(17));
    }
    // The Today card's number: the real count of unseen released puzzles
    const summary = await store.todaySummary(AT(17));
    expect(summary.newPersonal).toBe(50);
    expect(summary.totalPersonal).toBe(50);
    expect(summary.dueReviews).toEqual({ personal: 0, lichess: 0 });
    const queue = await store.dueQueue(AT(17));
    expect(queue.fresh).toHaveLength(50);
  });

  it('puts no opponent name, no PGN and no other game text in a puzzle or a card', async () => {
    await store.releaseHistoryPuzzles(getGame, AT(17));
    const everything = JSON.stringify([await storage.listPuzzles(), await storage.listSrsCards()]);
    expect(everything).not.toMatch(/Opponent|Ann|Ben/);
    const labels = (await storage.listPuzzles('personal')).map((p) => p.gameLabel);
    expect(labels.every((l) => /^as (White|Black) · 2026-\d\d-\d\d$/.test(l!))).toBe(true);
    // The color in the label is the color of the player whose move it was
    for (const p of await storage.listPuzzles('personal')) {
      expect(p.gameLabel!.startsWith(p.ply! % 2 === 1 ? 'as White' : 'as Black')).toBe(true);
    }
  });

  it('leaves a puzzle pending while its game is not in the library, and releases it once it is', async () => {
    library = library.filter((g) => g.id !== 'chesscom:g120' && g.id !== 'chesscom:g119');
    expect(await store.releaseHistoryPuzzles(getGame, AT(17))).toBe(50);
    expect(await storage.getPuzzle('personal:chesscom:g120:24')).toBeUndefined();
    // The two missing games were skipped, so the 50 came from further down
    expect(await storage.getPuzzle('personal:chesscom:g69:24')).toBeDefined();
    expect(await storage.getPuzzle('personal:chesscom:g68:21')).toBeUndefined();
    library = games(120);
    expect(await store.releaseHistoryPuzzles(getGame, AT(18))).toBe(20);
    const ids = (await storage.listPuzzles('personal')).map((p) => p.sourceGameId);
    expect(ids).toContain('chesscom:g120');
    expect(ids).toContain('chesscom:g119');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not add a puzzle that already exists, and does not count one a device review made', async () => {
    // The device's own review made the puzzle of game 120 (the newest) before it was released
    await storage.savePuzzle({
      id: 'personal:chesscom:g120:24',
      source: 'personal',
      fen: TEMPLATES[2]!.fen,
      moves: [...TEMPLATES[2]!.moves],
      rating: 0,
      themes: ['blunder'],
      sourceGameId: 'chesscom:g120',
      ply: 24,
      dueDate: AT(10),
      attempts: 3,
      solvedCount: 2,
      updatedAt: AT(10),
      reviewSavedAt: AT(10),
    });
    expect(await store.releaseHistoryPuzzles(getGame, AT(17))).toBe(50);
    const mine = (await storage.getPuzzle('personal:chesscom:g120:24'))!;
    expect(mine.attempts).toBe(3);
    expect(mine.origin).toBeUndefined();
    expect(await storage.listPuzzles('personal')).toHaveLength(51);
    expect(await storage.listSrsCards('puzzle')).toHaveLength(50);
    const blob = (await storage.getSetting<{ entries: HistoryPuzzleEntry[] }>('puzzles.fromHistory.pending'))!;
    expect(blob.entries.find((e) => e.id === 'chesscom:g120')).toBeUndefined();
  });

  it('after a stop between the puzzles and the state, counts the released ones once and adds none twice', async () => {
    expect(await store.releaseHistoryPuzzles(getGame, AT(17))).toBe(50);
    // Undo what the end of the run wrote: the blob and the state say nothing was released
    const state = (await store.historyPuzzleState())!;
    await storage.setSetting('puzzles.fromHistory.state', { ...state, released: 0, lastDayCount: 0 });
    await storage.setSetting('puzzles.fromHistory.pending', {
      version: 1,
      input: FILE.input,
      entries: entries(120).reverse(),
    });
    expect(await store.releaseHistoryPuzzles(getGame, AT(17, 10))).toBe(50);
    expect(await storage.listPuzzles('personal')).toHaveLength(50);
    expect(await storage.listSrsCards('puzzle')).toHaveLength(50);
    expect((await store.historyPuzzleState())!.released).toBe(50);
  });

  it('keeps its schedule through a backup and restore, and adds nothing twice', async () => {
    await store.releaseHistoryPuzzles(getGame, AT(17));
    const backup = await storage.exportBackupJson();
    expect(backup).toContain('puzzles.fromHistory.pending');
    expect(backup).not.toMatch(/Opponent|Ann|Ben/);
    storage.close();
    await deleteWizardChessDB(DB);
    storage = await WizardChessStorage.create({ dbName: DB });
    store = new PuzzleStore(storage);
    await storage.importBackupJson(backup);
    expect(await store.releaseHistoryPuzzles(getGame, AT(17, 15))).toBe(0);
    expect(await store.releaseHistoryPuzzles(getGame, AT(18))).toBe(20);
    expect(await storage.listPuzzles('personal')).toHaveLength(70);
  });
});

describe('syncing games leaves released puzzles alone', () => {
  const noReview = async () => undefined;

  it('does not delete a released puzzle for a game with no review on this device (syncAll, twice)', async () => {
    await store.loadHistoryPuzzles({ ...FILE, entries: entries(120) }, SLUG, library, AT(17));
    await store.releaseHistoryPuzzles(getGame, AT(17));
    const before = (await storage.listPuzzles('personal')).map((p) => p.id).sort();
    expect(await store.syncAll(library, noReview, ME, AT(17, 12))).toBe(0);
    expect(await store.syncAll(library, noReview, [], AT(17, 13))).toBe(0);
    expect((await storage.listPuzzles('personal')).map((p) => p.id).sort()).toEqual(before);
    expect(await storage.listSrsCards('puzzle')).toHaveLength(50);
    // The same when a game's review was dropped and the game is synced alone
    const one = library[119]!;
    await store.syncGame(one, undefined, ME, AT(17, 14));
    expect(await storage.getPuzzle('personal:chesscom:g120:24')).toBeDefined();
  });

  it('still deletes any other personal puzzle of a game with no review, as before', async () => {
    await storage.savePuzzle({
      id: 'personal:chesscom:g5:20',
      source: 'personal',
      fen: TEMPLATES[2]!.fen,
      moves: [...TEMPLATES[2]!.moves],
      rating: 0,
      themes: ['blunder'],
      sourceGameId: 'chesscom:g5',
      ply: 20,
      dueDate: 0,
      attempts: 0,
      solvedCount: 0,
      updatedAt: 0,
    });
    await storage.saveSrsCard({
      id: cardId('personal:chesscom:g5:20'),
      deck: 'puzzle',
      targetId: 'personal:chesscom:g5:20',
      state: 'new',
      stability: 0,
      difficulty: 0,
      reps: 0,
      lapses: 0,
      dueDate: 0,
      updatedAt: 0,
    });
    await store.syncAll(library, noReview, ME, AT(17));
    expect(await storage.getPuzzle('personal:chesscom:g5:20')).toBeUndefined();
    expect(await storage.getSrsCard(cardId('personal:chesscom:g5:20'))).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------------ the fetch

const goodText = () =>
  JSON.stringify({
    format: 'afterplay-mistake-puzzles',
    version: 1,
    input: FILE.input,
    count: 120,
    entries: entries(120).map((e) => ({ ...e, before: 70, after: 9, white: 'Opponent Ann' })),
  });
const reply =
  (body: string, init: ResponseInit = {}) =>
  async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('fetching the puzzle file', () => {
  it('asks for /start/<slug>/puzzles.json, once, and ignores a missing, HTML or broken answer', async () => {
    expect(puzzlesUrl(SLUG)).toBe('/start/ada-sample/puzzles.json');
    const urls: string[] = [];
    const fetchWith = (make: () => Promise<Response>) => async (url: string) => {
      urls.push(url);
      return make();
    };
    expect(
      await loadPuzzleFile({ slug: SLUG, fetchFile: fetchWith(async () => new Response('x', { status: 404 })) }),
    ).toEqual({
      kind: 'none',
    });
    expect(
      await loadPuzzleFile({
        slug: SLUG,
        fetchFile: fetchWith(
          async () => new Response('<!doctype html><p>Afterplay', { headers: { 'content-type': 'text/html' } }),
        ),
      }),
    ).toEqual({ kind: 'none' });
    expect(await loadPuzzleFile({ slug: SLUG, fetchFile: fetchWith(reply('{"format":"afterplay-mis')) })).toEqual({
      kind: 'none',
    });
    expect(
      await loadPuzzleFile({ slug: SLUG, fetchFile: fetchWith(async () => new Response('x', { status: 503 })) }),
    ).toEqual({
      kind: 'failed',
    });
    expect(
      await loadPuzzleFile({
        slug: SLUG,
        fetchFile: fetchWith(async () => {
          throw new TypeError('offline');
        }),
      }),
    ).toEqual({ kind: 'failed' });
    expect(urls).toEqual(Array(5).fill('/start/ada-sample/puzzles.json'));
    const ok = await loadPuzzleFile({ slug: SLUG, fetchFile: fetchWith(reply(goodText())) });
    expect(ok.kind).toBe('loaded');
    if (ok.kind === 'loaded') expect(JSON.stringify(ok.entries)).not.toMatch(/Opponent/);
  });

  it('loads the file and releases the first 50 in one visit, then asks for nothing again', async () => {
    const urls: string[] = [];
    const options = {
      slug: SLUG,
      store,
      listGames: async () => library,
      getGame,
      fetchFile: async (url: string) => {
        urls.push(url);
        return reply(goodText())();
      },
    };
    expect(await syncHistoryPuzzles({ ...options, now: () => AT(17) })).toBe(FIRST_BATCH);
    expect(urls).toHaveLength(1);
    expect(await syncHistoryPuzzles({ ...options, now: () => AT(17, 18) })).toBe(0);
    expect(await syncHistoryPuzzles({ ...options, now: () => AT(18) })).toBe(20);
    expect(urls).toHaveLength(1);
    expect(await storage.listPuzzles('personal')).toHaveLength(70);
  });

  it('a missing or broken file changes nothing: no puzzle, no card, and at most one more request a day', async () => {
    let calls = 0;
    const base = { slug: SLUG, store, listGames: async () => library, getGame };
    const missing = async () => {
      calls++;
      return new Response('nope', { status: 404 });
    };
    expect(await syncHistoryPuzzles({ ...base, fetchFile: missing, now: () => AT(17) })).toBe(0);
    expect(await syncHistoryPuzzles({ ...base, fetchFile: missing, now: () => AT(17, 20) })).toBe(0);
    expect(calls).toBe(1);
    expect(await syncHistoryPuzzles({ ...base, fetchFile: missing, now: () => AT(18) })).toBe(0);
    expect(calls).toBe(2);
    // A broken file counts as missing
    const broken = async () => {
      calls++;
      return reply(goodText().replace('"count":120', '"count":119'))();
    };
    expect(await syncHistoryPuzzles({ ...base, fetchFile: broken, now: () => AT(19) })).toBe(0);
    expect(calls).toBe(3);
    expect(await storage.listPuzzles()).toEqual([]);
    expect(await storage.listSrsCards()).toEqual([]);
    expect(await store.historyPuzzleState()).toBeUndefined();
    expect(await storage.getSetting('puzzles.fromHistory.pending')).toBeUndefined();
    // Once the file is there (a new build), the next day loads it
    expect(await syncHistoryPuzzles({ ...base, fetchFile: reply(goodText()), now: () => AT(20) })).toBe(50);
    expect(await store.historyPuzzleMissDay(SLUG)).toBe(localDay(AT(19)));
  });

  it('retries a failed request at the next start, the same day (offline is not "missing")', async () => {
    let calls = 0;
    const base = { slug: SLUG, store, listGames: async () => library, getGame, now: () => AT(17) };
    const offline = async (): Promise<Response> => {
      calls++;
      throw new TypeError('offline');
    };
    expect(await syncHistoryPuzzles({ ...base, fetchFile: offline })).toBe(0);
    expect(await syncHistoryPuzzles({ ...base, fetchFile: offline })).toBe(0);
    expect(calls).toBe(2);
    expect(await syncHistoryPuzzles({ ...base, fetchFile: reply(goodText()) })).toBe(50);
  });
});

// ------------------------------------------------------------------------------------- two pages at once

describe('two pages on the same profile', () => {
  let other: WizardChessStorage;
  let otherStore: PuzzleStore;

  beforeEach(async () => {
    // A second connection to the same database, as a second tab or a reloaded page has
    other = await WizardChessStorage.create({ dbName: DB });
    otherStore = new PuzzleStore(other);
  });
  afterEach(() => other.close());

  const consistent = async (released: number, day: string) => {
    const puzzles = await storage.listPuzzles('personal');
    const ids = puzzles.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await storage.listSrsCards('puzzle')).toHaveLength(released);
    expect(puzzles).toHaveLength(released);
    const state = (await store.historyPuzzleState())!;
    expect(state.released).toBe(released);
    expect(state.lastDay).toBe(day);
    const blob = (await storage.getSetting<{ entries: HistoryPuzzleEntry[] }>('puzzles.fromHistory.pending'))!;
    expect(blob.entries).toHaveLength(state.total - released);
    // What is pending and what was released never overlap
    const pending = new Set(blob.entries.map((e) => `personal:${e.id}:${e.ply}`));
    expect(ids.filter((id) => pending.has(id))).toEqual([]);
  };

  it('a release that finds the other page already released the day’s puzzles adds nothing and keeps the counts', async () => {
    await store.loadHistoryPuzzles({ ...FILE, entries: entries(120) }, SLUG, library, AT(17));
    let first = true;
    // While this page looks the games up, the other page does the whole day's release
    const lookup = async (id: string) => {
      if (first) {
        first = false;
        expect(await otherStore.releaseHistoryPuzzles(getGame, AT(17, 10))).toBe(50);
      }
      return getGame(id);
    };
    expect(await store.releaseHistoryPuzzles(lookup, AT(17, 10))).toBe(0);
    await consistent(50, '2026-11-17');
    expect((await store.historyPuzzleState())!.lastDayCount).toBe(50);
  });

  it('adds to the saved counts and never replaces them: the other page releases the next day’s 20 first', async () => {
    await store.loadHistoryPuzzles({ ...FILE, entries: entries(120) }, SLUG, library, AT(17));
    expect(await store.releaseHistoryPuzzles(getGame, AT(17))).toBe(50);
    let first = true;
    const lookup = async (id: string) => {
      if (first) {
        first = false;
        expect(await otherStore.releaseHistoryPuzzles(getGame, AT(18, 8))).toBe(20);
      }
      return getGame(id);
    };
    // This page read "50 released" before the other page released 20; writing 50 + 20 over 70 would be wrong either way
    expect(await store.releaseHistoryPuzzles(lookup, AT(18, 9))).toBe(0);
    await consistent(70, '2026-11-18');
    expect((await store.historyPuzzleState())!.lastDayCount).toBe(20);
  });

  /** A lock manager like the browser's: one holder of a name at a time, the others wait in order. */
  function mutex() {
    let tail: Promise<unknown> = Promise.resolve();
    return {
      request: <T>(_name: string, _o: { mode: 'exclusive' }, work: () => Promise<T>): Promise<T> => {
        const run = tail.then(work, work);
        tail = run.catch(() => undefined);
        return run;
      },
    };
  }

  it('two visits at the same moment release 50 on the first day, 20 more on the next, with no duplicate and consistent counts', async () => {
    const locks = mutex();
    const visit = (s: PuzzleStore, hour: number, day = 17) =>
      syncHistoryPuzzles({
        slug: SLUG,
        store: s,
        listGames: async () => library,
        getGame,
        fetchFile: reply(goodText()),
        now: () => AT(day, hour),
        locks,
      });
    const day1 = await Promise.all([visit(store, 9), visit(otherStore, 9), visit(store, 9), visit(otherStore, 9)]);
    expect(day1.reduce((a, b) => a + b, 0)).toBe(50);
    await consistent(50, '2026-11-17');

    const day2 = await Promise.all([visit(store, 8, 18), visit(otherStore, 8, 18), visit(store, 9, 18)]);
    expect(day2.reduce((a, b) => a + b, 0)).toBe(20);
    await consistent(70, '2026-11-18');
    expect((await store.historyPuzzleState())!.lastDayCount).toBe(20);
  });

  it('without a lock manager the load and release still end consistent when the visits do not overlap inside the store', async () => {
    const visit = (s: PuzzleStore, day = 17) =>
      syncHistoryPuzzles({
        slug: SLUG,
        store: s,
        listGames: async () => library,
        getGame,
        fetchFile: reply(goodText()),
        now: () => AT(day),
        locks: null,
      });
    expect(await visit(store)).toBe(50);
    expect(await visit(otherStore)).toBe(0);
    expect(await visit(otherStore, 18)).toBe(20);
    expect(await visit(store, 18)).toBe(0);
    await consistent(70, '2026-11-18');
  });
});
