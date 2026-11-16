/**
 * The engine-review numbers of one game, read from a stored record. One reader for the Story and Insights, so a
 * batch summary (`summaryOnly`, written by the Juno review) and a review made on this device count the same way.
 * Pure: no storage, no clock.
 */
import type { Color } from '../core/rules';
import { readPhases, type PhaseNumbers } from '../review/phase-numbers';
import type { StoredGameRecord } from '../storage/db';
import type { SavedReview } from './saved-review';

/** A game counts as reviewed from this many plies (the batch review skips shorter games too). */
export const MIN_REVIEWED_PLIES = 10;

export interface ReviewNumbers {
  /** My accuracy in the game, 0–100. */
  accuracy: number;
  plies: number;
  /** My moves that were reviewed. */
  moves: number;
  inaccuracy: number;
  mistake: number;
  blunder: number;
  miss: number;
  brilliant: number;
  great: number;
  /** My lowest win% in the game (the engine's chance for me), or null. */
  low: number | null;
  /** My largest single-move loss, in win% points. */
  drop: number;
  /** In advance (batch summary) or on this device (a full review saved here). */
  source: 'advance' | 'device';
  /** The fixed depth of a batch review, else null. */
  depth: number | null;
  /** The timed preset of a review made here, else null. */
  preset: SavedReview['preset'];
  /** My moves, accuracy and errors by game phase; absent for a game whose record has none (or malformed ones). */
  phases?: PhaseNumbers;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): v is number => isNumber(v) && v >= 0;

/**
 * My side's numbers, or null when the game has no usable review for that side: no analysis, no entry for the side
 * (the other side's numbers are never used), an accuracy that is not a number from 0 to 100, fewer than
 * MIN_REVIEWED_PLIES plies, or counts that are not whole non-negative numbers. `colour` is the side the Story worked
 * out from the usernames, never the record's own `playerColor`.
 */
export function readReviewNumbers(record: Pick<StoredGameRecord, 'analysis'>, colour: Color): ReviewNumbers | null {
  const a = record.analysis;
  if (!a || typeof a !== 'object') return null;
  const side = a.sides?.[colour];
  if (!side || typeof side !== 'object') return null;
  const accuracy = colour === 'w' ? a.whiteAccuracy : a.blackAccuracy;
  if (!isNumber(accuracy) || accuracy < 0 || accuracy > 100) return null;
  if (!isNumber(a.plies) || a.plies < MIN_REVIEWED_PLIES) return null;
  const counts = [side.inaccuracy, side.mistake, side.blunder, side.miss, side.brilliant, side.great];
  if (!isCount(side.moves) || side.moves < 1 || !counts.every(isCount) || !isNumber(side.drop)) return null;
  const phases = readPhases(side.phases);
  return {
    accuracy,
    plies: a.plies,
    moves: side.moves,
    inaccuracy: side.inaccuracy,
    mistake: side.mistake,
    blunder: side.blunder,
    miss: side.miss,
    brilliant: side.brilliant,
    great: side.great,
    low: isNumber(side.low) ? side.low : null,
    drop: side.drop,
    source: a.summaryOnly === true ? 'advance' : 'device',
    depth: isNumber(a.depth) ? a.depth : null,
    preset: a.preset ?? null,
    ...(phases ? { phases } : {}),
  };
}
