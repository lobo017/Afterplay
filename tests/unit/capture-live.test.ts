import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isMyGame, isRecentGame, RECENT_GAME_MS } from '../../extension/src/capture-rules';
import { CaptureService, type LinkResolution } from '../../extension/src/capture-service';
import {
  classifyStreamLine,
  readGameStream,
  STREAM_RATE_LIMIT_MS,
  STREAM_RETRY_MS,
  watchGameStream,
  type StreamLine,
  type StreamTimers,
} from '../../extension/src/content/lichess-stream';
import { startPoller } from '../../extension/src/content/poller';
import { DebugLog } from '../../extension/src/content/debug-log';
import type { PageStatus } from '../../extension/src/messages';
import { chessComRefFromRequest, classifyPage, pageKey } from '../../extension/src/pages';
import { CaptureQueue, MemoryStore } from '../../extension/src/queue';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '../../extension/src/settings';
import { hasLeft, leaveAction, leaveCaptureCheck, tabFromReport, tabFromUrl, type TrackedTab } from '../../extension/src/tab-tracker';

const FIX = path.join(__dirname, '..', 'fixtures', 'capture', 'lichess');
const LIVE_STREAM = fs.readFileSync(path.join(FIX, 'stream-7hMjEFmU-live.ndjson'), 'utf8');
const FINISHED_STREAM = fs.readFileSync(path.join(FIX, 'stream-Bjl39T9x-finished.ndjson'), 'utf8');
const EXPORT_PGN = fs.readFileSync(path.join(FIX, 'export-ids-Bjl39T9x.pgn'), 'utf8');

/** A streamed response whose chunks cut lines (and a multi-byte character) at awkward places. */
function streamed(text: string, chunk = 37, status = 200): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'application/x-ndjson' } });
}

/** Timers run by hand: `run()` fires the earliest one. */
class ManualTimers implements StreamTimers {
  public pending: Array<{ id: number; fn: () => void; ms: number }> = [];
  private next = 1;
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.push({ id, fn, ms });
    return id;
  }
  clear(handle: unknown): void {
    this.pending = this.pending.filter((t) => t.id !== handle);
  }
  run(): number {
    const t = this.pending.shift();
    if (!t) throw new Error('no timer');
    t.fn();
    return t.ms;
  }
}

const settings = (patch: Partial<ExtensionSettings> = {}): ExtensionSettings => ({ ...DEFAULT_SETTINGS, ...patch });

function status(patch: Partial<PageStatus> = {}): PageStatus {
  return {
    url: 'https://lichess.org/Bjl39T9x',
    kind: 'game',
    ref: { site: 'lichess', gameId: 'Bjl39T9x' },
    refSource: 'the URL',
    state: 'in-progress',
    stateSource: 'page data',
    white: 'GEU3',
    black: 'Lobo017',
    mine: true,
    mineReason: '',
    sawInProgress: true,
    startedAt: null,
    endedAt: null,
    captured: false,
    button: 'in-progress',
    watching: [],
    ...patch,
  };
}

