import { RulesAdapter, type Color, type ExecutedMove, type MoveInput } from '../core/rules';
import { normalizeFenToEpd } from '../core/datasets';

/**
 * A puzzle as stored, in the Lichess puzzle layout (both bundled and personal puzzles):
 * `fen` is the position BEFORE the opponent's move, `moves[0]` is that opponent move, and the
 * solution starts at `moves[1]` (player, reply, player, …, always ending on a player move).
 */
export interface PuzzleSource {
  id: string;
  fen: string;
  /** UCI. moves[0] = the opponent's setup move; moves[1..] = the solution. */
  moves: string[];
}

/** A puzzle ready to solve: the setup move already known, the player's side worked out. */
export interface PreparedPuzzle {
  id: string;
  /** The position before the opponent's move (shown first, then the move is animated). */
  setupFen: string;
  /** The opponent's move that leads to the puzzle position. */
  setupMove: ExecutedMove;
  /** The puzzle position: the player is to move. */
  startFen: string;
  /** The side the player plays (the side to move in `startFen`). */
  playerColor: Color;
  /** UCI moves from `startFen`: the player's moves at even indexes, the replies at odd ones. */
  solution: string[];
  /** The solution's moves in SAN, played from `startFen`. */
  solutionSan: string[];
  /** The solution ends in checkmate (a mate puzzle: only mating alternatives count). */
  endsInMate: boolean;
}

export class PuzzleFormatError extends Error {}

function playUci(adapter: RulesAdapter, uci: string): ExecutedMove {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
  if (!m) throw new PuzzleFormatError(`Not a UCI move: ${uci}`);
  const input: MoveInput = { from: m[1]!, to: m[2]!, ...(m[3] ? { promotion: m[3] } : {}) };
  try {
    return adapter.move(input);
  } catch {
    throw new PuzzleFormatError(`Illegal move ${uci} in ${adapter.fen()}`);
  }
}

/**
 * Turns a stored puzzle into a playable one. The first move is the opponent's: it is played
 * on `fen` to reach the puzzle position, and the player is the side to move after it.
 * Throws PuzzleFormatError when a move is illegal or the solution doesn't end on a player move.
 */
export function preparePuzzle(source: PuzzleSource): PreparedPuzzle {
  if (source.moves.length < 2) {
    throw new PuzzleFormatError(`Puzzle ${source.id}: needs the opponent's move and at least one solution move`);
  }
  const adapter = new RulesAdapter(source.fen);
  const setupMove = playUci(adapter, source.moves[0]!);
  const startFen = adapter.fen();
  const playerColor = adapter.turn();
  const solution = source.moves.slice(1);
  if (solution.length % 2 !== 1) {
    throw new PuzzleFormatError(`Puzzle ${source.id}: the solution must end on the player's move`);
  }
  const solutionSan = solution.map((uci) => playUci(adapter, uci).san);
  return {
    id: source.id,
    setupFen: source.fen,
    setupMove,
    startFen,
    playerColor,
    solution,
    solutionSan,
    endsInMate: adapter.isCheckmate(),
  };
}

/** The position after `uci` from `fen` (4-field EPD), or null when the move is illegal there. */
export function positionAfter(fen: string, uci: string): string | null {
  try {
    const adapter = new RulesAdapter(fen);
    playUci(adapter, uci);
    return normalizeFenToEpd(adapter.fen());
  } catch {
    return null;
  }
}

/**
 * Whether two moves from `fen` are the same move. Compared by the position they lead to, so
 * castling written as king-to-rook (e1h1) and king-two-squares (e1g1) match, and a promotion
 * only matches with the same piece.
 */
export function sameMove(fen: string, a: string, b: string): boolean {
  if (a === b) return true;
  const pa = positionAfter(fen, a);
  return pa !== null && pa === positionAfter(fen, b);
}

/** UCI of a board move ("e7e8q"). */
export function moveInputToUci(move: MoveInput): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}
