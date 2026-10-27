import type { Color } from '../core/rules';
import type { UciScore } from '../engine/uci-parser';

/** Logistic slope of the win% curve (Lichess's fit of centipawns to game results). */
export const WIN_PERCENT_SLOPE = 0.00368208;

/**
 * Evaluations are clamped to ±1000 cp before conversion, and a forced mate counts as
 * ±1000 cp, as on Lichess (lila `Eval.Cp.ceiled`, `WinPercent.fromMate`): 97.5% / 2.5%.
 */
export const WIN_PERCENT_CP_CEILING = 1000;

/**
 * Win% for a centipawn score from the side's own point of view, cp clamped to ±1000:
 * Win% = 50 + 50·(2/(1+e^(−0.00368208·cp)) − 1)
 */
export function winPercentFromCp(cp: number): number {
  const ceiled = Math.max(-WIN_PERCENT_CP_CEILING, Math.min(WIN_PERCENT_CP_CEILING, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-WIN_PERCENT_SLOPE * ceiled)) - 1);
}

/**
 * Win% for a UCI score from the scored side's point of view. A forced mate counts as
 * +1000 cp (the side mates) or −1000 cp (it gets mated; `mate 0`: already mated).
 */
export function winPercentFromScore(score: UciScore): number {
  if (score.type === 'mate') {
    return winPercentFromCp(score.value > 0 ? WIN_PERCENT_CP_CEILING : -WIN_PERCENT_CP_CEILING);
  }
  return winPercentFromCp(score.value);
}

/** Lichess adds 1 point to every move accuracy for the imprecision of the evaluations. */
export const ACCURACY_UNCERTAINTY_BONUS = 1;

/**
 * Move accuracy from the mover's win% drop, as on Lichess (lila
 * `AccuracyPercent.fromWinPercents`): 103.1668·e^(−0.04354·drop) − 3.1669 + 1, clamped to
 * 0–100. No drop (or a gain) is 100.
 */
export function moveAccuracy(winDrop: number): number {
  if (winDrop <= 0) return 100;
  const raw =
    103.1668100711649 * Math.exp(-0.04354415386753951 * winDrop) - 3.166924740191411 + ACCURACY_UNCERTAINTY_BONUS;
  return Math.max(0, Math.min(100, raw));
}

/**
 * A score as Lichess counts centipawns: cp clamped to ±1000, a forced mate as ±1000 (the
 * side to move mates / gets mated; `mate 0`: it is mated).
 */
export function ceiledCentipawns(score: UciScore): number {
  if (score.type === 'mate') {
    return score.value > 0 ? WIN_PERCENT_CP_CEILING : -WIN_PERCENT_CP_CEILING;
  }
  return Math.max(-WIN_PERCENT_CP_CEILING, Math.min(WIN_PERCENT_CP_CEILING, score.value));
}

/** Lichess's evaluation of the starting position (lila `Eval.Cp.initial`). */
export const LICHESS_INITIAL_CP = 15;

/**
 * Centipawn loss of one move, as on Lichess (lila `Accuracy.diffsList`): the mover's
 * evaluation before minus after, both ceiled (`ceiledCentipawns`), never below 0. Every
 * move counts. ACPL is the rounded mean of these per side.
 */
export function centipawnLoss(beforeCp: number, afterCp: number): number {
  const clamp = (cp: number) => Math.max(-WIN_PERCENT_CP_CEILING, Math.min(WIN_PERCENT_CP_CEILING, cp));
  return Math.max(0, clamp(beforeCp) - clamp(afterCp));
}

/**
 * Lichess ACPL for both sides from White's centipawn evaluation of every position (start
 * first). Losses are averaged per side and the mean is rounded.
 */
