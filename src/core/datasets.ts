export interface OpeningEntry {
  eco: string;
  name: string;
  pgn: string;
  moves: string[];
}

export type OpeningsMap = Record<string, OpeningEntry>;

export interface PuzzleEntry {
  id: string;
  /** Position BEFORE the opponent's setup move (moves[0]). */
  fen: string;
  /** UCI moves: moves[0] is opponent's setup move; player solution starts at moves[1]. */
  moves: string[];
  rating: number;
  themes: string[];
}

export interface EndgamePositionEntry {
  id: string;
  title: string;
  category: string;
  fen: string;
  sideToMove: 'w' | 'b';
  targetResult: '1-0' | '0-1' | '1/2-1/2';
  /**
   * The engine's mate distance: the player's moves to checkmate against the best defence.
   * Null where the drill doesn't end in a forced mate (Lucena, Philidor, R+P v R): only the
   * result is tracked there.
   */
  optimalMoves: number | null;
  description: string;
}

/**
 * Normalize a full 6-field FEN string into a 4-field EPD key (board, turn, castling, ep).
 */
export function normalizeFenToEpd(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}
