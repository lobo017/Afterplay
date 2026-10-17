import {
  DEFAULT_POSITION,
  RulesAdapter,
  type Color,
  type ExecutedMove,
  type PieceSymbol,
  type Square,
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
    description:
      'Makes natural beginner inaccuracies and occasional tactical oversights.',
  },
  Casual: {
    id: 'Casual',
    label: 'Casual',
    defaultRating: 1000,
    minRating: 800,
    maxRating: 1199,
    description:
      'Plays club-casual developing moves with human-like positional slips.',
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
    description:
      'Strong tournament player; rarely drops material and punishes mistakes.',
  },
  Master: {
    id: 'Master',
    label: 'Master',
    defaultRating: 2200,
    minRating: 2000,
    maxRating: 2400,
    description:
      'Near-optimal engine precision with subtle stylistic preferences.',
  },
};

export const BOT_STYLE_PRESETS: Record<BotStyleId, BotStylePreset> = {
  aggressive: {
    id: 'aggressive',
    label: 'Aggressive',
    description:
      'Favors checks, captures, king-side attacks, and forward piece activity.',
  },
  solid: {
    id: 'solid',
    label: 'Solid',
    description:
      'Prioritizes king safety, central control, and low-risk positional accuracy.',
  },
  gambiteer: {
    id: 'gambiteer',
    label: 'Gambiteer',
    description:
      'Embraces pawn sacrifices, open files, and sharp dynamic initiative.',
  },
};

export interface BotEngineParams {
  rating: number;
  tier: BotTierId;
  style: BotStyleId;
  skillLevel: number;
  /** True only when rating is in Stockfish's valid UCI_Elo interval [1320, 2399]. */
  uciLimitStrength: boolean;
  uciElo: number;
  /** Node limit (`go nodes`) used to bound search horizon per level. */
  nodes: number;
  depth: number;
  multipv: number;
  temperatureCp: number;
  maxPlausibleDropCp: number;
  /** Probability [0, 1] of playing a plausible human blunder (missed threat or hanging piece). */
  blunderChance: number;
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
  isHumanBlunder?: boolean;
}

export interface BotMoveDecision {
  uci: string;
  san: string;
  executedMove: ExecutedMove;
  selectedLine: EngineLine;
  candidates: CandidateMoveWeight[];
  params: BotEngineParams;
}

export interface BotThinkTimeOptions {
  fen?: string;
  ply?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  botRemainingMs?: number;
  incrementMs?: number;
  unlimitedClock?: boolean;
  lastOpponentMove?: {
    from: Square;
    to: Square;
    isCapture?: boolean;
  } | null;
  decision?: BotMoveDecision | null;
  rng?: () => number;
}

const PIECE_VALUE_CP: Record<PieceSymbol, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
};

