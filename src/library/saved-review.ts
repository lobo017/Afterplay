import type { GameTree } from '../core/game-tree';
import { mainLinePlies } from '../review/review-game';
import type { ReviewRunResult, ReviewRunStats } from '../review/review-runner';
import type { GameReview, PositionAnalysis, ReviewPreset } from '../review/types';

/**
 * A finished game review as stored with the game, so opening the game shows it again
 * without running the engine. Node IDs in it belong to the tree it was made on; they are
 * mapped onto a freshly parsed tree by ply when it is shown.
 */
export interface SavedReview {
  version: 1;
  preset: ReviewPreset | null;
  savedAt: number;
  /** The main line it covers (UCI), to check the game still matches before showing it. */
  ucis: string[];
  review: GameReview;
  /** Index 0 = start position; null where nothing was stored. */
  positions: Array<PositionAnalysis | null>;
  stats: ReviewRunStats;
}

export const SAVED_REVIEW_VERSION = 1;

/** The stored form of a finished review, or null for a cancelled or partial one. */
export function toSavedReview(result: ReviewRunResult, now: number = Date.now()): SavedReview | null {
  if (result.cancelled || !result.review.complete) return null;
  return {
    version: SAVED_REVIEW_VERSION,
    preset: result.review.preset,
    savedAt: now,
    ucis: result.plies.map((p) => p.uci),
    review: structuredClone(result.review),
    positions: result.positions.map((p) => (p ? structuredClone(p) : null)),
    stats: { ...result.stats },
  };
}

/**
 * The saved review as a run result on `tree`, with node IDs mapped to its main line; null
 * when the tree's main line isn't the reviewed one (or the record is from another version).
 */
export function restoreSavedReview(saved: SavedReview, tree: GameTree): ReviewRunResult | null {
  if (saved.version !== SAVED_REVIEW_VERSION) return null;
  const plies = mainLinePlies(tree);
  if (plies.length !== saved.ucis.length || plies.some((p, i) => p.uci !== saved.ucis[i])) return null;
  const nodeAt = (ply: number) => plies[ply - 1]?.nodeId;
  const moves = saved.review.moves.map((m) => ({ ...m, nodeId: nodeAt(m.ply) ?? m.nodeId }));
  const keyMoments = saved.review.keyMoments.map((k) => ({ ...k, nodeId: nodeAt(k.ply) ?? k.nodeId }));
  if (moves.some((m) => !nodeAt(m.ply))) return null;
  return {
    review: { ...saved.review, moves, keyMoments },
    positions: saved.positions.map((p) => p ?? undefined),
    plies,
    cancelled: false,
    stats: { ...saved.stats },
  };
}
