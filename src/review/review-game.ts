import { GameTree, type MoveClassification, type PgnEvalAnnotation } from '../core/game-tree';
import { writePgn } from '../core/pgn';
import { RulesAdapter, type Color } from '../core/rules';
import { scoreToCentipawns, type UciScore } from '../engine/uci-parser';
import { fenTurn, lineToSan, uciToSan } from './board';
import { stripEngineAnnotations, withReviewComment } from './annotations';
import { classifyMove, isErrorClass } from './classification';
import { explainMove } from './explain';
import {
  WIN_PERCENT_CP_CEILING,
  calibrationCentipawnLoss,
  ceiledCentipawns,
  centipawnLoss,
  estimateBotLevel,
  formatBotLevel,
  winPercentFromCp,
  gameAccuracy,
  moveAccuracy,
  winPercentFromScore,
} from './formulas';
import type {
  GameReview,
  KeyMoment,
  PositionAnalysis,
  ReviewBudget,
  ReviewPreset,
  ReviewedMove,
  SideReviewSummary,
} from './types';

/** One move of the line under review (the game's main line). */
export interface ReviewPly {
  nodeId: string;
  uci: string;
  san: string;
  color: Color;
  moveNumber: number;
  fenBefore: string;
  fenAfter: string;
}

export interface ReviewGameInput {
  preset: ReviewPreset | null;
  budget: ReviewBudget;
  startFen: string;
  plies: readonly ReviewPly[];
  /** positions[i]: the position after i plies (0 = start); missing until analyzed. */
  positions: ReadonlyArray<PositionAnalysis | undefined>;
  /** The position is in the openings dataset. */
  isBookPosition: (fen: string) => boolean;
}

/** Key moments: at most this many, and moves that swing White's win% by less don't count. */
export const KEY_MOMENT_MAX = 5;
export const KEY_MOMENT_MIN = 3;
export const KEY_MOMENT_MIN_SWING = 5;

/** Plies of engine line kept for the best line and the refutation. */
const LINE_PLIES = 8;

export const ALL_CLASSIFICATIONS: readonly MoveClassification[] = [
  'Brilliant',
  'Great',
  'Best',
  'Excellent',
  'Good',
  'Book',
  'Inaccuracy',
  'Mistake',
  'Blunder',
  'Miss',
];

/** The plies of a tree's main line, ready for review. */
export function mainLinePlies(tree: GameTree): ReviewPly[] {
  const plies: ReviewPly[] = [];
  let before = tree.root.fen;
  for (const node of tree.getMainLine()) {
    if (node.parentId === null) continue;
    plies.push({
      nodeId: node.id,
      uci: node.uci,
      san: node.san,
      color: node.moveColor ?? (fenTurn(before) === 'w' ? 'w' : 'b'),
      moveNumber: node.moveNumber,
      fenBefore: before,
      fenAfter: node.fen,
    });
    before = node.fen;
  }
  return plies;
}

/** White's win% for an analyzed position (null when it has no result yet). */
export function whiteWinPercent(analysis: PositionAnalysis | undefined): number | null {
  if (!analysis) return null;
  const turn = fenTurn(analysis.fen);
  // A checkmated side counts as −1000 cp, as in Lichess's analysis (2.5% / 97.5%)
  if (analysis.terminal === 'checkmate') {
    return winPercentFromCp(turn === 'w' ? -WIN_PERCENT_CP_CEILING : WIN_PERCENT_CP_CEILING);
  }
  if (analysis.terminal) return 50;
  const best = analysis.lines[0];
  if (!best) return null;
  const sideToMove = winPercentFromScore(best.score);
  return turn === 'w' ? sideToMove : 100 - sideToMove;
}

/** White's view of a score given from the point of view of `side`. */
function whiteScore(score: UciScore, side: Color): UciScore {
  return side === 'w' ? score : { type: score.type, value: -score.value };
}

/** The `[%eval]` annotation for the position after a move (White's point of view). */
export function evalAnnotation(analysis: PositionAnalysis): PgnEvalAnnotation | undefined {
  if (analysis.terminal === 'checkmate') return undefined;
  if (analysis.terminal) return { cp: 0 };
  const best = analysis.lines[0];
  if (!best) return undefined;
  const score = whiteScore(best.score, fenTurn(analysis.fen));
  return score.type === 'mate'
    ? { mate: score.value, depth: analysis.depth }
    : { cp: score.value, depth: analysis.depth };
}

function emptyCounts(): Record<MoveClassification, number> {
  return Object.fromEntries(ALL_CLASSIFICATIONS.map((c) => [c, 0])) as Record<MoveClassification, number>;
}

