import { RulesAdapter, type Color, type PieceSymbol, type Square } from '../core/rules';
import {
  PIECE_NAME,
  PIECE_VALUE,
  applyUci,
  bestCaptureThreat,
  captureThreats,
  fenTurn,
  materialCount,
  opposite,
  parseSquares,
  squareIndex,
  uciToSan,
} from './board';
import { DECIDED_WIN_PERCENT, isErrorClass } from './classification';
import {
  detectBackRank,
  detectDiscoveredAttack,
  detectFork,
  detectHangingPiece,
  detectMissedMate,
  detectPinOrSkewer,
  detectPromotionThreat,
  detectTrappedPiece,
} from './motifs';
import { scoreToCentipawns, type UciScore } from '../engine/uci-parser';
import type { Motif, MoveClassification, PositionAnalysis } from './types';

/*
 * One rule-based sentence per Inaccuracy, Mistake, Blunder or Miss. The rules are tried
 * in order and the first that applies writes the sentence (docs/classification.md lists
 * them). Every motif found on the way is returned too, tagged with whose move it is.
 *
 * A motif or a material claim is only used when the engine's line realizes it: following
 * the move and the engine's best line from the position before the move, the material
 * really changes hands (or the trapped piece is really captured). A recapture that only
 * restores the balance, or a piece that is attacked but can step away, names nothing;
 * the sentence then falls back to what happened to the evaluation.
 */

/** Plies of the engine line followed to see whether material really changes hands. */
export const REALIZE_PLIES = 10;

/** Material (pawns) a claim must actually win: the piece's value, at most 2. */
function requiredGain(value: number): number {
  return Math.min(value, 2);
}

/**
 * Material `color` gains (pawns; negative when it loses) from `fen` along `ucis`, measured
 * where the material settles: after the line's first capture, at the first two quiet
 * plies in a row. An even exchange therefore counts as nothing, however it starts. A line
 * that doesn't settle within REALIZE_PLIES is measured at its end, counting the best
 * capture pending for the side to move there.
 */
export function lineMaterialGain(fen: string, ucis: readonly string[], color: Color): number {
  const balance = (f: string) => {
    const sq = parseSquares(f);
    return materialCount(sq, color) - materialCount(sq, opposite(color));
  };
  const start = balance(fen);
  let adapter: RulesAdapter;
  try {
    adapter = new RulesAdapter(fen);
  } catch {
    return 0;
  }
  let seenCapture = false;
  let quiet = 0;
  for (const uci of ucis.slice(0, REALIZE_PLIES)) {
    let move;
    try {
      move = adapter.move(uci);
    } catch {
      break;
    }
    if (move.captured || move.promotion) {
      seenCapture = true;
      quiet = 0;
    } else if (++quiet >= 2 && seenCapture && !adapter.isGameOver()) {
      // Settled only if no profitable capture is pending (an in-between move such as
      // ...Nxc4 Qa4 Kc8 dxc4 delays a recapture, it doesn't cancel it)
      const now = adapter.fen();
      if (!bestCaptureThreat(now)) return balance(now) - start;
    }
  }
  const end = adapter.fen();
  const pending = adapter.isGameOver() ? null : bestCaptureThreat(end);
  const pendingGain = pending ? (fenTurn(end) === color ? pending.gain : -pending.gain) : 0;
  return balance(end) - start + pendingGain;
}

/** Follows the piece on `square` along `ucis`: is it captured? */
export function capturedAlongLine(fen: string, ucis: readonly string[], square: Square): boolean {
  let adapter: RulesAdapter;
  try {
    adapter = new RulesAdapter(fen);
  } catch {
    return false;
  }
  let at: string = square;
  for (const uci of ucis.slice(0, REALIZE_PLIES)) {
    let move;
    try {
      move = adapter.move(uci);
    } catch {
      return false;
    }
    if (move.to === at && move.captured) return true;
    if (move.from === at) at = move.to;
  }
  return false;
}

/** The most valuable piece a motif goes after (a king counts as 2: it forces material). */
function claimedValue(motif: Motif, fen: string): number {
  if (motif.kind === 'promotion-threat') return PIECE_VALUE.q - PIECE_VALUE.p;
  const board = parseSquares(fen);
  const squares = motif.kind === 'fork' ? (motif.targets ?? []) : [motif.square];
  let best = 0;
  for (const sq of squares) {
    const piece = board[squareIndex(sq)];
    if (!piece) continue;
    best = Math.max(best, piece.type === 'k' ? 2 : PIECE_VALUE[piece.type]);
  }
  return best;
}

