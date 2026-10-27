import { DEFAULT_POSITION, validateChessFen, type Color } from '../core/rules';
import {
  AnalysisCache,
  normalizeFenForCache,
  type CacheStats,
  type EngineAnalysisResult,
  type EngineLine,
} from './cache';
import {
  parseUciLine,
  scoreForWhite,
  scoreToCentipawns,
  type UciInfoSearchMessage,
  type UciOptionMessage,
  type UciScore,
} from './uci-parser';

export { AnalysisCache, normalizeFenForCache };
export type { CacheStats, EngineAnalysisResult, EngineLine };

export const MULTI_THREADED_STOCKFISH_FILE = 'stockfish-17.1-lite-51f59da.js';
export const SINGLE_THREADED_STOCKFISH_FILE = 'stockfish-17.1-lite-single-03e3232.js';

export const MULTI_THREADED_ENGINE_URL = `/stockfish/${MULTI_THREADED_STOCKFISH_FILE}`;
export const SINGLE_THREADED_ENGINE_URL = `/stockfish/${SINGLE_THREADED_STOCKFISH_FILE}`;

export type EngineVariant = 'multi-threaded' | 'single-threaded';
export type EnginePriority = 'live' | 'review' | 'background';

const PRIORITY_RANK: Record<EnginePriority, number> = {
  live: 3,
  review: 2,
  background: 1,
};

export interface EngineCapabilities {
  crossOriginIsolated: boolean;
  sharedArrayBufferAvailable: boolean;
  multiThreadedSupported: boolean;
  hardwareConcurrency: number;
  recommendedVariant: EngineVariant;
  recommendedThreads: number;
  recommendedHashMb: number;
}

export interface EngineTelemetry {
  variant: EngineVariant;
  engineName: string;
  threads: number;
  hashMb: number;
  depth: number;
  nps: number;
  nodes: number;
  multipv: number;
}

export interface EngineTransport {
  send(command: string): void;
  onMessage(handler: (line: string) => void): void;
  onError(handler: (error: Error) => void): void;
  terminate(): void;
}

export interface EngineClientOptions {
  variant?: 'auto' | EngineVariant;
  threads?: number;
  hashMb?: number;
  cache?: AnalysisCache;
  transportFactory?: (variant: EngineVariant, scriptUrl: string) => EngineTransport;
  onTelemetry?: (telemetry: EngineTelemetry) => void;
  onCacheLookup?: (hit: boolean) => void;
  initTimeoutMs?: number;
}

export interface EngineAnalyzeRequest {
  id?: string;
  priority?: EnginePriority;
  fen?: string;
  moves?: string[];
  depth?: number;
  nodes?: number;
  movetime?: number;
  infinite?: boolean;
  multipv?: number;
  chess960?: boolean;
  searchMoves?: string[];
  skillLevel?: number;
  uciLimitStrength?: boolean;
  uciElo?: number;
  resetGame?: boolean;
  useCache?: boolean;
  preempt?: boolean;
  signal?: AbortSignal;
  onInfo?: (snapshot: EngineAnalysisResult) => void;
}

export interface EnginePerftRequest {
  id?: string;
  priority?: EnginePriority;
  fen?: string;
  depth: number;
  chess960?: boolean;
  signal?: AbortSignal;
}

export interface EnginePerftResult {
  fen: string;
  depth: number;
  nodes: number;
  divide: Record<string, number>;
  timeMs: number;
}

export class EngineCancelledError extends Error {
  public readonly taskId: string;

  constructor(taskId: string, message = 'Engine task was cancelled') {
    super(message);
    this.name = 'EngineCancelledError';
    this.taskId = taskId;
  }
}

/**
 * Detects cross-origin isolation, SharedArrayBuffer availability, and optimal thread/hash defaults.
 */