function legalMoveCount(fen: string): number {
  try {
    return new RulesAdapter(fen).moves().length;
  } catch {
    return 0;
  }
}

/** Everything needed to review one move; plain data, so it can go to a worker. */
export interface ReviewMoveInput {
  /** 0-based move index (the move is ply index + 1). */
  index: number;
  ply: ReviewPly;
  /** The position the move was played from, and the one after it. */
  before: PositionAnalysis;
  after: PositionAnalysis;
  /** The opponent's previous move and the position it was played from (for Miss). */
  previous: { fenBefore: string; uci: string; before: PositionAnalysis } | null;
  isBook: boolean;
}

export interface MoveAnalysis {
  move: ReviewedMove | null;
  /**
   * The move needs a verification search: its class is Mistake, Blunder or Miss, or a
   * short forced mate appears or disappears across it (docs/classification.md).
   */
  suspicious: boolean;
}

const VERIFY_CLASSES: ReadonlySet<MoveClassification> = new Set(['Mistake', 'Blunder', 'Miss']);

/** The input for move `index`, or null until both positions around it are analyzed. */
export function reviewMoveInput(
  plies: readonly ReviewPly[],
  positions: ReadonlyArray<PositionAnalysis | undefined>,
  index: number,
  isBook: boolean,
): ReviewMoveInput | null {
  const ply = plies[index];
  const before = positions[index];
  const after = positions[index + 1];
  if (!ply || !before || !after) return null;
  const prevPly = index >= 1 ? plies[index - 1] : undefined;
  const prevBefore = index >= 1 ? positions[index - 1] : undefined;
  return {
    index,
    ply,
    before,
    after,
    previous: prevPly && prevBefore ? { fenBefore: prevPly.fenBefore, uci: prevPly.uci, before: prevBefore } : null,
    isBook,
  };
}

/**
 * Classifies, explains and scores one move. This is the heavy part of a review (chess.js
 * move generation for the sacrifice check and the motif detectors, 10–25 ms for an error
 * move), so the live review runs it in a worker (review-analysis-client.ts).
 */
export function analyzeMove(input: ReviewMoveInput): MoveAnalysis {
  const { ply, before, after, index } = input;
  const result = classifyMove({
    fenBefore: ply.fenBefore,
    uci: ply.uci,
    before,
    after,
    previous: input.previous,
    isBook: input.isBook,
  });
  if (!result) return { move: null, suspicious: false };
  const suspicious = VERIFY_CLASSES.has(result.classification) || result.mateLost || result.mateCreated;

  const best = before.lines[0];
  const bestMoveUci = best?.pv[0] ?? null;
  const refutationUci = after.terminal ? [] : (after.lines[0]?.pv.slice(0, LINE_PLIES) ?? []);
  const { explanation, motifs } = isErrorClass(result.classification)
    ? explainMove({
        classification: result.classification,
        fenBefore: ply.fenBefore,
        uci: ply.uci,
        winBefore: result.winBefore,
        winAfter: result.winAfter,
        before,
        after,
      })
    : { explanation: null, motifs: [] };

  const deliveredMate = after.terminal === 'checkmate';
  // Lichess's loss: ceiled evaluations before and after, every move counted
  let afterCeiled = 0; // stalemate or insufficient material: a draw
  if (deliveredMate) afterCeiled = WIN_PERCENT_CP_CEILING;
  else if (result.scoreAfter) afterCeiled = ceiledCentipawns(result.scoreAfter);
  const cpLoss = best ? centipawnLoss(ceiledCentipawns(best.score), afterCeiled) : 0;
  // The bot calibration's loss, for the bot-level comparison only
  let playedCp = 0;
  if (deliveredMate) playedCp = 10000;
  else if (result.scoreAfter) playedCp = scoreToCentipawns(result.scoreAfter);
  const calibrationCpLoss = best
    ? calibrationCentipawnLoss({
        bestCp: scoreToCentipawns(best.score),
        playedCp,
        legalMoveCount: legalMoveCount(ply.fenBefore),
        playedBest: result.isTopMove,
        deliveredMate,
      })
    : null;

  const move: ReviewedMove = {
    ply: index + 1,
    nodeId: ply.nodeId,
    color: ply.color,
    moveNumber: ply.moveNumber,
    san: ply.san,
    uci: ply.uci,
    fenBefore: ply.fenBefore,
    fenAfter: ply.fenAfter,
    winBefore: result.winBefore,
    winAfter: result.winAfter,
    whiteWinAfter: ply.color === 'w' ? result.winAfter : 100 - result.winAfter,
    winDrop: result.winDrop,
    accuracy: moveAccuracy(result.winDrop),
    cpLoss,
    calibrationCpLoss,
    classification: result.classification,
    bestMoveUci,
    bestMoveSan: bestMoveUci ? uciToSan(ply.fenBefore, bestMoveUci) : null,
    bestLineSan: best ? lineToSan(ply.fenBefore, best.pv, LINE_PLIES) : [],
    refutationSan: lineToSan(ply.fenAfter, refutationUci, LINE_PLIES),
    refutationUci,
    scoreBefore: result.scoreBefore,
    scoreAfter: result.scoreAfter,
    motifs,
    explanation,
  };
  return { move, suspicious };
}

