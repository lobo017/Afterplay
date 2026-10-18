import { RulesAdapter, type Color, type ExecutedMove } from '../core/rules';
import type { UciScore } from '../engine/uci-parser';
import {
  PIECE_VALUE,
  applyUci,
  attacksFrom,
  attackersOf,
  captureThreats,
  capturedValue,
  exchangeGain,
  findKing,
  firstTwoOnRay,
  lineBetween,
  opposite,
  parseSquares,
  passTurnFen,
  slidingDirections,
  squareIndex,
  squareName,
  uciToSan,
  type Squares,
} from './board';
import { MATE_HORIZON_MOVES } from './classification';
import type { Motif } from './types';

/**
 * Motif detectors. Each one looks at a single move (UCI) played from `fenBefore` and
 * reports the motif that move creates — or, for hanging-piece, the material it leaves
 * en prise. The review runs them on the played move, on the engine's refutation (what
 * the opponent can now do) and on the engine's best move (what the player missed).
 */

interface MoveContext {
  move: ExecutedMove;
  mover: Color;
  fenAfter: string;
  before: Squares;
  after: Squares;
}

function context(fenBefore: string, uci: string): MoveContext | null {
  const applied = applyUci(fenBefore, uci);
  if (!applied) return null;
  return {
    move: applied.move,
    mover: applied.move.color,
    fenAfter: applied.after,
    before: parseSquares(fenBefore),
    after: parseSquares(applied.after),
  };
}

/** The opponent can win the piece on `square` right now (a legal capture that nets material). */
function opponentWinsOn(fenAfter: string, square: number): boolean {
  return captureThreats(fenAfter).some(
    (t) => squareIndex(t.move.to) === square && t.gain > 0,
  );
}

/**
 * Hanging piece: after the move the opponent has a legal capture that wins material
 * (after the full exchange on that square), more than the move itself captured.
 */
export function detectHangingPiece(fenBefore: string, uci: string): Motif | null {
  const ctx = context(fenBefore, uci);
  if (!ctx) return null;
  const gainedByMove = capturedValue(ctx.move);
  let best: { gain: number; move: ExecutedMove } | null = null;
  for (const threat of captureThreats(ctx.fenAfter)) {
    if (threat.gain - gainedByMove <= 0) continue;
    const better =
      !best ||
      threat.gain > best.gain ||
      (threat.gain === best.gain &&
        PIECE_VALUE[threat.move.captured ?? 'p'] > PIECE_VALUE[best.move.captured ?? 'p']);
    if (better) best = threat;
  }
  if (!best) return null;

  const target = best.move.to;
  // Was it already en prise before this move (and the move didn't touch it)?
  let preexisting = false;
  if (target !== ctx.move.to && target !== ctx.move.from) {
    const passed = passTurnFen(fenBefore);
    if (passed) {
      preexisting = captureThreats(passed).some((t) => t.move.to === target && t.gain > 0);
    }
  }
  return {
    kind: 'hanging-piece',
    square: target,
    piece: best.move.captured ?? 'p',
    san: best.move.san,
    preexisting,
  };
}

/**
 * Fork: the moved piece (not the king) attacks two or more enemy pieces, each of them the
 * king, worth more than the forking piece, or loose (capturing it wins material). Pawns
 * don't count as targets, and the forking piece must not simply be lost on its square.
 */