export function detectEngineCapabilities(envOverride?: {
  crossOriginIsolated?: boolean;
  sharedArrayBufferAvailable?: boolean;
  hardwareConcurrency?: number;
  deviceMemory?: number;
}): EngineCapabilities {
  const crossOriginIsolated =
    envOverride?.crossOriginIsolated ??
    (typeof globalThis !== 'undefined' &&
      Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated));

  const sharedArrayBufferAvailable =
    envOverride?.sharedArrayBufferAvailable ?? typeof SharedArrayBuffer !== 'undefined';

  const multiThreadedSupported = crossOriginIsolated && sharedArrayBufferAvailable;

  const hardwareConcurrency = Math.max(
    1,
    envOverride?.hardwareConcurrency ??
      (typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 1),
  );

  const deviceMemory =
    envOverride?.deviceMemory ??
    (typeof navigator !== 'undefined' &&
    'deviceMemory' in navigator &&
    typeof (navigator as { deviceMemory?: number }).deviceMemory === 'number'
      ? (navigator as { deviceMemory: number }).deviceMemory
      : 4);

  const recommendedVariant: EngineVariant = multiThreadedSupported ? 'multi-threaded' : 'single-threaded';

  const recommendedThreads = multiThreadedSupported
    ? Math.max(1, Math.min(4, hardwareConcurrency > 2 ? hardwareConcurrency - 1 : hardwareConcurrency))
    : 1;

  const recommendedHashMb = multiThreadedSupported ? (deviceMemory >= 8 ? 64 : 32) : 16;

  return {
    crossOriginIsolated,
    sharedArrayBufferAvailable,
    multiThreadedSupported,
    hardwareConcurrency,
    recommendedVariant,
    recommendedThreads,
    recommendedHashMb,
  };
}

/**
 * Default browser Web Worker transport for Stockfish WASM.
 */
export function createBrowserWorkerTransport(_variant: EngineVariant, scriptUrl: string): EngineTransport {
  const worker = new Worker(scriptUrl);
  const messageHandlers: Array<(line: string) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];

  worker.onmessage = (event: MessageEvent<unknown>) => {
    const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      for (const h of messageHandlers) {
        h(line);
      }
    }
  };

  worker.onerror = (event: ErrorEvent) => {
    const err = event.error instanceof Error ? event.error : new Error(event.message || `Worker error in ${scriptUrl}`);
    for (const h of errorHandlers) {
      h(err);
    }
  };

  return {
    send(command: string) {
      worker.postMessage(command);
    },
    onMessage(handler: (line: string) => void) {
      messageHandlers.push(handler);
    },
    onError(handler: (error: Error) => void) {
      errorHandlers.push(handler);
    },
    terminate() {
      worker.terminate();
    },
  };
}

interface QueuedAnalyzeTask {
  kind: 'analyze';
  id: string;
  priority: EnginePriority;
  priorityRank: number;
  seq: number;
  request: EngineAnalyzeRequest;
  fen: string;
  sideToMove: Color;
  multipv: number;
  chess960: boolean;
  cacheable: boolean;
  cancelled: boolean;
  stoppingToResolve: boolean;
  startedAt: number;
  linesByMultiPv: Map<number, EngineLine>;
  maxDepth: number;
  latestNps: number;
  latestNodes: number;
  latestTimeMs: number;
  abortHandler?: () => void;
  resolve: (res: EngineAnalysisResult) => void;
  reject: (err: Error) => void;
}

interface QueuedPerftTask {
  kind: 'perft';
  id: string;
  priority: EnginePriority;
  priorityRank: number;
  seq: number;
  request: EnginePerftRequest;
  fen: string;
  depth: number;
  chess960: boolean;
  cancelled: boolean;
  startedAt: number;
  divide: Record<string, number>;
  abortHandler?: () => void;
  resolve: (res: EnginePerftResult) => void;
  reject: (err: Error) => void;
}

type QueuedTask = QueuedAnalyzeTask | QueuedPerftTask;

function extractSideToMove(fen: string, movesPlayed = 0): Color {
  let side: Color = 'w';
  if (fen && fen.trim().toLowerCase() !== 'startpos') {
    const parts = fen.trim().split(/\s+/);
    side = parts[1] === 'b' ? 'b' : 'w';
  }
  // `position fen … moves …` searches the position after those moves
  return movesPlayed % 2 === 1 ? (side === 'w' ? 'b' : 'w') : side;
}

function detectChess960Need(fen: string, explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') {
    return explicit;
  }
  if (!fen || fen.trim().toLowerCase() === 'startpos') {
    return false;
  }
  const validation = validateChessFen(fen);
  return Boolean(validation.isChess960);
}

export class EngineClient {
  private readonly options: EngineClientOptions;
  private readonly cache: AnalysisCache;
  private transport: EngineTransport | null = null;
  private transportGeneration = 0;
  private activeVariant: EngineVariant;
  private engineName = 'Stockfish 17.1 Lite WASM';
  private engineAuthor = 'the Stockfish developers';
  private uciOptions = new Map<string, UciOptionMessage>();
  private configuredThreads: number;
  private configuredHashMb: number;
  private appliedOptions = {
    multipv: 1,
    chess960: false,
    skillLevel: 20,
    uciLimitStrength: false,
    uciElo: 1320,
  };

  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private destroyed = false;

