import { RulesAdapter, type Color, type ExecutedMove, type PieceSymbol, type Square } from '../core/rules';

/**
 * A small board model for the motif detectors and the sacrifice check. Squares are
 * indexed 0–63 with a1 = 0, b1 = 1 … h8 = 63. Legality comes from RulesAdapter; this
 * module only answers "what attacks what" and "who wins an exchange".
 */
export interface BoardPiece {
  color: Color;
  type: PieceSymbol;
}

export type Squares = Array<BoardPiece | null>;

/** Exchange values in pawns. The king's value only matters for ordering. */
export const PIECE_VALUE: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 100,
};

export const PIECE_NAME: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

export function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

export function squareIndex(square: Square): number {
  return (square.charCodeAt(1) - 49) * 8 + (square.charCodeAt(0) - 97);
}

export function squareName(index: number): Square {
  return `${String.fromCharCode(97 + (index % 8))}${Math.floor(index / 8) + 1}` as Square;
}

const fileOf = (i: number) => i % 8;
const rankOf = (i: number) => Math.floor(i / 8);

export function parseSquares(fen: string): Squares {
  const squares: Squares = new Array(64).fill(null);
  const placement = fen.trim().split(/\s+/)[0] ?? '';
  const ranks = placement.split('/');
  for (let r = 0; r < 8; r++) {
    const row = ranks[r] ?? '';
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      const lower = ch.toLowerCase() as PieceSymbol;
      squares[(7 - r) * 8 + file] = {
        color: ch === lower ? 'b' : 'w',
        type: lower,
      };
      file++;
    }
  }
  return squares;
}

export function fenTurn(fen: string): Color {
  return fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

const KNIGHT_STEPS: ReadonlyArray<[number, number]> = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];
const KING_STEPS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];
export const ORTHOGONAL: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
export const DIAGONAL: ReadonlyArray<[number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function step(from: number, df: number, dr: number): number {
  const f = fileOf(from) + df;
  const r = rankOf(from) + dr;
  if (f < 0 || f > 7 || r < 0 || r > 7) return -1;
  return r * 8 + f;
}

export function slidingDirections(type: PieceSymbol): ReadonlyArray<[number, number]> {
  if (type === 'b') return DIAGONAL;
  if (type === 'r') return ORTHOGONAL;
  if (type === 'q') return [...ORTHOGONAL, ...DIAGONAL];
  return [];
}

/** Squares attacked by the piece standing on `from` (sliders stop at the first piece). */
export function attacksFrom(squares: Squares, from: number): number[] {
  const piece = squares[from];
  if (!piece) return [];
  const out: number[] = [];
  if (piece.type === 'p') {
    const dr = piece.color === 'w' ? 1 : -1;
    for (const df of [-1, 1]) {
      const to = step(from, df, dr);
      if (to >= 0) out.push(to);
    }
    return out;
  }
  if (piece.type === 'n' || piece.type === 'k') {
    for (const [df, dr] of piece.type === 'n' ? KNIGHT_STEPS : KING_STEPS) {
      const to = step(from, df, dr);
      if (to >= 0) out.push(to);
    }
    return out;
  }
  for (const [df, dr] of slidingDirections(piece.type)) {
    let to = step(from, df, dr);
    while (to >= 0) {
      out.push(to);
      if (squares[to]) break;
      to = step(to, df, dr);
    }
  }
  return out;
}

/** Squares holding pieces of `color` that attack `target`. */
export function attackersOf(squares: Squares, target: number, color: Color): number[] {
  const out: number[] = [];
  for (let i = 0; i < 64; i++) {
    const piece = squares[i];
    if (!piece || piece.color !== color || i === target) continue;
    if (attacksFrom(squares, i).includes(target)) out.push(i);
  }
  return out;
}

function leastValuable(squares: Squares, from: number[]): number {
  let best = from[0]!;
  for (const i of from) {
    if (PIECE_VALUE[squares[i]!.type] < PIECE_VALUE[squares[best]!.type]) best = i;
  }
  return best;
}

/**
 * Static exchange on `target`: the most `side` can win by starting a capture sequence
 * there, each side recapturing with its least valuable attacker and stopping when that
 * no longer pays. Removing each capturer from the board lets pieces behind it (x-rays)
 * join in. Pins are ignored; a king never captures onto a defended square.
 */
export function exchangeGain(squares: Squares, target: number, side: Color): number {
  const victim = squares[target];
  if (!victim || victim.color === side) return 0;
  const attackers = attackersOf(squares, target, side);
  if (attackers.length === 0) return 0;
  const capturer = leastValuable(squares, attackers);
  const next = squares.slice();
  next[target] = squares[capturer]!;
  next[capturer] = null;
  if (squares[capturer]!.type === 'k' && attackersOf(next, target, opposite(side)).length > 0) {
    return 0;
  }
  return Math.max(0, PIECE_VALUE[victim.type] - exchangeGain(next, target, opposite(side)));
}

export function capturedValue(move: ExecutedMove): number {
  let value = move.captured ? PIECE_VALUE[move.captured] : 0;
  if (move.promotion) value += PIECE_VALUE[move.promotion] - PIECE_VALUE.p;
  return value;
}

/** Board after a capture, as far as the exchange on its square is concerned. */
function squaresAfterMove(squares: Squares, move: ExecutedMove): Squares {
  const next = squares.slice();
  const from = squareIndex(move.from);
  const to = squareIndex(move.to);
  const mover = next[from];
  next[from] = null;
  if (move.isEnPassant) {
    next[to + (move.color === 'w' ? -8 : 8)] = null;
  }
  next[to] = mover ? { color: mover.color, type: move.promotion ?? mover.type } : null;
  return next;
}

/** Net material (pawns) the side making `move` comes out with after the exchange on its target. */
export function captureGain(squares: Squares, move: ExecutedMove): number {
  const after = squaresAfterMove(squares, move);
  const to = squareIndex(move.to);
  return capturedValue(move) - exchangeGain(after, to, opposite(move.color));
}

export interface CaptureThreat {
  move: ExecutedMove;
  gain: number;
}

/** Every legal capture for the side to move in `fen`, with what it nets after the exchange. */
export function captureThreats(fen: string): CaptureThreat[] {
  let adapter: RulesAdapter;
  try {
    adapter = new RulesAdapter(fen);
  } catch {
    return [];
  }
  const squares = parseSquares(fen);
  return adapter
    .verboseMoves()
    .filter((m) => m.isCapture)
    .map((move) => ({ move, gain: captureGain(squares, move) }));
}

/** The best capture for the side to move (null if no capture wins material). */
export function bestCaptureThreat(fen: string): CaptureThreat | null {
  let best: CaptureThreat | null = null;
  for (const threat of captureThreats(fen)) {
    if (threat.gain > 0 && (!best || threat.gain > best.gain)) best = threat;
  }
  return best;
}

/**
 * The same position with the other side to move and no en-passant square: what would the
 * opponent take if it were their turn? Null when that position is illegal (the side to
 * move is in check, so the opponent could capture the king).
 */
export function passTurnFen(fen: string): string | null {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) return null;
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  const flipped = parts.join(' ');
  try {
    // Rejected when the side that "passed" is in check (the king could be taken)
    return new RulesAdapter(flipped).fen();
  } catch {
    return null;
  }
}

