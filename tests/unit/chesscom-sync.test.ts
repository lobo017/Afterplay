import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { CHESSCOM_HISTORY_METHOD } from '../../extension/src/backfill';
import { checkPgnText, importProblemOf } from '../../src/capture/pgn-games';
import { buildGameRecord } from '../../src/library/game-record';
import { GameLibrary } from '../../src/library/library';
import type { SavedReview } from '../../src/library/saved-review';
import { LATEST_SCHEMA_VERSION, WizardChessStorage, deleteWizardChessDB } from '../../src/storage/db';
import type { StoredGameRecord } from '../../src/storage/db';
import {
  CHESSCOM_API_ROOT,
  CHESSCOM_SYNC_METHOD,
  archiveMonthUrl,
  archivesListUrl,
  gameKeyFromPgnHeaders,
  isChessComUsername,
  isMonthFinal,
  monthOfArchiveUrl,
  monthsFromList,
} from '../../src/sync/chesscom-archive';
import {
  SYNC_AUTO_REVIEW_MAX_GAMES,
  SYNC_RATE_LIMIT_WAIT_MS,
  SYNC_REQUEST_GAP_MS,
  SYNC_REVIEWS_NOT_QUEUED_LINE,
  SYNC_STATE_SETTING,
  describeSyncResult,
  librarySyncStore,
  parseSyncState,
  reviewsNotQueuedLine,
  runChessComSync,
  type SyncDeps,
  type SyncFetch,
  type SyncState,
} from '../../src/sync/chesscom-sync';
import { syncProgressText } from '../../src/ui/settings-data-section';
import {
  API_ROOT,
  HISTORY_METHOD,
  buildRestorePayload,
  collectGames,
  type ArchiveGame,
} from '../../hpc/history/lib/history.mjs';

// An invented player and invented games: nothing here is anyone's real name or history.
const PLAYER = 'Sync_Tester7';
const DB = 'wizards-chess-chesscom-sync-test';
const LIST = archivesListUrl(PLAYER);
/** The device's clock in these tests: 11 November 2026, noon UTC. August to October are over; November is not. */
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

const SCHOLARS_MATE = '1. e4 {[%clk 0:09:58]} 1... e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#';
const FOOLS_MATE = '1. f3 e5 2. g4 Qh4#';
const pad = (n: number) => String(n).padStart(2, '0');

interface Spec {
  id: number;
  type?: 'live' | 'daily';
  white: string;
  black: string;
  result: '1-0' | '0-1' | '1/2-1/2';
  date: [number, number, number];
  /** null: the archive entry has no PGN; '': a PGN with no moves. */
  moves: string | null;
  variant?: string;
}

function archiveGame(s: Spec): ArchiveGame {
  const [y, m, d] = s.date;
  const date = `${y}.${pad(m)}.${pad(d)}`;
  const link = `https://www.chess.com/game/${s.type ?? 'live'}/${s.id}`;
  const tags = [
    ['Event', 'Live Chess'],
    ['Site', 'Chess.com'],
    ['Date', date],
    ['Round', '-'],
    ['White', s.white],
    ['Black', s.black],
    ['Result', s.result],
    ...(s.variant ? [['Variant', s.variant]] : []),
    ['UTCDate', date],
    ['UTCTime', '18:02:11'],
    ['WhiteElo', '812'],
    ['BlackElo', '799'],
    ['TimeControl', s.type === 'daily' ? '1/86400' : '600'],
    ['EndDate', date],
    ['EndTime', '18:05:40'],
    ['Link', link],
  ];
  const game: ArchiveGame = {
    url: link,
    uuid: `00000000-0000-0000-0000-${String(s.id).padStart(12, '0')}`,
    end_time: Date.UTC(y, m - 1, d, 18, 5, 40) / 1000,
    rated: true,
    time_class: s.type === 'daily' ? 'daily' : 'rapid',
    time_control: s.type === 'daily' ? '1/86400' : '600',
    rules: s.variant ? 'kingofthehill' : 'chess',
    white: { username: s.white, rating: 812, result: s.result === '1-0' ? 'win' : 'resigned' },
    black: { username: s.black, rating: 799, result: s.result === '0-1' ? 'win' : 'resigned' },
  };
  if (s.moves !== null) {
    game.pgn = `${tags.map(([k, v]) => `[${k} "${v}"]`).join('\n')}\n\n${s.moves} ${s.result}\n`;
  }
  return game;
}