describe('Phase 5b live capture — Lichess game stream', () => {
  it('classifies the recorded lines: description, positions, and the final line with the status', () => {
    const lines = LIVE_STREAM.split('\n').filter(Boolean).map(classifyStreamLine);
    expect(lines[0]).toMatchObject({ kind: 'game', ended: false, status: null, white: 'Pasebri', black: 'Fitimiti123' });
    expect(lines.slice(1, -1).every((l) => l.kind === 'move')).toBe(true);
    expect(lines[lines.length - 1]).toMatchObject({ kind: 'game', ended: true, aborted: false, status: 'outoftime', winner: 'white' });
    expect(classifyStreamLine('not json')).toEqual({ kind: 'other' });
    expect(classifyStreamLine('{"id":"x","players":{},"status":{"id":25,"name":"aborted"}}')).toMatchObject({
      ended: true,
      aborted: true,
    });
  });

  it('reads a streamed response line by line, however the chunks fall', async () => {
    for (const chunk of [1, 7, 37, 4096]) {
      const seen: StreamLine[] = [];
      const outcome = await readGameStream('Bjl39T9x', async () => streamed(FINISHED_STREAM, chunk), (l) => seen.push(l));
      expect(outcome).toEqual({ kind: 'closed', lines: 49 });
      expect(seen.filter((l) => l.kind === 'move')).toHaveLength(47);
      expect(seen[seen.length - 1]).toMatchObject({ kind: 'game', ended: true, status: 'mate', winner: 'black', black: 'Lobo017' });
    }
  });

  it('reports the end once and stops; a close without an end reconnects with a back-off', async () => {
    const timers = new ManualTimers();
    const answers = [
      () => streamed(LIVE_STREAM.split('\n').slice(0, 5).join('\n') + '\n'), // closed early (no end line)
      () => new Response('', { status: 429 }),
      () => streamed(LIVE_STREAM),
    ];
    const urls: string[] = [];
    const onEnd = vi.fn();
    const onClosed = vi.fn();
    const log = new DebugLog();
    const watch = watchGameStream({
      gameId: '7hMjEFmU',
      fetch: async (input) => {
        urls.push(String(input));
        return answers.shift()!();
      },
      onEnd,
      onClosed,
      log: (t) => log.add(t),
      timers,
    });
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(watch.describe()).toContain('reconnecting in 3 s');
    expect(timers.run()).toBe(STREAM_RETRY_MS[0]);
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    // A rate limit waits a minute and is not a "closed" (nothing to check)
    expect(timers.pending[0]!.ms).toBe(STREAM_RATE_LIMIT_MS);
    expect(onClosed).toHaveBeenCalledTimes(1);
    timers.run();
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
    expect(onEnd.mock.calls[0]![0]).toMatchObject({ status: 'outoftime', winner: 'white' });
    expect(timers.pending).toHaveLength(0);
    expect(watch.describe()).toBe('Lichess game stream: ended');
    expect(urls.every((u) => u === 'https://lichess.org/api/stream/game/7hMjEFmU')).toBe(true);
    expect(log.list().map((e) => e.text)).toContain('Lichess game stream: the game ended (outoftime, white won).');
  });

  it('stop() aborts the open stream and any reconnect', async () => {
    const timers = new ManualTimers();
    let aborted = false;
    const watch = watchGameStream({
      gameId: 'abcdefgh',
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
      onEnd: () => undefined,
      timers,
    });
    watch.stop();
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(timers.pending).toHaveLength(0);
  });
});

