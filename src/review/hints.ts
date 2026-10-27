import type { Color } from '../core/rules';
import type { GameTree } from '../core/game-tree';

/**
 * Hints asked for while playing are kept with the game: the move played after a hint carries the comment
 * "Hint used: Nf3" (what the engine suggested). It travels in the saved game and its PGN, shows in the
 * Moves tree, survives a review (it is a plain comment), and the review reports how many were used.
 */
export const HINT_COMMENT_PREFIX = 'Hint used';

/** The comment for a move played after the given hints (the suggested moves, in the order they were asked for). */
export function hintComment(suggestedSans: readonly string[]): string {
  const first = suggestedSans[0] ?? '';
  return suggestedSans.length > 1
    ? `${HINT_COMMENT_PREFIX} (${suggestedSans.length}×): ${first}`
    : `${HINT_COMMENT_PREFIX}: ${first}`;
}

export interface HintedMove {
  ply: number;
  moveNumber: number;
  color: Color;
  san: string;
}

/** The main line's moves that carry a hint comment. */
export function hintedMoves(tree: GameTree): HintedMove[] {
  const out: HintedMove[] = [];
  for (const node of tree.getMainLine()) {
    if (node.comment.trimStart().startsWith(HINT_COMMENT_PREFIX)) {
      out.push({ ply: node.ply, moveNumber: node.moveNumber, color: node.moveColor ?? (node.ply % 2 === 1 ? 'w' : 'b'), san: node.san });
    }
  }
  return out;
}

/** "move 6 (Nf3), move 12 (Qd2)" for the review's status details. */
export function describeHintedMoves(moves: readonly HintedMove[]): string {
  return moves.map((m) => `${m.moveNumber}${m.color === 'w' ? '.' : '...'} ${m.san}`).join(', ');
}
