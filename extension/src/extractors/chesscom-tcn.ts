import { RulesAdapter } from '../../../src/core/rules';

/**
 * Chess.com's compact move format (TCN), as in the game data its pages load
 * (`game.moveList`) and the archive API's `tcn`: two characters per move, each an index
 * into ALPHABET. Squares are 0–63 (a1 = 0, b1 = 1, …, h8 = 63). A target index of 64 or
 * more is a promotion: (index − 64) / 3 picks the piece (q, n, r, b) and (index − 64) % 3
 * the direction (capture left, straight, capture right). Indexes above 75 in the first
 * character are crazyhouse drops, which this app doesn't support. Castling is the king's
 * move: two squares in standard chess, onto its own rook in Chess960.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=';
const PROMOTION_PIECES = 'qnrb';
const FILES = 'abcdefgh';

export interface TcnMove {
  from: string;
  to: string;
  promotion?: 'q' | 'n' | 'r' | 'b';
}

function square(index: number): string {
  return `${FILES[index % 8]}${Math.floor(index / 8) + 1}`;
}

/** The moves of a TCN string; throws on characters or drops it can't decode. */
export function decodeTcn(tcn: string): TcnMove[] {
  if (tcn.length % 2 !== 0) throw new Error('TCN has an odd length.');
  const moves: TcnMove[] = [];
  for (let i = 0; i < tcn.length; i += 2) {
    const from = ALPHABET.indexOf(tcn[i]!);
    let to = ALPHABET.indexOf(tcn[i + 1]!);
    if (from < 0 || to < 0) throw new Error(`Unknown TCN character at ${i}.`);
    if (from > 63) throw new Error('Drops (crazyhouse) are not supported.');
    if (to > 63) {
      const code = to - 64;
      const piece = PROMOTION_PIECES[Math.floor(code / 3)];
      if (!piece) throw new Error(`Unknown TCN promotion at ${i}.`);
      // The target is on the next rank, one file left, straight ahead or one file right
      const forward = from < 16 ? -8 : 8;
      to = from + forward + ((code % 3) - 1);
      moves.push({ from: square(from), to: square(to), promotion: piece as TcnMove['promotion'] });
      continue;
    }
    moves.push({ from: square(from), to: square(to) });
  }
  return moves;
}

/** Plays the TCN moves from the start position and returns their SAN; throws on an illegal move. */
export function tcnToSan(tcn: string, startFen: string, chess960: boolean): string[] {
  const adapter = new RulesAdapter(startFen, { chess960 });
  return decodeTcn(tcn).map((m, i) => {
    try {
      return adapter.move(m).san;
    } catch {
      throw new Error(`TCN move ${i + 1} (${m.from}${m.to}${m.promotion ?? ''}) is not legal.`);
    }
  });
}
