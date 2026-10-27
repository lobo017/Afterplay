import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();
import { ExtensionBridge, rejectionOf } from '../../extension/src/bridge-core';
import { CaptureQueue, MemoryStore } from '../../extension/src/queue';
import { siteMatchPatterns, siteOrigins } from '../../extension/src/settings';
import { checkPgnText, describeImportProblem, importProblemOf, repairTagLines } from '../../src/capture/pgn-games';
import {
  pageMessage,
  parsePageMessage,
  type BridgeGame,
  type MessageEventLike,
  type MessageWindow,
} from '../../src/capture/protocol';
import { ExtensionBridgeClient } from '../../src/library/bridge-client';
import { GameLibrary } from '../../src/library/library';
import { WizardChessStorage, deleteWizardChessDB } from '../../src/storage/db';

// The games behind "21 waiting" (docs/PROGRESS.md, "Delivery outcomes"): Lichess variants
// and Chess.com games without moves, offered to the site on every sync and refused every
// time. Synthetic PGNs of the same shape.

const DB = 'wizards-chess-delivery-test';
const ORIGIN = 'http://127.0.0.1:4173';

const STANDARD =
  '[Event "Casual"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
const ANTICHESS =
  '[Event "casual variant:antichess game"]\n[Site "https://lichess.org/6XyS2AA6"]\n[White "BradyAranya"]\n[Black "Lobo017"]\n' +
  '[Result "1-0"]\n[Variant "Antichess"]\n\n1. e3 b6 2. Ba6 Bxa6 3. Qe2 Bxe2 4. Kxe2 Nc6 5. Kd3 Qc8 6. Kc4 1-0';
const ATOMIC = ANTICHESS.replace('Antichess', 'Atomic').replace('6XyS2AA6', 'N8YdYmlV');
const CRAZYHOUSE = ANTICHESS.replace('Antichess', 'Crazyhouse').replace('6XyS2AA6', 'CfJ0muXA');
const NO_MOVES =
  '[Event "2022 Chess.com Daily Chess Championship - Round 1"]\n[Site "Chess.com"]\n[White "Marufazimov"]\n[Black "LocoLobo06"]\n' +
  '[Result "0-1"]\n[Termination "LocoLobo06 won on time"]\n[Link "https://www.chess.com/game/daily/376600893"]\n\n0-1';
const DRAWN_AT_MOVE_0 = NO_MOVES.replace('daily/376600893', 'live/38386395525').replace(/0-1/g, '1/2-1/2');
const ILLEGAL = '[Event "Bad"]\n[White "A"]\n[Black "B"]\n[Result "*"]\n\n1. e4 e5 2. Ke3 *';
const UNUSUAL = `[Event "The "big" one"]\n[Site 'Club']\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`;

describe('Phase 5b — what the site takes', () => {
  it('variants the app does not play and games without moves are named; standard, Chess960 and From Position pass', () => {
    expect(importProblemOf(ANTICHESS)).toEqual({ kind: 'variant', variant: 'Antichess' });
    expect(importProblemOf(ATOMIC)).toEqual({ kind: 'variant', variant: 'Atomic' });
    expect(importProblemOf(CRAZYHOUSE)).toEqual({ kind: 'variant', variant: 'Crazyhouse' });
    expect(importProblemOf(NO_MOVES)).toEqual({ kind: 'no-moves' });
    expect(importProblemOf(DRAWN_AT_MOVE_0)).toEqual({ kind: 'no-moves' });
    expect(importProblemOf('[Event "x"]\n\n{ The opponent never moved. } *')).toEqual({ kind: 'no-moves' });
    for (const ok of [STANDARD, ILLEGAL, UNUSUAL, STANDARD.replace('[Result', '[Variant "Standard"]\n[Result')]) {
      expect(importProblemOf(ok)).toBeNull();
    }
    expect(importProblemOf('[Variant "Chess960"]\n[FEN "x"]\n\n1. e4 *')).toBeNull();
    expect(importProblemOf('[Variant "From Position"]\n\n1. e4 *')).toBeNull();
    expect(describeImportProblem({ kind: 'variant', variant: 'Antichess' })).toBe('variant: Antichess');
    expect(describeImportProblem({ kind: 'no-moves' })).toBe('no moves');
  });

  it('a standard game with unusual tag lines (quotes inside, single quotes) is read after a repair', () => {
    expect(repairTagLines('[Event "The "big" one"]')).toBe('[Event "The \\"big\\" one"]');
    expect(repairTagLines("[Site 'Club']")).toBe('[Site "Club"]');
    // Well-formed lines and several tags on one line are left alone
    expect(repairTagLines('[Event "x"] [Result "1-0"]\n1. e4')).toBe('[Event "x"] [Result "1-0"]\n1. e4');
    const { games, errors } = checkPgnText(UNUSUAL);
    expect(errors).toEqual([]);
    expect(games[0]!.headers).toMatchObject({ Event: 'The "big" one', Site: 'Club', White: 'Alice' });
    expect(games[0]!.sanMoves).toHaveLength(7);
  });
});

