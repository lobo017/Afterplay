import { describe, expect, it } from 'vitest';
import {
  AnalysisCache,
  EngineCancelledError,
  EngineClient,
  detectEngineCapabilities,
  normalizeFenForCache,
  type EngineAnalysisResult,
  type EngineTransport,
  type EngineVariant,
} from '../../src/engine/engine-client';

class MockStockfishTransport implements EngineTransport {
  public readonly sentCommands: string[] = [];
  private messageHandlers: Array<(line: string) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  public terminated = false;
  public autoRespondSearch = true;
  private readonly variant: EngineVariant;

  constructor(variant: EngineVariant = 'single-threaded') {
    this.variant = variant;
  }

  public send(command: string): void {
    this.sentCommands.push(command);
    if (command === 'uci') {
      queueMicrotask(() => {
        const name =
          this.variant === 'multi-threaded'
            ? 'Stockfish 17.1 Lite WASM Multithreaded'
            : 'Stockfish 17.1 Lite WASM';
        const maxThreads = this.variant === 'multi-threaded' ? 32 : 1;
        this.emit(`id name ${name}`);
        this.emit('id author the Stockfish developers');
        this.emit(
          `option name Threads type spin default 1 min 1 max ${maxThreads}`,
        );
        this.emit(
          'option name Hash type spin default 16 min 1 max 33554432',
        );
        this.emit('option name MultiPV type spin default 1 min 1 max 256');
        this.emit('option name UCI_Chess960 type check default false');
        this.emit('uciok');
      });
    } else if (command === 'isready') {
      queueMicrotask(() => {
        this.emit('readyok');
      });
    } else if (command.startsWith('go ') && this.autoRespondSearch) {
      if (command.startsWith('go perft ')) {
        const d = Number(command.split(/\s+/)[2] ?? 1);
        queueMicrotask(() => {
          this.emit('e2e4: 20');
          this.emit(`Nodes searched: ${d === 1 ? 20 : 400}`);
        });
      } else {
        queueMicrotask(() => {
          this.emit(
            'info depth 10 seldepth 14 multipv 1 score cp 32 nodes 12000 nps 480000 time 25 pv e2e4 e7e5 g1f3',
          );
          this.emit(
            'info depth 10 seldepth 14 multipv 2 score cp 24 nodes 12000 nps 480000 time 25 pv d2d4 d7d5 c2c4',
          );
          this.emit('bestmove e2e4 ponder e7e5');
        });
      }
    } else if (command === 'stop') {
      queueMicrotask(() => {
        this.emit('bestmove e2e4 ponder e7e5');
      });
    }
  }

  public emit(line: string): void {
    for (const h of this.messageHandlers) {
      h(line);
    }
  }

  public emitError(err: Error): void {
    for (const h of this.errorHandlers) {
      h(err);
    }
  }

  public onMessage(handler: (line: string) => void): void {
    this.messageHandlers.push(handler);
  }

  public onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  public terminate(): void {
    this.terminated = true;
  }
}

