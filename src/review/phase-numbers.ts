import type { Color } from '../core/rules';
import { PHASES, phaseOf, type GamePhase } from '../library/insights';
import { moveAccuracy } from './formulas';

/**
 * Accuracy and error counts by game phase for one player in one game, computed from what a batch review stores (White's
 * win% at every position and one class letter per move) and the position before each move. No engine, no PGN: the
 * caller (scripts/history-phases.mjs) replays the game for the positions, and the app only reads the result.
 *
 * Stored per game as three tuples (opening, middlegame, endgame; about 60 bytes):
 *   [moves, accuracy, blunders, mistakes, misses]
 * `accuracy` is the mean of the player's move accuracies in the phase, rounded to 2 decimals (0 with no moves), so
 * several games average weighted by `moves`.
 */
export type PhaseTuple = [moves: number, accuracy: number, blunders: number, mistakes: number, misses: number];
export type PhaseNumbers = [opening: PhaseTuple, middlegame: PhaseTuple, endgame: PhaseTuple];

/** The class letters of a batch review's `classes` string (hpc/history/lib/reviews.mjs CLASS_LETTERS), the three counted. */
const BLUNDER = 'X';
const MISTAKE = 'M';
const MISS = 'S';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface PhaseInput {
  /** White's win% at every position, start first (n moves: n + 1 values). */
  win: readonly number[];
  /** One class letter per move, both sides (n letters). */
  classes: string;
  /** The FEN before each move (n of them). */
  fensBefore: readonly string[];
  /** The player's colour. */
  color: Color;
  /** Who moves first (White unless the game starts from another position). */
  firstMover?: Color;
}

/** The phase numbers of the player's moves, or null when the three lists do not fit one another. */
export function phaseNumbers(input: PhaseInput): PhaseNumbers | null {
  const { win, classes, fensBefore, color } = input;
  const firstMover = input.firstMover ?? 'w';
  const n = classes.length;
  if (n < 1 || win.length !== n + 1 || fensBefore.length !== n) return null;
  const sums = PHASES.map(() => ({ moves: 0, accuracy: 0, blunders: 0, mistakes: 0, misses: 0 }));
  for (let i = 0; i < n; i++) {
    const mover: Color = i % 2 === 0 ? firstMover : firstMover === 'w' ? 'b' : 'w';
    if (mover !== color) continue;
    const drop = mover === 'w' ? win[i]! - win[i + 1]! : win[i + 1]! - win[i]!;
    const bucket = sums[PHASES.indexOf(phaseOf(fensBefore[i]!, i + 1))]!;
    bucket.moves++;
    bucket.accuracy += moveAccuracy(drop);
    const letter = classes[i];
    if (letter === BLUNDER) bucket.blunders++;
    else if (letter === MISTAKE) bucket.mistakes++;
    else if (letter === MISS) bucket.misses++;
  }
  const tuple = (s: (typeof sums)[number]): PhaseTuple => [
    s.moves,
    s.moves === 0 ? 0 : round2(s.accuracy / s.moves),
    s.blunders,
    s.mistakes,
    s.misses,
  ];
  return [tuple(sums[0]!), tuple(sums[1]!), tuple(sums[2]!)];
}

export interface PhaseTotal {
  phase: GamePhase;
  moves: number;
  /** Mean accuracy over all the moves (weighted by each game's move count), null with no moves. */
  accuracy: number | null;
  blunders: number;
  mistakes: number;
  misses: number;
  /** Games with at least one move in the phase. */
  games: number;
}

/** Adds up the phase numbers of many games; `null` entries (games without numbers) are skipped. */
export function totalPhases(games: ReadonlyArray<PhaseNumbers | null | undefined>): PhaseTotal[] {
  return PHASES.map((phase, p) => {
    let moves = 0;
    let weighted = 0;
    let blunders = 0;
    let mistakes = 0;
    let misses = 0;
    let count = 0;
    for (const g of games) {
      const t = g?.[p];
      if (!t || t[0] === 0) continue;
      moves += t[0];
      weighted += t[0] * t[1];
      blunders += t[2];
      mistakes += t[3];
      misses += t[4];
      count++;
    }
    return {
      phase,
      moves,
      accuracy: moves === 0 ? null : weighted / moves,
      blunders,
      mistakes,
      misses,
      games: count,
    };
  });
}
