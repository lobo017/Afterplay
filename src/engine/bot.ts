import {
  DEFAULT_POSITION,
  RulesAdapter,
  type ExecutedMove,
  type PieceSymbol,
} from '../core/rules';
import type { EngineLine } from './cache';
import type { EngineClient, EnginePriority } from './engine-client';

export type BotTierId = 'Novice' | 'Casual' | 'Club' | 'Expert' | 'Master';
export type BotStyleId = 'aggressive' | 'solid' | 'gambiteer';

export interface BotTierPreset {
  id: BotTierId;
  label: string;
  defaultRating: number;
  minRating: number;
  maxRating: number;
  description: string;
}

export interface BotStylePreset {
  id: BotStyleId;
  label: string;
  description: string;
}

export const BOT_TIERS: Record<BotTierId, BotTierPreset> = {
  Novice: {
    id: 'Novice',
    label: 'Novice',
    defaultRating: 600,
    minRating: 400,
    maxRating: 799,
    description: 'Makes natural beginner inaccuracies and occasional tactical oversights.',
  },
  Casual: {
    id: 'Casual',
    label: 'Casual',
    defaultRating: 1000,
    minRating: 800,
    maxRating: 1199,
    description: 'Plays club-casual developing moves with human-like positional slips.',
  },
  Club: {
    id: 'Club',
    label: 'Club',
    defaultRating: 1400,
    minRating: 1200,
    maxRating: 1599,
    description: 'Solid tactical awareness; spots basic forks and hanging pieces.',
  },
  Expert: {
    id: 'Expert',
    label: 'Expert',
    defaultRating: 1800,
    minRating: 1600,
    maxRating: 1999,
    description: 'Strong tournament player; rarely drops material and punishes mistakes.',
  },
  Master: {
    id: 'Master',
    label: 'Master',
    defaultRating: 2200,
    minRating: 2000,
    maxRating: 2400,
    description: 'Near-optimal engine precision with subtle stylistic preferences.',
  },
};

export const BOT_STYLE_PRESETS: Record<BotStyleId, BotStylePreset> = {
  aggressive: {
    id: 'aggressive',
    label: 'Aggressive',
    description: 'Favors checks, captures, king-side attacks, and forward piece activity.',
  },
  solid: {
    id: 'solid',
    label: 'Solid',
    description: 'Prioritizes king safety, central control, and low-risk positional accuracy.',
  },
  gambiteer: {
    id: 'gambiteer',
    label: 'Gambiteer',
    description: 'Embraces pawn sacrifices, open files, and sharp dynamic initiative.',
  },
};

export interface BotEngineParams {
  rating: number;
  tier: BotTierId;
  style: BotStyleId;
  skillLevel: number;
  uciLimitStrength: boolean;
  uciElo: number;
  depth: number;
  multipv: number;
  temperatureCp: number;
  maxPlausibleDropCp: number;
}

export interface CandidateMoveWeight {
  uci: string;
  san: string;
  multipv: number;
  evalCp: number;
  dropCp: number;
  styleBonusCp: number;
  weight: number;
  probability: number;
  line: EngineLine;
}

export interface BotMoveDecision {
  uci: string;
  san: string;
  executedMove: ExecutedMove;
  selectedLine: EngineLine;
  candidates: CandidateMoveWeight[];
  params: BotEngineParams;
}

const PIECE_VALUE_CP: Record<PieceSymbol, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
};

/**
 * Clamps a bot rating to the spec-mandated [400, 2400] interval.
 */
export function clampBotRating(rating: number): number {
  if (Number.isNaN(rating)) return 1400;
  return Math.max(400, Math.min(2400, Math.round(rating)));
}

/**
 * Resolves the BotTierId corresponding to any rating in [400, 2400].
 */
export function getTierForRating(rating: number): BotTierId {
  const clamped = clampBotRating(rating);
  if (clamped < 800) return 'Novice';
  if (clamped < 1200) return 'Casual';
  if (clamped < 1600) return 'Club';
  if (clamped < 2000) return 'Expert';
  return 'Master';
}

/**
 * Computes the combined Stockfish UCI parameters and human-like selection parameters
 * for a target rating (400–2400) and style preset.
 */