const G = {
  whiteWin: archiveGame({
    id: 2001,
    white: PLAYER,
    black: 'opp_alpha',
    result: '1-0',
    date: [2026, 8, 3],
    moves: SCHOLARS_MATE,
  }),
  blackWin: archiveGame({
    id: 2002,
    white: 'opp_alpha',
    black: PLAYER,
    result: '0-1',
    date: [2026, 8, 20],
    moves: FOOLS_MATE,
  }),
  daily: archiveGame({
    id: 777,
    type: 'daily',
    white: PLAYER,
    black: 'OppBeta',
    result: '1-0',
    date: [2026, 9, 2],
    moves: '1. d4 d5 2. c4',
  }),
  variant: archiveGame({
    id: 2004,
    white: PLAYER,
    black: 'opp-gamma',
    result: '1-0',
    date: [2026, 9, 5],
    moves: '1. e4 e5 2. Ke2 Nc6',
    variant: 'King of the Hill',
  }),
  noPgn: archiveGame({ id: 2005, white: PLAYER, black: 'OppDelta', result: '1-0', date: [2026, 9, 9], moves: null }),
  illegal: archiveGame({
    id: 2006,
    white: 'OppDelta',
    black: PLAYER,
    result: '1/2-1/2',
    date: [2026, 9, 12],
    moves: '1. e4 e5 2. Ke3',
  }),
  october: archiveGame({
    id: 2007,
    white: 'OppBeta',
    black: PLAYER,
    result: '1-0',
    date: [2026, 10, 4],
    moves: SCHOLARS_MATE,
  }),
  noMoves: archiveGame({ id: 2008, white: PLAYER, black: 'OppBeta', result: '1-0', date: [2026, 10, 6], moves: '' }),
  november: archiveGame({
    id: 2009,
    white: PLAYER,
    black: 'opp_alpha',
    result: '0-1',
    date: [2026, 11, 8],
    moves: '1. e4 e5 2. Nf3 Nc6',
  }),
};

/** Four months: every kind of entry once, and one game listed in two months. */
const MONTHS: Record<string, unknown[]> = {
  '2026-08': [G.whiteWin, G.blackWin],
  '2026-09': [G.daily, G.variant, G.noPgn, G.illegal, null],
  '2026-10': [G.october, G.blackWin, G.noMoves],
  '2026-11': [G.november],
};
const GOOD_IDS = [
  'chesscom:daily-777',
  'chesscom:live-2001',
  'chesscom:live-2002',
  'chesscom:live-2007',
  'chesscom:live-2009',
];

type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error;

function fakeApi(months: Record<string, unknown[]>, player = PLAYER) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  /** Answers given once, in order, before the usual one. */
  const once = new Map<string, Reply[]>();
  const answer = (reply: Exclude<Reply, Error>) => ({
    status: reply.status,
    headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null },
    text: async () => reply.text ?? JSON.stringify(reply.body ?? {}),
  });
  const fetchImpl: SyncFetch = async (url, init) => {
    calls.push({ url, init });
    const queued = once.get(url)?.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return answer(queued);
    if (url === archivesListUrl(player)) {
      return answer({ status: 200, body: { archives: Object.keys(months).map((m) => archiveMonthUrl(player, m)) } });
    }
    for (const [month, games] of Object.entries(months)) {
      if (url === archiveMonthUrl(player, month)) return answer({ status: 200, body: { games } });
    }
    return answer({ status: 404, body: { message: 'not found' } });
  };
  return {
    calls,
    fetchImpl,
    urls: () => calls.map((c) => c.url),
    queue: (url: string, ...replies: Reply[]) => once.set(url, [...(once.get(url) ?? []), ...replies]),
    forget: () => calls.splice(0, calls.length),
  };
}

const month = (m: string) => archiveMonthUrl(PLAYER, m);
/** What a browser's fetch throws when it cannot reach the host; its message names the address, as real ones can. */
const networkError = () => new TypeError(`Failed to fetch ${LIST}`);

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

interface Env {
  api: ReturnType<typeof fakeApi>;
  sleeps: number[];
  /** The review queue as the app would see it: ids waiting, oldest first. */
  queue: string[];
  now: number;
  auto: boolean;
}

function env(months: Record<string, unknown[]> = MONTHS): Env {
  return { api: fakeApi(months), sleeps: [], queue: [], now: NOW, auto: false };
}

