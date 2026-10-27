import { describe, expect, it, vi } from 'vitest';
import { ExtensionBridge, BRIDGE_REPLY_TIMEOUT_MS } from '../../extension/src/bridge-core';
import { CaptureQueue, MemoryStore } from '../../extension/src/queue';
import {
  BRIDGE_MESSAGE_SOURCE,
  BRIDGE_PROTOCOL_VERSION,
  PAGE_MESSAGE_SOURCE,
  bridgeMessage,
  pageMessage,
  parseBridgeMessage,
  parsePageMessage,
  type BridgeGame,
  type MessageEventLike,
  type MessageWindow,
} from '../../src/capture/protocol';
import { ExtensionBridgeClient, type SaveOutcome } from '../../src/library/bridge-client';

const ORIGIN = 'http://127.0.0.1:4173';

/** One window shared by the page and the content script, delivering messages asynchronously like a browser. */
class FakeWindow implements MessageWindow {
  public readonly location = { origin: ORIGIN };
  public readonly sent: unknown[] = [];
  private readonly listeners = new Set<(e: MessageEventLike) => void>();

  postMessage(message: unknown, targetOrigin: string): void {
    expect(targetOrigin).toBe(ORIGIN);
    this.sent.push(message);
    this.dispatch({ data: structuredClone(message), origin: ORIGIN, source: this });
  }

  dispatch(event: MessageEventLike): void {
    setTimeout(() => {
      for (const l of [...this.listeners]) l(event);
    }, 0);
  }

  addEventListener(_type: 'message', l: (e: MessageEventLike) => void): void {
    this.listeners.add(l);
  }

  removeEventListener(_type: 'message', l: (e: MessageEventLike) => void): void {
    this.listeners.delete(l);
  }

  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => (m as { type?: string }).type === type) as Array<Record<string, unknown>>;
  }
}

const pgn = (n: number) => `[Event "T"]\n[White "W${n}"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 1-0`;

async function makeQueue(count: number) {
  let now = 1;
  const queue = new CaptureQueue(new MemoryStore(), () => now++);
  for (let i = 0; i < count; i++) {
    await queue.addReady([{ key: `chesscom:live-${i}`, source: 'chesscom', pgn: pgn(i), method: 'test' }]);
  }
  return queue;
}

function wire(queue: CaptureQueue, save: (games: readonly BridgeGame[]) => Promise<SaveOutcome>) {
  const win = new FakeWindow();
  const accounts: Array<{ lichess: string; chesscom: string }> = [];
  const bridge = new ExtensionBridge(win, {
    hello: async () => ({ extensionVersion: '9.9.9', accounts: { lichess: 'Lobo017', chesscom: 'lobo' } }),
    takeBatch: (max, exclude) => queue.takeBatch(max, new Set(exclude)),
    markDelivered: (keys) => queue.markDelivered(keys),
    markRejected: (items) => queue.markRejected(items),
  });
  const client = new ExtensionBridgeClient(win, { saveGames: save, setAccounts: (a) => void accounts.push(a) });
  return { win, bridge, client, accounts };
}

async function settle(bridge: ExtensionBridge, client: ExtensionBridgeClient): Promise<void> {
  await vi.waitFor(
    async () => {
      await client.idle();
      expect(bridge.isSyncing()).toBe(false);
      expect(client.getStatus()).toMatchObject({ syncing: false });
    },
    { timeout: 3000, interval: 5 },
  );
}

