import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePgn } from '../../src/core/pgn';
import { checkPgnText } from '../../src/capture/pgn-games';
import {
  chessComCallbackExtractor,
  chessComCallbackToPgn,
  chessComCallbackUrl,
  chessComUsernames,
  type ChessComCallback,
} from '../../extension/src/extractors/chesscom-callback';
import {
  fetchArchiveMonth,
  findArchiveGame,
  lookupInArchives,
  monthOf,
  nextMonth,
  previousMonth,
  retryAfterMs,
  type ArchiveGame,
} from '../../extension/src/extractors/chesscom-archive';
import { CaptureService, PENDING_MAX_AGE_MS, type LinkResolution } from '../../extension/src/capture-service';
import { CaptureQueue, MemoryStore } from '../../extension/src/queue';

const DIR = path.join(__dirname, '..', 'fixtures', 'capture', 'chesscom');
const json = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as T;
const archiveGames = [
  ...json<{ games: ArchiveGame[] }>('archive-hikaru-2026-10.json').games,
  ...json<{ games: ArchiveGame[] }>('archive-erik-2026-10.json').games,
];

function movesAndClocks(pgn: string, withClocks: boolean) {
  return parsePgn(pgn)
    .getMainLine()
    .map((n) => ({ san: n.san, clk: withClocks ? (/\[%clk ([0-9:.]+)\]/.exec(n.comment)?.[1] ?? null) : null }));
}