export function computeBotEngineParams(
  ratingOrTier: number | BotTierId,
  style: BotStyleId = 'solid',
): BotEngineParams {
  const rawRating =
    typeof ratingOrTier === 'string'
      ? BOT_TIERS[ratingOrTier].defaultRating
      : ratingOrTier;
  const rating = clampBotRating(rawRating);
  const tier = getTierForRating(rating);

  const normalized = (rating - 400) / 2000; // 0.0 at 400, 1.0 at 2400
  const skillLevel = Math.max(0, Math.min(20, Math.round(normalized * 20)));
  const uciLimitStrength = rating < 2400;
  const uciElo = Math.max(1320, Math.min(2400, rating));
  const depth = Math.max(4, Math.min(14, Math.round(5 + normalized * 9)));
  const multipv = rating < 1600 ? 5 : rating < 2000 ? 4 : 3;

  // Temperature in centipawns: high at 400 Elo (~142 cp), low at 2400 Elo (~2 cp)
  const baseTemp = 140 * Math.pow(1 - normalized, 1.55) + 2;
  const styleTempFactor =
    style === 'solid' ? 0.78 : style === 'gambiteer' ? 1.12 : 1.0;
  const temperatureCp = Number((baseTemp * styleTempFactor).toFixed(2));

  // Maximum centipawn drop considered a "plausible human mistake" at this rating
  // (Drops beyond this threshold are heavily suppressed so weak bots don't make random queen blunders)
  const maxPlausibleDropCp = Math.round(280 * (1 - normalized * 0.88) + 15);

  return {
    rating,
    tier,
    style,
    skillLevel,
    uciLimitStrength,
    uciElo,
    depth,
    multipv,
    temperatureCp,
    maxPlausibleDropCp,
  };
}

/**
 * Computes a centipawn style bonus for a candidate move according to the bot's style preset.
 */
export function computeStyleBonusCp(
  adapter: RulesAdapter,
  move: ExecutedMove,
  dropCp: number,
  style: BotStyleId,
): number {
  const us = move.color;
  const them = us === 'w' ? 'b' : 'w';
  const toRank = Number(move.to[1] ?? 1);
  const fromRank = Number(move.from[1] ?? 1);
  const forwardAdvance = us === 'w' ? toRank - fromRank : fromRank - toRank;
  const isCheckMove = move.san.includes('+') || move.san.includes('#');
  const isCentralFile =
    move.to[0] === 'c' ||
    move.to[0] === 'd' ||
    move.to[0] === 'e' ||
    move.to[0] === 'f';

  if (style === 'aggressive') {
    let bonus = 0;
    if (isCheckMove) bonus += 42;
    if (move.isCapture) {
      const capturedVal = move.captured ? PIECE_VALUE_CP[move.captured] : 100;
      bonus += Math.min(38, Math.round(capturedVal / 20) + 14);
    }
    if (forwardAdvance > 0) {
      bonus += forwardAdvance * 6;
    }
    const inEnemyHalf = us === 'w' ? toRank >= 5 : toRank <= 4;
    if (inEnemyHalf) {
      bonus += 12;
    }
    return bonus;
  }

  if (style === 'solid') {
    let bonus = 0;
    if (move.isCastle) bonus += 35;
    if (!move.isCapture && !isCheckMove) {
      bonus += 14;
    }
    if (
      isCentralFile &&
      (toRank === 3 || toRank === 4 || toRank === 5 || toRank === 6)
    ) {
      bonus += 12;
    }
    // Solid bots dislike walking onto attacked squares with valuable pieces
    if (
      PIECE_VALUE_CP[move.piece] >= 320 &&
      adapter.isAttacked(move.to, them)
    ) {
      bonus -= 18;
    }
    return bonus;
  }

  // style === 'gambiteer'
  let bonus = 0;
  // Gambiteer loves pawn sacrifices, contested squares within a playable eval window, and pawn breaks
  const isAttackedDest = adapter.isAttacked(move.to, them);
  if (
    isAttackedDest &&
    dropCp <= 160 &&
    (move.piece === 'p' || PIECE_VALUE_CP[move.piece] <= 330)
  ) {
    bonus += 44;
  }
  if (move.piece === 'p' && forwardAdvance > 0) {
    bonus += isCentralFile ? 28 : 22;
  }
  if (move.isCapture && isCentralFile) {
    bonus += 18;
  }
  return bonus;
}

/**
 * Selects a move from the engine's MultiPV candidate lines weighted by centipawn loss,
 * rating-scaled randomness, plausible-mistake filtering, and style preset.
 */
