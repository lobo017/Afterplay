import type { StoredSrsCardRecord, WizardChessStorage } from '../storage/db';
import type { Grade } from './fsrs';
import { gradeStoredCard } from './srs-cards';
import {
  BLINDFOLD_START_PLIES,
  gradeBlindfold,
  gradeCoordinates,
  gradeGuess,
  nextBlindfoldLevel,
  visualizationCardTarget,
} from './visualization';

const COORDINATES_SETTING = 'viz.coordinates';
const BLINDFOLD_SETTING = 'viz.blindfold';
const GUESS_SETTING = 'viz.guess';
/** Rounds kept in the history. */
export const COORDINATE_HISTORY_LIMIT = 30;

export interface CoordinateRoundRecord {
  at: number;
  correct: number;
  wrong: number;
}

export interface CoordinateStats {
  rounds: number;
  /** Most squares found right in one round. */
  best: number;
  history: CoordinateRoundRecord[];
}

export interface BlindfoldStats {
  /** Plies read out in the next drill. */
  level: number;
  drills: number;
  /** The most plies of a drill answered without a miss. */
  bestLevel: number;
}

/** Guess-the-move scores by game id: the last session's hits out of the positions asked. */
export type GuessStats = Record<string, { hits: number; total: number; at: number }>;

export interface VisualizationResult<S> {
  stats: S;
  card: StoredSrsCardRecord;
  grade: Grade;
}

/**
 * Visualization drill progress: the coordinate rounds, the blindfold level and the
 * guess-the-move scores (in the settings store, so a backup carries them), and one
 * spaced-repetition card per drill (deck `visualization`): `coordinates`, `blindfold`, and
 * `guess:<game id>` for each game guessed. A card exists from the first drill.
 */
export class VisualizationStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: WizardChessStorage) {}

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  public async coordinateStats(): Promise<CoordinateStats> {
    return (await this.storage.getSetting<CoordinateStats>(COORDINATES_SETTING)) ?? { rounds: 0, best: 0, history: [] };
  }

  public async blindfoldStats(): Promise<BlindfoldStats> {
    return (
      (await this.storage.getSetting<BlindfoldStats>(BLINDFOLD_SETTING)) ?? {
        level: BLINDFOLD_START_PLIES,
        drills: 0,
        bestLevel: 0,
      }
    );
  }

  public async guessStats(): Promise<GuessStats> {
    return (await this.storage.getSetting<GuessStats>(GUESS_SETTING)) ?? {};
  }

  public listCards(): Promise<StoredSrsCardRecord[]> {
    return this.storage.listSrsCards('visualization');
  }

  public async recordCoordinates(
    round: { correct: number; wrong: number },
    now: number = Date.now(),
  ): Promise<VisualizationResult<CoordinateStats> & { newBest: boolean }> {
    const prev = await this.coordinateStats();
    const newBest = round.correct > prev.best;
    const stats: CoordinateStats = {
      rounds: prev.rounds + 1,
      best: Math.max(prev.best, round.correct),
      history: [...prev.history, { at: now, correct: round.correct, wrong: round.wrong }].slice(
        -COORDINATE_HISTORY_LIMIT,
      ),
    };
    await this.storage.setSetting(COORDINATES_SETTING, stats);
    const grade = gradeCoordinates(round);
    const card = await gradeStoredCard(
      this.storage,
      'visualization',
      visualizationCardTarget('coordinates'),
      grade,
      now,
    );
    this.emit();
    return { stats, card, grade, newBest };
  }

  public async recordBlindfold(
    drill: { plies: number; correct: number; total: number },
    now: number = Date.now(),
  ): Promise<VisualizationResult<BlindfoldStats>> {
    const prev = await this.blindfoldStats();
    const perfect = drill.total > 0 && drill.correct === drill.total;
    const stats: BlindfoldStats = {
      level: nextBlindfoldLevel(drill.plies, drill),
      drills: prev.drills + 1,
      bestLevel: perfect ? Math.max(prev.bestLevel, drill.plies) : prev.bestLevel,
    };
    await this.storage.setSetting(BLINDFOLD_SETTING, stats);
    const grade = gradeBlindfold(drill);
    const card = await gradeStoredCard(this.storage, 'visualization', visualizationCardTarget('blindfold'), grade, now);
    this.emit();
    return { stats, card, grade };
  }

  public async recordGuess(
    gameId: string,
    result: { hits: number; total: number },
    now: number = Date.now(),
  ): Promise<VisualizationResult<GuessStats>> {
    const stats = { ...(await this.guessStats()), [gameId]: { hits: result.hits, total: result.total, at: now } };
    await this.storage.setSetting(GUESS_SETTING, stats);
    const grade = gradeGuess(result);
    const card = await gradeStoredCard(
      this.storage,
      'visualization',
      visualizationCardTarget('guess', gameId),
      grade,
      now,
    );
    this.emit();
    return { stats, card, grade };
  }
}
