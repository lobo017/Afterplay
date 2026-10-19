import type { PuzzleEntry } from '../core/datasets';
import type { ThemeCount } from './puzzle-dataset';

export type DatasetRequestMessage =
  | { id: number; kind: 'info' }
  | { id: number; kind: 'pick'; theme: string | null; targetRating: number; exclude: string[] }
  | { id: number; kind: 'get'; puzzleId: string };

export type DatasetResponseMessage =
  | { id: number; kind: 'info'; size: number; themes: ThemeCount[] }
  | { id: number; kind: 'puzzle'; puzzle: PuzzleEntry | null }
  | { id: number; kind: 'error'; message: string };

/** A request without its id (distributes over the union). */
type DatasetRequestBody = DatasetRequestMessage extends infer M ? (M extends DatasetRequestMessage ? Omit<M, 'id'> : never) : never;

export interface DatasetInfo {
  size: number;
  themes: ThemeCount[];
}

/**
 * The page's side of the bundled-puzzle worker. The worker (and with it the dataset chunk) is
 * only created by the first request, i.e. when puzzles are first opened.
 */
export class PuzzleDatasetClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (msg: DatasetResponseMessage) => void; reject: (err: Error) => void }>();
  private infoPromise: Promise<DatasetInfo> | null = null;

  /** Whether the worker has been started. */
  public get started(): boolean {
    return this.worker !== null;
  }

  public info(): Promise<DatasetInfo> {
    this.infoPromise ??= this.request({ kind: 'info' }).then((msg) => {
      if (msg.kind !== 'info') throw new Error('Unexpected answer from the puzzle worker');
      return { size: msg.size, themes: msg.themes };
    });
    return this.infoPromise;
  }

  public async pick(theme: string | null, targetRating: number, exclude: readonly string[]): Promise<PuzzleEntry | null> {
    const msg = await this.request({ kind: 'pick', theme, targetRating, exclude: [...exclude] });
    if (msg.kind !== 'puzzle') throw new Error('Unexpected answer from the puzzle worker');
    return msg.puzzle;
  }

  public async get(puzzleId: string): Promise<PuzzleEntry | null> {
    const msg = await this.request({ kind: 'get', puzzleId });
    if (msg.kind !== 'puzzle') throw new Error('Unexpected answer from the puzzle worker');
    return msg.puzzle;
  }

  public terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.infoPromise = null;
    for (const p of this.pending.values()) p.reject(new Error('The puzzle worker was stopped'));
    this.pending.clear();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./puzzle-dataset.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (e: MessageEvent<DatasetResponseMessage>) => {
      const entry = this.pending.get(e.data.id);
      if (!entry) return;
      this.pending.delete(e.data.id);
      if (e.data.kind === 'error') entry.reject(new Error(e.data.message));
      else entry.resolve(e.data);
    });
    worker.addEventListener('error', (e) => {
      const err = new Error(`The puzzle worker failed: ${e.message || 'could not load'}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
      this.infoPromise = null;
    });
    this.worker = worker;
    return worker;
  }

  private request(body: DatasetRequestBody): Promise<DatasetResponseMessage> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...body, id } as DatasetRequestMessage);
    });
  }
}