function sync(e: Env, extra: Partial<SyncDeps> = {}) {
  return runChessComSync({
    username: PLAYER,
    fetchImpl: e.api.fetchImpl,
    sleep: async (ms) => {
      e.sleeps.push(ms);
    },
    now: () => e.now,
    store: librarySyncStore(library),
    isAutoAnalyzeOn: () => e.auto,
    queueReviews: (ids) => {
      e.queue.push(...ids);
    },
    ...extra,
  });
}

const storedIds = async () => (await storage.listGameIds()).sort();
const state = async () => (await storage.getSetting<SyncState>(SYNC_STATE_SETTING))!;
const withoutTimes = (g: StoredGameRecord) => {
  const { createdAt: _c, updatedAt: _u, ...rest } = g;
  return rest;
};
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

describe('Chess.com sync: the archive list', () => {
  it('reads this player’s months and nothing else, oldest first, each once', () => {
    const parsed = monthsFromList(
      {
        archives: [
          month('2026-10'),
          month('2026-08'),
          `${CHESSCOM_API_ROOT}/SYNC_TESTER7/games/2026/09`,
          month('2026-08'),
          `${CHESSCOM_API_ROOT}/someone_else/games/2026/07`,
          'https://example.com/pub/player/sync_tester7/games/2026/07',
          `${CHESSCOM_API_ROOT}/sync_tester7/games/2026/13`,
          `${CHESSCOM_API_ROOT}/sync_tester7/games/2026/07/extra`,
          42,
        ],
      },
      PLAYER,
    );
    expect(parsed).toEqual({ months: ['2026-08', '2026-09', '2026-10'], ignored: 6 });
    expect(monthsFromList({ archives: [] }, PLAYER)).toEqual({ months: [], ignored: 0 });
    for (const notAList of [null, 'text', 42, {}, { archives: 'none' }, { games: [] }]) {
      expect(monthsFromList(notAList, PLAYER)).toBeNull();
    }
    expect(monthOfArchiveUrl(month('2026-11'), PLAYER)).toBe('2026-11');
    expect(month('2026-03')).toBe('https://api.chess.com/pub/player/sync_tester7/games/2026/03');
    expect(LIST).toBe('https://api.chess.com/pub/player/sync_tester7/games/archives');
  });

  it('accepts only names that can be a username', () => {
    expect(isChessComUsername('Sync_Tester-7')).toBe(true);
    for (const bad of ['ab', 'a/../b', 'name with space', 'x'.repeat(26), 'a?b=c', '', undefined, 7]) {
      expect(isChessComUsername(bad)).toBe(false);
    }
  });

  it('a month is final a day after it ended, and not before', () => {
    const end = Date.UTC(2026, 10, 1); // the first instant of November
    const day = 24 * 60 * 60 * 1000;
    expect(isMonthFinal('2026-10', end + day)).toBe(true);
    expect(isMonthFinal('2026-10', end + day - 1)).toBe(false);
    expect(isMonthFinal('2026-10', end - 1)).toBe(false);
    expect(isMonthFinal('2026-12', Date.UTC(2027, 0, 2))).toBe(true);
    expect(isMonthFinal('2026-10', Number.NaN)).toBe(false);
  });

  it('finds a game’s library key from its headers, without its moves', () => {
    expect(gameKeyFromPgnHeaders(G.whiteWin.pgn!)).toBe('chesscom:live-2001');
    expect(gameKeyFromPgnHeaders(G.daily.pgn!)).toBe('chesscom:daily-777');
    expect(gameKeyFromPgnHeaders('[White "A"]\n[Black "B"]\n\n1. e4 e5 *')).toBeNull();
    // The same key the full check gives the game
    expect(checkPgnText(G.daily.pgn!).games[0]!.key).toBe('chesscom:daily-777');
  });

  it('uses the API root and the capture method the history import uses', () => {
    expect(CHESSCOM_API_ROOT).toBe(API_ROOT);
    expect(CHESSCOM_SYNC_METHOD).toBe(HISTORY_METHOD);
    expect(CHESSCOM_SYNC_METHOD).toBe(CHESSCOM_HISTORY_METHOD);
  });
});

