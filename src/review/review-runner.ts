import type { GameTree } from '../core/game-tree';
import { RulesAdapter } from '../core/rules';
import {
  EngineCancelledError,
  type EngineAnalysisResult,
  type EngineAnalyzeRequest,
} from '../engine/engine-client';
import { ReviewAnalysisClient } from './review-analysis-client';
import {
  buildGameReview,
  mainLinePlies,
  reviewMoveInput,
  type ReviewPly,
} from './review-game';
import {
  REVIEW_MULTIPV,
  REVIEW_PRESET_MOVETIME_MS,
  REVIEW_VERIFY_MOVETIME_MS,
  type GameReview,
  type PositionAnalysis,
  type ReviewBudget,
  type ReviewPreset,
  type ReviewedMove,
  type TerminalKind,
} from './types';

/** The part of EngineClient the review needs (a fake in unit tests). */
export interface ReviewEngine {
  analyze(request: EngineAnalyzeRequest): Promise<EngineAnalysisResult>;
}

export interface ReviewRunOptions {
  tree: GameTree;
  /** A preset's movetime, or `budget` for a custom one (e.g. fixed depth). */
  preset?: ReviewPreset;
  budget?: ReviewBudget;
  isBookPosition: (fen: string) => boolean;
  signal?: AbortSignal;
  /** Called after every analyzed position with the review so far. */
  onProgress?: (review: GameReview, positions: ReadonlyArray<PositionAnalysis | undefined>) => void;
}

export interface ReviewRunStats {
  timeMs: number;
  meanDepth: number;
  minDepth: number;
  /** Positions searched (terminal positions need none). */
  searches: number;
  /** Positions searched a second time to verify a suspected error. */
  verifiedPositions: number;
}

export interface ReviewRunResult {
  review: GameReview;
  positions: Array<PositionAnalysis | undefined>;
  plies: ReviewPly[];
  cancelled: boolean;
  stats: ReviewRunStats;
}

function terminalKind(adapter: RulesAdapter): TerminalKind | undefined {
  if (adapter.isCheckmate()) return 'checkmate';
  if (adapter.isStalemate()) return 'stalemate';
  if (adapter.isInsufficientMaterial()) return 'insufficient';
  return undefined;
}

export function budgetForPreset(preset: ReviewPreset): ReviewBudget {
  return { movetimeMs: REVIEW_PRESET_MOVETIME_MS[preset] };
}

/**
 * Reviews a game's main line: every position from the start to the final one is searched
 * with MultiPV 2 on the review budget, in order, with the game's moves as history (so
 * the engine sees repetitions). Results stream out through `onProgress`; cancelling
 * resolves with the partial review instead of rejecting.
 *
 * Verification: a short search can miss a mate on one side of a move and see it on the
 * other, which shows up as a large false drop. When a move's first-pass class is
 * Mistake, Blunder or Miss, or a short forced mate appears or disappears across it, the
 * positions before and after it are searched again for the preset's verification time
 * (each position at most once) and the deeper result is kept. Fixed-depth reviews skip
 * this: their results are already consistent.
 *
 * Each move is classified and explained once, through `analysis` (a worker in the
 * browser), as soon as the positions around it are final; the progress snapshots only
 * assemble those results.
 */
export class ReviewRunner {
  constructor(
    private readonly engine: ReviewEngine,
    private readonly analysis: ReviewAnalysisClient = new ReviewAnalysisClient(),
  ) {}