export function detectFork(fenBefore: string, uci: string): Motif | null {
  const ctx = context(fenBefore, uci);
  if (!ctx) return null;
  const to = squareIndex(ctx.move.to);
  const piece = ctx.after[to];
  if (!piece || piece.type === 'k') return null;
  if (opponentWinsOn(ctx.fenAfter, to)) return null;

  const targets: number[] = [];
  for (const sq of attacksFrom(ctx.after, to)) {
    const target = ctx.after[sq];
    if (!target || target.color === ctx.mover || target.type === 'p') continue;
    const qualifies =
      target.type === 'k' ||
      PIECE_VALUE[target.type] > PIECE_VALUE[piece.type] ||
      exchangeGain(ctx.after, sq, ctx.mover) > 0;
    if (qualifies) targets.push(sq);
  }
  if (targets.length < 2) return null;
  targets.sort((a, b) => PIECE_VALUE[ctx.after[b]!.type] - PIECE_VALUE[ctx.after[a]!.type]);
  return {
    kind: 'fork',
    square: ctx.move.to,
    piece: piece.type,
    targets: targets.map(squareName),
    san: ctx.move.san,
  };
}

/**
 * Pin / skewer created by the moved bishop, rook or queen: along one of its lines the
 * first piece met (A) and the next one (B) are both enemy pieces.
 * - Pin: A is not a king or pawn and B is the king or worth more than A.
 * - Skewer: A is the king or worth more than B, B is not a pawn, and B can be won once A
 *   steps aside (B is worth at least the skewering piece or has no defender).
 * The slider must not be lost on its square, and the line must be new (the piece didn't
 * just slide along it).
 */
export function detectPinOrSkewer(fenBefore: string, uci: string): Motif | null {
  const ctx = context(fenBefore, uci);
  if (!ctx) return null;
  const to = squareIndex(ctx.move.to);
  const from = squareIndex(ctx.move.from);
  const piece = ctx.after[to];
  if (!piece || !['b', 'r', 'q'].includes(piece.type)) return null;
  if (opponentWinsOn(ctx.fenAfter, to)) return null;

  let best: { motif: Motif; score: number } | null = null;
  for (const [df, dr] of slidingDirections(piece.type)) {
    const ray = firstTwoOnRay(ctx.after, to, df, dr);
    if (!ray || ray[1] === null) continue;
    const [a, b] = ray;
    const front = ctx.after[a]!;
    const back = ctx.after[b]!;
    if (front.color === ctx.mover || back.color === ctx.mover) continue;
    // Sliding along the same line toward A: the pin/skewer was already there
    if (lineBetween(from, a)?.includes(to)) continue;

    let kind: 'pin' | 'skewer' | null = null;
    if (
      front.type !== 'k' &&
      front.type !== 'p' &&
      (back.type === 'k' || PIECE_VALUE[back.type] > PIECE_VALUE[front.type])
    ) {
      kind = 'pin';
    } else if (
      (front.type === 'k' || PIECE_VALUE[front.type] > PIECE_VALUE[back.type]) &&
      back.type !== 'p'
    ) {
      const withoutFront = ctx.after.slice();
      withoutFront[a] = null;
      const backDefended = attackersOf(withoutFront, b, back.color).length > 0;
      if (PIECE_VALUE[back.type] >= PIECE_VALUE[piece.type] || !backDefended) {
        kind = 'skewer';
      }
    }
    if (!kind) continue;
    const score = PIECE_VALUE[front.type] + PIECE_VALUE[back.type];
    if (!best || score > best.score) {
      best = {
        score,
        motif: {
          kind,
          square: squareName(a),
          piece: front.type,
          targets: [squareName(a), squareName(b)],
          san: ctx.move.san,
        },
      };
    }
  }
  return best?.motif ?? null;
}

/**
 * Discovered attack: the moved piece was the first thing in the line of one of the
 * mover's bishops, rooks or queens; after it moves, that line reaches an enemy king (a
 * discovered check), a piece worth more than the slider, or a loose piece. Pawns don't
 * count as targets.
 */