export function selectHumanLikeMove(options: {
  fen?: string;
  lines: EngineLine[];
  ratingOrTier: number | BotTierId;
  style?: BotStyleId;
  rng?: () => number;
}): BotMoveDecision {
  const fen = options.fen?.trim() || DEFAULT_POSITION;
  const style = options.style ?? 'solid';
  const params = computeBotEngineParams(options.ratingOrTier, style);
  const rng = options.rng ?? Math.random;

  const adapter = new RulesAdapter(fen);
  const legalMoves = adapter.verboseMoves();
  if (legalMoves.length === 0) {
    throw new Error(`No legal moves available in position: ${fen}`);
  }

  // Match engine PV first moves to legal moves in the position
  const matchedCandidates: Array<{
    move: ExecutedMove;
    line: EngineLine;
  }> = [];
  const seenUci = new Set<string>();

  const sortedLines = [...options.lines]
    .filter((l) => l.pv.length > 0)
    .sort((a, b) => b.evalCp - a.evalCp);

  for (const line of sortedLines) {
    const rawUci = line.pv[0]!;
    const matched = matchLegalMove(adapter, legalMoves, rawUci);
    if (matched && !seenUci.has(matched.uci)) {
      seenUci.add(matched.uci);
      matchedCandidates.push({ move: matched, line });
    }
  }

  // Fallback if engine lines were empty
  if (matchedCandidates.length === 0) {
    const fallbackMove = legalMoves[0]!;
    const fallbackLine: EngineLine = {
      multipv: 1,
      depth: 1,
      seldepth: 1,
      score: { type: 'cp', value: 0 },
      scoreWhite: { type: 'cp', value: 0 },
      evalCp: 0,
      nodes: 1,
      nps: 1,
      timeMs: 1,
      pv: [fallbackMove.uci],
    };
    matchedCandidates.push({ move: fallbackMove, line: fallbackLine });
  }

  const bestEvalCp = matchedCandidates[0]!.line.evalCp;
  const bestScore = matchedCandidates[0]!.line.score;
  const isForcedShortMate =
    bestScore.type === 'mate' && bestScore.value > 0 && bestScore.value <= 3;

  // Influence of style scales modestly so style shapes choices among comparable moves
  // without causing outright blunders.
  const styleScale =
    params.rating >= 2350
      ? 0.05
      : Math.min(1, params.temperatureCp / 55 + 0.35);

  const scoredCandidates = matchedCandidates.map(({ move, line }, idx) => {
    const dropCp = Math.max(0, bestEvalCp - line.evalCp);
    const styleBonusCp =
      dropCp <= params.maxPlausibleDropCp
        ? computeStyleBonusCp(adapter, move, dropCp, style)
        : 0;
    const utilityCp = -dropCp + styleBonusCp * styleScale;
    return {
      idx,
      move,
      line,
      dropCp,
      styleBonusCp,
      utilityCp,
    };
  });

  const maxUtilityCp = Math.max(
    ...scoredCandidates.map((c) => c.utilityCp),
  );

  const rawWeights: Array<{
    move: ExecutedMove;
    line: EngineLine;
    dropCp: number;
    styleBonusCp: number;
    weight: number;
  }> = scoredCandidates.map(
    ({ idx, move, line, dropCp, styleBonusCp, utilityCp }) => {
      // If there is a forced mate in <=3 and the bot is at least Club (1200+), lock onto mate
      if (isForcedShortMate && params.rating >= 1200) {
        const mateWeight = idx === 0 ? 1 : 0.00001;
        return {
          move,
          line,
          dropCp,
          styleBonusCp,
          weight: mateWeight,
        };
      }

      const relativeLossCp = Math.max(0, maxUtilityCp - utilityCp);
      let weight = Math.exp(
        -relativeLossCp / Math.max(1, params.temperatureCp),
      );

      // Plausible mistake filter: if a move drops far more than maxPlausibleDropCp (e.g. hanging a queen
      // for 900 cp when normal moves exist), steeply suppress it so weak bots make human-like mistakes
      // rather than random catastrophic blunders.
      if (dropCp > params.maxPlausibleDropCp) {
        const excess = dropCp - params.maxPlausibleDropCp;
        weight *= Math.exp(-excess / 35);
      }

      return {
        move,
        line,
        dropCp,
        styleBonusCp,
        weight: Math.max(1e-9, weight),
      };
    },
  );

  const totalWeight = rawWeights.reduce((acc, item) => acc + item.weight, 0);
  const candidates: CandidateMoveWeight[] = rawWeights.map((item) => ({
    uci: item.move.uci,
    san: item.move.san,
    multipv: item.line.multipv,
    evalCp: item.line.evalCp,
    dropCp: item.dropCp,
    styleBonusCp: item.styleBonusCp,
    weight: item.weight,
    probability: totalWeight > 0 ? item.weight / totalWeight : 0,
    line: item.line,
  }));

  // Sample according to normalized probabilities
  const sample = Math.max(0, Math.min(0.999999999, rng()));
  let cumulative = 0;
  let chosenIdx = 0;
  for (let i = 0; i < candidates.length; i++) {
    cumulative += candidates[i]!.probability;
    if (sample <= cumulative) {
      chosenIdx = i;
      break;
    }
  }

  const chosen = rawWeights[chosenIdx] ?? rawWeights[0]!;
  return {
    uci: chosen.move.uci,
    san: chosen.move.san,
    executedMove: chosen.move,
    selectedLine: chosen.line,
    candidates,
    params,
  };
}

