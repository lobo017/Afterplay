import { analyzeMove, type MoveAnalysis, type ReviewMoveInput } from './review-game';

export interface ReviewAnalysisRequestMessage {
  id: number;
  input: ReviewMoveInput;
}

export type ReviewAnalysisResponseMessage =
  { id: number; kind: 'ok'; result: MoveAnalysis } | { id: number; kind: 'error'; message: string };

class WorkerUnavailableError extends Error {}

/**
 * Runs `analyzeMove` (classification, explanation and motifs for one move: 10–25 ms of
 * chess.js work for an error move, more on a cold start) in a dedicated module worker,
 * so a live review never puts a long task on the main thread.
 *
 * Where `Worker` doesn't exist (Node: unit tests, scripts) or the worker fails to start,
 * the analysis runs inline and gives the same result.
 */
export class ReviewAnalysisClient {
  private worker: Worker | null = null;
  private workerUnavailable: boolean;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (msg: ReviewAnalysisResponseMessage) => void; reject: (err: Error) => void }
  >();
  private workerCalls = 0;
  private inlineCalls = 0;

  constructor(options?: { useWorker?: boolean }) {
    this.workerUnavailable = options?.useWorker === false || typeof Worker === 'undefined';
  }

  public async analyze(input: ReviewMoveInput): Promise<MoveAnalysis> {
    if (this.ensureWorker()) {
      try {
        const response = await this.post({ id: this.nextId++, input });
        if (response.kind === 'error') throw new Error(response.message);
        this.workerCalls++;
        return response.result;
      } catch (err) {
        if (!(err instanceof WorkerUnavailableError)) throw err;
      }
    }
    this.inlineCalls++;
    return analyzeMove(input);
  }

  /** How many moves were analyzed in the worker vs. inline (diagnostics and tests). */
  public getStats(): { worker: number; inline: number; workerActive: boolean } {
    return {
      worker: this.workerCalls,
      inline: this.inlineCalls,
      workerActive: this.worker !== null && !this.workerUnavailable,
    };
  }

  public terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerUnavailable = true;
    this.rejectAll(new WorkerUnavailableError('Review worker terminated'));
  }

  private ensureWorker(): boolean {
    if (this.workerUnavailable) return false;
    if (this.worker) return true;
    try {
      this.worker = new Worker(new URL('./review-analysis.worker.ts', import.meta.url), {
        type: 'module',
        name: 'review-analysis',
      });
    } catch {
      this.workerUnavailable = true;
      return false;
    }
    this.worker.addEventListener('message', (e: MessageEvent<ReviewAnalysisResponseMessage>) => {
      const entry = this.pending.get(e.data.id);
      if (!entry) return;
      this.pending.delete(e.data.id);
      entry.resolve(e.data);
    });
    const fail = () => {
      this.workerUnavailable = true;
      this.worker?.terminate();
      this.worker = null;
      this.rejectAll(new WorkerUnavailableError('Review worker failed'));
    };
    this.worker.addEventListener('error', fail);
    this.worker.addEventListener('messageerror', fail);
    return true;
  }

  private post(msg: ReviewAnalysisRequestMessage): Promise<ReviewAnalysisResponseMessage> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new WorkerUnavailableError('Review worker not running'));
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