function respond(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  const headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function fetchFrom(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return { fn, calls };
}

const CALLBACKS = [
  {
    file: 'callback-live-185518487990.json',
    ref: { site: 'chesscom' as const, gameId: 'live-185518487990' },
    clocks: true,
  },
  {
    file: 'callback-live-185358990103.json',
    ref: { site: 'chesscom' as const, gameId: 'live-185358990103' },
    clocks: true,
  },
  // Daily games: Chess.com's archive writes a [%clk] for them, the callback has no matching clock
  {
    file: 'callback-daily-1036320138.json',
    ref: { site: 'chesscom' as const, gameId: 'daily-1036320138' },
    clocks: false,
  },
  {
    file: 'callback-daily-1033338800.json',
    ref: { site: 'chesscom' as const, gameId: 'daily-1033338800' },
    clocks: false,
  },
];

describe("Phase 5b — Chess.com's game data (callback)", () => {
  for (const c of CALLBACKS) {
    it(`turns ${c.file} into Chess.com's own PGN (moves${c.clocks ? ' and clocks' : ''})`, () => {
      const data = json<ChessComCallback>(c.file);
      const pgn = chessComCallbackToPgn(data, c.ref)!;
      const archived = findArchiveGame(archiveGames, c.ref);
      expect(archived, 'the same game is in the recorded archive').not.toBeNull();
      expect(movesAndClocks(pgn, c.clocks)).toEqual(movesAndClocks(archived!.pgn!, c.clocks));
      const mine = parsePgn(pgn).getHeaders();
      const theirs = parsePgn(archived!.pgn!).getHeaders();
      for (const h of [
        'Event',
        'Date',
        'White',
        'Black',
        'Result',
        'WhiteElo',
        'BlackElo',
        'TimeControl',
        'Termination',
        'Link',
        'FEN',
        'Variant',
      ]) {
        expect(mine[h], h).toBe(theirs[h]);
      }
      const { games } = checkPgnText(pgn);
      expect(games).toHaveLength(1);
      expect(games[0]!.key).toBe(`chesscom:${c.ref.gameId}`);
    });
  }

  it('builds the request URL and reads the players', () => {
    expect(chessComCallbackUrl({ site: 'chesscom', gameId: 'daily-1036320138' })).toBe(
      'https://www.chess.com/callback/daily/game/1036320138',
    );
    expect(chessComUsernames(json<ChessComCallback>('callback-live-185518487990.json'))).toEqual({
      white: 'billy_thekid30',
      black: 'hikaru',
    });
  });

  it('extractor: fetches the callback, refuses a game in progress or the wrong game', async () => {
    const ref = { site: 'chesscom' as const, gameId: 'live-185518487990' };
    const data = json<ChessComCallback>('callback-live-185518487990.json');
    const ok = fetchFrom(() => respond(data));
    expect(await chessComCallbackExtractor.extract({ ref, fetch: ok.fn })).toMatchObject({
      ok: true,
      method: 'chesscom-callback',
    });
    expect(ok.calls[0]!.url).toBe('https://www.chess.com/callback/live/game/185518487990');
    const live = fetchFrom(() => respond({ ...data, game: { ...data.game, isFinished: false } }));
    expect(await chessComCallbackExtractor.extract({ ref, fetch: live.fn })).toMatchObject({
      ok: false,
      inProgress: true,
    });
    const other = fetchFrom(() => respond({ ...data, game: { ...data.game, id: 1 } }));
    expect(await chessComCallbackExtractor.extract({ ref, fetch: other.fn })).toMatchObject({ ok: false });
    const missing = fetchFrom(() => respond({ message: 'Game is not found.' }, { status: 404 }));
    expect(await chessComCallbackExtractor.extract({ ref, fetch: missing.fn })).toMatchObject({
      ok: false,
      notFound: true,
    });
  });
});

describe("Phase 5b — Chess.com's monthly archives", () => {
  it('finds a game by its URL and steps months', () => {
    expect(findArchiveGame(archiveGames, { site: 'chesscom', gameId: 'live-185518487990' })?.url).toBe(
      'https://www.chess.com/game/live/185518487990',
    );
    expect(findArchiveGame(archiveGames, { site: 'chesscom', gameId: 'daily-185518487990' })).toBeNull();
    expect(findArchiveGame(archiveGames, { site: 'chesscom', gameId: 'live-18551848799' })).toBeNull();
    expect(monthOf(Date.UTC(2026, 0, 31, 23, 59))).toBe('2026/01');
    expect(previousMonth('2026/01')).toBe('2025/12');
    expect(nextMonth('2026/12')).toBe('2027/01');
    expect(retryAfterMs('30', 5)).toBe(30_000);
    expect(retryAfterMs(null, 5)).toBe(5);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 5, 4_000)).toBe(6_000);
  });

  it('sends If-None-Match and reads 304 / 429 / 404 answers', async () => {
    const etag = 'W/"5ce5bab2c2c728a1fa4c63a023b0a4ba"';
    const f = fetchFrom((_url, init) => {
      const sent = (init?.headers as Record<string, string>)['If-None-Match'];
      return sent === etag
        ? respond(null, { status: 304 })
        : respond({ games: archiveGames }, { headers: { ETag: etag } });
    });
    expect(await fetchArchiveMonth(f.fn, 'Hikaru', '2026/10')).toMatchObject({ status: 'ok', etag });
    expect(f.calls[0]!.url).toBe('https://api.chess.com/pub/player/hikaru/games/2026/10');
    expect(await fetchArchiveMonth(f.fn, 'hikaru', '2026/10', etag)).toEqual({ status: 'not-modified' });
    const limited = fetchFrom(() => respond(null, { status: 429, headers: { 'Retry-After': '120' } }));
    expect(await fetchArchiveMonth(limited.fn, 'hikaru', '2026/10')).toEqual({
      status: 'rate-limited',
      retryAfterMs: 120_000,
    });
    const gone = fetchFrom(() => respond(null, { status: 404 }));
    expect(await fetchArchiveMonth(gone.fn, 'nobody', '2026/10')).toEqual({ status: 'not-found' });
  });

  it('a game not in the archive yet is pending; one request per month, in order', async () => {
    const ref = { site: 'chesscom' as const, gameId: 'live-185518487990' };
    const empty = fetchFrom(() => respond({ games: [] }));
    const pending = await lookupInArchives(empty.fn, ref, 'hikaru', ['2026/10', '2026/09']);
    expect(pending).toMatchObject({ status: 'pending', retryAfterMs: 15 * 60_000 });
    expect(empty.calls.map((c) => c.url.slice(-7))).toEqual(['2026/10', '2026/09']);
    const full = fetchFrom(() => respond({ games: archiveGames }));
    const found = await lookupInArchives(full.fn, ref, 'hikaru', ['2026/10', '2026/09']);
    expect(found.status).toBe('found');
    expect(full.calls).toHaveLength(1);
  });
});