describe('Chess.com sync: a run', () => {
  it('adds the games the app plays, counts the others by reason, and asks one month a second', async () => {
    const e = env();
    const progress: string[] = [];
    const result = await sync(e, { onProgress: (p) => progress.push(syncProgressText(p)) });

    expect(result).toMatchObject({
      status: 'done',
      failure: null,
      monthsTotal: 4,
      monthsRead: 4,
      monthsUnchanged: 0,
      monthsFailed: [],
      present: 0,
      skipped: { variant: 1, noMoves: 1, invalid: 1, noPgn: 1, malformed: 1, duplicate: 1 },
      reviews: 'none',
    });
    expect([...result.added].sort()).toEqual(GOOD_IDS);
    expect(await storedIds()).toEqual(GOOD_IDS);

    // The list, then each month once, oldest first, a second before each
    expect(e.api.urls()).toEqual([LIST, month('2026-08'), month('2026-09'), month('2026-10'), month('2026-11')]);
    expect(e.sleeps).toEqual([1000, 1000, 1000, 1000]);
    expect(SYNC_REQUEST_GAP_MS).toBe(1000);
    for (const call of e.api.calls) {
      expect(call.url.startsWith('https://api.chess.com/pub/player/sync_tester7/games/')).toBe(true);
      expect(call.init).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' },
      });
      expect(call.init.body).toBeUndefined();
      // No conditional header: the API's CORS rules refuse it, and no cache mode that would bypass the browser's own
      expect(Object.keys(call.init.headers as Record<string, string>)).toEqual(['Accept']);
      expect(call.init.cache).toBeUndefined();
    }
    expect(progress).toEqual([
      '0 of 4 months',
      '1 of 4 months · 2 games added',
      '2 of 4 months · 3 games added',
      '3 of 4 months · 4 games added',
      '4 of 4 months · 5 games added',
    ]);

    const report = describeSyncResult(result);
    expect(report.tone).toBe('ok');
    expect(report.lines).toEqual([
      'Added 5 games.',
      'Skipped 6 games: 1 variant game the app does not play, 1 with no moves, 3 that could not be read, 1 listed twice.',
    ]);
  });

  it('stores the record the restore file holds for the same games', async () => {
    const e = env();
    await sync(e);
    const stored = (await storage.listGames()).map(withoutTimes).sort(byId);

    const archives = Object.entries(MONTHS).map(([m, games]) => ({ month: m, games }));
    const restore = buildRestorePayload(
      collectGames(archives).games,
      PLAYER,
      { checkPgnText, importProblemOf, buildGameRecord, schemaVersion: LATEST_SCHEMA_VERSION },
      NOW,
    );
    const fromRestore = restore.payload.games.map((g) => withoutTimes(g as StoredGameRecord)).sort(byId);
    expect(stored).toEqual(fromRestore);
    // The same games left out, for the same reasons (the builder drops a twice-listed game and a stray entry earlier)
    expect(restore.skipped).toMatchObject({ variant: 1, noMoves: 1, invalid: 1, noPgn: 1 });

    const asBlack = stored.find((g) => g.id === 'chesscom:live-2002')!;
    expect(asBlack).toMatchObject({
      white: 'opp_alpha',
      black: PLAYER,
      playerColor: 'b',
      source: 'chesscom',
      url: 'https://www.chess.com/game/live/2002',
      capturedAt: null,
      captureMethod: 'chesscom-archive-history',
      analysis: null,
    });
    expect(asBlack.pgn).toBe(G.blackWin.pgn!.trim());
    expect(stored.find((g) => g.id === 'chesscom:live-2001')!.playerColor).toBe('w');
    expect(stored.find((g) => g.id === 'chesscom:daily-777')!.url).toBe('https://www.chess.com/game/daily/777');
  });

  it('a second sync adds nothing and asks only for the month that can still change', async () => {
    const e = env();
    await sync(e);
    e.api.forget();
    e.sleeps.length = 0;

    const again = await sync(e);
    expect(again).toMatchObject({ status: 'done', monthsTotal: 4, monthsRead: 1, monthsUnchanged: 3, present: 1 });
    expect(again.added).toEqual([]);
    expect(await storedIds()).toEqual(GOOD_IDS);
    expect(e.api.urls()).toEqual([LIST, month('2026-11')]);
    expect(e.sleeps).toEqual([1000]);
    expect(describeSyncResult(again).lines).toEqual([
      'No new games. 1 was already here.',
      '3 earlier months were already stored and not asked for again.',
    ]);

    // December: November is read once more (it was stored while it could still change), and then never again
    e.now = Date.UTC(2026, 11, 3);
    e.api.forget();
    expect((await sync(e)).monthsRead).toBe(1);
    expect(e.api.urls()).toEqual([LIST, month('2026-11')]);
    e.api.forget();
    expect(await sync(e)).toMatchObject({ monthsRead: 0, monthsUnchanged: 4, added: [] });
    expect(e.api.urls()).toEqual([LIST]);
    expect(await storedIds()).toEqual(GOOD_IDS);
  });

  it('a restore file and a sync, in either order, keep every game once', async () => {
    const archives = Object.entries(MONTHS).map(([m, games]) => ({ month: m, games }));
    const restoreFile = JSON.stringify(
      buildRestorePayload(
        collectGames(archives).games,
        PLAYER,
        { checkPgnText, importProblemOf, buildGameRecord, schemaVersion: LATEST_SCHEMA_VERSION },
        NOW,
      ).payload,
    );

    // Restore, then sync
    expect((await storage.importBackupJson(restoreFile)).gamesImported).toBe(5);
    const e = env();
    const result = await sync(e);
    expect(result.added).toEqual([]);
    // Five games already here; the one listed in two months is counted once
    expect(result.present).toBe(5);
    expect(result.skipped.duplicate).toBe(1);
    expect(await storedIds()).toEqual(GOOD_IDS);

    // And the restore file again after the sync
    await storage.importBackupJson(restoreFile);
    expect(await storedIds()).toEqual(GOOD_IDS);
  });

  it('a sync, then the restore file: still every game once', async () => {
    await sync(env());
    const archives = Object.entries(MONTHS).map(([m, games]) => ({ month: m, games }));
    const restore = buildRestorePayload(
      collectGames(archives).games,
      PLAYER,
      { checkPgnText, importProblemOf, buildGameRecord, schemaVersion: LATEST_SCHEMA_VERSION },
      NOW,
    );
    await storage.importBackupJson(JSON.stringify(restore.payload));
    expect(await storedIds()).toEqual(GOOD_IDS);
  });

  it('never changes or removes a game that is already stored', async () => {
    // The same game, reviewed here earlier; a Lichess game; a game played against the bot
    const mine = checkPgnText(G.whiteWin.pgn!).games[0]!;
    const reviewed = await storage.saveGame({
      ...buildGameRecord(mine, { capturedAt: 5, method: 'chesscom-archive' }),
      accuracy: 91.5,
      analysis: { preset: 'standard', savedAt: 123, whiteAccuracy: 91.5, blackAccuracy: 40 },
      tags: ['kept'],
      createdAt: 1000,
      updatedAt: 2000,
    });
    const review = { preset: 'standard', savedAt: 123 } as unknown as SavedReview;
    await storage.saveReview(reviewed.id, review);
    const lichess = await storage.saveGame({
      ...buildGameRecord(
        checkPgnText('[Site "https://lichess.org/AbCd1234"]\n[White "A"]\n[Black "B"]\n\n1. e4 e5 *').games[0]!,
      ),
      updatedAt: 2000,
    });
    const played = await storage.saveGame({
      ...buildGameRecord(checkPgnText('[White "You"]\n[Black "Bot"]\n\n1. d4 d5 *').games[0]!),
      id: 'play:1700000000000',
      source: 'play',
      updatedAt: 2000,
    });

    const result = await sync(env());
    expect([...result.added].sort()).toEqual(GOOD_IDS.filter((id) => id !== 'chesscom:live-2001'));
    expect(result.present).toBe(1);
    expect(await storage.getGame(reviewed.id)).toEqual(reviewed);
    expect(await storage.getReview(reviewed.id)).toEqual(review);
    expect(await storage.getGame(lichess.id)).toEqual(lichess);
    expect(await storage.getGame(played.id)).toEqual(played);
    expect(await storedIds()).toEqual([...GOOD_IDS, lichess.id, played.id].sort());
  });

  it('asks for nothing without a usable username', async () => {
    for (const [username, failure] of [
      ['', 'no-username'],
      ['   ', 'no-username'],
      ['a/../b', 'bad-username'],
      ['two words', 'bad-username'],
    ] as const) {
      const e = env();
      const result = await sync(e, { username });
      expect(result).toMatchObject({ status: 'failed', failure, added: [] });
      expect(e.api.calls).toHaveLength(0);
      expect(describeSyncResult(result).tone).toBe('bad');
    }
    expect(describeSyncResult(await sync(env(), { username: '' })).lines).toEqual([
      'Add your Chess.com username under Your games first.',
    ]);
  });

  it('another username starts again from the first month', async () => {
    await sync(env());
    const other = fakeApi({ '2026-08': [] }, 'Other_Tester8');
    const e: Env = { api: other, sleeps: [], queue: [], now: NOW, auto: false };
    const result = await sync(e, { username: 'Other_Tester8' });
    expect(result).toMatchObject({ status: 'done', monthsRead: 1, monthsUnchanged: 0 });
    expect(other.urls()).toEqual([archivesListUrl('Other_Tester8'), archiveMonthUrl('Other_Tester8', '2026-08')]);
    expect((await state()).player).toBe('other_tester8');
    // The first player's games are still there
    expect(await storedIds()).toEqual(GOOD_IDS);
  });
});

