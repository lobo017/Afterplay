import type { MoveClassification } from '../core/game-tree';
import type { UciScore } from '../engine/uci-parser';
import {
  applyUci,
  captureThreats,
  capturedValue,
  passTurnFen,
} from './board';
import { winPercentFromScore } from './formulas';
import type { PositionAnalysis } from './types';

/*
 * Every rule and number here is explained in docs/classification.md.
 */

/** Upper bounds of the mover's win% drop for each class; above `mistake` is a Blunder. */
export const CLASS_THRESHOLDS = {
  excellent: 2,
  good: 5,
  inaccuracy: 10,
  mistake: 20,
} as const;

/** Mates up to this many moves are found reliably at review depth; longer ones flicker. */
export const MATE_HORIZON_MOVES = 5;

/** A side at or beyond this win% (or at or below 100 − it) is in a decided position. */
export const DECIDED_WIN_PERCENT = 95;

/** Great: the second-best move would be a Blunder (gap above the Blunder threshold). */
export const GREAT_MIN_GAP = CLASS_THRESHOLDS.mistake;

/** Brilliant: material given up, in pawns (a minor piece for a pawn, or the exchange). */
export const BRILLIANT_MIN_SACRIFICE = 2;

/** Brilliant: after the sacrifice the mover must not be worse. */
export const BRILLIANT_MIN_WIN_AFTER = 50;

/** Miss: the opponent's previous move must have been a Mistake or a Blunder. */
export const MISS_MIN_OPPONENT_DROP = CLASS_THRESHOLDS.inaccuracy;

/** Miss: the player gave back at least this share of what the opponent's error handed over. */
export const MISS_MIN_GIVEN_BACK = 0.5;

const SEVERITY: Partial<Record<MoveClassification, number>> = {
  Excellent: 1,
  Good: 2,
  Inaccuracy: 3,
  Mistake: 4,
  Blunder: 5,
};

export function classFromWinDrop(drop: number): MoveClassification {
  if (drop <= CLASS_THRESHOLDS.excellent) return 'Excellent';
  if (drop <= CLASS_THRESHOLDS.good) return 'Good';
  if (drop <= CLASS_THRESHOLDS.inaccuracy) return 'Inaccuracy';
  if (drop <= CLASS_THRESHOLDS.mistake) return 'Mistake';
  return 'Blunder';
}

export function isErrorClass(c: MoveClassification | undefined): boolean {
  return c === 'Inaccuracy' || c === 'Mistake' || c === 'Blunder' || c === 'Miss';
}

/** The other side's view of a score. */
export function negateScore(score: UciScore): UciScore {
  return { type: score.type, value: -score.value };
}

/** Mover's win% once the move is played, from the analysis of the resulting position. */
export function moverWinAfter(after: PositionAnalysis): number | null {
  if (after.terminal === 'checkmate') return 100;
  if (after.terminal === 'stalemate' || after.terminal === 'insufficient') return 50;
  const best = after.lines[0];
  return best ? 100 - winPercentFromScore(best.score) : null;
}

/** Mover's score once the move is played (null for finished games). */
export function moverScoreAfter(after: PositionAnalysis): UciScore | null {
  if (after.terminal) return null;
  const best = after.lines[0];
  return best ? negateScore(best.score) : null;
}

function sameScore(a: UciScore, b: UciScore): boolean {
  return a.type === b.type && a.value === b.value;
}

function shortMateFor(score: UciScore | null | undefined): boolean {
  return Boolean(
    score && score.type === 'mate' && score.value > 0 && score.value <= MATE_HORIZON_MOVES,
  );
}

/**
 * Material given up by a move, in pawns: the best capture the opponent then has (after
 * the full exchange), minus what the move itself captured, minus material that was
 * already en prise before the move (so saving the queen from a fork and losing the rook
 * isn't a "sacrifice").
 */
export function materialSacrifice(fenBefore: string, uci: string): number {
  const applied = applyUci(fenBefore, uci);
  if (!applied) return 0;
  const bestGain = (fen: string | null) =>
    fen ? Math.max(0, ...captureThreats(fen).map((t) => t.gain)) : 0;
  const lossAfter = bestGain(applied.after);
  const pendingBefore = bestGain(passTurnFen(fenBefore));
  return lossAfter - capturedValue(applied.move) - pendingBefore;
}

