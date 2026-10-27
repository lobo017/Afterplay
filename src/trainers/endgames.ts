import endgamesJson from '../../data/endgames.json';
import type { EndgamePositionEntry } from '../core/datasets';
import type { Color } from '../core/rules';
import type { Grade } from './fsrs';

export const ENDGAMES: readonly EndgamePositionEntry[] = endgamesJson as EndgamePositionEntry[];

/**
 * How a drill reaches its target result:
 * - `mate`: checkmate the opponent (the engine's mate distance is the best possible count).
 * - `convert`: promote the pawn, or win the opponent's last piece, with the engine rating the
 *   position as decided; Lucena and R+P v R take dozens of moves to mate, and the drill is
 *   about the technique that wins them.
 * - `hold`: the draw, by a rule (repetition, 50 moves, stalemate, insufficient material) or by
 *   agreement once the opponent has had its chances.
 */
export type EndgameGoal = 'mate' | 'convert' | 'hold';

export function endgameGoal(entry: Pick<EndgamePositionEntry, 'targetResult' | 'optimalMoves'>): EndgameGoal {
  if (entry.targetResult === '1/2-1/2') return 'hold';
  return entry.optimalMoves === null ? 'convert' : 'mate';
}

/** The player has the move in every position, and plays the side that is to move. */
export function endgamePlayer(entry: Pick<EndgamePositionEntry, 'sideToMove'>): Color {
  return entry.sideToMove;
}

export function getEndgame(id: string): EndgamePositionEntry | undefined {
  return ENDGAMES.find((e) => e.id === id);
}

export const GOAL_LABEL: Record<EndgameGoal, string> = {
  mate: 'Checkmate',
  convert: 'Convert the win',
  hold: 'Hold the draw',
};

/** One line saying what to do and what counts, for the drill's card. */
export function goalText(entry: EndgamePositionEntry): string {
  switch (endgameGoal(entry)) {
    case 'mate':
      return `Checkmate. Best possible: ${entry.optimalMoves} moves against the best defence.`;
    case 'convert':
      return 'Promote the pawn, or win the last piece, and keep the win.';
    case 'hold':
      return 'Hold the draw: reach a draw by the rules, or hold long enough for the engine to agree to one.';
  }
}

/** How a finished drill went. */
export interface EndgameOutcome {
  reached: boolean;
  /** The player's moves in the drill. */
  moves: number;
  hintsUsed: number;
}

/** Moves over the best possible that still count as Good (mate drills). */
export const GOOD_EXTRA_MOVES = 4;

/**
 * The spaced-repetition grade of a drill: a miss is Again; any hint caps it at Hard; a mate
 * drill is Easy at the best possible count or better, Good within `GOOD_EXTRA_MOVES` of it and
 * Hard beyond; Lucena, Philidor and R+P v R are Good when reached.
 */
export function gradeEndgame(
  entry: Pick<EndgamePositionEntry, 'targetResult' | 'optimalMoves'>,
  outcome: EndgameOutcome,
): Grade {
  if (!outcome.reached) return 1;
  if (outcome.hintsUsed > 0) return 2;
  if (entry.optimalMoves === null) return 3;
  const extra = outcome.moves - entry.optimalMoves;
  if (extra <= 0) return 4;
  return extra <= GOOD_EXTRA_MOVES ? 3 : 2;
}
