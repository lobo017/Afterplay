import type { ImportBatch, SingleGameCheck } from './pgn-import-core';

export type PgnImportRequest =
  | {
      id: number;
      kind?: 'bulk';
      text: string;
      /** Keys already in the library. */
      known: string[];
    }
  | { id: number; kind: 'single'; pgn: string; method: string | null };

export type PgnImportResponse =
  | { id: number; kind: 'batch'; batch: ImportBatch }
  | { id: number; kind: 'done' }
  | { id: number; kind: 'single'; result: SingleGameCheck }
  | { id: number; kind: 'error'; message: string };

/** Lets other work run between batches when the import runs on the page itself. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Run {
  onBatch: (batch: ImportBatch) => Promise<void>;
  /** The batches handled so far, one after another. */
  chain: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface SingleRun {
  resolve: (result: SingleGameCheck) => void;
  reject: (err: Error) => void;
}

/**
 * The page's side of the bulk PGN import. The worker is started by the first import and kept.
 * Where `Worker` doesn't exist (Node: unit tests), or can't start, the same code runs inline,
 * a batch per task.
 */
export class PgnImportClient {
  private worker: Worker | null = null;
  private unavailable = typeof Worker === 'undefined';
  private nextId = 1;
  private readonly runs = new Map<number, Run>();
  private readonly singles = new Map<number, SingleRun>();

  /** Reads `text`, calling `onBatch` for each group of games, in order; resolves when the last batch is handled. */
  public async run(
    text: string,
    known: ReadonlySet<string>,
    onBatch: (batch: ImportBatch) => Promise<void>,
  ): Promise<void> {
    const worker = this.ensureWorker();
    if (!worker) {
      const { readPgnBatches } = await import('./pgn-import-core');
      for (const batch of readPgnBatches(text, known)) {
        await onBatch(batch);
        await yieldToEventLoop();
      }
      return;
    }
    const id = this.nextId++;
    await new Promise<void>((resolve, reject) => {
      this.runs.set(id, { onBatch, chain: Promise.resolve(), resolve, reject });
      worker.postMessage({ id, text, known: [...known] } satisfies PgnImportRequest);
    });
  }

  /** Checks one game on its own and makes its record with the given capture method (see checkSingleGame). */
  public async checkSingle(pgn: string, method: string | null): Promise<SingleGameCheck> {
    const worker = this.ensureWorker();
    if (!worker) {
      const { checkSingleGame } = await import('./pgn-import-core');
      const result = checkSingleGame(pgn, method);
      await yieldToEventLoop();
      return result;
    }
    const id = this.nextId++;
    return new Promise<SingleGameCheck>((resolve, reject) => {
      this.singles.set(id, { resolve, reject });
      worker.postMessage({ id, kind: 'single', pgn, method } satisfies PgnImportRequest);
    });
  }

  public terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.rejectAll(new Error('The import was stopped'));
  }

  private rejectAll(err: Error): void {
    for (const run of this.runs.values()) run.reject(err);
    this.runs.clear();
    for (const single of this.singles.values()) single.reject(err);
    this.singles.clear();
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (this.unavailable) return null;
    try {
      const worker = new Worker(new URL('./pgn-import.worker.ts', import.meta.url), {
        type: 'module',
        name: 'pgn-import',
      });
      worker.addEventListener('message', (e: MessageEvent<PgnImportResponse>) => this.onMessage(e.data));
      worker.addEventListener('error', (e) => {
        this.unavailable = true;
        this.worker = null;
        this.rejectAll(new Error(`The import worker failed: ${e.message || 'could not load'}`));
      });
      this.worker = worker;
      return worker;
    } catch {
      this.unavailable = true;
      return null;
    }
  }

  private onMessage(msg: PgnImportResponse): void {
    const single = this.singles.get(msg.id);
    if (single) {
      this.singles.delete(msg.id);
      if (msg.kind === 'single') single.resolve(msg.result);
      else single.reject(new Error(msg.kind === 'error' ? msg.message : 'The import worker answered out of turn'));
      return;
    }
    const run = this.runs.get(msg.id);
    if (!run) return;
    if (msg.kind === 'batch') {
      // Batches are handled one at a time, in the order they arrived
      run.chain = run.chain
        .then(() => run.onBatch(msg.batch))
        .catch((err: unknown) => {
          this.runs.delete(msg.id);
          run.reject(err instanceof Error ? err : new Error(String(err)));
        });
      return;
    }
    if (msg.kind === 'error') {
      this.runs.delete(msg.id);
      run.reject(new Error(msg.message));
      return;
    }
    if (msg.kind !== 'done') return;
    void run.chain.then(() => {
      if (this.runs.delete(msg.id)) run.resolve();
    });
  }
}
