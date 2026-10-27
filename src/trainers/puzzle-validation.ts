import type { UciScore } from '../engine/uci-parser';
import { CLASS_THRESHOLDS } from '../review/classification';
import { winPercentFromScore } from '../review/formulas';
import type { ReviewLine } from '../review/types';

/**
 * A move other than the solution "keeps a decisive advantage" at this win% or more for the
 * player (about +6 pawns on the Lichess curve: Lichess's "crushing" puzzles).
 */
export const DECISIVE_WIN_PERCENT = 90;

/** A move other than the solution within this many win% points of it is as good (Excellent band). */
export const ALTERNATIVE_TOLERANCE = CLASS_THRESHOLDS.excellent;

/**
 * Personal puzzles: the best move must beat the second-best by at least this many win%
 * points (the Mistake band), otherwise the second-best is "nearly as good" and the position
 * is no puzzle.
 */
export const PERSONAL_MIN_GAP = CLASS_THRESHOLDS.mistake;

export interface AlternativeInput {
  /** The player's move mates at once. */
  givesMate: boolean;
  /** The engine's score of the position after the player's move, from the player's side. */
  altScore: UciScore | null;
  /** The engine's score after the expected solution move, from the player's side. */
  solutionScore: UciScore | null;
  /** A mate puzzle (the solution ends in mate): only mating moves are accepted. */
  matePuzzle: boolean;
}

export type AlternativeVerdict =
  { accepted: true; reason: 'mate' | 'forced-mate' | 'decisive' | 'as-good' } | { accepted: false };

/**
 * Whether a move other than the expected one also solves the puzzle: it mates, or the engine
 * finds a forced mate for the player after it, or (not in a mate puzzle) it keeps a decisive
 * advantage or is as good as the solution.
 */
export function judgeAlternative(input: AlternativeInput): AlternativeVerdict {
  if (input.givesMate) return { accepted: true, reason: 'mate' };
  const alt = input.altScore;
  if (!alt) return { accepted: false };
  if (alt.type === 'mate' && alt.value > 0) return { accepted: true, reason: 'forced-mate' };
  if (input.matePuzzle) return { accepted: false };
  const altWin = winPercentFromScore(alt);
  if (altWin >= DECISIVE_WIN_PERCENT) return { accepted: true, reason: 'decisive' };
  if (input.solutionScore && altWin >= winPercentFromScore(input.solutionScore) - ALTERNATIVE_TOLERANCE) {
    return { accepted: true, reason: 'as-good' };
  }
  return { accepted: false };
}

/**
 * Whether the engine's best move is clearly the only good one: two lines exist (MultiPV 2)
 * and the second-best is at least PERSONAL_MIN_GAP win% points worse.
 */
export function isClearBest(lines: readonly ReviewLine[]): boolean {
  const [best, second] = [...lines].sort((a, b) => a.multipv - b.multipv);
  if (!best || !second || best.pv.length === 0) return false;
  return winPercentFromScore(best.score) - winPercentFromScore(second.score) >= PERSONAL_MIN_GAP;
}