export function detectDiscoveredAttack(fenBefore: string, uci: string): Motif | null {
  const ctx = context(fenBefore, uci);
  if (!ctx) return null;
  const from = squareIndex(ctx.move.from);
  const to = squareIndex(ctx.move.to);

  let best: { motif: Motif; value: number } | null = null;
  for (let s = 0; s < 64; s++) {
    const slider = ctx.after[s];
    if (!slider || slider.color !== ctx.mover || s === to) continue;
    for (const [df, dr] of slidingDirections(slider.type)) {
      const beforeRay = firstTwoOnRay(ctx.before, s, df, dr);
      if (!beforeRay || beforeRay[0] !== from) continue;
      const afterRay = firstTwoOnRay(ctx.after, s, df, dr);
      if (!afterRay) continue;
      const t = afterRay[0];
      const target = ctx.after[t]!;
      if (target.color === ctx.mover || target.type === 'p') continue;
      const qualifies =
        target.type === 'k' ||
        PIECE_VALUE[target.type] > PIECE_VALUE[slider.type] ||
        exchangeGain(ctx.after, t, ctx.mover) > 0;
      if (!qualifies) continue;
      const value = target.type === 'k' ? 1000 : PIECE_VALUE[target.type];
      if (!best || value > best.value) {
        best = {
          value,
          motif: {
            kind: 'discovered-attack',
            square: squareName(t),
            piece: target.type,
            targets: [squareName(s), squareName(t)],
            san: ctx.move.san,
          },
        };
      }
    }
  }
  return best?.motif ?? null;
}

/**
 * Back-rank: a rook or queen gives check along the enemy king's back rank, the king's
 * squares on the next rank are all blocked by its own pieces, and it has no legal move.
 */
export function detectBackRank(fenBefore: string, uci: string): Motif | null {
  const ctx = context(fenBefore, uci);
  if (!ctx) return null;
  const to = squareIndex(ctx.move.to);
  const piece = ctx.after[to];
  if (!piece || (piece.type !== 'r' && piece.type !== 'q')) return null;
  const enemy = opposite(ctx.mover);
  const king = findKing(ctx.after, enemy);
  if (king < 0) return null;
  const backRank = enemy === 'w' ? 0 : 7;
  if (Math.floor(king / 8) !== backRank || Math.floor(to / 8) !== backRank) return null;

  const adapter = new RulesAdapter(ctx.fenAfter);
  if (!adapter.inCheck()) return null;
  if (adapter.verboseMoves({ square: squareName(king) }).length > 0) return null;

  const forwardRank = enemy === 'w' ? 1 : 6;
  const kingFile = king % 8;
  for (let f = kingFile - 1; f <= kingFile + 1; f++) {
    if (f < 0 || f > 7) continue;
    const occupant = ctx.after[forwardRank * 8 + f];
    if (!occupant || occupant.color !== enemy) return null;
  }
  return { kind: 'back-rank', square: squareName(king), san: ctx.move.san };
}

/**
 * Missed mate: the mover had a forced mate within the mate horizon and the move neither
 * mates nor keeps a forced mate within the horizon. Scores are from the mover's view;
 * `afterScore` is the engine's score once the move is played.
 */
export function detectMissedMate(input: {
  fenBefore: string;
  uci: string;
  bestMoveUci: string | null;
  bestScore: UciScore | null;
  afterScore?: UciScore | null;
}): Motif | null {
  const { bestScore } = input;
  if (!bestScore || bestScore.type !== 'mate' || bestScore.value <= 0) return null;
  if (bestScore.value > MATE_HORIZON_MOVES) return null;
  const applied = applyUci(input.fenBefore, input.uci);
  if (!applied) return null;
  const after = new RulesAdapter(applied.after);
  if (after.isCheckmate()) return null;
  const a = input.afterScore;
  if (a && a.type === 'mate' && a.value > 0 && a.value <= MATE_HORIZON_MOVES) return null;

  const squares = parseSquares(input.fenBefore);
  const king = findKing(squares, opposite(applied.move.color));
  return {
    kind: 'missed-mate',
    square: squareName(Math.max(0, king)),
    mateIn: bestScore.value,
    san: input.bestMoveUci ? (uciToSan(input.fenBefore, input.bestMoveUci) ?? undefined) : undefined,
  };
}

