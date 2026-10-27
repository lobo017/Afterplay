/*
 * Glicko-2 (Mark Glickman, "Example of the Glicko-2 system", 2013). Ratings on the Glicko
 * scale; internally μ = (r − 1500)/173.7178, φ = RD/173.7178. Each rated puzzle is one
 * rating period with one game against the puzzle's rating.
 */

export interface GlickoRating {
  rating: number;
  rd: number;
  volatility: number;
}

export interface GlickoGame {
  opponent: { rating: number; rd: number };
  /** 1 win, 0.5 draw, 0 loss. */
  score: number;
}

export const GLICKO_SCALE = 173.7178;
/** System constant: how much the volatility may change (Glickman suggests 0.3–1.2). */
export const DEFAULT_TAU = 0.5;
export const DEFAULT_PLAYER: GlickoRating = { rating: 1500, rd: 350, volatility: 0.06 };
/** The bundled puzzles carry a rating but no deviation; they count as well established. */
export const PUZZLE_RD = 75;
/** The player's deviation stays in this range, so the rating keeps moving after many puzzles. */
export const MIN_PLAYER_RD = 45;
export const MAX_PLAYER_RD = 350;

const CONVERGENCE = 1e-6;

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/** The rating after one rating period with `games` (none: only the deviation grows). */
export function updateGlicko2(
  player: GlickoRating,
  games: readonly GlickoGame[],
  tau: number = DEFAULT_TAU,
): GlickoRating {
  const mu = (player.rating - 1500) / GLICKO_SCALE;
  const phi = player.rd / GLICKO_SCALE;
  const sigma = player.volatility;

  if (games.length === 0) {
    return { ...player, rd: Math.sqrt(phi * phi + sigma * sigma) * GLICKO_SCALE };
  }

  let vInv = 0;
  let deltaSum = 0;
  for (const game of games) {
    const muJ = (game.opponent.rating - 1500) / GLICKO_SCALE;
    const phiJ = game.opponent.rd / GLICKO_SCALE;
    const e = expected(mu, muJ, phiJ);
    vInv += g(phiJ) ** 2 * e * (1 - e);
    deltaSum += g(phiJ) * (game.score - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Step 5: the new volatility (Illinois algorithm)
  const a = Math.log(sigma * sigma);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > CONVERGENCE) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  const newSigma = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * deltaSum;
  return { rating: newMu * GLICKO_SCALE + 1500, rd: newPhi * GLICKO_SCALE, volatility: newSigma };
}

/** The player's rating after one puzzle (solved = win), with the deviation kept in range. */
export function ratePuzzleAttempt(player: GlickoRating, puzzleRating: number, solved: boolean): GlickoRating {
  const next = updateGlicko2(player, [{ opponent: { rating: puzzleRating, rd: PUZZLE_RD }, score: solved ? 1 : 0 }]);
  return { ...next, rd: Math.min(MAX_PLAYER_RD, Math.max(MIN_PLAYER_RD, next.rd)) };
}