describe('Phase 5b — the site’s answer for every game it is offered', () => {
  beforeEach(async () => {
    await deleteWizardChessDB(DB);
  });

  it('saved, already on the site, variant, no moves, unreadable; unusual headers are saved', async () => {
    const storage = await WizardChessStorage.create({ dbName: DB });
    const library = new GameLibrary(storage);
    await library.init();
    const game = (key: string, pgn: string): BridgeGame => ({
      key,
      source: key.split(':')[0] as BridgeGame['source'],
      pgn,
      capturedAt: 1,
      method: 'm',
    });
    await library.saveBridgeGames([game('chesscom:live-1', STANDARD)]);
    const outcome = await library.saveBridgeGames([
      game('chesscom:live-1', STANDARD),
      game('lichess:6XyS2AA6', ANTICHESS),
      game('chesscom:daily-376600893', NO_MOVES),
      game('chesscom:live-2', ILLEGAL),
      game('chesscom:live-3', UNUSUAL),
    ]);
    expect(outcome.saved).toEqual(['chesscom:live-3']);
    expect(outcome.duplicates).toEqual(['chesscom:live-1']);
    expect(outcome.failed).toEqual([
      { key: 'lichess:6XyS2AA6', kind: 'variant', reason: 'variant: Antichess' },
      { key: 'chesscom:daily-376600893', kind: 'no-moves', reason: 'no moves' },
      { key: 'chesscom:live-2', kind: 'invalid', reason: expect.stringContaining('Illegal move: Ke3') },
    ]);
    expect(await library.get('chesscom:live-3')).toMatchObject({ white: 'Alice', black: 'Bob' });
    expect(await library.get('lichess:6XyS2AA6')).toBeUndefined();

    // Storage trouble is "error": worth another try
    vi.spyOn(storage, 'saveGame').mockRejectedValueOnce(new Error('QuotaExceededError'));
    const later = await library.saveBridgeGames([game('chesscom:live-4', STANDARD)]);
    expect(later.failed).toEqual([{ key: 'chesscom:live-4', kind: 'error', reason: 'QuotaExceededError' }]);
    storage.close();
  });

  it('the protocol carries the kind, and refuses an unknown one', () => {
    const saved = pageMessage('saved', {
      batchId: 'b-1',
      saved: [],
      duplicates: [],
      failed: [{ key: 'lichess:6XyS2AA6', kind: 'variant', reason: 'variant: Antichess' }],
    });
    expect(parsePageMessage(saved)).toEqual(saved);
    expect(parsePageMessage({ ...saved, failed: [{ key: 'lichess:6XyS2AA6', kind: 'nope', reason: 'x' }] })).toBeNull();
    // Without a kind (an older page) the message is still read
    expect(parsePageMessage({ ...saved, failed: [{ key: 'lichess:6XyS2AA6', reason: 'x' }] })).not.toBeNull();
    expect(rejectionOf({ key: 'lichess:6XyS2AA6', reason: 'x' })).toBeNull();
    expect(rejectionOf({ key: 'lichess:6XyS2AA6', kind: 'error', reason: 'x' })).toBeNull();
    expect(rejectionOf({ key: 'lichess:6XyS2AA6', kind: 'invalid', reason: 'x' })).toEqual({
      key: 'lichess:6XyS2AA6',
      kind: 'invalid',
      reason: 'x',
    });
  });
});