  private taskSeq = 0;
  private readonly queue: QueuedTask[] = [];
  private activeTask: QueuedTask | null = null;
  private activePhase: 'idle' | 'configuring' | 'searching' | 'stopping' = 'idle';
  private readyWaiters: Array<() => void> = [];

  private latestDepth = 0;
  private latestNps = 0;
  private latestNodes = 0;

  constructor(options?: EngineClientOptions) {
    this.options = options ?? {};
    const caps = detectEngineCapabilities();
    this.activeVariant = options?.variant && options.variant !== 'auto' ? options.variant : caps.recommendedVariant;

    this.configuredThreads =
      this.activeVariant === 'single-threaded' ? 1 : Math.max(1, options?.threads ?? caps.recommendedThreads);

    this.configuredHashMb = Math.max(1, options?.hashMb ?? caps.recommendedHashMb);

    this.cache =
      options?.cache ??
      new AnalysisCache({
        onLookup: (hit) => {
          this.options.onCacheLookup?.(hit);
        },
      });
  }

  public getVariant(): EngineVariant {
    return this.activeVariant;
  }

  public getScriptUrl(variant: EngineVariant = this.activeVariant): string {
    return variant === 'multi-threaded' ? MULTI_THREADED_ENGINE_URL : SINGLE_THREADED_ENGINE_URL;
  }

  public getEngineName(): string {
    return this.engineName;
  }

  public getEngineAuthor(): string {
    return this.engineAuthor;
  }

  public getUciOptions(): ReadonlyMap<string, UciOptionMessage> {
    return this.uciOptions;
  }

  public getThreads(): number {
    return this.configuredThreads;
  }

  public getHashMb(): number {
    return this.configuredHashMb;
  }

  public getCache(): AnalysisCache {
    return this.cache;
  }

  public getCacheStats(): CacheStats {
    return this.cache.getStats();
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public isReady(): boolean {
    return this.initialized && !this.destroyed;
  }

  public getTelemetry(): EngineTelemetry {
    return {
      variant: this.activeVariant,
      engineName: this.engineName,
      threads: this.configuredThreads,
      hashMb: this.configuredHashMb,
      depth: this.latestDepth,
      nps: this.latestNps,
      nodes: this.latestNodes,
      multipv: this.appliedOptions.multipv,
    };
  }

  /**
   * Initializes the Stockfish worker (with automatic fallback to single-threaded if 'auto' fails).
   */
  public async init(): Promise<void> {
    if (this.destroyed) {
      throw new Error('EngineClient has been terminated');
    }
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.performInit();
    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      throw err;
    }
  }

  private async performInit(): Promise<void> {
    const requested = this.options.variant ?? 'auto';
    if (requested === 'auto' && this.activeVariant === 'multi-threaded') {
      try {
        await this.bootVariant('multi-threaded');
        return;
      } catch {
        // Automatic fallback to single-threaded Stockfish if multi-threaded fails to boot
        this.cleanupTransport();
        this.activeVariant = 'single-threaded';
        this.configuredThreads = 1;
        this.configuredHashMb = Math.min(this.configuredHashMb, 16);
        await this.bootVariant('single-threaded');
        return;
      }
    }

    await this.bootVariant(this.activeVariant);
  }