/** Where a realization count starts, the line followed, and who should gain. */
interface Realize {
  baseFen: string;
  line: readonly string[];
  beneficiary: Color;
  /**
   * How much the engine's evaluation moved in the beneficiary's favour (pawns). A claim
   * must be backed by it: a short line can stop before a recapture (...Nxc4 Qa4, with
   * dxc4 still to come), but then the evaluation hasn't moved by a knight either.
   */
  evalSwing: number;
}

/** The evaluation must move by at least this share of the material claimed. */
const EVAL_BACKING_SHARE = 0.5;

function backedByEval(claimed: number, realize: Realize): boolean {
  return realize.evalSwing >= claimed * EVAL_BACKING_SHARE;
}

export interface ExplainInput {
  classification: MoveClassification;
  fenBefore: string;
  uci: string;
  /** Mover's win% before and after the move. */
  winBefore: number;
  winAfter: number;
  /** Analysis of the position the move was played from (mover to move). */
  before: PositionAnalysis;
  /** Analysis of the position after the move (opponent to move). */
  after: PositionAnalysis;
}

export interface ExplainResult {
  explanation: string | null;
  motifs: Motif[];
}

const ARTICLE_PIECE: Record<PieceSymbol, string> = {
  p: 'a pawn',
  n: 'a knight',
  b: 'a bishop',
  r: 'a rook',
  q: 'a queen',
  k: 'a king',
};

