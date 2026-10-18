import type { PieceSymbol, Square } from '../core/rules';
import {
  PIECE_NAME,
  applyUci,
  captureThreats,
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
import type { Motif, MoveClassification, PositionAnalysis } from './types';

/*
 * One rule-based sentence per Inaccuracy, Mistake, Blunder or Miss. The rules are tried
 * in order and the first that applies writes the sentence (docs/classification.md lists
 * them). Every motif found on the way is returned too, tagged with whose move it is.
 */

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

/** Motifs a move creates (not hanging-piece: that is about the mover's own material). */
function attackMotifs(fen: string, uci: string, role: Motif['role']): Motif[] {
  return [
    detectBackRank(fen, uci),
    detectFork(fen, uci),
    detectPinOrSkewer(fen, uci),
    detectDiscoveredAttack(fen, uci),
    detectTrappedPiece(fen, uci),
    detectPromotionThreat(fen, uci),
  ]
    .map((m) => tagged(m, role))
    .filter((m): m is Motif => m !== null);
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
      return motif.piece === 'k'
        ? 'a discovered check'
        : `a discovered attack on the ${pieceOn(motif)}`;
    case 'trapped-piece':
      return `trapping the ${pieceOn(motif)}`;
    case 'promotion-threat':
      return 'threatening to promote';
    default:
      return null;
  }
}

/** A capture that nets material for the side to move in `fen` with `uci`, if it is one. */
function winningCapture(fen: string, uci: string): { piece: PieceSymbol; square: string } | null {
  const threat = captureThreats(fen).find((t) => t.move.uci === uci && t.gain > 0);
  return threat ? { piece: threat.move.captured ?? 'p', square: threat.move.to } : null;
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
  const refutationUci = input.after.lines[0]?.pv[0] ?? null;
  const refutationSan = refutationUci ? uciToSan(fenAfter, refutationUci) : null;

  // What the move itself and the opponent's best reply do
  const hanging = tagged(detectHangingPiece(input.fenBefore, input.uci), 'played');
  if (hanging) motifs.push(hanging);
  const refutationMotifs = refutationUci ? attackMotifs(fenAfter, refutationUci, 'refutation') : [];
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
  const missedMotifs =
    input.classification === 'Miss' && bestUci && bestUci !== input.uci
      ? attackMotifs(input.fenBefore, bestUci, 'missed')
      : [];
  motifs.push(...missedMotifs);

  const better = bestSan && bestUci !== input.uci ? bestSan : null;

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
      n === 1
        ? `Misses mate in 1 with ${missedMate.san}.`
        : `Misses mate in ${n}, starting with ${missedMate.san}.`;
    return { explanation, motifs };
  }

  // 4. Miss: the opponent's error went unpunished; say what the best move would have won
  if (input.classification === 'Miss' && better && bestUci) {
    const capture = winningCapture(input.fenBefore, bestUci);
    let what: string;
    if (capture) {
      what = `which wins the ${PIECE_NAME[capture.piece]} on ${capture.square}`;
    } else {
      const motif = missedMotifs.find((m) => m.kind !== 'back-rank');
      const phrase = motif ? motifPhrase(motif, applyUci(input.fenBefore, bestUci)?.after ?? input.fenBefore) : null;
      what = phrase ?? "which keeps the advantage from the opponent's mistake";
    }
    return { explanation: `Misses ${better}, ${what}.`, motifs };
  }

  // 5. The move leaves material en prise and the opponent's best reply takes it
  if (hanging && hanging.san && (!refutationUci || refutationUci.slice(2, 4) === hanging.square)) {
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
    const phrase = motif
      ? motifPhrase(motif, applyUci(fenAfter, refutationUci)?.after ?? fenAfter)
      : null;
    if (phrase) return { explanation: `Allows ${refutationSan}, ${phrase}.`, motifs };
    const capture = winningCapture(fenAfter, refutationUci);
    if (capture) {
      return {
        explanation: `Allows ${refutationSan}, winning the ${PIECE_NAME[capture.piece]} on ${capture.square}.`,
        motifs,
      };
    }
  }

  // 7. No concrete tactic: describe what happened to the evaluation
  let explanation: string;
  if (input.winBefore >= 50 && input.winAfter < 45) {
    explanation = 'Hands the opponent the advantage';
  } else if (input.winBefore >= 60) {
    explanation = 'Lets part of the advantage slip';
  } else {
    explanation = 'Loses ground';
  }
  return { explanation: better ? `${explanation}; ${better} was better.` : `${explanation}.`, motifs };
}