  private async bootVariant(variant: EngineVariant): Promise<void> {
    this.activeVariant = variant;
    if (variant === 'single-threaded') {
      this.configuredThreads = 1;
    }

    const scriptUrl = this.getScriptUrl(variant);
    const factory = this.options.transportFactory ?? createBrowserWorkerTransport;
    const transport = factory(variant, scriptUrl);
    this.transport = transport;
    // Lines from a replaced worker must never reach the tasks of the next one
    const generation = ++this.transportGeneration;
    const isCurrent = () => generation === this.transportGeneration;
    this.uciOptions.clear();

    const timeoutMs = this.options.initTimeoutMs ?? 15000;

    await new Promise<void>((resolve, reject) => {
      let uciOkReceived = false;
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for Stockfish (${variant}) initialization after ${timeoutMs}ms`));
      }, timeoutMs);

      transport.onError((err) => {
        if (!isCurrent()) return;
        if (!this.initialized) {
          clearTimeout(timer);
          reject(err);
        } else {
          this.handleRuntimeTransportError(err);
        }
      });

      transport.onMessage((line) => {
        if (!isCurrent()) return;
        if (!uciOkReceived) {
          const parsed = parseUciLine(line);
          if (!parsed) return;
          if (parsed.type === 'id') {
            if (parsed.field === 'name') this.engineName = parsed.value;
            if (parsed.field === 'author') this.engineAuthor = parsed.value;
          } else if (parsed.type === 'option') {
            this.uciOptions.set(parsed.name, parsed);
          } else if (parsed.type === 'uciok') {
            uciOkReceived = true;
            const threadsOpt = this.uciOptions.get('Threads');
            const maxThreads = threadsOpt?.max ?? (variant === 'multi-threaded' ? 32 : 1);
            this.configuredThreads = Math.max(1, Math.min(maxThreads, this.configuredThreads));
            if (maxThreads > 1 || this.configuredThreads > 1) {
              transport.send(`setoption name Threads value ${this.configuredThreads}`);
            }
            transport.send(`setoption name Hash value ${this.configuredHashMb}`);
            transport.send('isready');
          }
          return;
        }

        if (!this.initialized) {
          const parsed = parseUciLine(line);
          if (parsed?.type === 'readyok') {
            clearTimeout(timer);
            this.initialized = true;
            this.emitTelemetry();
            resolve();
            return;
          }
        }

        this.handleEngineLine(line);
      });

      transport.send('uci');
    });
  }

  /**
   * Changes Threads or Hash size by restarting the Stockfish worker with the new values.
   *
   * These options are never sent to a live engine: `setoption name Threads` on the
   * running multi-threaded WASM build hangs the page and then crashes it, even with an
   * unchanged value (and Hash resizes the same shared memory). Instead the worker is
   * stopped, terminated and booted again, and the search that was running continues on
   * the new worker (same position, MultiPV and callbacks; its promise stays pending).
   */
  public async configure(config: { threads?: number; hashMb?: number }): Promise<void> {
    await this.init();

    let threads = this.configuredThreads;
    if (typeof config.threads === 'number' && this.activeVariant === 'multi-threaded') {
      const maxThreads = this.uciOptions.get('Threads')?.max ?? 32;
      threads = Math.max(1, Math.min(maxThreads, Math.floor(config.threads)));
    }
    const hashMb =
      typeof config.hashMb === 'number'
        ? Math.max(1, Math.min(1024, Math.floor(config.hashMb)))
        : this.configuredHashMb;

    if (threads === this.configuredThreads && hashMb === this.configuredHashMb) {
      return;
    }
    this.configuredThreads = threads;
    this.configuredHashMb = hashMb;
    await this.restartWorker();
  }

  /**
   * Replaces the Stockfish worker with a fresh one booted with the current configuration
   * (variant, Threads, Hash). The active search is handed to the new worker: it goes back
   * to the front of the queue with its results cleared, and runs again from scratch.
   */
  private async restartWorker(): Promise<void> {
    const active = this.activeTask;
    this.activeTask = null;
    this.activePhase = 'idle';

    if (active) {
      if (active.cancelled && !(active.kind === 'analyze' && active.stoppingToResolve)) {
        // Already cancelled: it was only waiting for the old worker's bestmove
        active.abortHandler?.();
        active.reject(new EngineCancelledError(active.id));
      } else if (active.kind === 'analyze' && active.stoppingToResolve) {
        // stopActiveSearch() asked for the result so far: deliver it now
        active.abortHandler?.();
        active.resolve(this.buildTaskSnapshot(active, null, null));
      } else {
        if (active.kind === 'analyze') {
          active.linesByMultiPv.clear();
          active.maxDepth = 0;
          active.latestNodes = 0;
          active.latestNps = 0;
          active.latestTimeMs = 0;
        } else {
          active.divide = {};
        }
        this.queue.unshift(active);
      }
    }

    // Waiters on the old worker's readyok would never be answered
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const resolveWaiter of waiters) resolveWaiter();

    this.cleanupTransport();
    this.initialized = false;
    this.initPromise = null;
    // A new engine starts with its own defaults; tasks re-apply what they need
    this.appliedOptions = {
      multipv: 1,
      chess960: false,
      skillLevel: 20,
      uciLimitStrength: false,
      uciElo: 1320,
    };

    await this.init();
    this.emitTelemetry();
    this.pumpQueue();
  }

  public async newGame(): Promise<void> {
    await this.init();
    if (!this.transport) return;
    this.transport.send('ucinewgame');
    await this.waitForReadyOk();
  }

  /**
   * Enqueues a Stockfish analysis task with priority ordering, streaming MultiPV info,
   * result caching, and AbortSignal / ID cancellation.
   */
  public async analyze(request: EngineAnalyzeRequest): Promise<EngineAnalysisResult> {
    const taskId = request.id ?? `analyze-${++this.taskSeq}`;
    if (request.signal?.aborted) {
      throw new EngineCancelledError(taskId);
    }

    const fen = request.fen?.trim() || DEFAULT_POSITION;
    const multipv = Math.max(1, Math.min(12, Math.floor(request.multipv ?? 1)));
    const priority: EnginePriority = request.priority ?? 'live';
    const chess960 = detectChess960Need(fen, request.chess960);

    const isFullStrength = !request.uciLimitStrength && (request.skillLevel === undefined || request.skillLevel >= 20);
    const hasCustomMoves =
      Boolean(request.moves && request.moves.length > 0) ||
      Boolean(request.searchMoves && request.searchMoves.length > 0);
    const hasNodeLimit = typeof request.nodes === 'number' && request.nodes > 0;
    const targetDepth = !request.infinite && !request.movetime && !hasNodeLimit ? (request.depth ?? 14) : request.depth;

    const cacheable =
      request.useCache !== false &&
      !request.resetGame &&
      !hasNodeLimit &&
      typeof targetDepth === 'number' &&
      isFullStrength &&
      !hasCustomMoves;

    if (cacheable && targetDepth !== undefined) {
      const cached = this.cache.get(fen, targetDepth, multipv);
      if (cached) {
        this.latestDepth = cached.depth;
        this.latestNps = cached.nps;
        this.latestNodes = cached.nodes;
        this.emitTelemetry();
        request.onInfo?.(cached);
        return cached;
      }
    }

    if (!this.initialized) {
      await this.init();
      if (request.signal?.aborted) {
        throw new EngineCancelledError(taskId);
      }
    }

    return new Promise<EngineAnalysisResult>((resolve, reject) => {
      const task: QueuedAnalyzeTask = {
        kind: 'analyze',
        id: taskId,
        priority,
        priorityRank: PRIORITY_RANK[priority],
        seq: ++this.taskSeq,
        request: {
          ...request,
          ...(targetDepth !== undefined ? { depth: targetDepth } : {}),
        },
        fen,
        sideToMove: extractSideToMove(fen, request.moves?.length ?? 0),
        multipv,
        chess960,
        cacheable,
        cancelled: false,
        stoppingToResolve: false,
        startedAt: 0,
        linesByMultiPv: new Map<number, EngineLine>(),
        maxDepth: 0,
        latestNps: 0,
        latestNodes: 0,
        latestTimeMs: 0,
        resolve,
        reject,
      };

      if (request.signal) {
        const onAbort = () => {
          this.cancel(task.id);
        };
        task.abortHandler = () => {
          request.signal?.removeEventListener('abort', onAbort);
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
      }

      // Preempt active search if request.preempt is true or if the active search is an infinite background search
      if (
        this.activeTask &&
        this.activePhase === 'searching' &&
        ((request.preempt && this.activeTask.priorityRank < task.priorityRank) ||
          (this.activeTask.kind === 'analyze' &&
            Boolean(this.activeTask.request.infinite) &&
            this.activeTask.priorityRank <= task.priorityRank))
      ) {
        this.cancel(this.activeTask.id);
      }

      this.enqueueTask(task);
      this.pumpQueue();
    });
  }

  /**
   * Executes Stockfish `go perft <depth>` for exact legal move tree cross-checking.
   */
  public async perft(request: EnginePerftRequest): Promise<EnginePerftResult> {
    const taskId = request.id ?? `perft-${++this.taskSeq}`;
    if (request.signal?.aborted) {
      throw new EngineCancelledError(taskId);
    }

    const fen = request.fen?.trim() || DEFAULT_POSITION;
    const depth = Math.max(1, Math.floor(request.depth));
    const priority: EnginePriority = request.priority ?? 'live';
    const chess960 = detectChess960Need(fen, request.chess960);

    if (!this.initialized) {
      await this.init();
      if (request.signal?.aborted) {
        throw new EngineCancelledError(taskId);
      }
    }

    return new Promise<EnginePerftResult>((resolve, reject) => {
      const task: QueuedPerftTask = {
        kind: 'perft',
        id: taskId,
        priority,
        priorityRank: PRIORITY_RANK[priority],
        seq: ++this.taskSeq,
        request,
        fen,
        depth,
        chess960,
        cancelled: false,
        startedAt: 0,
        divide: {},
        resolve,
        reject,
      };

      if (request.signal) {
        const onAbort = () => {
          this.cancel(task.id);
        };
        task.abortHandler = () => {
          request.signal?.removeEventListener('abort', onAbort);
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.enqueueTask(task);
      this.pumpQueue();
    });
  }

  /**
   * Stops the currently active search so it resolves with the best move/lines found so far.
   */
  public stopActiveSearch(): void {
    if (this.activeTask && this.activeTask.kind === 'analyze' && this.activePhase === 'searching' && this.transport) {
      this.activeTask.stoppingToResolve = true;
      this.activePhase = 'stopping';
      this.transport.send('stop');
    }
  }

  /**
   * Cancels a queued or active task by ID.
   */
  public cancel(taskId: string): boolean {
    const qIdx = this.queue.findIndex((t) => t.id === taskId);
    if (qIdx !== -1) {
      const [removed] = this.queue.splice(qIdx, 1);
      if (removed) {
        removed.cancelled = true;
        removed.abortHandler?.();
        removed.reject(new EngineCancelledError(removed.id));
      }
      return true;
    }

    if (this.activeTask && this.activeTask.id === taskId) {
      this.activeTask.cancelled = true;
      this.activeTask.abortHandler?.();
      if (this.activePhase === 'searching' && this.transport) {
        this.activePhase = 'stopping';
        this.transport.send('stop');
      }
      return true;
    }

    return false;
  }

  /**
   * Cancels all queued tasks and aborts any active search.
   */
  public cancelAll(): void {
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      task.cancelled = true;
      task.abortHandler?.();
      task.reject(new EngineCancelledError(task.id));
    }

    if (this.activeTask) {
      this.cancel(this.activeTask.id);
    }
  }

  /**
   * Terminates the underlying Stockfish worker and rejects any pending tasks.
   */
  public terminate(): void {
    this.destroyed = true;
    this.initialized = false;
    this.initPromise = null;

    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      task.abortHandler?.();
      task.reject(new EngineCancelledError(task.id, 'EngineClient terminated'));
    }

    if (this.activeTask) {
      const active = this.activeTask;
      this.activeTask = null;
      this.activePhase = 'idle';
      active.abortHandler?.();
      active.reject(new EngineCancelledError(active.id, 'EngineClient terminated'));
    }

    this.cleanupTransport();
  }

  private cleanupTransport(): void {
    if (this.transport) {
      try {
        this.transport.terminate();
      } catch {
        // Ignore termination errors
      }
      this.transport = null;
    }
  }

  private enqueueTask(task: QueuedTask): void {
    this.queue.push(task);
    this.queue.sort((a, b) => {
      if (b.priorityRank !== a.priorityRank) {
        return b.priorityRank - a.priorityRank;
      }
      return a.seq - b.seq;
    });
  }

  private pumpQueue(): void {
    if (!this.initialized || this.destroyed || !this.transport || this.activeTask !== null || this.queue.length === 0) {
      return;
    }

    const nextTask = this.queue.shift()!;
    if (nextTask.cancelled) {
      this.pumpQueue();
      return;
    }

    this.activeTask = nextTask;
    this.activePhase = 'configuring';
    nextTask.startedAt = performance.now();

    if (nextTask.kind === 'analyze') {
      this.applyTaskOptionsAndStartAnalyze(nextTask);
    } else {
      this.applyTaskOptionsAndStartPerft(nextTask);
    }
  }

  private applyTaskOptionsAndStartAnalyze(task: QueuedAnalyzeTask): void {
    if (!this.transport) return;

    const req = task.request;
    const desiredMultiPv = task.multipv;
    const desiredChess960 = task.chess960;
    const desiredLimitStrength = Boolean(req.uciLimitStrength);
    const desiredElo = Math.max(1320, Math.min(3190, Math.round(req.uciElo ?? 1320)));
    const desiredSkill = Math.max(0, Math.min(20, Math.round(req.skillLevel ?? 20)));

    if (req.resetGame) {
      this.transport.send('ucinewgame');
    }

    if (this.appliedOptions.multipv !== desiredMultiPv) {
      this.transport.send(`setoption name MultiPV value ${desiredMultiPv}`);
      this.appliedOptions.multipv = desiredMultiPv;
    }

    if (this.appliedOptions.chess960 !== desiredChess960) {
      this.transport.send(`setoption name UCI_Chess960 value ${desiredChess960 ? 'true' : 'false'}`);
      this.appliedOptions.chess960 = desiredChess960;
    }

    if (this.appliedOptions.uciLimitStrength !== desiredLimitStrength) {
      this.transport.send(`setoption name UCI_LimitStrength value ${desiredLimitStrength ? 'true' : 'false'}`);
      this.appliedOptions.uciLimitStrength = desiredLimitStrength;
    }

    if (desiredLimitStrength && this.appliedOptions.uciElo !== desiredElo) {
      this.transport.send(`setoption name UCI_Elo value ${desiredElo}`);
      this.appliedOptions.uciElo = desiredElo;
    }

    if (this.appliedOptions.skillLevel !== desiredSkill) {
      this.transport.send(`setoption name Skill Level value ${desiredSkill}`);
      this.appliedOptions.skillLevel = desiredSkill;
    }

    this.waitForReadyOk().then(() => {
      if (this.activeTask !== task || !this.transport) {
        return;
      }
      if (task.cancelled) {
        this.finishCancelledActiveTask(task);
        return;
      }

      this.activePhase = 'searching';
      const posCmd = this.buildPositionCommand(task.fen, task.chess960, req.moves);
      this.transport.send(posCmd);
      this.transport.send(this.buildGoCommand(req));
    });
  }

  private applyTaskOptionsAndStartPerft(task: QueuedPerftTask): void {
    if (!this.transport) return;

    if (this.appliedOptions.chess960 !== task.chess960) {
      this.transport.send(`setoption name UCI_Chess960 value ${task.chess960 ? 'true' : 'false'}`);
      this.appliedOptions.chess960 = task.chess960;
    }

    this.waitForReadyOk().then(() => {
      if (this.activeTask !== task || !this.transport) {
        return;
      }
      if (task.cancelled) {
        this.finishCancelledActiveTask(task);
        return;
      }

      this.activePhase = 'searching';
      const posCmd = this.buildPositionCommand(task.fen, task.chess960);
      this.transport.send(posCmd);
      this.transport.send(`go perft ${task.depth}`);
    });
  }

  private buildPositionCommand(fen: string, chess960: boolean, moves?: string[]): string {
    const isStartPos = !chess960 && (fen.toLowerCase() === 'startpos' || fen === DEFAULT_POSITION);
    const base = isStartPos ? 'position startpos' : `position fen ${fen}`;
    if (moves && moves.length > 0) {
      return `${base} moves ${moves.join(' ')}`;
    }
    return base;
  }

  private buildGoCommand(req: EngineAnalyzeRequest): string {
    const parts = ['go'];
    if (req.infinite) {
      parts.push('infinite');
    } else {
      if (typeof req.movetime === 'number') {
        parts.push(`movetime ${Math.max(1, Math.floor(req.movetime))}`);
      }
      if (typeof req.nodes === 'number' && req.nodes > 0) {
        parts.push(`nodes ${Math.max(1, Math.floor(req.nodes))}`);
      }
      if (
        typeof req.depth === 'number' ||
        (typeof req.movetime !== 'number' && !(typeof req.nodes === 'number' && req.nodes > 0))
      ) {
        parts.push(`depth ${Math.max(1, Math.floor(req.depth ?? 14))}`);
      }
    }

    if (req.searchMoves && req.searchMoves.length > 0) {
      parts.push(`searchmoves ${req.searchMoves.join(' ')}`);
    }

    return parts.join(' ');
  }

  private waitForReadyOk(): Promise<void> {
    if (!this.transport) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.readyWaiters.push(resolve);
      this.transport!.send('isready');
    });
  }

  private handleEngineLine(rawLine: string): void {
    const parsed = parseUciLine(rawLine);
    if (!parsed) return;

    if (parsed.type === 'readyok') {
      const waiter = this.readyWaiters.shift();
      waiter?.();
      return;
    }

    const task = this.activeTask;
    if (!task) return;

    if (task.kind === 'analyze') {
      if (parsed.type === 'info') {
        this.handleAnalyzeInfo(task, parsed);
      } else if (parsed.type === 'bestmove') {
        this.handleAnalyzeBestMove(task, parsed.bestMove, parsed.ponder);
      }
    } else if (task.kind === 'perft') {
      if (parsed.type === 'perft_divide') {
        task.divide[parsed.move] = parsed.nodes;
      } else if (parsed.type === 'perft_total') {
        this.handlePerftTotal(task, parsed.nodes);
      }
    }
  }

  private handleAnalyzeInfo(task: QueuedAnalyzeTask, info: UciInfoSearchMessage): void {
    if (task.cancelled) return;

    if (typeof info.nps === 'number') {
      task.latestNps = info.nps;
      this.latestNps = info.nps;
    }
    if (typeof info.nodes === 'number') {
      task.latestNodes = info.nodes;
      this.latestNodes = info.nodes;
    }
    if (typeof info.timeMs === 'number') {
      task.latestTimeMs = info.timeMs;
    }

    if (typeof info.depth === 'number' && info.score) {
      const mpv = info.multipv ?? 1;
      if (mpv >= 1 && mpv <= task.multipv) {
        const score: UciScore = info.score;
        const scoreWhite = scoreForWhite(score, task.sideToMove);
        const evalCp = scoreToCentipawns(score);
        const existing = task.linesByMultiPv.get(mpv);

        const pv = info.pv.length > 0 ? info.pv : (existing?.pv ?? []);

        const lineObj: EngineLine = {
          multipv: mpv,
          depth: info.depth,
          seldepth: info.seldepth ?? info.depth,
          score,
          scoreWhite,
          evalCp,
          nodes: info.nodes ?? task.latestNodes,
          nps: info.nps ?? task.latestNps,
          timeMs: info.timeMs ?? task.latestTimeMs,
          pv,
          ...(info.wdl ? { wdl: info.wdl } : {}),
        };

        task.linesByMultiPv.set(mpv, lineObj);
        if (info.depth > task.maxDepth) {
          task.maxDepth = info.depth;
          this.latestDepth = info.depth;
        }

        this.emitTelemetry();
        if (task.request.onInfo) {
          task.request.onInfo(this.buildTaskSnapshot(task, null, null));
        }
      }
    }
  }

  private handleAnalyzeBestMove(task: QueuedAnalyzeTask, bestMove: string | null, ponder: string | null): void {
    this.activeTask = null;
    this.activePhase = 'idle';
    task.abortHandler?.();

    if (task.cancelled && !task.stoppingToResolve) {
      task.reject(new EngineCancelledError(task.id));
      this.pumpQueue();
      return;
    }

    const result = this.buildTaskSnapshot(task, bestMove, ponder);

    if (task.cacheable && typeof task.request.depth === 'number' && !task.stoppingToResolve) {
      this.cache.set(task.fen, task.request.depth, task.multipv, result);
    }

    task.resolve(result);
    this.pumpQueue();
  }

  private handlePerftTotal(task: QueuedPerftTask, totalNodes: number): void {
    this.activeTask = null;
    this.activePhase = 'idle';
    task.abortHandler?.();

    if (task.cancelled) {
      task.reject(new EngineCancelledError(task.id));
      this.pumpQueue();
      return;
    }

    const elapsed = Math.max(0, performance.now() - task.startedAt);
    task.resolve({
      fen: task.fen,
      depth: task.depth,
      nodes: totalNodes,
      divide: { ...task.divide },
      timeMs: Number(elapsed.toFixed(2)),
    });
    this.pumpQueue();
  }

  private finishCancelledActiveTask(task: QueuedTask): void {
    this.activeTask = null;
    this.activePhase = 'idle';
    task.abortHandler?.();
    task.reject(new EngineCancelledError(task.id));
    this.pumpQueue();
  }

  private buildTaskSnapshot(
    task: QueuedAnalyzeTask,
    bestMove: string | null,
    ponder: string | null,
  ): EngineAnalysisResult {
    const lines = Array.from(task.linesByMultiPv.values()).sort((a, b) => a.multipv - b.multipv);
    const resolvedBestMove = bestMove ?? lines[0]?.pv[0] ?? null;
    const resolvedPonder = ponder ?? lines[0]?.pv[1] ?? null;
    const elapsed =
      task.latestTimeMs > 0 ? task.latestTimeMs : Math.max(0, Math.round(performance.now() - task.startedAt));

    return {
      fen: task.fen,
      normalizedFen: normalizeFenForCache(task.fen),
      depth: task.maxDepth || (task.request.depth ?? 0),
      multipv: task.multipv,
      bestMove: resolvedBestMove,
      ponder: resolvedPonder,
      lines,
      nodes: task.latestNodes,
      nps: task.latestNps,
      timeMs: elapsed,
      cached: false,
    };
  }

  private handleRuntimeTransportError(err: Error): void {
    if (this.activeTask) {
      const task = this.activeTask;
      this.activeTask = null;
      this.activePhase = 'idle';
      task.abortHandler?.();
      task.reject(err);
    }
    this.pumpQueue();
  }

  private emitTelemetry(): void {
    this.options.onTelemetry?.(this.getTelemetry());
  }
}