function pieceOn(motif: Motif): string {
  return `${PIECE_NAME[motif.piece ?? 'p']} on ${motif.square}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function tagged(motif: Motif | null, role: Motif['role']): Motif | null {
  return motif ? { ...motif, role } : null;
}

/**
 * Motifs `uci` creates from `fen` (not hanging-piece: that is about the mover's own
 * material) that `realize`'s line actually cashes in.
 */
function attackMotifs(fen: string, uci: string, role: Motif['role'], realize: Realize): Motif[] {
  const after = applyUci(fen, uci)?.after ?? fen;
  // The line from `fen` on (the count may start one move earlier, before the reviewed move)
  const fromHere = realize.baseFen === fen ? realize.line : realize.line.slice(1);
  const gain = lineMaterialGain(realize.baseFen, realize.line, realize.beneficiary);
  const found = [
    detectBackRank(fen, uci),
    detectFork(fen, uci),
    detectPinOrSkewer(fen, uci),
    detectDiscoveredAttack(fen, uci),
    detectTrappedPiece(fen, uci),
    detectPromotionThreat(fen, uci),
  ].filter((m): m is Motif => m !== null);
  return found
    .filter((m) => {
      if (m.kind === 'back-rank') return true; // only named when the line is a forced mate
      if (m.kind === 'trapped-piece') return capturedAlongLine(fen, fromHere, m.square);
      // The tactic has to net material; what it wins needn't be the piece it attacks
      // (Nh4? Nxe4!: the discovered attack on h4 wins the e4 pawn)
      return claimedValue(m, after) > 0 && gain >= 1 && backedByEval(gain, realize);
    })
    .map((m) => ({ ...m, role }));
}

/** What the motif does to the opponent, as a participle phrase ("forking the king and rook"). */
function motifPhrase(motif: Motif, fen: string): string | null {
  const board = parseSquares(fen);
  const names = (motif.targets ?? []).map((sq: Square) => {
    const piece = board[squareIndex(sq)];
    return piece ? PIECE_NAME[piece.type] : sq;
  });
  switch (motif.kind) {
    case 'fork':
      return `forking the ${joinNames(names)}`;
    case 'pin':
      return `pinning the ${names[0]} to the ${names[1]}`;
    case 'skewer':
      return `skewering the ${names[0]} and the ${names[1]}`;
    case 'discovered-attack':
      return motif.piece === 'k' ? 'a discovered check' : `a discovered attack on the ${pieceOn(motif)}`;
    case 'trapped-piece':
      return `trapping the ${pieceOn(motif)}`;
    case 'promotion-threat':
      return 'threatening to promote';
    default:
      return null;
  }
}

/** A capture with `uci` that nets material, if `realize`'s line really wins that much. */
function winningCapture(fen: string, uci: string, realize: Realize): { piece: PieceSymbol; square: string } | null {
  const threat = captureThreats(fen).find((t) => t.move.uci === uci && t.gain > 0);
  if (!threat) return null;
  const piece = threat.move.captured ?? 'p';
  const gain = lineMaterialGain(realize.baseFen, realize.line, realize.beneficiary);
  const claimed = PIECE_VALUE[piece];
  return gain >= requiredGain(claimed) && backedByEval(claimed, realize) ? { piece, square: threat.move.to } : null;
}

/** How a side stands, from its win%. */
export type Standing = 'winning' | 'better' | 'equal' | 'worse' | 'losing';

/** Lower bounds of the bands (mover's win%): +1.9, +0.65, −0.65, −1.9 pawns or so. */
export const STANDING_MIN_WIN = { winning: 67, better: 56, equal: 44, worse: 33 } as const;

const STANDING_RANK: Record<Standing, number> = { losing: 0, worse: 1, equal: 2, better: 3, winning: 4 };

export function standingFromWin(win: number): Standing {
  if (win >= STANDING_MIN_WIN.winning) return 'winning';
  if (win >= STANDING_MIN_WIN.better) return 'better';
  if (win > STANDING_MIN_WIN.equal) return 'equal';
  if (win >= STANDING_MIN_WIN.worse) return 'worse';
  return 'losing';
}

/** An evaluation from White's side, as the eval bar shows it: "+1.5", "−2.0", "0.0", "M3", "−M3". */
export function formatEvalShort(scoreWhite: UciScore | null): string {
  if (!scoreWhite) return '0.0';
  if (scoreWhite.type === 'mate') {
    return scoreWhite.value < 0 ? `−M${-scoreWhite.value}` : `M${scoreWhite.value}`;
  }
  const text = (Math.abs(scoreWhite.value) / 100).toFixed(1);
  if (text === '0.0') return text;
  return scoreWhite.value < 0 ? `−${text}` : `+${text}`;
}

/** How much of an edge a drop inside one band gave back, by class. */
const SHARE_BY_CLASS: Partial<Record<MoveClassification, string>> = {
  Inaccuracy: 'some of',
  Mistake: 'much of',
  Blunder: 'a large part of',
};

/**
 * The sentence when no tactic explains an error: the side, how its standing changed,
 * the evaluation change (White's view) and the move that kept it. One sentence: the best
 * move is joined with a semicolon.
 */
export function fallbackSentence(params: {
  classification: MoveClassification;
  side: Color;
  winBefore: number;
  winAfter: number;
  evalChange: string;
  bestSan: string | null;
}): string {
  const s = params.side === 'w' ? 'White' : 'Black';
  const e = `(${params.evalChange})`;
  const from = standingFromWin(params.winBefore);
  let to = standingFromWin(params.winAfter);
  // An error never improves the standing; noise at a band edge is read as staying put
  if (STANDING_RANK[to] > STANDING_RANK[from]) to = from;
  const share = SHARE_BY_CLASS[params.classification] ?? 'some of';
  const tail = (what: string) => (params.bestSan ? `; ${params.bestSan} ${what}` : '');

  let text: string;
  if (params.classification === 'Miss') {
    if (from === 'winning') text = `Misses the win for ${s} ${e}${tail('was winning')}`;
    else if (from === 'better') text = `Lets the opponent off the hook ${e}${tail(`kept ${s}'s advantage`)}`;
    else text = `Leaves the opponent's mistake unpunished ${e}${tail('punished it')}`;
    return `${text}.`;
  }
  switch (from) {
    case 'winning':
      if (to === 'winning') text = `Gives back ${share} ${s}'s winning advantage ${e}${tail('was stronger')}`;
      else if (to === 'better')
        text =
          params.classification === 'Blunder'
            ? `Throws away most of ${s}'s winning advantage ${e}${tail('kept the win')}`
            : `Lets ${s}'s winning advantage shrink to a small edge ${e}${tail('kept the win')}`;
      else if (to === 'equal') text = `Throws away ${s}'s winning advantage ${e}${tail('kept it')}`;
      else if (to === 'worse')
        text = `Throws away ${s}'s winning advantage and gives the opponent the better game ${e}${tail('kept the win')}`;
      else text = `Turns ${s}'s winning position into a losing one ${e}${tail('kept the win')}`;
      break;
    case 'better':
      if (to === 'better') text = `Gives back ${share} ${s}'s advantage ${e}${tail('was stronger')}`;
      else if (to === 'equal')
        text =
          params.classification === 'Blunder'
            ? `Throws away ${s}'s advantage ${e}${tail('kept it')}`
            : `Lets ${s}'s advantage slip away ${e}${tail('kept it')}`;
      else if (to === 'worse')
        text = `Turns ${s}'s advantage into the worse position ${e}${tail('kept the advantage')}`;
      else text = `Turns ${s}'s advantage into a losing position ${e}${tail('kept the advantage')}`;
      break;
    case 'equal':
      if (to === 'equal') text = `Gives the opponent the easier game ${e}${tail('was stronger')}`;
      else if (to === 'worse')
        text = `Hands the opponent the advantage in a level position ${e}${tail('kept the balance')}`;
      else text = `Turns a level position into a losing one for ${s} ${e}${tail('kept the balance')}`;
      break;
    case 'worse':
      if (to === 'worse') text = `Makes ${s}'s difficult position harder ${e}${tail('defended better')}`;
      else text = `Turns ${s}'s difficult position into a losing one ${e}${tail('held on')}`;
      break;
    case 'losing':
      text = `Makes ${s}'s losing position ${params.classification === 'Inaccuracy' ? 'worse' : 'much worse'} ${e}${tail('was the toughest defence')}`;
      break;
  }
  return `${text}.`;
}

