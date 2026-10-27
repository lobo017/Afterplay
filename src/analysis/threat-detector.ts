import { RulesAdapter, type Color, type PieceSymbol, type Square } from '../core/rules';
import { EngineCancelledError, type EngineClient } from '../engine/engine-client';
import type { UciScore } from '../engine/uci-parser';

export interface ThreatDetectionResult {
  fen: string;
  nullMoveFen: string;
  threatSide: Color;
  uci: string;
  san: string;
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
  scoreWhite: UciScore;
  evalCp: number;
  pv: string[];
}

export interface ThreatDetectOptions {
  depth?: number;
  chess960?: boolean;
  signal?: AbortSignal;
}

/**
 * Produces the FEN after a null move (`--`), flipping side-to-move and clearing en-passant.
 * Returns `null` if the side to move is currently in check, the game is over, or the opponent
 * has no legal moves after passing.
 */
export function buildNullMoveFen(fen: string, chess960?: boolean): string | null {
  try {
    const adapter = new RulesAdapter(fen, { chess960 });
    if (adapter.inCheck() || adapter.isGameOver()) {
      return null;
    }
    adapter.move('--');
    if (adapter.verboseMoves().length === 0) {
      return null;
    }
    return adapter.fen();
  } catch {
    return null;
  }
}

/**
 * Runs a null-move search with Stockfish to determine what the opponent is threatening
 * if the side to move passes their turn.
 */
export async function detectOpponentThreat(
  engine: EngineClient,
  fen: string,
  options?: ThreatDetectOptions,
): Promise<ThreatDetectionResult | null> {
  const nullMoveFen = buildNullMoveFen(fen, options?.chess960);
  if (!nullMoveFen) {
    return null;
  }

  try {
    const res = await engine.analyze({
      fen: nullMoveFen,
      depth: options?.depth ?? 8,
      multipv: 1,
      chess960: options?.chess960,
      priority: 'background',
      signal: options?.signal,
    });

    const topLine = res.lines[0];
    const bestMove = res.bestMove && res.bestMove !== '(none)' ? res.bestMove : (topLine?.pv[0] ?? '');

    if (!bestMove || bestMove.length < 4) {
      return null;
    }

    const probe = new RulesAdapter(nullMoveFen, {
      chess960: options?.chess960,
    });
    const threatSide = probe.turn();
    let from = bestMove.slice(0, 2) as Square;
    let to = bestMove.slice(2, 4) as Square;
    let promotion = bestMove[4] as PieceSymbol | undefined;
    let san = bestMove;

    try {
      const executed = probe.move(bestMove);
      from = executed.from;
      to = executed.to;
      promotion = executed.promotion;
      san = executed.san;
    } catch {
      // Fallback to raw UCI coordinates if SAN conversion fails
    }

    return {
      fen,
      nullMoveFen,
      threatSide,
      uci: bestMove,
      san,
      from,
      to,
      ...(promotion ? { promotion } : {}),
      scoreWhite: topLine?.scoreWhite ?? { type: 'cp', value: 0 },
      evalCp: topLine?.evalCp ?? 0,
      pv: topLine?.pv ?? [bestMove],
    };
  } catch (err: unknown) {
    if (err instanceof EngineCancelledError || options?.signal?.aborted) {
      return null;
    }
    return null;
  }
}