function summarize(moves: readonly ReviewedMove[], color: Color, accuracy: number | null): SideReviewSummary {
  const counts = emptyCounts();
  const losses: number[] = [];
  const calibrationLosses: number[] = [];
  for (const move of moves) {
    if (move.color !== color) continue;
    counts[move.classification]++;
    losses.push(move.cpLoss);
    if (move.calibrationCpLoss !== null) calibrationLosses.push(move.calibrationCpLoss);
  }
  const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, v) => a + v, 0) / xs.length : null);
  return {
    accuracy,
    acpl: mean(losses),
    botLevel: estimateBotLevel(mean(calibrationLosses), calibrationLosses.length),
    counts,
  };
}

function moveLabel(move: ReviewedMove): string {
  return `${move.moveNumber}${move.color === 'w' ? '.' : '...'} ${move.san}`;
}

/**
 * The 3–5 biggest swings in White's win%, in game order. With `side`, only that side's
 * moves that lowered its own win% count (its errors, Misses included).
 */
export function findKeyMoments(moves: readonly ReviewedMove[], side?: Color): KeyMoment[] {
  const withSwing = moves.map((move) => {
    const whiteBefore = move.color === 'w' ? move.winBefore : 100 - move.winBefore;
    return { move, swing: move.whiteWinAfter - whiteBefore };
  });
  const bySize = withSwing
    .filter((m) => !side || (m.move.color === side && (side === 'w' ? m.swing < 0 : m.swing > 0)))
    .filter((m) => Math.abs(m.swing) > 0.5)
    .sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing));
  let chosen = bySize.filter((m) => Math.abs(m.swing) >= KEY_MOMENT_MIN_SWING).slice(0, KEY_MOMENT_MAX);
  if (chosen.length < KEY_MOMENT_MIN) chosen = bySize.slice(0, KEY_MOMENT_MIN);
  return chosen
    .sort((a, b) => a.move.ply - b.move.ply)
    .map(({ move, swing }) => ({
      ply: move.ply,
      nodeId: move.nodeId,
      swing,
      label: `${moveLabel(move)} — ${move.classification}`,
    }));
}

/**
 * Builds the review from whatever has been analyzed so far: every move whose positions
 * before and after are both analyzed is classified, explained and counted.
 *
 * `cache` (optional) keeps reviewed moves between calls while positions arrive in order,
 * so a live review classifies and explains each move once instead of on every update.
 * A move is cached once the position after it and the one before the previous move are
 * in, since nothing else it depends on can change.
 */
export function buildGameReview(
  input: ReviewGameInput,
  cache?: Map<number, { move: ReviewedMove; inBook: boolean }>,
): GameReview {
  const moves: ReviewedMove[] = [];
  let inBook = true;
  for (let i = 0; i < input.plies.length; i++) {
    const cached = cache?.get(i);
    if (cached) {
      inBook = cached.inBook;
      moves.push(cached.move);
      continue;
    }
    // Book only while every move so far was book: a later transposition into a dataset
    // position is a played move like any other
    inBook = inBook && input.isBookPosition(input.plies[i]!.fenAfter);
    const moveInput = reviewMoveInput(input.plies, input.positions, i, inBook);
    const reviewed = moveInput ? analyzeMove(moveInput).move : null;
    if (reviewed) {
      moves.push(reviewed);
      cache?.set(i, { move: reviewed, inBook });
    }
  }

  const whiteWinSeries: Array<number | null> = [];
  let analyzedPositions = 0;
  for (let i = 0; i <= input.plies.length; i++) {
    const value = whiteWinPercent(input.positions[i]);
    whiteWinSeries.push(value);
    if (value !== null) analyzedPositions++;
  }

  // Game accuracy over the analyzed stretch from the start
  const prefix: number[] = [];
  for (const value of whiteWinSeries) {
    if (value === null) break;
    prefix.push(value);
  }
  const accuracy = gameAccuracy(prefix, fenTurn(input.startFen));

  return {
    preset: input.preset,
    budget: input.budget,
    startFen: input.startFen,
    moves,
    white: summarize(moves, 'w', accuracy.white),
    black: summarize(moves, 'b', accuracy.black),
    keyMoments: findKeyMoments(moves),
    whiteWinSeries,
    analyzedPositions,
    totalPositions: input.plies.length + 1,
    complete: analyzedPositions === input.plies.length + 1,
  };
}

