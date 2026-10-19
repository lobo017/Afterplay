import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKFILL_MAX_BACKOFF_MS,
  BACKFILL_QUEUE_LIMIT,
  BackfillRunner,
  LICHESS_PAGE_SIZE,
  archiveInputs,
  type StepResult,
} from '../../extension/src/backfill';
import { CaptureQueue, MemoryStore } from '../../extension/src/queue';
import type { ArchiveGame } from '../../extension/src/extractors/chesscom-archive';

const FIX = path.join(__dirname, '..', 'fixtures', 'capture');
const lichessLines = fs
  .readFileSync(path.join(FIX, 'lichess', 'user-games.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { id: string; createdAt: number; pgn: string });
const ccGames = (JSON.parse(fs.readFileSync(path.join(FIX, 'chesscom', 'archive-hikaru-2026-10.json'), 'utf8')) as { games: ArchiveGame[] })
  .games;

/** n Lichess history lines starting at `from` (ms), one minute apart, from the recorded lines. */
function lichessHistory(n: number, from: number) {
  return Array.from({ length: n }, (_, i) => {
    const base = lichessLines[i % lichessLines.length]!;
    const id = `g${String(from / 60_000 + i).padStart(7, '0')}`.slice(-8);
    return { ...base, id, createdAt: from + i * 60_000, pgn: base.pgn.replace(/lichess\.org\/\w{8}/, `lichess.org/${id}`) };
  });
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

function setup(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  let now = Date.UTC(2026, 9, 18, 12, 0, 0);
  const store = new MemoryStore();
  const queue = new CaptureQueue(store, () => now);
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    requests.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    try {
      await new Promise((r) => setTimeout(r, 1));
      return await handler(String(input), init);
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  const runner = new BackfillRunner({ store, queue, fetch: fetchFn, now: () => now });
  return {
    runner,
    queue,
    requests,
    maxInFlight: () => maxInFlight,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

/** Steps until the import stops or waits. */
async function drain(runner: BackfillRunner, site: 'lichess' | 'chesscom', limit = 50): Promise<StepResult> {
  for (let i = 0; i < limit; i++) {
    const r = await runner.step(site);
    if (r.next !== 'continue') return r;
  }
  throw new Error('did not finish');
}

describe('Phase 5b — history import: Lichess', () => {
  it('pages through the history oldest first and fetches only what is new next time', async () => {
    const start = Date.UTC(2026, 0, 1);
    const all = lichessHistory(LICHESS_PAGE_SIZE * 2 + 50, start);
    const t = setup((url) => {
      const since = Number(new URL(url).searchParams.get('since'));
      const page = all.filter((g) => g.createdAt >= since).slice(0, LICHESS_PAGE_SIZE);
      return response(page.map((g) => JSON.stringify(g)).join('\n') + '\n');
    });
    await t.runner.start('lichess', 'Lobo017');
    expect(await drain(t.runner, 'lichess')).toEqual({ next: 'stop' });
    expect(t.requests).toHaveLength(3);
    const params = t.requests.map((r) => new URL(r.url).searchParams);
    expect(params.map((p) => Number(p.get('since')))).toEqual([0, all[199]!.createdAt + 1, all[399]!.createdAt + 1]);
    expect(params.every((p) => p.get('sort') === 'dateAsc' && p.get('clocks') === 'true' && p.get('pgnInJson') === 'true')).toBe(true);
    expect(t.requests[0]!.url).toContain('/api/games/user/Lobo017?');
    expect(t.requests[0]!.headers.Accept).toBe('application/x-ndjson');
    expect((await t.queue.counts()).ready).toBe(450);
    const entry = await t.queue.get(`lichess:${all[0]!.id}`);
    expect(entry).toMatchObject({ method: 'lichess-history', source: 'lichess', url: `https://lichess.org/${all[0]!.id}` });
    expect(await t.runner.state('lichess')).toMatchObject({ status: 'done', imported: 450, message: 'Up to date · 450 new games imported' });

    // Later: two new games
    all.push(...lichessHistory(2, all.at(-1)!.createdAt + 3_600_000));
    await t.runner.start('lichess', 'Lobo017');
    await drain(t.runner, 'lichess');
    expect(Number(new URL(t.requests.at(-1)!.url).searchParams.get('since'))).toBe(all[449]!.createdAt + 1);
    expect(await t.runner.state('lichess')).toMatchObject({ status: 'done', imported: 2 });
    expect((await t.queue.counts()).ready).toBe(452);
  });

  it('backs off on 429, longer each time, and goes on afterwards', async () => {
    let limited = 3;
    const t = setup(() => (limited-- > 0 ? response('', 429) : response(JSON.stringify(lichessLines[0]) + '\n')));
    await t.runner.start('lichess', 'lobo017');
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await t.runner.step('lichess');
      expect(r.next).toBe('wait');
      const at = (r as { atMs: number }).atMs;
      waits.push(at - t.now());
      // Before the time: no request
      const before = t.requests.length;
      expect(await t.runner.step('lichess')).toEqual({ next: 'wait', atMs: at });
      expect(t.requests.length).toBe(before);
      t.advance(at - t.now());
    }
    expect(waits).toEqual([60_000, 120_000, 240_000]);
    expect(await t.runner.state('lichess')).toMatchObject({ status: 'waiting' });
    expect(await drain(t.runner, 'lichess')).toEqual({ next: 'stop' });
    expect(await t.runner.state('lichess')).toMatchObject({ status: 'done', imported: 1 });
  });

  it('never waits longer than the cap, and honours a longer Retry-After', async () => {
    const t = setup(() => response('', 429, { 'Retry-After': String(BACKFILL_MAX_BACKOFF_MS / 1000 + 600) }));
    await t.runner.start('lichess', 'lobo017');
    const r = (await t.runner.step('lichess')) as { atMs: number };
    expect(r.atMs - t.now()).toBe(BACKFILL_MAX_BACKOFF_MS);
  });

  it('pauses while the queue is full and goes on once the site has collected games', async () => {
    const t = setup(() => response(JSON.stringify(lichessLines[0]) + '\n'));
    await t.queue.addReady(
      Array.from({ length: BACKFILL_QUEUE_LIMIT }, (_, i) => ({
        key: `chesscom:live-${i}`,
        source: 'chesscom' as const,
        pgn: '[Event "x"]\n\n1. e4 *',
        method: 'm',
      })),
    );
    await t.runner.start('lichess', 'lobo017');
    expect(await t.runner.step('lichess')).toEqual({ next: 'wait', atMs: null });
    expect(t.requests).toHaveLength(0);
    expect((await t.runner.state('lichess')).message).toMatch(/wait for the analysis site/);
    await t.queue.markDelivered(['chesscom:live-0']);
    expect(await t.runner.step('lichess')).toEqual({ next: 'stop' });
    expect(t.requests).toHaveLength(1);
  });

  it('stops on an unknown user, and when stopped by hand', async () => {
    const t = setup(() => response('', 404));
    await t.runner.start('lichess', 'nobody');
    await t.runner.step('lichess');
    expect(await t.runner.state('lichess')).toMatchObject({ status: 'error', message: 'Lichess has no user "nobody".' });
    const u = setup(() => response(JSON.stringify(lichessLines[0]) + '\n'));
    await u.runner.start('lichess', 'lobo017');
    await u.runner.stop('lichess');
    expect(await u.runner.step('lichess')).toEqual({ next: 'stop' });
    expect(u.requests).toHaveLength(0);
  });
});

describe('Phase 5b — history import: Chess.com', () => {
  const MONTHS = ['2026/08', '2026/09', '2026/10'];
  const listBody = JSON.stringify({ archives: MONTHS.map((m) => `https://api.chess.com/pub/player/hikaru/games/${m}`).reverse() });

  it('fetches the archive list, then each month oldest first, with ETags; next time only the current month', async () => {
    const etags: Record<string, string> = {};
    const t = setup((url, init) => {
      const sent = (init?.headers as Record<string, string>)['If-None-Match'];
      if (url.endsWith('/archives')) return response(listBody, 200, { ETag: 'W/"list"' });
      const month = url.slice(-7);
      const etag = `W/"${month}"`;
      etags[month] = etag;
      if (sent === etag) return response('', 304);
      const games = month === '2026/10' ? ccGames : [];
      return response(JSON.stringify({ games }), 200, { ETag: etag });
    });
    await t.runner.start('chesscom', 'Hikaru');
    expect(await drain(t.runner, 'chesscom')).toEqual({ next: 'stop' });
    expect(t.requests.map((r) => r.url.replace('https://api.chess.com/pub/player/', ''))).toEqual([
      'hikaru/games/archives',
      'hikaru/games/2026/08',
      'hikaru/games/2026/09',
      'hikaru/games/2026/10',
    ]);
    const imported = (await t.queue.counts()).ready;
    expect(imported).toBe(archiveInputs(ccGames).length);
    expect(await t.runner.state('chesscom')).toMatchObject({ status: 'done', imported });

    // Next import: the list again (with its ETag) and only the current month, which hasn't changed
    t.requests.length = 0;
    await t.runner.start('chesscom', 'Hikaru');
    await drain(t.runner, 'chesscom');
    expect(t.requests.map((r) => [r.url.slice(-8), r.headers['If-None-Match']])).toEqual([
      ['archives', 'W/"list"'],
      ['/2026/10', 'W/"2026/10"'],
    ]);
    expect(await t.runner.state('chesscom')).toMatchObject({ status: 'done', imported: 0 });
  });

  it('keeps only standard and Chess960 games of an archive month', () => {
    const games: ArchiveGame[] = [
      { url: 'https://www.chess.com/game/live/1', pgn: '[Event "a"]\n\n1. e4 *', rules: 'chess' },
      { url: 'https://www.chess.com/game/live/2', pgn: '[Event "b"]\n\n1. e4 *', rules: 'crazyhouse' },
      { url: 'https://www.chess.com/game/daily/3', pgn: '[Event "c"]\n\n1. e4 *', rules: 'chess960' },
      { url: 'https://www.chess.com/game/live/4', rules: 'chess' },
    ];
    expect(archiveInputs(games).map((g) => g.key)).toEqual(['chesscom:live-1', 'chesscom:daily-3']);
  });

  it('runs one request at a time, also with both sites importing at once', async () => {
    const t = setup((url) => {
      if (url.includes('lichess')) return response(JSON.stringify(lichessLines[0]) + '\n');
      if (url.endsWith('/archives')) return response(listBody);
      return response(JSON.stringify({ games: [] }));
    });
    await t.runner.start('lichess', 'lobo017');
    await t.runner.start('chesscom', 'hikaru');
    await Promise.all([drain(t.runner, 'lichess'), drain(t.runner, 'chesscom'), t.runner.step('chesscom')]);
    expect(t.maxInFlight()).toBe(1);
    expect(t.requests.length).toBeGreaterThanOrEqual(5);
  });
});
