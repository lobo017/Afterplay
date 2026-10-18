import { parsePgn } from '../core/pgn';
import { ReviewAnalysisClient } from '../review/review-analysis-client';
import { ReviewRunner, type ReviewEngine } from '../review/review-runner';
import type { ReviewPreset } from '../review/types';
import type { GameLibrary } from './library';
import { toSavedReview } from './saved-review';

export type ReviewJobState =
  | { status: 'queued'; preset: ReviewPreset }
  | { status: 'running'; preset: ReviewPreset; analyzed: number; total: number }
  | { status: 'failed'; preset: ReviewPreset; error: string };

export interface ReviewQueueDeps {
  library: GameLibrary;
  /** The review's own engine (shared with the board's review panel). */
  getEngine: () => ReviewEngine;
  isBookPosition: (fen: string) => boolean;
  analysisClient?: ReviewAnalysisClient;
}

/**
 * Reviews games from the Games list in the background, one at a time, and saves each
 * finished review with its game. Nothing here touches the analysis board.
 */
export class ReviewQueue {
  private readonly order: string[] = [];
  private readonly states = new Map<string, ReviewJobState>();
  private readonly listeners = new Set<() => void>();
  private running: { id: string; abort: AbortController } | null = null;
  private readonly analysisClient: ReviewAnalysisClient;

  constructor(private readonly deps: ReviewQueueDeps) {
    this.analysisClient = deps.analysisClient ?? new ReviewAnalysisClient();
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  public getState(id: string): ReviewJobState | undefined {
    return this.states.get(id);
  }

  /** Games waiting or running, in order. */
  public pending(): string[] {
    return [...(this.running ? [this.running.id] : []), ...this.order];
  }

  /** Queues games for review on a preset; a game already waiting keeps its place and takes the new preset. */
  public enqueue(ids: readonly string[], preset: ReviewPreset): void {
    for (const id of ids) {
      if (this.running?.id === id) continue;
      if (!this.order.includes(id)) this.order.push(id);
      this.states.set(id, { status: 'queued', preset });
    }
    this.emit();
    void this.pump();
  }

  /** Removes a waiting game, or stops the running one. */
  public cancel(id: string): void {
    const i = this.order.indexOf(id);
    if (i >= 0) this.order.splice(i, 1);
    if (this.running?.id === id) this.running.abort.abort();
    this.states.delete(id);
    this.emit();
  }

  public cancelAll(): void {
    for (const id of [...this.order]) this.cancel(id);
    if (this.running) this.cancel(this.running.id);
  }

  /** Resolves when nothing is queued or running. */
  public async idle(): Promise<void> {
    while (this.running || this.order.length > 0) {
      await new Promise<void>((resolve) => {
        const off = this.onChange(() => {
          if (!this.running && this.order.length === 0) {
            off();
            resolve();
          }
        });
      });
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const id = this.order.shift();
    if (id === undefined) return;
    const state = this.states.get(id);
    const preset = state?.preset ?? 'standard';
    const abort = new AbortController();
    this.running = { id, abort };
    try {
      const record = await this.deps.library.get(id);
      if (!record) throw new Error('The game is no longer in the list.');
      const tree = parsePgn(record.pgn);
      const total = tree.getMainLine().length + 1;
      this.states.set(id, { status: 'running', preset, analyzed: 0, total });
      this.emit();
      const runner = new ReviewRunner(this.deps.getEngine(), this.analysisClient);
      const result = await runner.run({
        tree,
        preset,
        isBookPosition: this.deps.isBookPosition,
        signal: abort.signal,
        onProgress: (review) => {
          this.states.set(id, { status: 'running', preset, analyzed: review.analyzedPositions, total });
          this.emit();
        },
      });
      const saved = toSavedReview(result);
      if (saved) {
        await this.deps.library.saveReview(id, saved);
        this.states.delete(id);
      } else if (!abort.signal.aborted) {
        this.states.set(id, { status: 'failed', preset, error: 'The review did not finish.' });
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        this.states.set(id, { status: 'failed', preset, error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.running = null;
      this.emit();
      void this.pump();
    }
  }
}