export function averageCentipawnLoss(
  whiteCps: readonly number[],
  firstMover: Color = 'w',
): { white: number | null; black: number | null } {
  const losses: Record<Color, number[]> = { w: [], b: [] };
  for (let i = 0; i + 1 < whiteCps.length; i++) {
    const mover: Color = i % 2 === 0 ? firstMover : firstMover === 'w' ? 'b' : 'w';
    const sign = mover === 'w' ? 1 : -1;
    losses[mover].push(centipawnLoss(sign * whiteCps[i]!, sign * whiteCps[i + 1]!));
  }
  const mean = (xs: number[]) => (xs.length > 0 ? Math.round(xs.reduce((a, v) => a + v, 0) / xs.length) : null);
  return { white: mean(losses.w), black: mean(losses.b) };
}

/** Population standard deviation. */
function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

/** Harmonic mean, with each value floored at 1 so a single 0% move doesn't zero the result. */
export function harmonicMean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const denominator = values.reduce((sum, v) => sum + 1 / Math.max(1, v), 0);
  return values.length / denominator;
}

export interface GameAccuracyResult {
  white: number | null;
  black: number | null;
}

/**
 * Lichess-style game accuracy for both sides.
 *
 * `whiteWins` is White's win% for every position of the game, start position first
 * (n moves → n + 1 values). Each move's accuracy is weighted by the volatility of the
 * game around it: the standard deviation of the win% over a sliding window of positions
 * (window = n/10 clamped to 2–8, weight clamped to 0.5–12), so moves in sharp phases
 * count more than moves in dead positions. A side's accuracy is the mean of that
 * weighted average and the harmonic mean of its move accuracies, which pulls the result
 * down for a few very bad moves.
 */
export function gameAccuracy(whiteWins: readonly number[], firstMover: Color = 'w'): GameAccuracyResult {
  const moveCount = whiteWins.length - 1;
  if (moveCount < 1) return { white: null, black: null };

  const windowSize = Math.max(2, Math.min(8, Math.floor(moveCount / 10)));
  const windows: number[][] = [];
  const leading = Math.min(windowSize, whiteWins.length) - 2;
  for (let i = 0; i < leading; i++) {
    windows.push(whiteWins.slice(0, windowSize));
  }
  if (whiteWins.length <= windowSize) {
    windows.push([...whiteWins]);
  } else {
    for (let i = 0; i + windowSize <= whiteWins.length; i++) {
      windows.push(whiteWins.slice(i, i + windowSize));
    }
  }

  const perSide: Record<Color, { accuracy: number; weight: number }[]> = {
    w: [],
    b: [],
  };
  for (let i = 0; i < moveCount; i++) {
    const before = whiteWins[i]!;
    const after = whiteWins[i + 1]!;
    const mover: Color = i % 2 === 0 ? firstMover : firstMover === 'w' ? 'b' : 'w';
    const drop = mover === 'w' ? before - after : after - before;
    const window = windows[Math.min(i, windows.length - 1)]!;
    const weight = Math.max(0.5, Math.min(12, standardDeviation(window)));
    perSide[mover].push({ accuracy: moveAccuracy(drop), weight });
  }

  const sideAccuracy = (entries: { accuracy: number; weight: number }[]): number | null => {
    if (entries.length === 0) return null;
    const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
    const weighted = entries.reduce((sum, e) => sum + e.accuracy * e.weight, 0) / totalWeight;
    const harmonic = harmonicMean(entries.map((e) => e.accuracy))!;
    return (weighted + harmonic) / 2;
  };

  return { white: sideAccuracy(perSide.w), black: sideAccuracy(perSide.b) };
}

/**
 * Centipawn loss on the bot calibration's scale, measured the way `npm run calibrate:bots`
 * measures the bots, so it can be compared with their ACPL: only positions where the best
 * line is within ±650 cp for the mover and there are at least two legal moves count,
 * mate scores convert to ±(10000 − 10·n) cp, and the loss is capped at 420 cp. Returns
 * null for positions that don't count. Used only for the bot-level comparison; the ACPL
 * the review shows is Lichess's (`centipawnLoss`).
 */