describe('Chess.com sync: offline and errors', () => {
  it('offline: says so and asks for nothing', async () => {
    const e = env();
    const result = await sync(e, { isOnline: () => false });
    expect(result).toMatchObject({ status: 'failed', failure: 'offline', added: [] });
    expect(e.api.calls).toHaveLength(0);
    expect(describeSyncResult(result).lines).toEqual(['You are offline. Connect to the internet and sync again.']);
  });

  it('the network fails at the list: nothing is stored and the message names no address', async () => {
    const e = env();
    e.api.queue(LIST, networkError());
    const result = await sync(e);
    expect(result).toMatchObject({ status: 'failed', failure: 'network', monthsTotal: 0, added: [] });
    expect(e.api.urls()).toEqual([LIST]);
    expect(await storedIds()).toEqual([]);
    const text = describeSyncResult(result).lines.join(' ');
    expect(text).toContain('Chess.com could not be reached; you may be offline.');
    expect(text.toLowerCase()).not.toContain('api.chess.com');
    expect(text.toLowerCase()).not.toContain(PLAYER.toLowerCase());
  });

  it('the network fails mid-run: what was stored stays, and the next run continues from there', async () => {
    const e = env();
    e.api.queue(month('2026-10'), networkError());
    const result = await sync(e);
    expect(result).toMatchObject({ status: 'failed', failure: 'network', monthsTotal: 4, monthsRead: 2 });
    expect(await storedIds()).toEqual(['chesscom:daily-777', 'chesscom:live-2001', 'chesscom:live-2002']);
    expect(Object.keys((await state()).months)).toEqual(['2026-08', '2026-09']);
    expect(describeSyncResult(result).lines).toEqual([
      'Chess.com could not be reached; you may be offline. What was read so far is kept: sync again to continue.',
      'Added 3 games.',
      'Skipped 4 games: 1 variant game the app does not play, 3 that could not be read.',
    ]);

    e.api.forget();
    const next = await sync(e);
    expect(next).toMatchObject({ status: 'done', monthsRead: 2, monthsUnchanged: 2 });
    expect(e.api.urls()).toEqual([LIST, month('2026-10'), month('2026-11')]);
    expect([...next.added].sort()).toEqual(['chesscom:live-2007', 'chesscom:live-2009']);
    expect(await storedIds()).toEqual(GOOD_IDS);
  });

  it('the list answers an error: a clear reason, nothing else asked', async () => {
    const cases: Array<[Reply, string, string]> = [
      [{ status: 404, body: { message: 'not found' } }, 'unknown-player', 'Chess.com does not know a player'],
      [{ status: 410 }, 'unknown-player', 'Chess.com does not know a player'],
      [{ status: 500, text: 'oops' }, 'list', 'could not be read (HTTP 500). Try again later.'],
      [{ status: 403, text: 'Forbidden' }, 'list', 'could not be read (HTTP 403). Try again later.'],
      [{ status: 200, text: '<html>not json</html>' }, 'list', 'could not be read (not an archive list)'],
      [{ status: 200, body: { games: [] } }, 'list', 'could not be read (not an archive list)'],
    ];
    for (const [reply, failure, text] of cases) {
      const e = env();
      e.api.queue(LIST, reply);
      const result = await sync(e);
      expect(result).toMatchObject({ status: 'failed', failure, added: [] });
      expect(e.api.urls()).toEqual([LIST]);
      expect(describeSyncResult(result).lines.join(' ')).toContain(text);
      expect(describeSyncResult(result).tone).toBe('bad');
    }
    expect(await storedIds()).toEqual([]);
  });

  it('a month answers an error: the others go on, and it is asked for again next time', async () => {
    const e = env();
    e.api.queue(month('2026-09'), { status: 500, text: 'oops' });
    e.api.queue(month('2026-10'), { status: 200, text: 'not json' });
    const result = await sync(e);
    expect(result).toMatchObject({ status: 'done', monthsRead: 2 });
    expect(result.monthsFailed).toEqual([
      { month: '2026-09', reason: 'HTTP 500' },
      { month: '2026-10', reason: 'not JSON' },
    ]);
    expect(await storedIds()).toEqual(['chesscom:live-2001', 'chesscom:live-2002', 'chesscom:live-2009']);
    const report = describeSyncResult(result);
    expect(report.tone).toBe('bad');
    expect(report.lines).toContain(
      '2 months could not be read (2026-09: HTTP 500, 2026-10: not JSON). Sync again to read them.',
    );

    e.api.forget();
    const next = await sync(e);
    expect(e.api.urls()).toEqual([LIST, month('2026-09'), month('2026-10'), month('2026-11')]);
    expect(next.monthsFailed).toEqual([]);
    expect(await storedIds()).toEqual(GOOD_IDS);
  });

  it('a month whose answer has no games list is a failed month too', async () => {
    const e = env({ '2026-08': [G.whiteWin] });
    e.api.queue(month('2026-08'), { status: 200, body: { message: 'nothing here' } });
    const result = await sync(e);
    expect(result.monthsFailed).toEqual([{ month: '2026-08', reason: 'no games list' }]);
    expect(await storedIds()).toEqual([]);
    expect((await storage.getSetting(SYNC_STATE_SETTING)) ?? null).toBeNull();
  });

  it('too many requests: one wait, one more try, then the run stops and keeps what it has', async () => {
    // Once: waited out, and the run finishes
    const once = env();
    once.api.queue(month('2026-09'), { status: 429 });
    expect((await sync(once)).status).toBe('done');
    expect(once.sleeps).toEqual([1000, 1000, SYNC_RATE_LIMIT_WAIT_MS, 1000, 1000]);
    expect(once.api.urls().filter((u) => u === month('2026-09'))).toHaveLength(2);
    expect(await storedIds()).toEqual(GOOD_IDS);

    // Twice in a row: stop. The answer's own wait is used when it can be read
    await storage.setSetting(SYNC_STATE_SETTING, null);
    const twice = env();
    twice.api.queue(month('2026-09'), { status: 429, headers: { 'retry-after': '3' } }, { status: 429 });
    const result = await sync(twice);
    expect(result).toMatchObject({ status: 'failed', failure: 'rate-limited', monthsRead: 1 });
    expect(twice.sleeps).toEqual([1000, 1000, 3000]);
    expect(twice.api.urls()).toEqual([LIST, month('2026-08'), month('2026-09'), month('2026-09')]);
    expect(describeSyncResult(result).lines[0]).toBe(
      'Chess.com asked for fewer requests. Wait a few minutes. What was read so far is kept: sync again to continue.',
    );
  });

  it('Stop ends the run after the step it is in and keeps what was stored', async () => {
    const e = env();
    const stop = new AbortController();
    const result = await sync(e, {
      signal: stop.signal,
      sleep: async (ms) => {
        e.sleeps.push(ms);
        if (e.sleeps.length === 3) stop.abort(); // while waiting before the third month
      },
    });
    expect(result).toMatchObject({ status: 'stopped', failure: null, monthsRead: 2 });
    expect(e.api.urls()).toEqual([LIST, month('2026-08'), month('2026-09')]);
    expect(await storedIds()).toEqual(['chesscom:daily-777', 'chesscom:live-2001', 'chesscom:live-2002']);
    expect(describeSyncResult(result).lines[0]).toBe('Stopped. What was read so far is kept: sync again to continue.');

    e.api.forget();
    expect((await sync(e)).status).toBe('done');
    expect(e.api.urls()).toEqual([LIST, month('2026-10'), month('2026-11')]);
    expect(await storedIds()).toEqual(GOOD_IDS);
  });

  it('reads back only a state that is this player’s and well formed', () => {
    const good: SyncState = { version: 1, player: 'sync_tester7', months: { '2026-08': { at: 5, games: 2 } } };
    expect(parseSyncState(good, PLAYER)).toEqual(good);
    expect(parseSyncState(good, 'Other_Tester8')).toEqual({ version: 1, player: 'other_tester8', months: {} });
    for (const bad of [null, undefined, 'x', { version: 2, player: 'sync_tester7', months: {} }, { version: 1 }]) {
      expect(parseSyncState(bad, PLAYER).months).toEqual({});
    }
    expect(
      parseSyncState(
        {
          version: 1,
          player: 'sync_tester7',
          months: { '2026-08': { at: 'soon' }, nonsense: { at: 1 }, '2026-09': 7 },
        },
        PLAYER,
      ).months,
    ).toEqual({});
  });
});

