import type { EndgamePositionEntry } from '../core/datasets';
import type { StoredEndgameProgressRecord, StoredSrsCardRecord, WizardChessStorage } from '../storage/db';
import { gradeEndgame, type EndgameOutcome } from './endgames';
import type { Grade } from './fsrs';
import { gradeStoredCard } from './srs-cards';

export interface EndgameRecordResult {
  progress: StoredEndgameProgressRecord;
  card: StoredSrsCardRecord;
  grade: Grade;
  /** A new fewest-moves record (mate drills, without hints). */
  newBest: boolean;
}

/**
 * Endgame drill progress in IndexedDB: per position, attempts, completions and the fewest moves
 * against the engine's best possible (where the drill ends in mate), and the position's
 * spaced-repetition card (deck `endgame`), made by the first drill.
 */
export class EndgameStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: WizardChessStorage) {}

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  public async progress(): Promise<Map<string, StoredEndgameProgressRecord>> {
    return new Map((await this.storage.listEndgameProgress()).map((p) => [p.id, p]));
  }

  public getProgress(id: string): Promise<StoredEndgameProgressRecord | undefined> {
    return this.storage.getEndgameProgress(id);
  }

  public listCards(): Promise<StoredSrsCardRecord[]> {
    return this.storage.listSrsCards('endgame');
  }

  /** Records a finished drill: the position's counters and its card. */
  public async record(
    entry: EndgamePositionEntry,
    outcome: EndgameOutcome,
    now: number = Date.now(),
  ): Promise<EndgameRecordResult> {
    const prev = await this.storage.getEndgameProgress(entry.id);
    const tracksMoves = entry.optimalMoves !== null;
    const unaided = outcome.reached && outcome.hintsUsed === 0;
    const prevBest = prev?.bestMoves ?? null;
    const newBest = tracksMoves && unaided && (prevBest === null || outcome.moves < prevBest);
    const progress: StoredEndgameProgressRecord = {
      id: entry.id,
      category: entry.category,
      completed: prev?.completed === 1 || outcome.reached ? 1 : 0,
      attempts: (prev?.attempts ?? 0) + 1,
      bestMoves: newBest ? outcome.moves : prevBest,
      optimalMoves: entry.optimalMoves,
      updatedAt: now,
      completions: (prev?.completions ?? (prev?.completed === 1 ? 1 : 0)) + (outcome.reached ? 1 : 0),
      lastAttemptAt: now,
      lastReached: outcome.reached,
      lastMoves: outcome.reached && tracksMoves ? outcome.moves : null,
    };
    await this.storage.saveEndgameProgress(progress);
    const grade = gradeEndgame(entry, outcome);
    const card = await gradeStoredCard(this.storage, 'endgame', entry.id, grade, now);
    this.emit();
    return { progress, card, grade, newBest };
  }
}