/** NAG written for each class in the annotated PGN (none for the quiet classes). */
export const CLASSIFICATION_NAG: Partial<Record<MoveClassification, number>> = {
  Brilliant: 3,
  Great: 1,
  Inaccuracy: 6,
  Mistake: 2,
  Blunder: 4,
  Miss: 2,
};

function budgetLabel(review: GameReview): string {
  const preset = review.preset ? `${review.preset[0]!.toUpperCase()}${review.preset.slice(1)}, ` : '';
  if (review.budget.depth !== undefined) return `${preset}depth ${review.budget.depth}`;
  return `${preset}${((review.budget.movetimeMs ?? 0) / 1000).toFixed(1)} s per move`;
}

function sideSummaryText(name: string, side: SideReviewSummary): string {
  const accuracy = side.accuracy === null ? '—' : side.accuracy.toFixed(1);
  const acpl = side.acpl === null ? '—' : Math.round(side.acpl).toString();
  return `${name} accuracy ${accuracy}%, ACPL ${acpl}, approximate bot level ${formatBotLevel(side.botLevel)}`;
}

/**
 * The game with the review written into it: `[%eval]` on every reviewed move, a NAG and
 * a comment for each error, Great and Brilliant move, the engine's best line as a
 * variation after each Mistake, Blunder and Miss, and a summary in the game comment.
 * Earlier engine annotations are removed first (annotations.ts); human comments and
 * other NAGs are kept, with the review text after them behind the `Review:` marker.
 */
export function buildAnnotatedPgn(
  tree: GameTree,
  review: GameReview,
  positions: ReadonlyArray<PositionAnalysis | undefined>,
  engineName: string,
): string {
  const copy = GameTree.fromJSON(tree.toJSON());
  // Earlier engine annotations (an imported Lichess analysis, an earlier review) go first,
  // so every NAG, eval and engine comment in the export is this review's
  stripEngineAnnotations(copy);
  copy.setHeader('Annotator', `Afterplay review (${engineName}, ${budgetLabel(review)})`);

  for (const move of review.moves) {
    const node = copy.getNode(move.nodeId);
    if (!node) continue;
    const after = positions[move.ply];
    const annotation = after ? evalAnnotation(after) : undefined;
    if (annotation) copy.setEval(node.id, annotation);
    copy.setClassification(node.id, move.classification);

    const nag = CLASSIFICATION_NAG[move.classification];
    if (nag !== undefined) copy.addNag(node.id, nag);

    const notes: string[] = [];
    if (isErrorClass(move.classification)) {
      notes.push(`${move.classification}.`);
      if (move.explanation) notes.push(move.explanation);
      // Name the best move once: only if the sentence doesn't already
      const best = move.bestMoveSan;
      if (best && move.bestMoveUci !== move.uci && !move.explanation?.includes(best)) {
        notes.push(`Best: ${best}.`);
      }
    } else if (move.classification === 'Brilliant' || move.classification === 'Great') {
      notes.push(`${move.classification} move.`);
    }
    if (notes.length > 0) {
      copy.setComment(node.id, withReviewComment(node.comment.trim(), notes.join(' ')));
    }

    const before = positions[move.ply - 1];
    const bestLine = before?.lines[0]?.pv ?? [];
    if (
      (move.classification === 'Mistake' || move.classification === 'Blunder' || move.classification === 'Miss') &&
      node.parentId &&
      bestLine.length > 0 &&
      bestLine[0] !== move.uci
    ) {
      let from = node.parentId;
      for (const uci of bestLine.slice(0, LINE_PLIES)) {
        try {
          from = copy.addMove(uci, { fromNodeId: from }).id;
        } catch {
          break;
        }
      }
    }
  }

  const summary = `${sideSummaryText('White', review.white)}. ${sideSummaryText('Black', review.black)}.`;
  copy.setComment(copy.root.id, withReviewComment(copy.root.comment.trim(), summary));
  return writePgn(copy);
}