describe('Phase 2 — EngineClient, Thread Detection, Priority Queue & Cache', () => {
  it('detects cross-origin isolation and selects multi-threaded vs single-threaded fallback', () => {
    const isolated = detectEngineCapabilities({
      crossOriginIsolated: true,
      sharedArrayBufferAvailable: true,
      hardwareConcurrency: 8,
      deviceMemory: 8,
    });
    expect(isolated.multiThreadedSupported).toBe(true);
    expect(isolated.recommendedVariant).toBe('multi-threaded');
    expect(isolated.recommendedThreads).toBe(4);
    expect(isolated.recommendedHashMb).toBe(64);

    const nonIsolated = detectEngineCapabilities({
      crossOriginIsolated: false,
      sharedArrayBufferAvailable: true,
      hardwareConcurrency: 8,
    });
    expect(nonIsolated.multiThreadedSupported).toBe(false);
    expect(nonIsolated.recommendedVariant).toBe('single-threaded');
    expect(nonIsolated.recommendedThreads).toBe(1);
    expect(nonIsolated.recommendedHashMb).toBe(16);
  });

  it('falls back to single-threaded automatically if multi-threaded worker fails on init', async () => {
    const requestedVariants: EngineVariant[] = [];
    const client = new EngineClient({
      variant: 'auto',
      transportFactory: (variant) => {
        requestedVariants.push(variant);
        const mock = new MockStockfishTransport(variant);
        if (variant === 'multi-threaded') {
          queueMicrotask(() => {
            mock.emitError(new Error('SharedArrayBuffer blocked'));
          });
          mock.send = () => {};
        }
        return mock;
      },
    });

    // Force initial attempt as multi-threaded
    (client as unknown as { activeVariant: EngineVariant }).activeVariant =
      'multi-threaded';

    await client.init();
    expect(requestedVariants).toEqual(['multi-threaded', 'single-threaded']);
    expect(client.getVariant()).toBe('single-threaded');
    expect(client.getThreads()).toBe(1);
    client.terminate();
  });

  it('streams MultiPV lines, caches results by (normalized FEN, depth, multipv), and reports hit rate', async () => {
    let mockTransport!: MockStockfishTransport;
    const telemetryEvents: Array<{ depth: number; nps: number }> = [];
    const cacheLookups: boolean[] = [];

    const client = new EngineClient({
      variant: 'single-threaded',
      transportFactory: (v) => {
        mockTransport = new MockStockfishTransport(v);
        return mockTransport;
      },
      onTelemetry: (t) => {
        telemetryEvents.push({ depth: t.depth, nps: t.nps });
      },
      onCacheLookup: (hit) => {
        cacheLookups.push(hit);
      },
    });

    const streamedSnapshots: EngineAnalysisResult[] = [];
    const res1 = await client.analyze({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      depth: 10,
      multipv: 2,
      onInfo: (snap) => streamedSnapshots.push(snap),
    });

    expect(res1.cached).toBe(false);
    expect(res1.bestMove).toBe('e2e4');
    expect(res1.lines).toHaveLength(2);
    expect(res1.lines[0]?.pv).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(res1.lines[1]?.pv).toEqual(['d2d4', 'd7d5', 'c2c4']);
    expect(streamedSnapshots.length).toBeGreaterThanOrEqual(2);
    expect(telemetryEvents.some((e) => e.depth === 10 && e.nps === 480000)).toBe(
      true,
    );

    const commandsBeforeSecondCall = mockTransport.sentCommands.length;

    // Same normalized 4-field FEN with different move counters -> should hit cache!
    const res2 = await client.analyze({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 4 12',
      depth: 10,
      multipv: 2,
    });

    expect(res2.cached).toBe(true);
    expect(res2.bestMove).toBe('e2e4');
    expect(mockTransport.sentCommands.length).toBe(commandsBeforeSecondCall);
    expect(cacheLookups).toEqual([false, true]);
    expect(client.getCacheStats().hitRate).toBe(50);

    client.terminate();
  });

  it('executes queued tasks in strict priority order (live > review > background) and supports cancellation', async () => {
    let mockTransport!: MockStockfishTransport;
    const client = new EngineClient({
      variant: 'single-threaded',
      transportFactory: (v) => {
        mockTransport = new MockStockfishTransport(v);
        mockTransport.autoRespondSearch = false;
        return mockTransport;
      },
    });

    await client.init();

    const executionOrder: string[] = [];
    let currentGoCount = 0;

    const origSend = mockTransport.send.bind(mockTransport);
    mockTransport.send = (cmd: string) => {
      origSend(cmd);
      if (cmd.startsWith('go ')) {
        currentGoCount++;
        const goIndex = currentGoCount;
        setTimeout(() => {
          mockTransport.emit(
            `info depth 8 multipv 1 score cp ${goIndex * 10} nodes 1000 nps 100000 time 10 pv e2e4`,
          );
          mockTransport.emit('bestmove e2e4');
        }, 15);
      }
    };

    // Enqueue 4 tasks simultaneously while engine starts first task:
    // 1. background-1 (starts immediately because queue is idle)
    // 2. background-2 (queued)
    // 3. review-1 (queued -> should jump ahead of background-2)
    // 4. live-1 (queued -> should jump ahead of both review-1 and background-2)
    // 5. cancelled-review (queued then immediately aborted via AbortController)
    const abortCtrl = new AbortController();

    const pBg1 = client
      .analyze({
        id: 'bg-1',
        priority: 'background',
        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        depth: 6,
        useCache: false,
      })
      .then(() => executionOrder.push('bg-1'));

    const pBg2 = client
      .analyze({
        id: 'bg-2',
        priority: 'background',
        fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        depth: 6,
        useCache: false,
      })
      .then(() => executionOrder.push('bg-2'));

    const pRev1 = client
      .analyze({
        id: 'review-1',
        priority: 'review',
        fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
        depth: 6,
        useCache: false,
      })
      .then(() => executionOrder.push('review-1'));

    const pCancelled = client.analyze({
      id: 'cancelled-review',
      priority: 'review',
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      depth: 6,
      useCache: false,
      signal: abortCtrl.signal,
    });

    const pLive1 = client
      .analyze({
        id: 'live-1',
        priority: 'live',
        fen: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
        depth: 6,
        useCache: false,
      })
      .then(() => executionOrder.push('live-1'));

    abortCtrl.abort();

    await expect(pCancelled).rejects.toThrow(EngineCancelledError);
    await Promise.all([pBg1, pBg2, pRev1, pLive1]);

    expect(executionOrder).toEqual(['bg-1', 'live-1', 'review-1', 'bg-2']);
    client.terminate();
  });

  it('evicts oldest entries in AnalysisCache according to LRU policy', () => {
    const cache = new AnalysisCache({ maxEntries: 16 });
    for (let i = 0; i < 20; i++) {
      const fen = `4k3/8/8/8/8/8/8/4K3 w - - ${i} ${i + 1}`;
      cache.set(fen, i + 1, 1, {
        fen,
        normalizedFen: normalizeFenForCache(fen),
        depth: i + 1,
        multipv: 1,
        bestMove: 'e1e2',
        ponder: null,
        lines: [],
        nodes: 100,
        nps: 1000,
        timeMs: 1,
        cached: false,
      });
    }
    expect(cache.getStats().size).toBe(16);
    expect(cache.has('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 1, 1)).toBe(false);
    expect(cache.has('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 20, 1)).toBe(true);
  });
  it('changing threads restarts the worker and resumes the running analysis on the new one', async () => {
    const transports: MockStockfishTransport[] = [];
    const client = new EngineClient({
      variant: 'multi-threaded',
      threads: 4,
      transportFactory: (variant) => {
        const mock = new MockStockfishTransport(variant);
        mock.autoRespondSearch = false; // infinite search: lines only when we emit them
        transports.push(mock);
        return mock;
      },
    });
    await client.init();

    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const infos: EngineAnalysisResult[] = [];
    const analysis = client.analyze({
      fen,
      infinite: true,
      multipv: 3,
      priority: 'background',
      useCache: false,
      onInfo: (snap) => infos.push(snap),
    });
    await new Promise((r) => setTimeout(r, 0));
    const first = transports[0]!;
    expect(first.sentCommands).toContain('go infinite');
    first.emit('info depth 12 multipv 1 score cp 20 nodes 1000 nps 100000 time 10 pv e7e5');

    await client.configure({ threads: 2 });

    // The old worker never received a live Threads change; it was terminated instead
    expect(first.sentCommands.filter((c) => c.startsWith('setoption name Threads'))).toEqual([
      'setoption name Threads value 4',
    ]);
    expect(first.terminated).toBe(true);
    expect(client.getThreads()).toBe(2);

    // The new worker booted with 2 threads and resumed the same search
    expect(transports).toHaveLength(2);
    const second = transports[1]!;
    expect(second.sentCommands).toContain('setoption name Threads value 2');
    expect(second.sentCommands).toContain('setoption name MultiPV value 3');
    expect(second.sentCommands).toContain(`position fen ${fen}`);
    expect(second.sentCommands).toContain('go infinite');

    // Late output from the old worker is ignored; the new worker's output streams through
    first.emit('info depth 30 multipv 1 score cp 999 nodes 1 nps 1 time 1 pv a7a6');
    second.emit('info depth 8 multipv 1 score cp 25 nodes 500 nps 90000 time 5 pv c7c5');
    expect(infos.at(-1)?.lines[0]?.pv[0]).toBe('c7c5');
    expect(infos.at(-1)?.depth).toBe(8);

    // Same promise, finished by the new worker
    client.stopActiveSearch();
    second.emit('bestmove c7c5');
    const result = await analysis;
    expect(result.bestMove).toBe('c7c5');
    expect(result.multipv).toBe(3);

    // An unchanged value is a no-op: no third worker
    await client.configure({ threads: 2 });
    expect(transports).toHaveLength(2);
    client.terminate();
  });

  it('turns scores into White view from the side to move after request.moves', async () => {
    const client = new EngineClient({
      variant: 'single-threaded',
      transportFactory: (v) => new MockStockfishTransport(v),
    });
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    // The mock always reports cp +32 for the side to move
    const whiteToMove = await client.analyze({ fen: start, moves: ['e2e4', 'e7e5'], depth: 10, multipv: 1 });
    expect(whiteToMove.lines[0]?.scoreWhite).toEqual({ type: 'cp', value: 32 });
    const blackToMove = await client.analyze({ fen: start, moves: ['e2e4'], depth: 10, multipv: 1 });
    expect(blackToMove.lines[0]?.scoreWhite).toEqual({ type: 'cp', value: -32 });
    client.terminate();
  });
});