export function materialCount(squares: Squares, color: Color): number {
  let total = 0;
  for (const piece of squares) {
    if (piece && piece.color === color && piece.type !== 'k') total += PIECE_VALUE[piece.type];
  }
  return total;
}

export function findKing(squares: Squares, color: Color): number {
  return squares.findIndex((p) => p?.type === 'k' && p.color === color);
}

/** Squares between two squares on a shared line (exclusive), or null when not aligned. */
export function lineBetween(a: number, b: number): number[] | null {
  const df = fileOf(b) - fileOf(a);
  const dr = rankOf(b) - rankOf(a);
  if (df === 0 && dr === 0) return null;
  if (df !== 0 && dr !== 0 && Math.abs(df) !== Math.abs(dr)) return null;
  const sf = Math.sign(df);
  const sr = Math.sign(dr);
  const out: number[] = [];
  let cur = step(a, sf, sr);
  while (cur >= 0 && cur !== b) {
    out.push(cur);
    cur = step(cur, sf, sr);
  }
  return cur === b ? out : null;
}

/** First two pieces met walking from `from` in direction (df, dr). */
export function firstTwoOnRay(squares: Squares, from: number, df: number, dr: number): [number, number | null] | null {
  let cur = step(from, df, dr);
  let first: number | null = null;
  while (cur >= 0) {
    if (squares[cur]) {
      if (first === null) first = cur;
      else return [first, cur];
    }
    cur = step(cur, df, dr);
  }
  return first === null ? null : [first, null];
}

export function isDefended(squares: Squares, target: number): boolean {
  const piece = squares[target];
  if (!piece) return false;
  return attackersOf(squares, target, piece.color).length > 0;
}

export function applyUci(fen: string, uci: string): { after: string; move: ExecutedMove } | null {
  try {
    const adapter = new RulesAdapter(fen);
    const move = adapter.move(uci);
    return { after: adapter.fen(), move };
  } catch {
    return null;
  }
}

export function uciToSan(fen: string, uci: string): string | null {
  return applyUci(fen, uci)?.move.san ?? null;
}

/** SAN for a whole UCI line from `fen` (stops at the first illegal move). */
export function lineToSan(fen: string, uciLine: readonly string[], maxPlies = 8): string[] {
  const out: string[] = [];
  let adapter: RulesAdapter;
  try {
    adapter = new RulesAdapter(fen);
  } catch {
    return out;
  }
  for (const uci of uciLine.slice(0, maxPlies)) {
    try {
      out.push(adapter.move(uci).san);
    } catch {
      break;
    }
  }
  return out;
}
