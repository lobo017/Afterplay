import { Chess } from 'chess.js';
import { exactMateDistance } from './dtm-oracle';

/**
 * Perfect play for K+Q, K+R and K+P v K (White has the piece), from chess.js's legal moves and the
 * independent retrograde solver in dtm-oracle.ts. Used by the tests as the attacker, and to
 * judge the defender.
 */

/**
 * How far the mate is after a reply by Black: White's moves to mate, or Infinity when Black
 * escaped (it took White's last piece, or the position is no longer won).
 */
export function mateAfterReply(chess: Chess, from: string, to: string): number {
  const probe = new Chess(chess.fen());
  const move = probe.move({ from, to });
  if (move.captured) return Infinity;
  return exactMateDistance(probe.fen()) ?? Infinity;
}

/** The mate distance of a position with Black to move against the best defence (0: Black is mated). */
export function blackToMoveValue(fen: string): number {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return 0;
  if (chess.isGameOver()) return Infinity;
  return Math.max(...chess.moves({ verbose: true }).map((m) => mateAfterReply(chess, m.from, m.to)));
}

/** White's move that gives the shortest mate against the best defence (SAN), with that distance. */
export function bestAttackerMove(fen: string): {
  san: string;
  from: string;
  to: string;
  promotion?: string;
  moves: number;
} {
  const game = new Chess(fen);
  let pick: { san: string; from: string; to: string; promotion?: string; moves: number } | null = null;
  for (const m of game.moves({ verbose: true })) {
    const probe = new Chess(fen);
    probe.move(m);
    const value = blackToMoveValue(probe.fen());
    if (!pick || value + 1 < pick.moves) {
      pick = {
        san: m.san,
        from: m.from,
        to: m.to,
        ...(m.promotion ? { promotion: m.promotion } : {}),
        moves: value + 1,
      };
    }
  }
  if (!pick) throw new Error(`no legal move in ${fen}`);
  return pick;
}
