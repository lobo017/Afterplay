import type { Color, PieceSymbol, Square } from '../core/rules';
import type { MoveClassification } from '../core/game-tree';
import type { UciScore } from '../engine/uci-parser';
import type { PerformanceEstimate } from './formulas';

export type { MoveClassification };

export type ReviewPreset = 'quick' | 'standard' | 'deep';

/** Engine time per position for each preset (spec, Phase 5). */
export const REVIEW_PRESET_MOVETIME_MS: Record<ReviewPreset, number> = {
  quick: 200,
  standard: 600,
  deep: 1500,
};

/**
 * Engine time per position when a move looks like an error (or a forced mate appears or
 * disappears across it): both positions are searched again for this long before the
 * move is classified. See docs/classification.md, "Verification searches".
 */
export const REVIEW_VERIFY_MOVETIME_MS: Record<ReviewPreset, number> = {
  quick: 1000,
  standard: 2000,
  deep: 3000,
};

/** MultiPV used for every reviewed position (spec, Phase 5). */
export const REVIEW_MULTIPV = 2;

/** One engine line, scored from the side to move's point of view. */
export interface ReviewLine {
  multipv: number;
  score: UciScore;
  pv: string[];
}

/** Positions the engine can't (or needn't) search. */
export type TerminalKind = 'checkmate' | 'stalemate' | 'insufficient';

/** What the review knows about one position of the game. */
export interface PositionAnalysis {
  fen: string;
  terminal?: TerminalKind;
  lines: ReviewLine[];
  depth: number;
  nodes?: number;
  timeMs?: number;
}

export type MotifKind =
  | 'hanging-piece'
  | 'fork'
  | 'pin'
  | 'skewer'
  | 'discovered-attack'
  | 'back-rank'
  | 'missed-mate'
  | 'trapped-piece'
  | 'promotion-threat';

export interface Motif {
  kind: MotifKind;
  /** The square the motif is about: the hanging/pinned/trapped piece, the forking piece, the mated king… */
  square: Square;
  piece?: PieceSymbol;
  /** Fork targets, or [front, behind] for pins and skewers. */
  targets?: Square[];
  /** Mate distance for missed-mate. */
  mateIn?: number;
  /** SAN of the move that creates or exploits the motif. */
  san?: string;
  /** hanging-piece: the piece was already en prise before the move (the move ignored it). */
  preexisting?: boolean;
  /**
   * Whose move it belongs to, when the review attaches it to a reviewed move: the move
   * played, the opponent's refutation of it, or the best move the player missed.
   */
  role?: 'played' | 'refutation' | 'missed';
}

export interface ReviewedMove {
  ply: number;
  nodeId: string;
  color: Color;
  moveNumber: number;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  /** Mover's win% before and after the move (0–100). */
  winBefore: number;
  winAfter: number;
  /** White's win% after the move, for the chart. */
  whiteWinAfter: number;
  /** max(0, winBefore − winAfter). */
  winDrop: number;
  accuracy: number;
  /** Centipawn loss used for ACPL (null when the position was out of the counted range). */
  cpLoss: number | null;
  classification: MoveClassification;
  bestMoveUci: string | null;
  bestMoveSan: string | null;
  /** Engine's best line from the position before the move (SAN). */
  bestLineSan: string[];
  /** Engine's best line for the opponent after the move (SAN): the refutation of a mistake. */
  refutationSan: string[];
  refutationUci: string[];
  /** Mover's score before the move and after it (mover's point of view). */
  scoreBefore: UciScore | null;
  scoreAfter: UciScore | null;
  motifs: Motif[];
  explanation: string | null;
}

export interface SideReviewSummary {
  accuracy: number | null;
  acpl: number | null;
  /** Moves that counted toward the ACPL (see `centipawnLoss`). */
  countedMoves: number;
  performance: PerformanceEstimate | null;
  counts: Record<MoveClassification, number>;
}

/** Engine budget per position: a preset's movetime, or a fixed depth (fixture settings). */
export interface ReviewBudget {
  movetimeMs?: number;
  depth?: number;
}

export interface KeyMoment {
  ply: number;
  nodeId: string;
  /** Signed change in White's win% caused by this move. */
  swing: number;
  label: string;
}

export interface GameReview {
  /** Null when the review ran on a custom budget (e.g. the depth-18 fixture settings). */
  preset: ReviewPreset | null;
  budget: ReviewBudget;
  startFen: string;
  moves: ReviewedMove[];
  white: SideReviewSummary;
  black: SideReviewSummary;
  keyMoments: KeyMoment[];
  /** White's win% for every position (index 0 = start), null where not yet analyzed. */
  whiteWinSeries: Array<number | null>;
  /** Positions analyzed so far, out of `moves.length + 1`. */
  analyzedPositions: number;
  totalPositions: number;
  complete: boolean;
}