export interface ClassifyInput {
  fenBefore: string;
  uci: string;
  /** Analysis of the position the move was played from (mover to move). */
  before: PositionAnalysis;
  /** Analysis of the position after the move (opponent to move). */
  after: PositionAnalysis;
  /** The opponent's previous move and the analysis of the position it was played from. */
  previous?: { fenBefore: string; uci: string; before: PositionAnalysis } | null;
  /** The position after the move is in the openings dataset. */
  isBook: boolean;
}

export interface ClassifyResult {
  classification: MoveClassification;
  winBefore: number;
  winAfter: number;
  winDrop: number;
  scoreBefore: UciScore | null;
  scoreAfter: UciScore | null;
  isTopMove: boolean;
  mateLost: boolean;
  mateCreated: boolean;
}

/**
 * Classifies one move from the engine's view of the positions before and after it.
 * Returns null when either analysis is missing (an unfinished review).
 */
export function classifyMove(input: ClassifyInput): ClassifyResult | null {
  const { before, after } = input;
  const best = before.lines[0];
  if (!best) return null;
  const winAfter = moverWinAfter(after);
  if (winAfter === null) return null;

  const scoreBefore = best.score;
  const scoreAfter = moverScoreAfter(after);
  const winBefore = winPercentFromScore(scoreBefore);
  const winDrop = Math.max(0, winBefore - winAfter);
  const second = before.lines[1];

  const mateLost =
    shortMateFor(scoreBefore) && after.terminal !== 'checkmate' && !shortMateFor(scoreAfter);
  const mateCreated =
    !after.terminal &&
    shortMateFor(after.lines[0]?.score) &&
    !shortMateFor(negateScore(scoreBefore));

  const base = { winBefore, winAfter, winDrop, scoreBefore, scoreAfter, mateLost, mateCreated };

  if (input.isBook) {
    return { ...base, classification: 'Book', isTopMove: false };
  }

  const isTopMove =
    best.pv[0] === input.uci ||
    (second?.pv[0] === input.uci && sameScore(second.score, best.score)) ||
    after.terminal === 'checkmate';

  if (isTopMove) {
    // The best alternative to the move played
    const alternative = best.pv[0] === input.uci ? second : best;
    const winAlternative = alternative ? winPercentFromScore(alternative.score) : null;

    if (
      winAlternative !== null &&
      winAlternative < DECIDED_WIN_PERCENT &&
      winAfter >= BRILLIANT_MIN_WIN_AFTER &&
      materialSacrifice(input.fenBefore, input.uci) >= BRILLIANT_MIN_SACRIFICE
    ) {
      return { ...base, classification: 'Brilliant', isTopMove };
    }
    if (
      winAlternative !== null &&
      winBefore - winAlternative > GREAT_MIN_GAP &&
      !isRecapture(input)
    ) {
      return { ...base, classification: 'Great', isTopMove };
    }
    return { ...base, classification: 'Best', isTopMove };
  }

  let classification = classFromWinDrop(winDrop);
  if ((mateLost || mateCreated) && (SEVERITY[classification] ?? 0) < SEVERITY.Inaccuracy!) {
    classification = 'Inaccuracy';
  }

  if (input.previous && isMiss(input.previous.before, winBefore, winAfter, winDrop)) {
    classification = 'Miss';
  }

  return { ...base, classification, isTopMove };
}

/** The move captures on the square where the opponent just captured. */
function isRecapture(input: ClassifyInput): boolean {
  if (!input.previous) return false;
  const prev = applyUci(input.previous.fenBefore, input.previous.uci);
  if (!prev?.move.isCapture) return false;
  const current = applyUci(input.fenBefore, input.uci);
  return Boolean(current?.move.isCapture && current.move.to === prev.move.to);
}

function isMiss(
  opponentBefore: PositionAnalysis,
  winBefore: number,
  winAfter: number,
  winDrop: number,
): boolean {
  const opponentBest = opponentBefore.lines[0];
  if (!opponentBest) return false;
  // Mover's win% before the opponent's error, and what that error handed over
  const winPrior = 100 - winPercentFromScore(opponentBest.score);
  const gift = winBefore - winPrior;
  return (
    gift > MISS_MIN_OPPONENT_DROP &&
    winDrop > CLASS_THRESHOLDS.good &&
    winDrop >= MISS_MIN_GIVEN_BACK * gift &&
    winAfter >= winPrior - CLASS_THRESHOLDS.inaccuracy
  );
}
