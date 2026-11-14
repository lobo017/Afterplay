import type { Color } from '../core/rules';
import type { SideAnalysisSummary } from '../storage/db';
import type { GameReview, SideReviewSummary } from './types';

/** What a finished review adds to a game record's `analysis` (besides preset, time and accuracies). */
export interface ReviewSummary {
  /** The fixed search depth, when the review ran on one. */
  depth?: number;
  /** Plies of the reviewed main line. */
  plies: number;
  sides: { w?: SideAnalysisSummary; b?: SideAnalysisSummary };
}

export interface SummarizeOptions {
  /** Summarize only this side (the hosted history file holds the player's side only). */
  side?: Color;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function sideSummary(review: GameReview, color: Color): SideAnalysisSummary {
  const summary: SideReviewSummary = color === 'w' ? review.white : review.black;
  const moves = review.moves.filter((m) => m.color === color);
  let low: number | null = null;
  let drop = 0;
  let dropPly: number | null = null;
  for (const m of moves) {
    for (const win of [m.winBefore, m.winAfter]) if (low === null || win < low) low = win;
    if (m.winDrop > drop) {
      drop = m.winDrop;
      dropPly = m.ply;
    }
  }
  return {
    moves: moves.length,
    acpl: summary.acpl === null ? null : round1(summary.acpl),
    inaccuracy: summary.counts.Inaccuracy ?? 0,
    mistake: summary.counts.Mistake ?? 0,
    blunder: summary.counts.Blunder ?? 0,
    miss: summary.counts.Miss ?? 0,
    brilliant: summary.counts.Brilliant ?? 0,
    great: summary.counts.Great ?? 0,
    low: low === null ? null : round1(low),
    drop: round1(drop),
    dropPly,
  };
}

/**
 * The compact summary of a finished review: the per-side counts the Story reads. Used by the
 * batch review and by `library.saveReview`, so a review made on the device feeds the Story too.
 */
export function summarizeReview(review: GameReview, options: SummarizeOptions = {}): ReviewSummary {
  const sides: ReviewSummary['sides'] = {};
  if (options.side !== 'b') sides.w = sideSummary(review, 'w');
  if (options.side !== 'w') sides.b = sideSummary(review, 'b');
  return {
    ...(review.budget.depth !== undefined ? { depth: review.budget.depth } : {}),
    plies: review.moves.length,
    sides,
  };
}