describe('Chess.com sync: reviews of the added games (Auto-analyze new games)', () => {
  /** One month of `n` different short games. */
  const bigMonth = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      archiveGame({
        id: 5000 + i,
        white: i % 2 === 0 ? PLAYER : 'opp_alpha',
        black: i % 2 === 0 ? 'opp_alpha' : PLAYER,
        result: '1-0',
        date: [2026, 10, 1 + (i % 28)],
        moves: '1. e4 e5 2. Nf3 Nc6',
      }),
    );
  const EARLIER = ['lichess:Earlier01', 'chesscom:live-1'];

  it('the limit is one named constant, and the line is built from it', () => {
    expect(SYNC_AUTO_REVIEW_MAX_GAMES).toBe(100);
    expect(SYNC_REVIEWS_NOT_QUEUED_LINE).toBe('{added} games added; reviews not queued (more than {max} at once)');
    expect(reviewsNotQueuedLine(101)).toBe('101 games added; reviews not queued (more than 100 at once)');
    expect(reviewsNotQueuedLine(2345)).toBe(
      `2345 games added; reviews not queued (more than ${SYNC_AUTO_REVIEW_MAX_GAMES} at once)`,
    );
  });

  it('at most the limit, Auto-analyze on: the added games are queued once, after the ones already waiting', async () => {
    const e = env({ '2026-09': bigMonth(60), '2026-10': bigMonth(SYNC_AUTO_REVIEW_MAX_GAMES).slice(60) });
    e.auto = true;
    e.queue.push(...EARLIER);
    const result = await sync(e);
    expect(result.added).toHaveLength(SYNC_AUTO_REVIEW_MAX_GAMES);
    expect(result.reviews).toBe('queued');
    expect(e.queue).toEqual([...EARLIER, ...result.added]);
    const lines = describeSyncResult(result).lines;
    expect(lines).toEqual(['Added 100 games.', 'Quick reviews are queued for the new games.']);
  }, 60_000);

  it('more than the limit, Auto-analyze on: none is queued, the status says so, earlier reviews stay', async () => {
    const e = env({ '2026-10': bigMonth(SYNC_AUTO_REVIEW_MAX_GAMES + 1) });
    e.auto = true;
    e.queue.push(...EARLIER);
    const result = await sync(e);
    expect(result.added).toHaveLength(SYNC_AUTO_REVIEW_MAX_GAMES + 1);
    expect(result.reviews).toBe('not-queued');
    expect(e.queue).toEqual(EARLIER);
    expect(describeSyncResult(result).lines).toEqual([
      'Added 101 games.',
      '101 games added; reviews not queued (more than 100 at once)',
    ]);
    // The games themselves are all stored
    expect(await storage.listGameIds()).toHaveLength(SYNC_AUTO_REVIEW_MAX_GAMES + 1);
  }, 60_000);

  it('Auto-analyze off: nothing is queued and nothing is said about reviews, whatever the size', async () => {
    const e = env({ '2026-10': bigMonth(SYNC_AUTO_REVIEW_MAX_GAMES + 1) });
    e.queue.push(...EARLIER);
    const result = await sync(e);
    expect(result.reviews).toBe('none');
    expect(e.queue).toEqual(EARLIER);
    expect(describeSyncResult(result).lines).toEqual(['Added 101 games.']);
  }, 60_000);

  it('a run that stops early follows the same rule for what it added; a run that added nothing queues nothing', async () => {
    const e = env({ '2026-09': bigMonth(SYNC_AUTO_REVIEW_MAX_GAMES + 1), '2026-10': [G.october] });
    e.auto = true;
    e.api.queue(month('2026-10'), networkError());
    const result = await sync(e);
    expect(result).toMatchObject({ status: 'failed', failure: 'network', reviews: 'not-queued' });
    expect(e.queue).toEqual([]);
    expect(describeSyncResult(result).lines).toContain('101 games added; reviews not queued (more than 100 at once)');

    // The next run adds one game: under the limit, so that one is queued
    const next = await sync(e);
    expect(next.added).toEqual(['chesscom:live-2007']);
    expect(e.queue).toEqual(['chesscom:live-2007']);

    // And a run with nothing new leaves the queue alone
    const nothing = await sync(e);
    expect(nothing).toMatchObject({ added: [], reviews: 'none' });
    expect(e.queue).toEqual(['chesscom:live-2007']);
  }, 60_000);
});