function mateDistance(analysis: PositionAnalysis): number | null {
  const score = analysis.lines[0]?.score;
  return score && score.type === 'mate' && score.value > 0 ? score.value : null;
}

export function explainMove(input: ExplainInput): ExplainResult {
  const motifs: Motif[] = [];
  if (!isErrorClass(input.classification)) return { explanation: null, motifs };

  const best = input.before.lines[0];
  const bestUci = best?.pv[0] ?? null;
  const bestSan = bestUci ? uciToSan(input.fenBefore, bestUci) : null;
  const applied = applyUci(input.fenBefore, input.uci);
  if (!applied) return { explanation: null, motifs };
  const fenAfter = applied.after;
  const refutationLine = input.after.terminal ? [] : (input.after.lines[0]?.pv ?? []);
  const refutationUci = refutationLine[0] ?? null;
  const refutationSan = refutationUci ? uciToSan(fenAfter, refutationUci) : null;
  const mover = applied.move.color;
  // Mover's evaluation (pawns) before the move, after it, and after the best move
  const pawns = (score: UciScore | undefined) => (score ? scoreToCentipawns(score) / 100 : 0);
  const evalBefore = pawns(best?.score);
  const evalAfter =
    input.after.terminal === 'checkmate' ? 100 : input.after.terminal ? 0 : -pawns(input.after.lines[0]?.score);
  // The reviewed move and the opponent's best line, counted from before the move
  const againstMover: Realize = {
    baseFen: input.fenBefore,
    line: [input.uci, ...refutationLine],
    beneficiary: opposite(mover),
    evalSwing: evalBefore - evalAfter,
  };
  const moverLoss = lineMaterialGain(againstMover.baseFen, againstMover.line, opposite(mover));

  // What the move itself and the opponent's best reply do
  let hanging = tagged(detectHangingPiece(input.fenBefore, input.uci), 'played');
  if (
    hanging &&
    !(
      capturedAlongLine(fenAfter, refutationLine, hanging.square) &&
      moverLoss >= requiredGain(PIECE_VALUE[hanging.piece ?? 'p']) &&
      backedByEval(PIECE_VALUE[hanging.piece ?? 'p'], againstMover)
    )
  ) {
    hanging = null; // attacked, but the engine's line doesn't actually win it
  }
  if (hanging) motifs.push(hanging);
  const refutationMotifs = refutationUci ? attackMotifs(fenAfter, refutationUci, 'refutation', againstMover) : [];
  motifs.push(...refutationMotifs);
  const missedMate = tagged(
    detectMissedMate({
      fenBefore: input.fenBefore,
      uci: input.uci,
      bestMoveUci: bestUci,
      bestScore: best?.score ?? null,
      afterScore: input.after.lines[0]
        ? { type: input.after.lines[0].score.type, value: -input.after.lines[0].score.value }
        : null,
    }),
    'missed',
  );
  if (missedMate) motifs.push(missedMate);
  const forMover: Realize = {
    baseFen: input.fenBefore,
    line: best?.pv ?? [],
    beneficiary: mover,
    evalSwing: evalBefore - evalAfter,
  };
  const missedMotifs =
    input.classification === 'Miss' && bestUci && bestUci !== input.uci
      ? attackMotifs(input.fenBefore, bestUci, 'missed', forMover)
      : [];
  motifs.push(...missedMotifs);

  const better = bestSan && bestUci !== input.uci ? bestSan : null;
  // The evaluation before and after the move, from White's side
  const toWhite = (score: UciScore | undefined, pov: Color): UciScore | null =>
    score ? (pov === 'w' ? score : { type: score.type, value: -score.value }) : null;
  const whiteBefore = toWhite(best?.score, mover);
  const whiteAfter: UciScore | null = input.after.terminal
    ? { type: 'cp', value: 0 }
    : toWhite(input.after.lines[0]?.score, opposite(mover));
  const fallback = () =>
    fallbackSentence({
      classification: input.classification,
      side: mover,
      winBefore: input.winBefore,
      winAfter: input.winAfter,
      evalChange: `${formatEvalShort(whiteBefore)} → ${formatEvalShort(whiteAfter)}`,
      bestSan: better,
    });

  // 1. A won position thrown away by stalemate
  if (input.after.terminal === 'stalemate' && input.winBefore >= DECIDED_WIN_PERCENT) {
    const explanation =
      better && better.endsWith('#')
        ? `Stalemates the opponent; ${better} was mate.`
        : `Stalemates the opponent and throws away the win${better ? `; ${better} was winning` : ''}.`;
    return { explanation, motifs };
  }

  // 2. The opponent can now force mate
  const opponentMate = mateDistance(input.after);
  if (opponentMate !== null && refutationSan) {
    let explanation: string;
    if (opponentMate === 1) {
      const backRank = refutationMotifs.find((m) => m.kind === 'back-rank');
      explanation = backRank
        ? `Allows ${refutationSan}, a back-rank mate.`
        : `Allows ${refutationSan}, an immediate mate.`;
    } else {
      explanation = `Allows mate in ${opponentMate}, starting with ${refutationSan}.`;
    }
    return { explanation, motifs };
  }

  // 3. A short forced mate was on the board and is gone
  if (missedMate && missedMate.san) {
    const n = missedMate.mateIn ?? 1;
    const explanation =
      n === 1 ? `Misses mate in 1 with ${missedMate.san}.` : `Misses mate in ${n}, starting with ${missedMate.san}.`;
    return { explanation, motifs };
  }

  // 4. Miss: the opponent's error went unpunished; say what the best move would have won
  if (input.classification === 'Miss' && better && bestUci) {
    const capture = winningCapture(input.fenBefore, bestUci, forMover);
    if (capture) {
      return {
        explanation: `Misses ${better}, which wins the ${PIECE_NAME[capture.piece]} on ${capture.square}.`,
        motifs,
      };
    }
    const motif = missedMotifs.find((m) => m.kind !== 'back-rank');
    const phrase = motif ? motifPhrase(motif, applyUci(input.fenBefore, bestUci)?.after ?? input.fenBefore) : null;
    return { explanation: phrase ? `Misses ${better}, ${phrase}.` : fallback(), motifs };
  }

  // 5. The move leaves material en prise and the opponent's best reply takes it
  if (hanging && hanging.san && refutationUci?.slice(2, 4) === hanging.square) {
    const piece = pieceOn(hanging);
    let explanation: string;
    if (hanging.preexisting) {
      explanation = `Leaves the ${piece} hanging to ${hanging.san}.`;
    } else if (applied.move.captured && hanging.square === applied.move.to) {
      explanation = `Gives up the ${piece} for ${ARTICLE_PIECE[applied.move.captured]}; ${hanging.san} takes it.`;
    } else {
      explanation = `Hangs the ${piece} to ${hanging.san}.`;
    }
    return { explanation, motifs };
  }

  // 6. The opponent's best reply is a tactic
  if (refutationSan && refutationUci) {
    const motif = refutationMotifs.find((m) => m.kind !== 'back-rank');
    const phrase = motif ? motifPhrase(motif, applyUci(fenAfter, refutationUci)?.after ?? fenAfter) : null;
    if (phrase) return { explanation: `Allows ${refutationSan}, ${phrase}.`, motifs };
    const capture = winningCapture(fenAfter, refutationUci, againstMover);
    if (capture) {
      return {
        explanation: `Allows ${refutationSan}, winning the ${PIECE_NAME[capture.piece]} on ${capture.square}.`,
        motifs,
      };
    }
  }

  // 7. No realized tactic: what happened to the side's standing, the evaluation change and
  // the move that kept it
  return { explanation: fallback(), motifs };
}