describe('Phase 5b — bridge protocol messages', () => {
  it('accepts well-formed messages of this version only', () => {
    expect(parsePageMessage(pageMessage('hello', {}))).toEqual({
      source: PAGE_MESSAGE_SOURCE,
      type: 'hello',
      version: BRIDGE_PROTOCOL_VERSION,
    });
    expect(parsePageMessage({ ...pageMessage('hello', {}), version: 2 })).toBeNull();
    expect(parsePageMessage({ ...pageMessage('hello', {}), source: BRIDGE_MESSAGE_SOURCE })).toBeNull();
    expect(parsePageMessage('hello')).toBeNull();
    const saved = pageMessage('saved', { batchId: 'b-1', saved: ['lichess:Bjl39T9x'], duplicates: [], failed: [] });
    expect(parsePageMessage(saved)).toEqual(saved);
    expect(parsePageMessage({ ...saved, saved: ['not a key'] })).toBeNull();
    expect(parsePageMessage({ ...saved, batchId: 'bad id!' })).toBeNull();
    expect(parsePageMessage({ ...saved, failed: [{ key: 'lichess:Bjl39T9x' }] })).toBeNull();
  });

  it('rejects malformed or oversized games from the extension side', () => {
    const game: BridgeGame = { key: 'lichess:Bjl39T9x', source: 'lichess', pgn: pgn(1), capturedAt: 1, method: 'm' };
    const ok = bridgeMessage('games', { batchId: 'b-1', games: [game], remaining: 0 });
    expect(parseBridgeMessage(ok)).toEqual(ok);
    expect(parseBridgeMessage({ ...ok, games: [{ ...game, source: 'chesscom' }] })).toBeNull();
    expect(parseBridgeMessage({ ...ok, games: [{ ...game, pgn: '' }] })).toBeNull();
    expect(parseBridgeMessage({ ...ok, games: [{ ...game, pgn: 'x'.repeat(600 * 1024) }] })).toBeNull();
    expect(parseBridgeMessage({ ...ok, games: Array(51).fill(game) })).toBeNull();
    expect(parseBridgeMessage({ ...ok, remaining: -1 })).toBeNull();
    const ack = bridgeMessage('hello-ack', { extensionVersion: '1', accounts: { lichess: 'a', chesscom: '' } });
    expect(parseBridgeMessage(ack)).toEqual(ack);
    expect(parseBridgeMessage({ ...ack, accounts: { lichess: 1 } })).toBeNull();
  });
});