const ALL_SQUARES: Square[] = [];
for (const f of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
  for (let r = 1; r <= 8; r++) {
    ALL_SQUARES.push(`${f}${r}` as Square);
  }
}

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
 * Computes the Stockfish UCI search parameters and human-like selection parameters
 * for a target rating (400–2400) and style preset.
 *
 * - Uses strict node limits (`go nodes`) and `Skill Level` for low levels (< 1320),
 *   and enables `UCI_LimitStrength` + `UCI_Elo` ONLY where valid (rating >= 1320).
 * - Uses MultiPV 6–8 at low/club levels so candidate sampling sees beyond top engine moves.
 * - Includes a rating-dependent `blunderChance` for plausible human tactical oversights.
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

  // Stockfish UCI_Elo has a hard minimum of 1320; only enable UCI_LimitStrength where UCI_Elo is valid
  const uciLimitStrength = rating >= 1320 && rating < 2400;
  const uciElo = Math.max(1320, Math.min(2400, rating));

  // MultiPV 6–8 at low levels so the bot explores a wide set of candidate moves
  const multipv =
    rating < 800
      ? 8
      : rating < 1200
        ? 7
        : rating < 1600
          ? 6
          : rating < 2000
            ? 4
            : rating < 2350
              ? 3
              : 2;

  // Node budget (`go nodes`) accounts for MultiPV root splitting so each tier searches
  // the appropriate depth per candidate line:
  // 400 -> 25, 600 -> 180, 1000 -> 1600, 1400 -> 3400, 1800 -> 8500, 2200 -> 15500, 2400 -> 60000
  let nodes: number;
  if (rating <= 600) {
    const t = (rating - 400) / 200;
    nodes = Math.round(25 + t * (180 - 25));
  } else if (rating <= 1000) {
    const t = (rating - 600) / 400;
    nodes = Math.round(180 * Math.pow(1600 / 180, t));
  } else if (rating <= 1400) {
    const t = (rating - 1000) / 400;
    nodes = Math.round(1600 * Math.pow(3400 / 1600, t));
  } else if (rating <= 1800) {
    const t = (rating - 1400) / 400;
    nodes = Math.round(3400 * Math.pow(8500 / 3400, t));
  } else if (rating <= 2200) {
    const t = (rating - 1800) / 400;
    nodes = Math.round(8500 * Math.pow(15500 / 8500, t));
  } else {
    const t = (rating - 2200) / 200;
    nodes = Math.round(15500 * Math.pow(60000 / 15500, t));
  }

  const depth =
    rating <= 450
      ? 1
      : rating <= 700
        ? 3
        : Math.max(4, Math.min(13, Math.round(2 + normalized * 11)));

  // Temperature in centipawns: high at 400 Elo (~145 cp), near-zero at 2400 Elo (~1.8 cp)
  const baseTemp = 142 * Math.pow(1 - normalized, 2.05) + 1.8;
  const styleTempFactor =
    style === 'solid' ? 0.78 : style === 'gambiteer' ? 1.12 : 1.0;
  const temperatureCp = Number((baseTemp * styleTempFactor).toFixed(2));

  // Maximum centipawn drop considered a "plausible human mistake" at this rating
  // (Drops far beyond this threshold, such as 900cp Queen giveaways, are steeply suppressed)
  const maxPlausibleDropCp = Math.round(340 * Math.pow(1 - normalized, 1.25) + 18);

  // Rating-dependent chance of a "human blunder" (missing an opponent threat or leaving a piece hanging)
  let rawBlunderChance: number;
  if (rating >= 2350) {
    rawBlunderChance = 0;
  } else if (rating <= 600) {
    const t = (rating - 400) / 200;
    rawBlunderChance = 0.45 - t * (0.45 - 0.21);
  } else if (rating <= 1000) {
    const t = (rating - 600) / 400;
    rawBlunderChance = 0.21 - t * (0.21 - 0.062);
  } else if (rating <= 1400) {
    const t = (rating - 1000) / 400;
    rawBlunderChance = 0.062 - t * (0.062 - 0.036);
  } else if (rating <= 1800) {
    const t = (rating - 1400) / 400;
    rawBlunderChance = 0.036 - t * (0.036 - 0.012);
  } else if (rating <= 2200) {
    const t = (rating - 1800) / 400;
    rawBlunderChance = 0.012 - t * (0.012 - 0.004);
  } else {
    const t = (rating - 2200) / 150;
    rawBlunderChance = 0.004 * Math.max(0, 1 - t);
  }
  const blunderChance = Number(
    Math.max(0, Math.min(0.5, rawBlunderChance)).toFixed(4),
  );

  return {
    rating,
    tier,
    style,
    skillLevel,
    uciLimitStrength,
    uciElo,
    nodes,
    depth,
    multipv,
    temperatureCp,
    maxPlausibleDropCp,
    blunderChance,
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
 * Evaluates whether a move looks plausible and purposeful to a human player,
 * rejecting bizarre/random-looking moves (aimless King walks, rim Rook shuffles,
 * unprovoked Queen giveaways, or retreating developed minor pieces to the back rank).
 *
 * Returns a plausibility score > 0 for natural human moves, or 0 if the move looks random.
 */
export function scoreMoveHumanPlausibility(
  adapter: RulesAdapter,
  move: ExecutedMove,
): number {
  const us = move.color;
  const them: Color = us === 'w' ? 'b' : 'w';
  const fromFile = move.from[0] ?? 'a';
  const toFile = move.to[0] ?? 'a';
  const fromRank = Number(move.from[1] ?? 1);
  const toRank = Number(move.to[1] ?? 1);
  const homeRank = us === 'w' ? 1 : 8;
  const forwardAdvance = us === 'w' ? toRank - fromRank : fromRank - toRank;
  const isCheckMove = move.san.includes('+') || move.san.includes('#');
  const isCentralFile =
    toFile === 'c' || toFile === 'd' || toFile === 'e' || toFile === 'f';
  const isCentralRank =
    toRank === 3 || toRank === 4 || toRank === 5 || toRank === 6;

  // Count non-king pieces to detect opening/middlegame vs endgame
  let nonKingPieces = 0;
  for (const sq of ALL_SQUARES) {
    const p = adapter.get(sq);
    if (p && p.type !== 'k') nonKingPieces++;
  }

  // 1. Reject non-castling King walks in opening/middlegame unless in check or capturing
  if (
    move.piece === 'k' &&
    !move.isCastle &&
    !adapter.inCheck() &&
    !move.isCapture &&
    nonKingPieces >= 8
  ) {
    return 0;
  }

  // 2. Reject unprovoked Queen giveaways onto squares attacked by lower-value enemy pieces
  if (move.piece === 'q') {
    const capturedCp = move.captured ? PIECE_VALUE_CP[move.captured] : 0;
    if (adapter.isAttacked(move.to, them) && capturedCp < 500) {
      return 0;
    }
  }

  // 3. Reject aimless Rook 1-square shuffles to blocked edge squares in the opening
  if (
    move.piece === 'r' &&
    !move.isCapture &&
    !isCheckMove &&
    nonKingPieces >= 20 &&
    (toFile === 'a' || toFile === 'h' || toFile === 'b' || toFile === 'g')
  ) {
    return 0;
  }

  // 4. Reject retreating a developed piece to the home rank without capturing when not attacked
  if (
    (move.piece === 'n' || move.piece === 'b') &&
    toRank === homeRank &&
    !move.isCapture &&
    !adapter.isAttacked(move.from, them)
  ) {
    return 0;
  }

  // 5. Reject rim Knight moves to the 1st/8th or a3/h3/a6/h6 when central development exists unless capturing
  if (
    move.piece === 'n' &&
    (toFile === 'a' || toFile === 'h') &&
    !move.isCapture &&
    !isCheckMove
  ) {
    return 8; // Low plausibility compared to central moves
  }

  let score = 15;

  // Natural human actions:
  if (move.isCapture) {
    const capturedVal = move.captured ? PIECE_VALUE_CP[move.captured] : 100;
    score += 40 + Math.min(35, Math.round(capturedVal / 15));
  }
  if (isCheckMove) {
    score += 42;
  }
  if (move.isCastle) {
    score += 45;
  }
  if (
    (move.piece === 'n' || move.piece === 'b') &&
    fromRank === homeRank &&
    forwardAdvance > 0
  ) {
    // Developing a minor piece off the back rank
    score += isCentralFile ? 44 : 32;
  } else if (
    (move.piece === 'n' || move.piece === 'b') &&
    isCentralFile &&
    isCentralRank &&
    forwardAdvance >= 0
  ) {
    score += 34;
  }
  if (move.piece === 'p' && forwardAdvance > 0) {
    if (isCentralFile && isCentralRank) {
      score += 38;
    } else if (fromFile === 'b' || fromFile === 'c' || fromFile === 'f' || fromFile === 'g') {
      score += 24;
    } else {
      score += 14;
    }
  }

  return score;
}

/**
 * Computes the worst immediate 1-ply material loss for `us` on the board in `postMoveAdapter`
 * (where it is now `them` to move). Used to detect when a move leaves a piece hanging or
 * misses the opponent's tactical threat.
 */
function computeWorstHangingLossForSide(
  postMoveAdapter: RulesAdapter,
  us: Color,
): { maxLossCp: number; hangingSquare: Square | null } {
  // SAN carries everything needed here (mate marker, capture, mover, target square), and
  // listing moves as SAN avoids building a verbose move object with two FEN strings per
  // reply. This scan runs for every candidate move, so it dominated the bot's main-thread
  // time (~100 ms per move) before.
  const opponentSans = postMoveAdapter.sanMoves();
  let maxLossCp = 0;
  let hangingSquare: Square | null = null;

  for (const san of opponentSans) {
    const to = sanTargetSquare(san);
    if (san.includes('#')) {
      return { maxLossCp: 900, hangingSquare: to };
    }
    if (!san.includes('x') || !to) continue;

    // An empty target square on a pawn capture is en passant: the victim is a pawn
    const victimType = postMoveAdapter.get(to)?.type ?? 'p';
    const moverType: PieceSymbol = /^[KQRBN]/.test(san)
      ? (san[0]!.toLowerCase() as PieceSymbol)
      : 'p';
    const victimCp = PIECE_VALUE_CP[victimType] ?? 100;
    const attackerCp = PIECE_VALUE_CP[moverType] ?? 100;

    // Check if the square is defended by `us` after the opponent captures
    const afterOppCapture = postMoveAdapter.clone();
    try {
      afterOppCapture.move(san);
      const isRecapturable = afterOppCapture.isAttacked(to, us);
      const netLoss = isRecapturable
        ? Math.max(0, victimCp - attackerCp)
        : victimCp;
      if (netLoss > maxLossCp) {
        maxLossCp = netLoss;
        hangingSquare = to;
      }
    } catch {
      // Ignore illegal probe
    }
  }

  return { maxLossCp, hangingSquare };
}

/** Destination square of a SAN move ("Nxf7+" → f7, "exd8=Q#" → d8); null for castling. */
function sanTargetSquare(san: string): Square | null {
  const m = /([a-h][1-8])(?:=[QRBN])?[+#]?$/.exec(san);
  return m ? (m[1] as Square) : null;
}

/**
 * Scans all legal moves in `adapter` that are not already in `matchedCandidates` and finds
 * plausible "human blunders": moves that look constructive to a human (developing a piece,
 * advancing a central pawn, capturing, or giving check) but either miss the opponent's threat
 * or leave a piece/pawn hanging (losing ~90–520 cp, never a catastrophic Queen giveaway).
 */
export function findPlausibleHumanBlunderCandidates(
  adapter: RulesAdapter,
  legalMoves: ExecutedMove[],
  seenUci: ReadonlySet<string>,
  bestMove: ExecutedMove,
  bestEvalCp: number,
): Array<{
  move: ExecutedMove;
  line: EngineLine;
  plausibility: number;
}> {
  const us = bestMove.color;
  const bestPost = adapter.clone();
  let baselineExposureCp = 0;
  try {
    bestPost.move(bestMove.uci);
    baselineExposureCp = computeWorstHangingLossForSide(bestPost, us).maxLossCp;
  } catch {
    baselineExposureCp = 0;
  }

  const results: Array<{
    move: ExecutedMove;
    line: EngineLine;
    plausibility: number;
    estimatedDropCp: number;
  }> = [];

  for (const move of legalMoves) {
    if (seenUci.has(move.uci)) continue;
    const plausibility = scoreMoveHumanPlausibility(adapter, move);
    if (plausibility < 22) continue; // Never pick random-looking moves

    // In standard chess the verbose move already carries the resulting FEN, which is much
    // cheaper to load than clone() + move(). Chess960 keeps the full path so its castling
    // state carries over exactly.
    let post: RulesAdapter;
    try {
      if (adapter.isChess960()) {
        post = adapter.clone();
        post.move(move.uci);
      } else {
        post = new RulesAdapter(move.after);
      }
    } catch {
      continue;
    }

    const immediateGainCp = move.captured ? PIECE_VALUE_CP[move.captured] : 0;
    const { maxLossCp } = computeWorstHangingLossForSide(post, us);

    // Net tactical oversight relative to the best move's baseline exposure
    const tacticalOversightCp = Math.max(
      0,
      maxLossCp - immediateGainCp - baselineExposureCp,
    );

    // Even if there isn't an immediate 1-ply hanging piece, a natural move not in the engine's
    // top 6–8 MultiPV lines typically drops at least ~95–190 cp positionally/tactically.
    const positionalSlipCp =
      tacticalOversightCp >= 85
        ? tacticalOversightCp
        : 105 + Math.max(0, 50 - Math.round(plausibility * 0.45));

    // Reject catastrophic blunders (> 520 cp, e.g. hanging a Queen or walking into mate)
    if (positionalSlipCp < 85 || positionalSlipCp > 520) {
      continue;
    }

    const estimatedEvalCp = bestEvalCp - positionalSlipCp;
    const syntheticScore = { type: 'cp' as const, value: estimatedEvalCp };
    const syntheticWhiteScore = {
      type: 'cp' as const,
      value: us === 'w' ? estimatedEvalCp : -estimatedEvalCp,
    };

    results.push({
      move,
      plausibility:
        tacticalOversightCp >= 95 ? plausibility + 65 : plausibility,
      estimatedDropCp: positionalSlipCp,
      line: {
        multipv: 99,
        depth: 1,
        seldepth: 1,
        score: syntheticScore,
        scoreWhite: syntheticWhiteScore,
        evalCp: estimatedEvalCp,
        nodes: 1,
        nps: 1,
        timeMs: 1,
        pv: [move.uci],
      },
    });
  }

  // Keep the top 4 most plausible human blunder candidates
  results.sort((a, b) => b.plausibility - a.plausibility);
  return results.slice(0, 4).map(({ move, line, plausibility }) => ({
    move,
    line,
    plausibility,
  }));
}

/**
 * Selects a move from the engine's MultiPV candidate lines weighted by centipawn loss,
 * rating-scaled temperature, plausible-mistake filtering, human blunder probability,
 * and style preset.
 */
export function selectHumanLikeMove(
  options: HumanLikeSelectionRequest & { rng?: () => number },
): BotMoveDecision {
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
    isSyntheticBlunder?: boolean;
    plausibility?: number;
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
      matchedCandidates.push({
        move: matched,
        line,
        plausibility: scoreMoveHumanPlausibility(adapter, matched),
      });
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
    matchedCandidates.push({
      move: fallbackMove,
      line: fallbackLine,
      plausibility: 20,
    });
  }

  const bestEvalCp = matchedCandidates[0]!.line.evalCp;
  const bestScore = matchedCandidates[0]!.line.score;
  const isForcedShortMate =
    bestScore.type === 'mate' && bestScore.value > 0 && bestScore.value <= 3;

  // Augment with plausible human blunders (missed threats / hanging pieces) when enabled
  if (
    options.enableHumanBlunders &&
    params.blunderChance > 0 &&
    !isForcedShortMate
  ) {
    const extraBlunders = findPlausibleHumanBlunderCandidates(
      adapter,
      legalMoves,
      seenUci,
      matchedCandidates[0]!.move,
      bestEvalCp,
    );
    for (const b of extraBlunders) {
      seenUci.add(b.move.uci);
      matchedCandidates.push({
        move: b.move,
        line: b.line,
        isSyntheticBlunder: true,
        plausibility: b.plausibility,
      });
    }
  }

  // Influence of style scales modestly so style shapes choices among comparable moves
  // without causing outright blunders.
  const styleScale =
    params.rating >= 2350
      ? 0.05
      : Math.min(1, params.temperatureCp / 55 + 0.35);

  const scoredCandidates = matchedCandidates.map(
    ({ move, line, isSyntheticBlunder, plausibility }, idx) => {
      const dropCp = Math.max(0, bestEvalCp - line.evalCp);
      const styleBonusCp =
        dropCp <= params.maxPlausibleDropCp
          ? computeStyleBonusCp(adapter, move, dropCp, style)
          : 0;
      const utilityCp = -dropCp + styleBonusCp * styleScale;
      const humanPlausibility =
        plausibility ?? scoreMoveHumanPlausibility(adapter, move);
      // A candidate is a plausible human blunder if it loses 85–520 cp (never a catastrophic 890cp Queen giveaway)
      // and looks like a natural human move (plausibility >= 20).
      const isHumanBlunder =
        Boolean(isSyntheticBlunder) ||
        (dropCp >= 85 && dropCp <= 520 && humanPlausibility >= 20);

      return {
        idx,
        move,
        line,
        dropCp,
        styleBonusCp,
        utilityCp,
        humanPlausibility,
        isHumanBlunder,
        isSyntheticBlunder: Boolean(isSyntheticBlunder),
      };
    },
  );

  const nonSynthetic = scoredCandidates.filter((c) => !c.isSyntheticBlunder);
  const maxUtilityCp = Math.max(
    ...(nonSynthetic.length > 0 ? nonSynthetic : scoredCandidates).map(
      (c) => c.utilityCp,
    ),
  );

  // Compute standard Boltzmann temperature weights for the non-blunder MultiPV moves
  const boltzmannRaw = scoredCandidates.map((c) => {
    if (isForcedShortMate && params.rating >= 1200) {
      return c.idx === 0 ? 1 : 0.00001;
    }
    if (
      c.isSyntheticBlunder ||
      (options.enableHumanBlunders && c.isHumanBlunder && c.idx > 0)
    ) {
      return 0;
    }

    const relativeLossCp = Math.max(0, maxUtilityCp - c.utilityCp);
    let w = Math.exp(-relativeLossCp / Math.max(1, params.temperatureCp));

    // Plausible mistake filter: if a move drops far more than maxPlausibleDropCp (e.g. hanging a queen
    // for 890 cp when normal moves exist), steeply suppress it so weak bots make human-like mistakes
    // rather than random catastrophic blunders.
    if (c.dropCp > params.maxPlausibleDropCp) {
      const excess = c.dropCp - params.maxPlausibleDropCp;
      w *= Math.exp(-excess / 35);
    }

    // Also suppress non-plausible random-looking moves at all levels
    if (c.idx > 0 && c.humanPlausibility === 0) {
      w *= 0.001;
    }

    return Math.max(1e-9, w);
  });

  const boltzmannSum =
    boltzmannRaw.reduce((a, b) => a + b, 0) || 1;

  // Compute human-blunder distribution over plausible blunder candidates when enableHumanBlunders is active
  const blunderPool =
    options.enableHumanBlunders && !isForcedShortMate
      ? scoredCandidates.filter((c) => c.isHumanBlunder)
      : [];

  // Target blunder drop sweet-spot scales with rating (larger oversights at 400–600, smaller tactical slips at 1400–1800)
  const targetBlunderDropCp =
    115 + 165 * Math.max(0, (2000 - params.rating) / 1600);

  const blunderRaw = scoredCandidates.map((c) => {
    if (!options.enableHumanBlunders || !c.isHumanBlunder || blunderPool.length === 0) {
      return 0;
    }
    const distFromSweetSpot = Math.abs(c.dropCp - targetBlunderDropCp);
    return (
      Math.max(1, c.humanPlausibility) *
      Math.exp(-distFromSweetSpot / 120)
    );
  });
  const blunderSum = blunderRaw.reduce((a, b) => a + b, 0);

  const effectiveBlunderChance =
    blunderSum > 0 ? params.blunderChance : 0;

  const rawWeights = scoredCandidates.map((c, i) => {
    const pBoltzmann = boltzmannRaw[i]! / boltzmannSum;
    const pBlunder = blunderSum > 0 ? blunderRaw[i]! / blunderSum : 0;
    const combined =
      (1 - effectiveBlunderChance) * pBoltzmann +
      effectiveBlunderChance * pBlunder;

    return {
      move: c.move,
      line: c.line,
      dropCp: c.dropCp,
      styleBonusCp: c.styleBonusCp,
      isHumanBlunder: c.isHumanBlunder,
      weight: Math.max(1e-9, combined),
    };
  });

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
    isHumanBlunder: item.isHumanBlunder,
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

/**
 * Computes a human-like thinking delay (in milliseconds) that varies with:
 * - User-configured minimum and maximum delay (default 500–3000 ms in untimed games)
 * - Time control and the bot's own remaining clock + increment in timed games
 * - Forced moves (1 legal move) and obvious immediate recaptures (quick replies)
 * - Position complexity (legal move count, available captures and checks, MultiPV tension)
 * - Game phase (faster in early opening book plies, longer in complex middlegames)
 */
export function computeBotThinkTimeMs(options: BotThinkTimeOptions): number {
  const minDelayMs = Math.max(0, options.minDelayMs ?? 500);
  const maxDelayMs = Math.max(minDelayMs, options.maxDelayMs ?? 3000);
  if (maxDelayMs === 0 || minDelayMs === maxDelayMs) {
    return Math.round(minDelayMs);
  }

  const fen = options.fen?.trim() || DEFAULT_POSITION;
  const adapter = new RulesAdapter(fen);
  const legalMoves = adapter.verboseMoves();
  const rng = options.rng ?? Math.random;

  let effectiveMin = minDelayMs;
  let effectiveMax = maxDelayMs;

  // Respect the bot's own clock in timed games
  if (
    !options.unlimitedClock &&
    typeof options.botRemainingMs === 'number' &&
    options.botRemainingMs > 0
  ) {
    const rem = options.botRemainingMs;
    const inc = Math.max(0, options.incrementMs ?? 0);

    // Scale pace with time control (faster in bullet/blitz)
    const tcScale = rem < 90_000 ? 0.45 : rem < 300_000 ? 0.72 : 1.0;

    // Never spend more than ~6.5% of remaining time + 60% of increment (or 3% under 5s)
    const clockBudgetMs =
      rem < 5_000
        ? Math.max(25, Math.floor(rem * 0.03))
        : Math.max(80, Math.floor(rem * 0.065 + inc * 0.6));

    effectiveMax = Math.max(
      25,
      Math.min(Math.round(maxDelayMs * tcScale), clockBudgetMs),
    );
    effectiveMin = Math.min(
      Math.round(minDelayMs * tcScale),
      Math.floor(effectiveMax * 0.45),
    );
  }

  // 1. Forced move (only 1 legal reply) -> quick reply near effectiveMin
  if (legalMoves.length <= 1) {
    return Math.round(effectiveMin);
  }

  // 2. Obvious immediate recapture on the same square -> quick reply
  const chosenMove = options.decision?.executedMove;
  if (
    options.lastOpponentMove?.isCapture &&
    chosenMove &&
    chosenMove.isCapture &&
    chosenMove.to === options.lastOpponentMove.to
  ) {
    const quickRecapture =
      effectiveMin + (effectiveMax - effectiveMin) * 0.14;
    return Math.round(
      Math.max(effectiveMin, Math.min(effectiveMax, quickRecapture)),
    );
  }

  // 3. Forced mate-in-1 -> quick reply
  const bestScore = options.decision?.selectedLine.score;
  if (bestScore?.type === 'mate' && Math.abs(bestScore.value) === 1) {
    return Math.round(effectiveMin + (effectiveMax - effectiveMin) * 0.15);
  }

  // 4. Position complexity: legal moves, captures, checks, and top-2 MultiPV tension
  const captureCount = legalMoves.filter((m) => m.isCapture).length;
  const checkCount = legalMoves.filter(
    (m) => m.san.includes('+') || m.san.includes('#'),
  ).length;
  const inCheck = adapter.inCheck();

  const branchingScore = Math.min(
    1,
    Math.max(0, (legalMoves.length - 5) / 30),
  );
  const tacticalSharpness = Math.min(
    1,
    captureCount * 0.15 + checkCount * 0.18 + (inCheck ? 0.24 : 0),
  );

  let evalTension = 0;
  const cands = options.decision?.candidates;
  if (cands && cands.length >= 2) {
    const gapCp = Math.abs(cands[0]!.evalCp - cands[1]!.evalCp);
    if (gapCp <= 35) {
      evalTension = 0.22; // Close decision between multiple lines
    } else if (gapCp >= 200) {
      evalTension = -0.18; // One obvious best move
    }
  }

  // 5. Game phase factor (opening vs middlegame vs endgame)
  let nonKingPieces = 0;
  for (const sq of ALL_SQUARES) {
    const p = adapter.get(sq);
    if (p && p.type !== 'k') nonKingPieces++;
  }
  const ply =
    options.ply ??
    Math.max(
      0,
      (adapter.moveNumber() - 1) * 2 + (adapter.turn() === 'b' ? 1 : 0),
    );

  let phaseFactor = 1.0;
  if (ply < 8 && captureCount <= 1 && !inCheck) {
    phaseFactor = 0.35 + (ply / 8) * 0.3; // Quick early opening moves
  } else if (nonKingPieces < 10) {
    phaseFactor = 0.68; // Simplified endgame
  } else if (ply >= 10 && nonKingPieces >= 14) {
    phaseFactor = 1.08; // Peak middlegame complexity
  }

  const rawComplexity = Math.max(
    0.05,
    Math.min(
      1,
      (branchingScore * 0.42 + tacticalSharpness * 0.58 + evalTension) *
        phaseFactor,
    ),
  );

  const jitter = (rng() - 0.5) * 0.1;
  const normalized = Math.max(0.04, Math.min(1, rawComplexity + jitter));

  return Math.round(effectiveMin + normalized * (effectiveMax - effectiveMin));
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

/** Everything selectHumanLikeMove() needs apart from its random source. */
export interface HumanLikeSelectionRequest {
  fen?: string;
  lines: EngineLine[];
  ratingOrTier: number | BotTierId;
  style?: BotStyleId;
  enableHumanBlunders?: boolean;
}

/**
 * Runs the human-like move selection. It must draw from `rng` exactly as
 * selectHumanLikeMove() would, so a seeded stream produces the same moves wherever the
 * selection runs (see BotSelectionClient, which moves it into a worker).
 */
export type BotMoveSelector = (
  request: HumanLikeSelectionRequest,
  rng: () => number,
) => Promise<BotMoveDecision>;

/** Default selector: runs on the calling thread (Node scripts and unit tests). */
export const selectHumanLikeMoveInline: BotMoveSelector = (request, rng) =>
  Promise.resolve(selectHumanLikeMove({ ...request, rng }));

export interface ChessBotOptions {
  rating?: number | BotTierId;
  style?: BotStyleId;
  rng?: () => number;
  /** Where the move selection runs; defaults to inline on the calling thread. */
  selectMove?: BotMoveSelector;
}

/**
 * High-level playing bot combining Stockfish node-limited / Skill-limited searches
 * on an isolated engine state with human-like MultiPV temperature sampling and
 * rating-dependent plausible human blunders.
 */
export class ChessBot {
  private readonly engine: EngineClient;
  private rating: number;
  private style: BotStyleId;
  private readonly rng: () => number;
  private readonly selectMove: BotMoveSelector;

  constructor(engine: EngineClient, options?: ChessBotOptions) {
    this.engine = engine;
    const initRating =
      typeof options?.rating === 'string'
        ? BOT_TIERS[options.rating].defaultRating
        : (options?.rating ?? BOT_TIERS.Club.defaultRating);
    this.rating = clampBotRating(initRating);
    this.style = options?.style ?? 'solid';
    this.rng = options?.rng ?? Math.random;
    this.selectMove = options?.selectMove ?? selectHumanLikeMoveInline;
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
   * Queries the engine with a fresh, node-limited search (never reusing cached or
   * full-strength analysis state) and chooses a human-like move for the given FEN.
   */
  public async chooseMove(
    fen: string = DEFAULT_POSITION,
    options?: {
      depth?: number;
      nodes?: number;
      movetime?: number;
      priority?: EnginePriority;
      signal?: AbortSignal;
      rng?: () => number;
      enableHumanBlunders?: boolean;
    },
  ): Promise<BotMoveDecision> {
    const params = this.getParams();
    const analysis = await this.engine.analyze({
      fen,
      nodes: options?.nodes ?? params.nodes,
      depth: options?.depth ?? params.depth,
      movetime: options?.movetime,
      multipv: params.multipv,
      skillLevel: params.skillLevel,
      uciLimitStrength: params.uciLimitStrength,
      uciElo: params.uciElo,
      resetGame: true,
      useCache: false,
      priority: options?.priority ?? 'live',
      signal: options?.signal,
    });

    return this.selectMove(
      {
        fen,
        lines: analysis.lines,
        ratingOrTier: this.rating,
        style: this.style,
        enableHumanBlunders: options?.enableHumanBlunders ?? true,
      },
      options?.rng ?? this.rng,
    );
  }
}