describe('Phase 5b live capture — poller', () => {
  it('checks one at a time with the current interval, runs at once on poke, and stops', async () => {
    const timers = new ManualTimers();
    let hidden = false;
    let checks = 0;
    const poller = startPoller({
      intervalMs: () => (hidden ? 30_000 : 10_000),
      check: async () => {
        checks++;
        if (checks === 2) throw new Error('network');
        return 'continue';
      },
      timers,
    });
    expect(timers.pending.map((t) => t.ms)).toEqual([10_000]);
    timers.run();
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    hidden = true;
    timers.run(); // this check throws: still continues
    await vi.waitFor(() => expect(timers.pending.map((t) => t.ms)).toEqual([30_000]));
    poller.poke();
    await vi.waitFor(() => expect(checks).toBe(3));
    expect(timers.pending).toHaveLength(1);
    poller.stop();
    expect(timers.pending).toHaveLength(0);
    expect(poller.runs()).toBe(3);
  });

  it("stops on the check's 'stop'", async () => {
    const timers = new ManualTimers();
    startPoller({ intervalMs: () => 5, check: async () => 'stop', timers, immediate: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(timers.pending).toHaveLength(0);
  });
});

describe('Phase 5b live capture — pages', () => {
  it('tells game pages, play pages and other pages apart on both sites', () => {
    const cases: Array<[string, string | null, string | null]> = [
      ['https://lichess.org/Bjl39T9x', 'game', 'Bjl39T9x'],
      ['https://lichess.org/Bjl39T9xAbCd', 'game', 'Bjl39T9x'],
      ['https://lichess.org/Bjl39T9x/black', 'game', 'Bjl39T9x'],
      ['https://lichess.org/Bjl39T9x/white#12', 'game', 'Bjl39T9x'],
      ['https://lichess.org/', 'other', null],
      ['https://lichess.org/@/Lobo017', 'other', null],
      ['https://www.chess.com/play/online', 'play', null],
      ['https://www.chess.com/play/online/new?action=createLiveChallenge', 'play', null],
      ['https://www.chess.com/play/computer', 'play', null],
      ['https://www.chess.com/game/live/185518487990', 'game', 'live-185518487990'],
      ['https://www.chess.com/game/185518487990', 'game', 'live-185518487990'],
      ['https://www.chess.com/game/daily/1033338800', 'game', 'daily-1033338800'],
      ['https://www.chess.com/analysis/game/live/185518487990?tab=review', 'game', 'live-185518487990'],
      ['https://www.chess.com/home', 'other', null],
    ];
    for (const [url, kind, id] of cases) {
      const page = classifyPage(url);
      expect([url, page?.kind ?? null, page?.ref?.gameId ?? null]).toEqual([url, kind, id]);
    }
    expect(classifyPage('https://example.com/Bjl39T9x')).toBeNull();
    expect(classifyPage(undefined)).toBeNull();
  });

  it("finds the game in a Chess.com page's requests", () => {
    expect(chessComRefFromRequest('https://www.chess.com/callback/live/game/185518487990')).toEqual({
      site: 'chesscom',
      gameId: 'live-185518487990',
    });
    expect(chessComRefFromRequest('https://www.chess.com/callback/daily/game/1033338800?x=1')?.gameId).toBe('daily-1033338800');
    expect(chessComRefFromRequest('https://www.chess.com/game/live/42/whatever')?.gameId).toBe('live-42');
    expect(chessComRefFromRequest('https://www.chess.com/live/game/42')?.gameId).toBe('live-42');
    expect(chessComRefFromRequest('https://www.chess.com/callback/user/popup/hikaru')).toBeNull();
    expect(chessComRefFromRequest('https://images.chesscomfiles.com/game/live/42')).toBeNull();
    expect(chessComRefFromRequest('https://www.chess.com/callback/live/game/42abc')).toBeNull();
  });

  it('page keys ignore hashes except the old #g= game links', () => {
    expect(pageKey('https://lichess.org/Bjl39T9x#12')).toBe('https://lichess.org/Bjl39T9x');
    expect(pageKey('https://www.chess.com/live#g=123')).toBe('https://www.chess.com/live#g=123');
  });
});

describe('Phase 5b live capture — leaving a game page', () => {
  const now = Date.UTC(2026, 9, 19, 12, 0, 0);
  const tracked = (patch: Partial<PageStatus> = {}): TrackedTab => tabFromReport(7, status(patch), now)!;

  it('knows when a tab has left its page', () => {
    const tab = tracked();
    expect(hasLeft(tab, 'https://lichess.org/Bjl39T9x')).toBe(false);
    expect(hasLeft(tab, 'https://lichess.org/Bjl39T9x#40')).toBe(false);
    expect(hasLeft(tab, 'https://lichess.org/')).toBe(true);
    expect(hasLeft(tab, undefined)).toBe(true);
    expect(tabFromUrl(1, 'https://example.com/', now)).toBeNull();
    expect(tabFromUrl(1, 'https://www.chess.com/play/online', now)).toMatchObject({ kind: 'play', ref: null, reported: false });
  });

  it('captures and syncs, or only syncs, or does nothing, by what the page showed', () => {
    expect(leaveAction(tracked())).toMatchObject({ capture: true, sync: true });
    expect(leaveAction(tracked({ captured: true }))).toMatchObject({ capture: false, sync: true, reason: 'already captured' });
    expect(leaveAction(tracked({ mine: false }))).toMatchObject({ capture: false, sync: true, reason: 'not my game' });
    expect(leaveAction(tracked({ state: 'aborted' }))).toMatchObject({ capture: false, sync: true });
    expect(leaveAction(tracked({ kind: 'play', ref: null, url: 'https://www.chess.com/play/online' }))).toMatchObject({
      capture: false,
      sync: true,
    });
    expect(leaveAction(tracked({ kind: 'other', ref: null, url: 'https://lichess.org/' }))).toMatchObject({ capture: false, sync: false });
    // Known from the URL only (no script reported): still worth a try
    expect(leaveAction(tabFromUrl(3, 'https://lichess.org/Bjl39T9x', now)!)).toMatchObject({ capture: true });
  });

  it('accepts a left game only if it is mine and was just played', () => {
    const facts = { white: 'GEU3', black: 'Lobo017', result: '0-1', playedAt: now - 10 * 60_000 };
    const mineByName = settings({ lichessUsername: 'lobo017' });
    expect(leaveCaptureCheck(tracked(), mineByName, now)(facts)).toBeNull();
    expect(leaveCaptureCheck(tracked(), settings({ lichessUsername: 'someone' }), now)(facts)).toBe('not my game');
    // No username: the page's player view decides; nothing known → refused
    expect(leaveCaptureCheck(tracked({ mine: true }), settings(), now)(facts)).toBeNull();
    expect(leaveCaptureCheck(tracked({ mine: null }), settings(), now)(facts)).toMatch(/set my Lichess username/);
    // Not seen in progress: only a recent game
    const opened = tracked({ sawInProgress: false, state: 'finished' });
    expect(leaveCaptureCheck(opened, mineByName, now)(facts)).toBeNull();
    expect(leaveCaptureCheck(opened, mineByName, now)({ ...facts, playedAt: now - RECENT_GAME_MS - 60_000 })).toBe('not a recent game');
  });

  it('captureFinished queues a finished game of mine with its trigger, and skips the rest', async () => {
    const store = new MemoryStore();
    const queue = new CaptureQueue(store, () => now);
    const changed = vi.fn();
    const service = new CaptureService({ queue, store, now: () => now, resolvers: {}, onQueueChanged: changed });
    const ref = { site: 'lichess' as const, gameId: 'Bjl39T9x' };
    const resolver = vi.fn(async (): Promise<LinkResolution> => ({ kind: 'pgn', pgn: EXPORT_PGN, method: 'lichess-ids-export' }));
    const accept = () => null;

    expect(await service.captureFinished(ref, 'u', resolver, () => 'not my game', 'left-page')).toMatchObject({
      outcome: 'skipped',
      reason: 'not my game',
    });
    expect(await queue.get('lichess:Bjl39T9x')).toBeNull();

    const running = EXPORT_PGN.replace('[Result "0-1"]', '[Result "*"]').replace(/0-1\s*$/, '*');
    resolver.mockResolvedValueOnce({ kind: 'pgn', pgn: running, method: 'lichess-ids-export' });
    expect(await service.captureFinished(ref, 'u', resolver, accept, 'left-page')).toMatchObject({ outcome: 'skipped' });
    resolver.mockResolvedValueOnce({ kind: 'in-progress', reason: 'The game is still in progress.' });
    expect(await service.captureFinished(ref, 'u', resolver, accept, 'left-page')).toMatchObject({ outcome: 'skipped' });

    expect(await service.captureFinished(ref, 'https://lichess.org/Bjl39T9x', resolver, accept, 'left-page')).toEqual({
      outcome: 'added',
      key: 'lichess:Bjl39T9x',
    });
    expect(await queue.get('lichess:Bjl39T9x')).toMatchObject({
      status: 'ready',
      trigger: 'left-page',
      method: 'lichess-ids-export',
      playedAt: Date.UTC(2026, 9, 4, 5, 33, 38),
    });
    expect(changed).toHaveBeenCalled();

    // Already queued: nothing is fetched
    resolver.mockClear();
    expect(await service.captureFinished(ref, 'u', resolver, accept, 'left-page')).toEqual({ outcome: 'known', key: 'lichess:Bjl39T9x' });
    expect(resolver).not.toHaveBeenCalled();

    // Not in Chess.com's archive yet: pending, keeping the trigger when it later resolves
    const cc = { site: 'chesscom' as const, gameId: 'live-1' };
    const pending = async (): Promise<LinkResolution> => ({ kind: 'pending', reason: 'not yet', retryAt: now + 1, white: 'a', black: 'b' });
    expect(await service.captureFinished(cc, 'https://www.chess.com/game/live/1', pending, accept, 'left-page')).toMatchObject({
      outcome: 'pending',
    });
    expect(await queue.get('chesscom:live-1')).toMatchObject({ status: 'pending', trigger: 'left-page' });
  });
});

describe('Phase 5b live capture — rules', () => {
  it('a game is recent by its end, or its start when the end is unknown', () => {
    const now = 10 * RECENT_GAME_MS;
    expect(isRecentGame({ endedAt: now - 1000 }, now)).toBe(true);
    expect(isRecentGame({ startedAt: now - RECENT_GAME_MS - 1 }, now)).toBe(false);
    expect(isRecentGame({ startedAt: now - 2 * RECENT_GAME_MS, endedAt: now - 1 }, now)).toBe(true);
    expect(isRecentGame({}, now)).toBe(false);
  });

  it('my game: by username (any case), else the page view, else unknown', () => {
    const players = { white: 'Hikaru', black: 'Superbeans' };
    expect(isMyGame(players, settings({ chesscomUsername: 'hikaru' }), 'chesscom', null)).toBe(true);
    expect(isMyGame(players, settings({ chesscomUsername: 'other' }), 'chesscom', true)).toBe(false);
    expect(isMyGame(players, settings(), 'chesscom', true)).toBe(true);
    expect(isMyGame(players, settings(), 'chesscom', null)).toBeNull();
    // The Lichess username doesn't count on Chess.com
    expect(isMyGame(players, settings({ lichessUsername: 'hikaru' }), 'chesscom', null)).toBeNull();
  });

  it('the debug log keeps the newest events', () => {
    let t = 0;
    const log = new DebugLog(() => ++t);
    for (let i = 0; i < DebugLog.MAX_EVENTS + 5; i++) log.add(`e${i}`);
    expect(log.list()).toHaveLength(DebugLog.MAX_EVENTS);
    expect(log.list()[0]!.text).toBe('e5');
    expect(log.last()).toEqual({ at: DebugLog.MAX_EVENTS + 5, text: `e${DebugLog.MAX_EVENTS + 4}` });
  });
});