  public async run(options: ReviewRunOptions): Promise<ReviewRunResult> {
    const { tree } = options;
    const chess960 = tree.isChess960();
    const startFen = tree.root.fen;
    const plies = mainLinePlies(tree);
    const preset = options.budget ? null : (options.preset ?? 'quick');
    const budget = options.budget ?? budgetForPreset(preset ?? 'quick');
    const verifyMovetime = preset ? REVIEW_VERIFY_MOVETIME_MS[preset] : null;
    const positions: Array<PositionAnalysis | undefined> = new Array(plies.length + 1);
    const cache = new Map<number, { move: ReviewedMove; inBook: boolean }>();
    const fens = [startFen, ...plies.map((p) => p.fenAfter)];
    const ucis = plies.map((p) => p.uci);
    const verified = new Set<number>();
    const startedAt = performance.now();
    let cancelled = false;

    const snapshot = () =>
      buildGameReview(
        { preset, budget, startFen, plies, positions, isBookPosition: options.isBookPosition },
        cache,
      );

    // Book status of each move: in the dataset, with every earlier move in it too
    const bookPrefix: boolean[] = [];
    for (let k = 0; k < plies.length; k++) {
      bookPrefix.push((k === 0 || bookPrefix[k - 1]!) && options.isBookPosition(plies[k]!.fenAfter));
    }
    const moveInput = (k: number) => reviewMoveInput(plies, positions, k, bookPrefix[k]!);
    const storeMove = async (k: number) => {
      const input = moveInput(k);
      const analysis = input ? await this.analysis.analyze(input) : null;
      if (analysis?.move) cache.set(k, { move: analysis.move, inBook: bookPrefix[k]! });
      else cache.delete(k);
    };

    /** Searches position i; null when the review was cancelled. */
    const search = async (
      i: number,
      limit: { movetime: number } | { depth: number },
    ): Promise<PositionAnalysis | null> => {
      try {
        const result = await this.engine.analyze({
          fen: startFen,
          moves: ucis.slice(0, i),
          ...limit,
          multipv: REVIEW_MULTIPV,
          chess960,
          priority: 'review',
          useCache: false,
          resetGame: i === 0 && !positions.some(Boolean),
          signal: options.signal,
        });
        return {
          fen: fens[i]!,
          lines: result.lines.map((line) => ({
            multipv: line.multipv,
            score: line.score,
            pv: line.pv,
          })),
          depth: result.depth,
          nodes: result.nodes,
          timeMs: result.timeMs,
        };
      } catch (err) {
        if (err instanceof EngineCancelledError || options.signal?.aborted) return null;
        throw err;
      }
    };

    const firstPassLimit =
      budget.depth !== undefined
        ? { depth: budget.depth }
        : { movetime: budget.movetimeMs ?? REVIEW_PRESET_MOVETIME_MS.quick };

    for (let i = 0; i <= plies.length && !cancelled; i++) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      const fen = fens[i]!;
      const terminal = terminalKind(new RulesAdapter(fen, { chess960 }));
      if (terminal) {
        positions[i] = { fen, terminal, lines: [], depth: 0 };
      } else {
        const analysis = await search(i, firstPassLimit);
        if (!analysis) {
          cancelled = true;
          break;
        }
        positions[i] = analysis;
      }

      if (i >= 1) {
        let analysis = await this.analysis.analyze(moveInput(i - 1)!);
        if (analysis.suspicious && verifyMovetime !== null) {
          let beforeChanged = false;
          let afterChanged = false;
          for (const j of [i - 1, i]) {
            const current = positions[j];
            if (!current || current.terminal || verified.has(j)) continue;
            const deeper = await search(j, { movetime: verifyMovetime });
            if (!deeper) {
              cancelled = true;
              break;
            }
            verified.add(j);
            if (deeper.depth >= current.depth) {
              positions[j] = deeper;
              if (j === i - 1) beforeChanged = true;
              else afterChanged = true;
            }
          }
          if (cancelled) break;
          // The previous move ended on position i − 1: review it again if that changed
          if (beforeChanged && i >= 2) await storeMove(i - 2);
          if (beforeChanged || afterChanged) analysis = await this.analysis.analyze(moveInput(i - 1)!);
        }
        if (analysis.move) cache.set(i - 1, { move: analysis.move, inBook: bookPrefix[i - 1]! });
      }
      if (!cancelled) options.onProgress?.(snapshot(), positions);
    }

    const depths = positions.filter((p) => p && !p.terminal).map((p) => p!.depth);
    return {
      review: snapshot(),
      positions,
      plies,
      cancelled,
      stats: {
        timeMs: performance.now() - startedAt,
        meanDepth: depths.length > 0 ? depths.reduce((a, d) => a + d, 0) / depths.length : 0,
        minDepth: depths.length > 0 ? Math.min(...depths) : 0,
        searches: depths.length,
        verifiedPositions: verified.size,
      },
    };
  }
}