/** One window shared by the page and the content script, delivering messages asynchronously. */
class FakeWindow implements MessageWindow {
  public readonly location = { origin: ORIGIN };
  public readonly sent: unknown[] = [];
  private readonly listeners = new Set<(e: MessageEventLike) => void>();
  postMessage(message: unknown): void {
    this.sent.push(message);
    const event = { data: structuredClone(message), origin: ORIGIN, source: this };
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
  count(type: string): number {
    return this.sent.filter((m) => (m as { type?: string }).type === type).length;
  }
}

describe('Phase 5b — the extension acts on every answer', () => {
  beforeEach(async () => {
    await deleteWizardChessDB(DB);
  });

  /** A queue holding games the way they were before this change (straight in as ready). */
  async function legacyQueue(games: Record<string, string>) {
    const store = new MemoryStore();
    const queue = new CaptureQueue(store, () => 1);
    for (const [key, pgn] of Object.entries(games)) {
      // An import that didn't look at the PGN: written as the old queue wrote it
      await queue.addReady([
        { key, source: key.split(':')[0] as 'lichess', pgn: STANDARD, method: 'lichess-history', trigger: 'history' },
      ]);
      await store.set({ [`queue:pgn:${key}`]: pgn });
    }
    return { store, queue };
  }

  async function sync(queue: CaptureQueue, library: GameLibrary) {
    const win = new FakeWindow();
    const bridge = new ExtensionBridge(win, {
      hello: async () => ({ extensionVersion: '1', accounts: { lichess: '', chesscom: '' } }),
      takeBatch: (max, exclude) => queue.takeBatch(max, new Set(exclude)),
      markDelivered: (keys) => queue.markDelivered(keys),
      markRejected: (items) => queue.markRejected(items),
    });
    const client = new ExtensionBridgeClient(win, {
      saveGames: (g) => library.saveBridgeGames(g),
      setAccounts: () => undefined,
    });
    bridge.start();
    client.start();
    await vi.waitFor(
      async () => {
        await client.idle();
        expect(bridge.isSyncing()).toBe(false);
        expect(win.count('sync-done')).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 5 },
    );
    bridge.stop();
    client.stop();
    return win;
  }

  it('the reported set: nothing stays waiting; variants and no-move games are rejected with the reason, the rest delivered', async () => {
    const storage = await WizardChessStorage.create({ dbName: DB });
    const library = new GameLibrary(storage);
    await library.init();
    await library.saveBridgeGames([
      { key: 'chesscom:live-1', source: 'chesscom', pgn: STANDARD, capturedAt: 1, method: 'm' },
    ]);
    const { queue, store } = await legacyQueue({
      'lichess:6XyS2AA6': ANTICHESS,
      'lichess:N8YdYmlV': ATOMIC,
      'chesscom:daily-376600893': NO_MOVES,
      'chesscom:live-1': STANDARD,
      'chesscom:live-2': ILLEGAL,
      'chesscom:live-3': UNUSUAL,
    });
    expect(await queue.counts()).toMatchObject({ ready: 6 });
    await sync(queue, library);
    expect(await queue.counts()).toEqual({ pending: 0, ready: 0, delivered: 2, rejected: 4 });
    expect(await queue.get('chesscom:live-1')).toMatchObject({ status: 'delivered' }); // already on the site
    expect(await queue.get('chesscom:live-3')).toMatchObject({ status: 'delivered' }); // unusual headers
    expect(await queue.get('lichess:6XyS2AA6')).toMatchObject({
      status: 'rejected',
      rejectKind: 'variant',
      rejectReason: 'variant: Antichess',
    });
    expect(await queue.get('chesscom:daily-376600893')).toMatchObject({ status: 'rejected', rejectKind: 'no-moves' });
    expect(await queue.get('chesscom:live-2')).toMatchObject({ status: 'rejected', rejectKind: 'invalid' });
    // A variant's PGN is dropped; an unreadable one is kept for Retry
    expect((await store.get(['queue:pgn:lichess:6XyS2AA6']))['queue:pgn:lichess:6XyS2AA6']).toBeUndefined();
    expect((await store.get(['queue:pgn:chesscom:live-2']))['queue:pgn:chesscom:live-2']).toBe(ILLEGAL);

    // The next sync offers nothing
    const second = await sync(queue, library);
    expect(second.count('games')).toBe(0);

    // Retry offers the unreadable one again (still refused); Dismiss hides it for good
    expect(await queue.retryRejected('chesscom:live-2')).toBe(true);
    expect(await queue.retryRejected('lichess:6XyS2AA6')).toBe(false);
    await sync(queue, library);
    expect(await queue.get('chesscom:live-2')).toMatchObject({ status: 'rejected', rejectKind: 'invalid' });
    expect(await queue.dismissRejected('chesscom:live-2')).toBe(true);
    expect(await queue.counts()).toMatchObject({ rejected: 3 });
    expect((await store.get(['queue:pgn:chesscom:live-2']))['queue:pgn:chesscom:live-2']).toBeUndefined();
    storage.close();
  });

  it('a storage error keeps the game ready for the next sync', async () => {
    const storage = await WizardChessStorage.create({ dbName: DB });
    const library = new GameLibrary(storage);
    await library.init();
    const { queue } = await legacyQueue({ 'chesscom:live-5': STANDARD });
    const spy = vi.spyOn(storage, 'saveGame').mockRejectedValueOnce(new Error('QuotaExceededError'));
    await sync(queue, library);
    expect(await queue.get('chesscom:live-5')).toMatchObject({ status: 'ready' });
    spy.mockRestore();
    await sync(queue, library);
    expect(await queue.get('chesscom:live-5')).toMatchObject({ status: 'delivered' });
    storage.close();
  });

  it('the queue rejects variants and no-move games as they come in, and on start for those already waiting', async () => {
    const store = new MemoryStore();
    const queue = new CaptureQueue(store, () => 1);
    const outcomes = await queue.addReady([
      { key: 'lichess:6XyS2AA6', source: 'lichess', pgn: ANTICHESS, method: 'lichess-history', trigger: 'history' },
      {
        key: 'chesscom:daily-376600893',
        source: 'chesscom',
        pgn: NO_MOVES,
        method: 'chesscom-archive-history',
        trigger: 'history',
      },
      { key: 'chesscom:live-1', source: 'chesscom', pgn: STANDARD, method: 'm', trigger: 'history' },
    ]);
    expect(outcomes).toEqual(['not-importable', 'not-importable', 'added']);
    expect(await queue.counts()).toEqual({ pending: 0, ready: 1, delivered: 0, rejected: 2 });
    expect(Object.keys(await store.get(null)).filter((k) => k.startsWith('queue:pgn:'))).toEqual([
      'queue:pgn:chesscom:live-1',
    ]);
    expect((await queue.takeBatch(50)).games.map((g) => g.key)).toEqual(['chesscom:live-1']);

    // Imports and the sync don't bring a rejected game back; Save, a link or a paste may
    expect(
      await queue.addReady([
        { key: 'lichess:6XyS2AA6', source: 'lichess', pgn: STANDARD, method: 'lichess-sync', trigger: 'sync' },
      ]),
    ).toEqual(['already-rejected']);
    expect(
      await queue.addReady([
        { key: 'lichess:6XyS2AA6', source: 'lichess', pgn: ANTICHESS, method: 'x', trigger: 'save-button' },
      ]),
    ).toEqual(['not-importable']);
    expect(
      await queue.addPending({ key: 'lichess:6XyS2AA6', source: 'lichess', url: null, error: 'x', nextRetryAt: null }),
    ).toBe('already-rejected');

    // Games queued before the queue looked: classified when the extension starts
    const old = await legacyQueue({
      'lichess:CfJ0muXA': CRAZYHOUSE,
      'chesscom:live-38386395525': DRAWN_AT_MOVE_0,
      'chesscom:live-9': STANDARD,
    });
    expect(await old.queue.classifyWaiting()).toBe(2);
    expect(await old.queue.counts()).toEqual({ pending: 0, ready: 1, delivered: 0, rejected: 2 });
    expect(await old.queue.get('lichess:CfJ0muXA')).toMatchObject({
      rejectKind: 'variant',
      rejectReason: 'variant: Crazyhouse',
    });
  });
});

describe('Phase 5b — the site under either loopback name', () => {
  it('127.0.0.1 and localhost on the same port both count as the site', () => {
    expect(siteOrigins('http://127.0.0.1:4173')).toEqual(['http://127.0.0.1:4173', 'http://localhost:4173']);
    expect(siteOrigins('http://localhost:5173')).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(siteMatchPatterns('http://127.0.0.1:4173')).toEqual(['http://127.0.0.1:4173/*', 'http://localhost:4173/*']);
  });
});
