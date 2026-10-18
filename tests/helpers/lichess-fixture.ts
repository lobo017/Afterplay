import fixtureJson from '../fixtures/review/lichess-Bjl39T9x.json';
import type { GameTree } from '../../src/core/game-tree';
import { parsePgn } from '../../src/core/pgn';
import { RulesAdapter } from '../../src/core/rules';
import type { UciScore } from '../../src/engine/uci-parser';
import { LICHESS_INITIAL_CP, WIN_PERCENT_CP_CEILING } from '../../src/review/formulas';
import { mainLinePlies } from '../../src/review/review-game';
import type { PositionAnalysis } from '../../src/review/types';

/** One ply of Lichess's analysis: the eval after the move (White's view), as exported. */
export interface LichessInfo {
  eval?: number;
  mate?: number;
  best?: string;
  variation?: string;
  judgment?: { name: 'Inaccuracy' | 'Mistake' | 'Blunder'; comment: string };
}

interface LichessFixture {
  id: string;
  pgn: string;
  game: {
    moves: string;
    analysis: LichessInfo[];
    players: Record<
      'white' | 'black',
      {
        rating: number;
        analysis: { inaccuracy: number; mistake: number; blunder: number; acpl: number; accuracy: number };
      }
    >;
  };
}

export const lichessGame = fixtureJson as unknown as LichessFixture;

export function lichessTree(): GameTree {
  return parsePgn(lichessGame.pgn);
}

/**
 * White's centipawns for every position, start first, the way lila counts them: the start
 * is `Cp.initial` (15), a mate is ±1000, and `mate 0` (the side to move is mated) is −1000
 * for that side.
 */
export function lichessWhiteCps(): number[] {
  const cps = lichessGame.game.analysis.map((info, i) => {
    if (info.eval !== undefined) return info.eval;
    const mate = info.mate ?? 0;
    if (mate !== 0) return Math.sign(mate) * WIN_PERCENT_CP_CEILING;
    // After ply i + 1 the side to move is White when i + 1 is even
    const whiteToMove = (i + 1) % 2 === 0;
    return whiteToMove ? -WIN_PERCENT_CP_CEILING : WIN_PERCENT_CP_CEILING;
  });
  return [LICHESS_INITIAL_CP, ...cps];
}

/** Lichess's analysis as the review's PositionAnalysis list (scores from the side to move). */
export function lichessPositions(tree: GameTree): PositionAnalysis[] {
  const plies = mainLinePlies(tree);
  const fens = [tree.root.fen, ...plies.map((p) => p.fenAfter)];
  const infos = lichessGame.game.analysis;
  return fens.map((fen, i) => {
    const adapter = new RulesAdapter(fen);
    if (adapter.isCheckmate()) return { fen, terminal: 'checkmate' as const, lines: [], depth: 0 };
    const whiteToMove = adapter.turn() === 'w';
    const info: LichessInfo = i === 0 ? { eval: LICHESS_INITIAL_CP } : infos[i - 1]!;
    let score: UciScore;
    if (info.mate !== undefined) score = { type: 'mate', value: whiteToMove ? info.mate : -info.mate };
    else score = { type: 'cp', value: whiteToMove ? info.eval! : -info.eval! };
    // Lichess names the best move only where it judged the next move
    const best = infos[i]?.best;
    return { fen, depth: 20, lines: [{ multipv: 1, score, pv: best ? [best] : [] }] };
  });
}
