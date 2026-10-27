import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTO_SYNC_FIRST_WINDOW_MS,
  AUTO_SYNC_MIN_GAP_MS,
  AutoSync,
  CHESSCOM_ARCHIVE_LAG_MS,
  CHESSCOM_SYNC_METHOD,
  LICHESS_SYNC_METHOD,
  LICHESS_SYNC_PAGE_SIZE,
} from '../../extension/src/auto-sync';
import { BACKFILL_QUEUE_LIMIT } from '../../extension/src/backfill';
import type { ArchiveGame } from '../../extension/src/extractors/chesscom-archive';
import { CaptureQueue, MemoryStore } from '../../extension/src/queue';

const FIX = path.join(__dirname, '..', 'fixtures', 'capture');
type LichessLine = { id: string; createdAt: number; pgn: string; status: string; speed: string };
const lichessLines = fs
  .readFileSync(path.join(FIX, 'lichess', 'user-games.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as LichessLine);
const ccGames = (
  JSON.parse(fs.readFileSync(path.join(FIX, 'chesscom', 'archive-hikaru-2026-10.json'), 'utf8')) as {
    games: ArchiveGame[];
  }
).games;

/** A Lichess games-API line for game `id` started at `createdAt` (the PGN of a recorded game, renamed). */
function lichessGame(id: string, createdAt: number, patch: Partial<LichessLine> = {}): LichessLine {
  const base = lichessLines[0]!;
  return { ...base, id, createdAt, pgn: base.pgn.replace(/lichess\.org\/\w{8}/, `lichess.org/${id}`), ...patch };
}

function response(body: string, status = 200, headers: Record<string, string> = {}): Response {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

function setup(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  start = Date.UTC(2026, 9, 18, 12, 0, 0),
) {
  const clock = { now: start };
  const store = new MemoryStore();
  const queue = new CaptureQueue(store, () => clock.now);
  const requests: Array<{ url: URL; headers: Record<string, string> }> = [];
  let importing = false;
  const sync = new AutoSync({
    store,
    queue,
    now: () => clock.now,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      return handler(url, init);
    }) as typeof fetch,
    importActive: async () => importing,
  });
  return {
    clock,
    store,
    queue,
    sync,
    requests,
    setImporting: (v: boolean) => {
      importing = v;
    },
  };
}

const ndjson = (lines: readonly object[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

describe('Phase 5b — automatic sync (Lichess)', () => {
  it('first run looks 24 h back; finished games are queued, a running one holds the cursor back until it ends', async () => {
    const t0 = Date.UTC(2026, 9, 18, 12, 0, 0);
    let games: LichessLine[] = [
      lichessGame('aaaaaaa1', t0 - 3 * 3600_000),
      lichessGame('aaaaaaa2', t0 - 20 * 60_000, { status: 'started' }),
      lichessGame('aaaaaaa3', t0 - 10 * 60_000),
      lichessGame('aaaaaaa4', t0 - 5 * 60_000, { status: 'aborted' }),
    ];
    const s = setup((url) => {
      const since = Number(url.searchParams.get('since'));
      return response(ndjson(games.filter((g) => g.createdAt >= since)));
    });
    const state = await s.sync.run('lichess', 'Lobo017', 'alarm');
    expect(state).toMatchObject({
      lastAdded: 2,
      totalAdded: 2,
      lastResult: '2 new games.',
      lastError: null,
      username: 'Lobo017',
    });
    const first = s.requests[0]!.url;
    expect(first.pathname).toBe('/api/games/user/Lobo017');
    expect(Number(first.searchParams.get('since'))).toBe(t0 - AUTO_SYNC_FIRST_WINDOW_MS);
    expect(first.searchParams.get('ongoing')).toBe('true');
    expect(first.searchParams.get('sort')).toBe('dateAsc');
    expect(s.requests[0]!.headers.Accept).toBe('application/x-ndjson');
    expect(await s.queue.get('lichess:aaaaaaa1')).toMatchObject({
      status: 'ready',
      method: LICHESS_SYNC_METHOD,
      trigger: 'sync',
    });
    expect(await s.queue.get('lichess:aaaaaaa2')).toBeNull();
    expect(await s.queue.get('lichess:aaaaaaa4')).toBeNull();

    // The running game ends; the next run starts from its start and gets it (the others are known)
    games = games.map((g) => (g.id === 'aaaaaaa2' ? { ...g, status: 'mate' } : g));
    s.clock.now += AUTO_SYNC_MIN_GAP_MS;
    const second = await s.sync.run('lichess', 'Lobo017', 'alarm');
    expect(Number(s.requests[1]!.url.searchParams.get('since'))).toBe(t0 - 20 * 60_000);
    expect(second).toMatchObject({ lastAdded: 1, totalAdded: 3 });
    expect(await s.queue.get('lichess:aaaaaaa2')).toMatchObject({ status: 'ready', trigger: 'sync' });

    // Then from just after the newest game
    s.clock.now += AUTO_SYNC_MIN_GAP_MS;
    expect(await s.sync.run('lichess', 'Lobo017', 'alarm')).toMatchObject({
      lastAdded: 0,
      lastResult: 'No new games.',
    });
    expect(Number(s.requests[2]!.url.searchParams.get('since'))).toBe(t0 - 5 * 60_000 + 1);
  });

  it('a correspondence game in progress does not hold the cursor back', async () => {
    const t0 = Date.UTC(2026, 9, 18, 12, 0, 0);
    const games = [
      lichessGame('ccccccc1', t0 - 3600_000, { status: 'started', speed: 'correspondence' }),
      lichessGame('ccccccc2', t0 - 60_000),
    ];
    const s = setup((url) =>
      response(ndjson(games.filter((g) => g.createdAt >= Number(url.searchParams.get('since'))))),
    );
    await s.sync.run('lichess', 'me', 'alarm');
    s.clock.now += AUTO_SYNC_MIN_GAP_MS;
    await s.sync.run('lichess', 'me', 'alarm');
    expect(Number(s.requests[1]!.url.searchParams.get('since'))).toBe(t0 - 60_000 + 1);
  });

  it('reads further pages in one run when a page is full', async () => {
    const t0 = Date.UTC(2026, 9, 18, 12, 0, 0);
    const games = Array.from({ length: LICHESS_SYNC_PAGE_SIZE + 30 }, (_, i) =>
      lichessGame(`p${String(i).padStart(7, '0')}`, t0 - 6 * 3600_000 + i * 60_000),
    );
    const s = setup((url) => {
      const since = Number(url.searchParams.get('since'));
      const max = Number(url.searchParams.get('max'));
      return response(ndjson(games.filter((g) => g.createdAt >= since).slice(0, max)));
    });
    expect(await s.sync.run('lichess', 'me', 'alarm')).toMatchObject({ lastAdded: LICHESS_SYNC_PAGE_SIZE + 30 });
    expect(s.requests).toHaveLength(2);
    expect(Number(s.requests[1]!.url.searchParams.get('since'))).toBe(games[LICHESS_SYNC_PAGE_SIZE - 1]!.createdAt + 1);
  });

  it('waits between runs, backs off on 429, skips while the history import runs or the queue is full', async () => {
    let answer: Response = response('');
    const s = setup(() => answer);
    await s.sync.run('lichess', 'me', 'alarm');
    expect(s.requests).toHaveLength(1);
    // Too soon on the alarm: nothing fetched; leaving a page may go sooner
    s.clock.now += 5_000;
    await s.sync.run('lichess', 'me', 'alarm');
    expect(s.requests).toHaveLength(1);
    s.clock.now += 6_000;
    await s.sync.run('lichess', 'me', 'left-page');
    expect(s.requests).toHaveLength(2);

    answer = response('', 429, { 'Retry-After': '90' });
    s.clock.now += AUTO_SYNC_MIN_GAP_MS;
    const limited = await s.sync.run('lichess', 'me', 'alarm');
    expect(limited.backoffUntil).toBe(s.clock.now + 90_000);
    expect(limited.lastResult).toMatch(/^Rate limited; trying again after \d\d:\d\d\.$/);
    s.clock.now += AUTO_SYNC_MIN_GAP_MS;
    expect((await s.sync.run('lichess', 'me', 'manual')).lastResult).toMatch(/^Skipped: rate limited until/);
    expect(s.requests).toHaveLength(3);

    answer = response('');
    s.clock.now += 60_000;
    s.setImporting(true);
    expect((await s.sync.run('lichess', 'me', 'manual')).lastResult).toBe('Skipped: the history import is running.');
    s.setImporting(false);
    expect(s.requests).toHaveLength(3);

    const many = Array.from({ length: BACKFILL_QUEUE_LIMIT }, (_, i) => ({
      key: `paste:${i.toString(16).padStart(16, '0')}`,
      source: 'paste' as const,
      pgn: '[White "a"]\n\n1. e4 *',
      method: 'pasted-pgn',
    }));
    await s.queue.addReady(many);
    expect((await s.sync.run('lichess', 'me', 'manual')).lastResult).toMatch(/^Skipped: 1000 games wait/);
    expect(s.requests).toHaveLength(3);
  });

  it('reports an unknown user and other failures without throwing', async () => {
    const s = setup(() => response('', 404));
    expect(await s.sync.run('lichess', 'nobody', 'manual')).toMatchObject({
      lastResult: 'Failed: Lichess has no user "nobody".',
    });
    const s2 = setup(() => response('', 500));
    expect(await s2.sync.run('lichess', 'me', 'manual')).toMatchObject({ lastError: 'Lichess answered 500.' });
  });
});

describe('Phase 5b — automatic sync (Chess.com)', () => {
  const lastEnd = Math.max(...ccGames.map((g) => g.end_time!)) * 1000;

  it('first run: recent games of the current month only, with the ETag; then 304 means nothing new', async () => {
    const etag = '"v1"';
    const s = setup((url, init) => {
      const sent = (init?.headers as Record<string, string>)['If-None-Match'];
      if (url.pathname.endsWith('/2026/10')) {
        return sent === etag ? response('', 304) : response(JSON.stringify({ games: ccGames }), 200, { ETag: etag });
      }
      return response(JSON.stringify({ games: [] }));
    }, lastEnd + 3600_000);
    const state = await s.sync.run('chesscom', 'Hikaru', 'alarm');
    const recent = ccGames.filter(
      (g) => g.end_time! * 1000 >= lastEnd + 3600_000 - AUTO_SYNC_FIRST_WINDOW_MS - CHESSCOM_ARCHIVE_LAG_MS,
    );
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.length).toBeLessThan(ccGames.length);
    expect(state.lastAdded).toBe(recent.length);
    expect(s.requests.map((r) => r.url.pathname)).toEqual(['/pub/player/hikaru/games/2026/10']);
    const one = await s.queue.get(`chesscom:live-${recent[0]!.url.split('/').pop()}`);
    expect(one).toMatchObject({ status: 'ready', method: CHESSCOM_SYNC_METHOD, trigger: 'sync' });

    s.clock.now += AUTO_SYNC_MIN_GAP_MS;
    expect(await s.sync.run('chesscom', 'Hikaru', 'alarm')).toMatchObject({
      lastAdded: 0,
      lastResult: 'No new games.',
    });
    expect(s.requests[1]!.headers['If-None-Match']).toBe(etag);
  });

  it('at a month change the previous month is read too; rate limits back off', async () => {
    // Just after midnight UTC on 1 November: the lag window reaches back into October
    const s = setup(
      (url) => {
        if (url.pathname.endsWith('/2026/11')) return response('', 429, { 'Retry-After': '120' });
        return response(JSON.stringify({ games: [] }));
      },
      Date.UTC(2026, 10, 1, 0, 30),
    );
    const state = await s.sync.run('chesscom', 'hikaru', 'manual');
    expect(s.requests.map((r) => r.url.pathname)).toEqual([
      '/pub/player/hikaru/games/2026/10',
      '/pub/player/hikaru/games/2026/11',
    ]);
    expect(state.backoffUntil).toBe(Date.UTC(2026, 10, 1, 0, 30) + 120_000);
  });

  it('games the queue has already are not added again (history import, earlier sync)', async () => {
    const s = setup(() => response(JSON.stringify({ games: ccGames })), lastEnd + 60_000);
    const first = await s.sync.run('chesscom', 'hikaru', 'manual');
    expect(first.lastAdded).toBeGreaterThan(0);
    s.clock.now += 1;
    expect(await s.sync.run('chesscom', 'hikaru', 'manual')).toMatchObject({
      lastAdded: 0,
      totalAdded: first.lastAdded,
    });
  });
});