export const ACPL_COUNTED_EVAL_LIMIT_CP = 650;
export const ACPL_LOSS_CAP_CP = 420;

export function calibrationCentipawnLoss(input: {
  bestCp: number;
  playedCp: number;
  legalMoveCount: number;
  playedBest: boolean;
  deliveredMate: boolean;
}): number | null {
  if (input.legalMoveCount < 2) return null;
  if (Math.abs(input.bestCp) > ACPL_COUNTED_EVAL_LIMIT_CP) return null;
  if (input.playedBest || input.deliveredMate) return 0;
  return Math.min(ACPL_LOSS_CAP_CP, Math.max(0, input.bestCp - input.playedCp));
}

/**
 * Anchors for the bot-level comparison: each in-app bot level and the middle of the ACPL
 * band it is calibrated to (`npm run calibrate:bots` targets, PROGRESS.md Phase 3), on
 * the calibration's own scale (`calibrationCentipawnLoss`).
 *
 * This is not a human rating model. The bots are limited Stockfish, which loses far less
 * per move than a person of the same nominal rating, and one game's ACPL is dominated by
 * a few large losses: in the Lichess reference game (tests/fixtures/review), players
 * rated 1374 and 1397 come out at ≈770 and ≈710. Without human (ACPL, rating, time
 * control) data, which an offline app doesn't have, it can't be turned into one, so the
 * review shows it as an approximate bot comparison, labelled as such.
 */
export const BOT_LEVEL_ANCHORS: ReadonlyArray<{ rating: number; acpl: number }> = [
  { rating: 400, acpl: 141.5 },
  { rating: 600, acpl: 105 },
  { rating: 1000, acpl: 70 },
  { rating: 1400, acpl: 37 },
  { rating: 1800, acpl: 20.5 },
  { rating: 2200, acpl: 12.5 },
  { rating: 2400, acpl: 5 },
];

/** Below this many counted moves an average is dominated by single moves: no comparison. */
export const BOT_LEVEL_MIN_COUNTED_MOVES = 8;

export interface BotLevelEstimate {
  rating: number;
  /** The ACPL was outside the calibrated range, so the level is a bound ("≤400", "2400+"). */
  clamped: 'low' | 'high' | null;
}

/**
 * The in-app bot level whose calibrated ACPL matches a side's calibration ACPL,
 * interpolated linearly in log(ACPL) between anchors. Approximate; see BOT_LEVEL_ANCHORS.
 */
export function estimateBotLevel(acpl: number | null, countedMoves: number): BotLevelEstimate | null {
  if (acpl === null || countedMoves < BOT_LEVEL_MIN_COUNTED_MOVES) return null;
  const first = BOT_LEVEL_ANCHORS[0]!;
  const last = BOT_LEVEL_ANCHORS[BOT_LEVEL_ANCHORS.length - 1]!;
  if (acpl >= first.acpl) return { rating: first.rating, clamped: 'low' };
  if (acpl <= last.acpl) return { rating: last.rating, clamped: 'high' };
  for (let i = 0; i < BOT_LEVEL_ANCHORS.length - 1; i++) {
    const hi = BOT_LEVEL_ANCHORS[i]!;
    const lo = BOT_LEVEL_ANCHORS[i + 1]!;
    if (acpl <= hi.acpl && acpl >= lo.acpl) {
      const t = (Math.log(hi.acpl) - Math.log(acpl)) / (Math.log(hi.acpl) - Math.log(lo.acpl));
      return {
        rating: Math.round(hi.rating + t * (lo.rating - hi.rating)),
        clamped: null,
      };
    }
  }
  return null;
}

/** "≈700", "≤400", "2400+" or "—": always visibly approximate. */
export function formatBotLevel(estimate: BotLevelEstimate | null): string {
  if (!estimate) return '—';
  if (estimate.clamped === 'low') return `≤${estimate.rating}`;
  if (estimate.clamped === 'high') return `${estimate.rating}+`;
  return `≈${estimate.rating}`;
}