describe('Phase 5b — links and pending games', () => {
  function service(resolve: (n: number) => LinkResolution) {
    let now = 1_000_000;
    let n = 0;
    const store = new MemoryStore();
    const queue = new CaptureQueue(store, () => now);
    const svc = new CaptureService({
      queue,
      store,
      now: () => now,
      resolvers: { chesscom: async () => resolve(++n), lichess: async () => resolve(++n) },
      onQueueChanged: () => undefined,
    });
    return { svc, queue, advance: (ms: number) => (now += ms), calls: () => n };
  }

  const LINK = 'https://www.chess.com/game/live/185518487990';
  const archived = findArchiveGame(archiveGames, { site: 'chesscom', gameId: 'live-185518487990' })!.pgn!;

  it('queues a link as pending, retries when due, and turns ready once the archive has it', async () => {
    const { svc, queue, advance } = service((n) =>
      n < 3
        ? { kind: 'pending', reason: 'not yet', retryAt: 1_000_000 + n * 60_000 }
        : { kind: 'pgn', pgn: archived, method: 'chesscom-archive' },
    );
    expect(await svc.saveLink(LINK)).toMatchObject({ ok: true, outcome: 'pending' });
    expect(await queue.get('chesscom:live-185518487990')).toMatchObject({ status: 'pending', error: 'not yet' });
    expect(await svc.retryPending()).toBe(0);
    advance(70_000);
    expect(await svc.retryPending()).toBe(0);
    advance(70_000);
    expect(await svc.retryPending()).toBe(1);
    expect(await queue.get('chesscom:live-185518487990')).toMatchObject({
      status: 'ready',
      method: 'chesscom-archive',
    });
    // A known game isn't resolved again
    expect(await svc.saveLink(LINK)).toMatchObject({ ok: true, outcome: 'already-queued' });
  });

  it('stops retrying on its own after 48 hours, but Retry now still works', async () => {
    const { svc, queue, advance, calls } = service(() => ({ kind: 'pending', reason: 'not yet', retryAt: 0 }));
    await svc.saveLink(LINK);
    advance(PENDING_MAX_AGE_MS + 1);
    await svc.retryPending();
    const entry = await queue.get('chesscom:live-185518487990');
    expect(entry).toMatchObject({ status: 'pending', nextRetryAt: null });
    expect(entry?.error).toMatch(/Gave up retrying after 48 h/);
    const before = calls();
    await svc.retryPending();
    expect(calls()).toBe(before);
    await svc.retryPending('chesscom:live-185518487990');
    expect(calls()).toBe(before + 1);
  });

  it('pasted text: links one per line, PGN otherwise; bad links are reported', async () => {
    const { svc } = service(() => ({ kind: 'pgn', pgn: archived, method: 'chesscom-archive' }));
    const results = await svc.saveText(`${LINK}\nhttps://example.com/game/1\n`);
    expect(results).toEqual([
      { label: 'Billy_thekid30 vs Hikaru', ok: true, outcome: 'added' },
      { label: 'https://example.com/game/1', ok: false, error: 'Not a Lichess or Chess.com game link.' },
    ]);
    const err = service(() => ({ kind: 'error', error: 'nope' }));
    expect(await err.svc.saveText('https://lichess.org/Bjl39T9x')).toEqual([
      { label: 'https://lichess.org/Bjl39T9x', ok: false, error: 'nope' },
    ]);
  });
});