function isTrapped(fen: string, square: number, captor: Color): boolean {
  const squares = parseSquares(fen);
  if (exchangeGain(squares, square, captor) <= 0) return false;
  let adapter: RulesAdapter;
  try {
    adapter = new RulesAdapter(fen);
  } catch {
    return false;
  }
  for (const escape of adapter.verboseMoves({ square: squareName(square) })) {
    const next = squares.slice();
    next[squareIndex(escape.to)] = next[square]!;
    next[square] = null;
    const net = capturedValue(escape) - exchangeGain(next, squareIndex(escape.to), captor);
    if (net >= 0) return false;
  }
  return true;
}

/**
 * Trapped piece: after the move an enemy knight, bishop, rook or queen is attacked and
 * lost where it stands, and every legal move it has also loses material. It must be newly
 * trapped (with the turn passed back, it wasn't trapped before the move). A side in check
 * is never reported: the check, not the piece's surroundings, is what limits its moves.
 */
export function detectTrappedPiece(fenBefore: string, uci: string): Motif | null {
  const ctx = context(fenBefore, uci);
  if (!ctx) return null;
  if (ctx.move.san.endsWith('+') || ctx.move.san.endsWith('#')) return null;
  const enemy = opposite(ctx.mover);
  const passed = passTurnFen(fenBefore);
  let best: Motif | null = null;
  for (let sq = 0; sq < 64; sq++) {
    const piece = ctx.after[sq];
    if (!piece || piece.color !== enemy || piece.type === 'p' || piece.type === 'k') continue;
    if (!isTrapped(ctx.fenAfter, sq, ctx.mover)) continue;
    if (passed && ctx.before[sq]?.type === piece.type && isTrapped(passed, sq, ctx.mover)) continue;
    if (!best || PIECE_VALUE[piece.type] > PIECE_VALUE[best.piece ?? 'p']) {
      best = { kind: 'trapped-piece', square: squareName(sq), piece: piece.type, san: ctx.move.san };
    }
  }
  return best;
}

/**
 * Promotion threat: a pawn steps onto its seventh rank with the promotion square empty,
 * the opponent can't win the pawn at once, and promoting next move would keep the new
 * queen's value after the exchange on the promotion square.
 */
export function detectPromotionThreat(fenBefore: string, uci: string): Motif | null {
  const ctx = context(fenBefore, uci);
  if (!ctx || ctx.move.piece !== 'p' || ctx.move.promotion) return null;
  const to = squareIndex(ctx.move.to);
  const seventh = ctx.mover === 'w' ? 6 : 1;
  if (Math.floor(to / 8) !== seventh) return null;
  const promotionSquare = to + (ctx.mover === 'w' ? 8 : -8);
  if (ctx.after[promotionSquare]) return null;
  if (opponentWinsOn(ctx.fenAfter, to)) return null;

  const promoted = ctx.after.slice();
  promoted[promotionSquare] = { color: ctx.mover, type: 'q' };
  promoted[to] = null;
  const kept = PIECE_VALUE.q - PIECE_VALUE.p - exchangeGain(promoted, promotionSquare, opposite(ctx.mover));
  if (kept <= 0) return null;
  return { kind: 'promotion-threat', square: ctx.move.to, piece: 'p', san: ctx.move.san };
}

/** All board-only detectors for one move (missed-mate needs engine scores and is separate). */
export function detectMoveMotifs(fenBefore: string, uci: string): Motif[] {
  const found: Array<Motif | null> = [
    detectHangingPiece(fenBefore, uci),
    detectFork(fenBefore, uci),
    detectPinOrSkewer(fenBefore, uci),
    detectDiscoveredAttack(fenBefore, uci),
    detectBackRank(fenBefore, uci),
    detectTrappedPiece(fenBefore, uci),
    detectPromotionThreat(fenBefore, uci),
  ];
  return found.filter((m): m is Motif => m !== null);
}