describe('Phase 5b — bridge sync', () => {
  it('delivers every ready game in batches and marks them delivered', async () => {
    const queue = await makeQueue(120);
    const stored = new Set<string>();
    const { bridge, client, win, accounts } = wire(queue, async (games) => {
      for (const g of games) stored.add(g.key);
      return { saved: games.map((g) => g.key), duplicates: [], failed: [] };
    });
    bridge.start();
    client.start();
    await settle(bridge, client);
    expect(stored.size).toBe(120);
    expect(await queue.counts()).toEqual({ pending: 0, ready: 0, delivered: 120, rejected: 0 });
    expect(win.sentOfType('games').map((m) => (m.games as unknown[]).length)).toEqual([50, 50, 20]);
    expect(accounts).toContainEqual({ lichess: 'Lobo017', chesscom: 'lobo' });
    expect(client.getStatus()).toMatchObject({ state: 'connected', extensionVersion: '9.9.9', lastDelivered: 120 });
  });

  it('treats games the page already had as delivered', async () => {
    const queue = await makeQueue(3);
    const { bridge, client } = wire(queue, async (games) => ({
      saved: [],
      duplicates: games.map((g) => g.key),
      failed: [],
    }));
    bridge.start();
    client.start();
    await settle(bridge, client);
    expect(await queue.counts()).toMatchObject({ ready: 0, delivered: 3 });
  });

  it('partial failure: only the games the page stored are delivered; the rest wait for the next sync', async () => {
    const queue = await makeQueue(6);
    const failing = new Set(['chesscom:live-1', 'chesscom:live-4']);
    let calls = 0;
    const { bridge, client, win } = wire(queue, async (games) => {
      calls++;
      return {
        saved: games.filter((g) => !failing.has(g.key)).map((g) => g.key),
        duplicates: [],
        failed: games.filter((g) => failing.has(g.key)).map((g) => ({ key: g.key, reason: 'disk full' })),
      };
    });
    bridge.start();
    client.start();
    await settle(bridge, client);
    expect(await queue.counts()).toMatchObject({ ready: 2, delivered: 4 });
    // The failed games are not offered again in the same sync
    expect(calls).toBe(1);
    expect(win.sentOfType('sync-done').at(-1)).toMatchObject({ delivered: 4 });

    // The next sync (tab focus) offers them again; now the page stores them
    failing.clear();
    const syncsBefore = win.sentOfType('sync-done').length;
    client.hello();
    await vi.waitFor(() => expect(win.sentOfType('sync-done').length).toBe(syncsBefore + 1));
    await settle(bridge, client);
    expect(await queue.counts()).toMatchObject({ ready: 0, delivered: 6 });
  });

  it('a page that throws while storing reports every game of the batch as failed', async () => {
    const queue = await makeQueue(2);
    const { bridge, client, win } = wire(queue, async () => {
      throw new Error('QuotaExceededError');
    });
    bridge.start();
    client.start();
    await settle(bridge, client);
    expect(await queue.counts()).toMatchObject({ ready: 2, delivered: 0 });
    const saved = win.sentOfType('saved')[0]!;
    // A storage error: kept ready for the next sync (not rejected)
    expect(saved.failed).toEqual([
      { key: 'chesscom:live-0', kind: 'error', reason: 'QuotaExceededError' },
      { key: 'chesscom:live-1', kind: 'error', reason: 'QuotaExceededError' },
    ]);
  });

  it('ignores acknowledgements for keys outside the batch and answers to other batches', async () => {
    const queue = await makeQueue(2);
    await queue.addReady([{ key: 'lichess:zzzzzzzz', source: 'lichess', pgn: pgn(9), method: 'm' }]);
    const win = new FakeWindow();
    const bridge = new ExtensionBridge(win, {
      hello: async () => ({ extensionVersion: '1', accounts: { lichess: '', chesscom: '' } }),
      takeBatch: (max, exclude) => queue.takeBatch(Math.min(max, 2), new Set(exclude)),
      markDelivered: (keys) => queue.markDelivered(keys),
      markRejected: (items) => queue.markRejected(items),
    });
    bridge.start();
    win.postMessage(pageMessage('hello', {}), ORIGIN);
    await vi.waitFor(() => expect(win.sentOfType('games')).toHaveLength(1));
    const batch = win.sentOfType('games')[0]!;
    // An answer naming another batch is ignored
    win.postMessage(
      pageMessage('saved', { batchId: 'b-other', saved: ['chesscom:live-0'], duplicates: [], failed: [] }),
      ORIGIN,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(await queue.counts()).toMatchObject({ delivered: 0 });
    // A key that wasn't in the batch is ignored, the batch's key is delivered
    win.postMessage(
      pageMessage('saved', {
        batchId: batch.batchId as string,
        saved: ['chesscom:live-0', 'lichess:zzzzzzzz'],
        duplicates: [],
        failed: [],
      }),
      ORIGIN,
    );
    await vi.waitFor(async () => expect(await queue.get('chesscom:live-0')).toMatchObject({ status: 'delivered' }));
    expect(await queue.get('lichess:zzzzzzzz')).toMatchObject({ status: 'ready' });
  });

  it('checks the sender: other origins and other windows are ignored on both sides', async () => {
    const queue = await makeQueue(1);
    const { bridge, client, win } = wire(queue, async (games) => ({
      saved: games.map((g) => g.key),
      duplicates: [],
      failed: [],
    }));
    bridge.start();
    // Spoofed hello from another origin, and from another window
    win.dispatch({ data: pageMessage('hello', {}), origin: 'https://evil.example', source: win });
    win.dispatch({ data: pageMessage('hello', {}), origin: ORIGIN, source: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(win.sentOfType('hello-ack')).toHaveLength(0);
    // Spoofed games to the page from another origin
    const stored: string[] = [];
    const spoofClient = new ExtensionBridgeClient(win, {
      saveGames: async (games) => {
        stored.push(...games.map((g) => g.key));
        return { saved: [], duplicates: [], failed: [] };
      },
      setAccounts: () => undefined,
    });
    spoofClient.start();
    const game: BridgeGame = { key: 'lichess:Bjl39T9x', source: 'lichess', pgn: pgn(1), capturedAt: 1, method: 'm' };
    win.dispatch({
      data: bridgeMessage('games', { batchId: 'b-1', games: [game], remaining: 0 }),
      origin: 'https://evil.example',
      source: win,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stored).not.toContain('lichess:Bjl39T9x');
    spoofClient.stop();
    client.start();
    await settle(bridge, client);
    expect(await queue.counts()).toMatchObject({ delivered: 1 });
  });

  it('gives up on a batch the page never answers, and retries on the next hello', async () => {
    vi.useFakeTimers();
    try {
      const queue = await makeQueue(1);
      const win = new FakeWindow();
      const bridge = new ExtensionBridge(win, {
        hello: async () => ({ extensionVersion: '1', accounts: { lichess: '', chesscom: '' } }),
        takeBatch: (max, exclude) => queue.takeBatch(max, new Set(exclude)),
        markDelivered: (keys) => queue.markDelivered(keys),
        markRejected: (items) => queue.markRejected(items),
      });
      bridge.start();
      win.postMessage(pageMessage('hello', {}), ORIGIN);
      await vi.advanceTimersByTimeAsync(10);
      expect(win.sentOfType('games')).toHaveLength(1);
      expect(bridge.isSyncing()).toBe(true);
      await vi.advanceTimersByTimeAsync(BRIDGE_REPLY_TIMEOUT_MS + 10);
      expect(bridge.isSyncing()).toBe(false);
      expect(win.sentOfType('sync-done')).toHaveLength(1);
      win.postMessage(pageMessage('hello', {}), ORIGIN);
      await vi.advanceTimersByTimeAsync(10);
      expect(win.sentOfType('games')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a game captured during a sync goes out in that sync; a hello meanwhile starts no second sync', async () => {
    const queue = await makeQueue(1);
    let release: (() => void) | null = null;
    const { bridge, client, win } = wire(queue, async (games) => {
      if (!release) await new Promise<void>((r) => (release = r));
      return { saved: games.map((g) => g.key), duplicates: [], failed: [] };
    });
    bridge.start();
    client.start();
    await vi.waitFor(() => expect(release).not.toBeNull());
    await queue.addReady([{ key: 'lichess:newgame1', source: 'lichess', pgn: pgn(2), method: 'm' }]);
    client.hello();
    await new Promise((r) => setTimeout(r, 10));
    release!();
    await settle(bridge, client);
    expect(await queue.counts()).toMatchObject({ ready: 0, delivered: 2 });
    expect(win.sentOfType('hello-ack')).toHaveLength(1);
  });
});

describe('Phase 5b — delivery without focus (bridge nudge)', () => {
  it('a nudge makes an idle page sync now: the page answers bridge-ready with hello', async () => {
    const queue = await makeQueue(0);
    const stored: string[] = [];
    const { bridge, client, win } = wire(queue, async (games) => {
      stored.push(...games.map((g) => g.key));
      return { saved: games.map((g) => g.key), duplicates: [], failed: [] };
    });
    bridge.start();
    client.start();
    await settle(bridge, client);
    const hellos = win.sentOfType('hello').length;
    // A game is captured while the page sits in a background tab (no focus, no visibility change)
    await queue.addReady([{ key: 'lichess:Bjl39T9x', source: 'lichess', pgn: pgn(1), method: 'lichess-sync' }]);
    bridge.nudge();
    await vi.waitFor(() => expect(stored).toEqual(['lichess:Bjl39T9x']), { timeout: 3000, interval: 5 });
    await settle(bridge, client);
    expect(win.sentOfType('hello').length).toBe(hellos + 1);
    expect(await queue.counts()).toMatchObject({ ready: 0, delivered: 1 });
  });

  it('a nudge during a sync starts one more sync after it, for games the running one missed', async () => {
    const queue = await makeQueue(2);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const stored: string[] = [];
    const { bridge, client, win } = wire(queue, async (games) => {
      await gate;
      stored.push(...games.map((g) => g.key));
      return { saved: games.map((g) => g.key), duplicates: [], failed: [] };
    });
    bridge.start();
    client.start();
    await vi.waitFor(() => expect(win.sentOfType('games')).toHaveLength(1), { timeout: 3000, interval: 5 });
    bridge.nudge();
    bridge.nudge();
    release();
    await vi.waitFor(() => expect(win.sentOfType('sync-done').length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
      interval: 5,
    });
    await settle(bridge, client);
    expect(stored.sort()).toEqual(['chesscom:live-0', 'chesscom:live-1']);
    // One sync from the page's own hello(s), one more from the nudges (not one per nudge)
    expect(win.sentOfType('bridge-ready').length).toBe(2);
  });
});