function matchLegalMove(
  adapter: RulesAdapter,
  legalMoves: ExecutedMove[],
  uci: string,
): ExecutedMove | null {
  const clean = uci.trim().toLowerCase();
  const exact = legalMoves.find((m) => m.uci.toLowerCase() === clean);
  if (exact) return exact;

  // Also check standard/Chess960 castling alias (e.g. e1g1 vs e1h1)
  if (/^[a-h][18][a-h][18][qrbn]?$/.test(clean)) {
    const clone = adapter.clone();
    try {
      const moved = clone.move({
        from: clean.slice(0, 2),
        to: clean.slice(2, 4),
        promotion: clean[4],
      });
      return (
        legalMoves.find((m) => m.san === moved.san) ??
        legalMoves.find((m) => m.uci === moved.uci) ??
        moved
      );
    } catch {
      return null;
    }
  }

  return null;
}

export interface ChessBotOptions {
  rating?: number | BotTierId;
  style?: BotStyleId;
  rng?: () => number;
}

/**
 * High-level playing bot combining Stockfish UCI strength controls with human-like MultiPV selection.
 */
export class ChessBot {
  private readonly engine: EngineClient;
  private rating: number;
  private style: BotStyleId;
  private readonly rng: () => number;

  constructor(engine: EngineClient, options?: ChessBotOptions) {
    this.engine = engine;
    const initRating =
      typeof options?.rating === 'string'
        ? BOT_TIERS[options.rating].defaultRating
        : (options?.rating ?? BOT_TIERS.Club.defaultRating);
    this.rating = clampBotRating(initRating);
    this.style = options?.style ?? 'solid';
    this.rng = options?.rng ?? Math.random;
  }

  public getRating(): number {
    return this.rating;
  }

  public getTier(): BotTierId {
    return getTierForRating(this.rating);
  }

  public getStyle(): BotStyleId {
    return this.style;
  }

  public setRating(ratingOrTier: number | BotTierId): void {
    const next =
      typeof ratingOrTier === 'string'
        ? BOT_TIERS[ratingOrTier].defaultRating
        : ratingOrTier;
    this.rating = clampBotRating(next);
  }

  public setStyle(style: BotStyleId): void {
    this.style = style;
  }

  public getParams(): BotEngineParams {
    return computeBotEngineParams(this.rating, this.style);
  }

  /**
   * Queries the engine and chooses a human-like move for the given FEN position.
   */
  public async chooseMove(
    fen: string = DEFAULT_POSITION,
    options?: {
      depth?: number;
      movetime?: number;
      priority?: EnginePriority;
      signal?: AbortSignal;
      rng?: () => number;
    },
  ): Promise<BotMoveDecision> {
    const params = this.getParams();
    const analysis = await this.engine.analyze({
      fen,
      depth: options?.depth ?? params.depth,
      movetime: options?.movetime,
      multipv: params.multipv,
      skillLevel: params.skillLevel,
      uciLimitStrength: params.uciLimitStrength,
      uciElo: params.uciElo,
      useCache: false,
      priority: options?.priority ?? 'live',
      signal: options?.signal,
    });

    return selectHumanLikeMove({
      fen,
      lines: analysis.lines,
      ratingOrTier: this.rating,
      style: this.style,
      rng: options?.rng ?? this.rng,
    });
  }
}
