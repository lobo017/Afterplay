import { selectHumanLikeMove, type BotMoveDecision, type HumanLikeSelectionRequest } from './bot';

export interface BotSelectionRequestMessage {
  id: number;
  request: HumanLikeSelectionRequest;
  /** Random values pre-drawn from the caller's rng, replayed in order by the worker. */
  randoms: number[];
}

export type BotSelectionResponseMessage =
  | { id: number; kind: 'ok'; decision: BotMoveDecision; consumed: number }
  | { id: number; kind: 'more' }
  | { id: number; kind: 'error'; message: string };

const INITIAL_RANDOM_BUFFER = 8;

class WorkerUnavailableError extends Error {}

/**
 * Runs the bot's human-like move selection (`selectHumanLikeMove`) in a dedicated module
 * worker, so its chess.js candidate scanning (15–40 ms per bot move) never blocks the
 * main thread.
 *
 * The caller's random source is a function and can't cross into the worker, so values
 * are pre-drawn from it, replayed by the worker, and the worker reports how many it used.
 * Unused values are kept per rng and handed out first next time. A seeded rng is thus
 * consumed exactly as if selectHumanLikeMove() had called it directly, and gives the
 * same moves. Requests run one at a time, in order, so concurrent callers sharing an rng
 * can't interleave its stream.
 *
 * Where `Worker` doesn't exist (Node: unit tests, calibration) or the worker fails to
 * start, the selection runs inline with the same buffering.
 */
export class BotSelectionClient {
  private worker: Worker | null = null;
  private workerUnavailable: boolean;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (msg: BotSelectionResponseMessage) => void;
      reject: (err: Error) => void;
    }
  >();
  /** Values drawn from an rng but not yet used, oldest first. */
  private readonly spare = new WeakMap<() => number, number[]>();
  private queue: Promise<unknown> = Promise.resolve();
  private workerSelections = 0;
  private inlineSelections = 0;

  constructor(options?: { useWorker?: boolean }) {
    this.workerUnavailable = options?.useWorker === false || typeof Worker === 'undefined';
  }

  /** Selects a move; resolves with exactly what selectHumanLikeMove() would return. */
  public select(request: HumanLikeSelectionRequest, rng: () => number = Math.random): Promise<BotMoveDecision> {
    const run = this.queue.then(() => this.selectNow(request, rng));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** How many selections ran in the worker vs. inline (diagnostics and tests). */
  public getStats(): { worker: number; inline: number; workerActive: boolean } {
    return {
      worker: this.workerSelections,
      inline: this.inlineSelections,
      workerActive: this.worker !== null && !this.workerUnavailable,
    };
  }

  public terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerUnavailable = true;
    this.rejectAll(new WorkerUnavailableError('Bot selection worker terminated'));
  }

  private async selectNow(request: HumanLikeSelectionRequest, rng: () => number): Promise<BotMoveDecision> {
    let size = INITIAL_RANDOM_BUFFER;
    while (this.ensureWorker()) {
      const randoms = this.take(rng, size);
      let response: BotSelectionResponseMessage;
      try {
        response = await this.post({ id: this.nextId++, request, randoms });
      } catch (err) {
        this.giveBack(rng, randoms);
        if (err instanceof WorkerUnavailableError) break;
        throw err;
      }
      if (response.kind === 'ok') {
        this.giveBack(rng, randoms.slice(response.consumed));
        this.workerSelections++;
        return response.decision;
      }
      this.giveBack(rng, randoms);
      if (response.kind === 'error') {
        throw new Error(response.message);
      }
      size *= 4; // needed more random values than were sent
    }
    return this.selectInline(request, rng);
  }

  private selectInline(request: HumanLikeSelectionRequest, rng: () => number): BotMoveDecision {
    this.inlineSelections++;
    const buffered = () => {
      const spare = this.spare.get(rng);
      return spare && spare.length > 0 ? spare.shift()! : rng();
    };
    return selectHumanLikeMove({ ...request, rng: buffered });
  }

  private take(rng: () => number, count: number): number[] {
    const spare = this.spare.get(rng) ?? [];
    const out = spare.splice(0, count);
    while (out.length < count) out.push(rng());
    this.spare.set(rng, spare);
    return out;
  }

  /** Returns unused values to the front of the rng's queue (they were drawn first). */
  private giveBack(rng: () => number, values: number[]): void {
    if (values.length === 0) return;
    this.spare.set(rng, values.concat(this.spare.get(rng) ?? []));
  }

  private ensureWorker(): boolean {
    if (this.workerUnavailable) return false;
    if (this.worker) return true;
    try {
      this.worker = new Worker(new URL('./bot-selection.worker.ts', import.meta.url), {
        type: 'module',
        name: 'bot-selection',
      });
    } catch {
      this.workerUnavailable = true;
      return false;
    }
    this.worker.addEventListener('message', (e: MessageEvent<BotSelectionResponseMessage>) => {
      const entry = this.pending.get(e.data.id);
      if (!entry) return;
      this.pending.delete(e.data.id);
      entry.resolve(e.data);
    });
    const fail = () => {
      this.workerUnavailable = true;
      this.worker?.terminate();
      this.worker = null;
      this.rejectAll(new WorkerUnavailableError('Bot selection worker failed'));
    };
    this.worker.addEventListener('error', fail);
    this.worker.addEventListener('messageerror', fail);
    return true;
  }

  private post(msg: BotSelectionRequestMessage): Promise<BotSelectionResponseMessage> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new WorkerUnavailableError('Bot selection worker not running'));
        return;
      }
      this.pending.set(msg.id, { resolve, reject });
      this.worker.postMessage(msg);
    });
  }

  private rejectAll(err: Error): void {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }
}
