import { RulesAdapter, type Square } from '../core/rules';
import type { Grade } from './fsrs';
import { sameMove, type PreparedPuzzle } from './puzzle-format';

/** A clean solve at or under this many seconds per player move is graded Easy. */
export const EASY_SECONDS_PER_MOVE = 10;

export type PuzzleStatus = 'playing' | 'checking' | 'solved' | 'shown';

/** What happened when the player made a move. */
export type PlayResult =
  /** The expected move; `reply` is the opponent's answer to show (null when solved). */
  | { kind: 'correct'; uci: string; reply: string | null; solved: boolean }
  /** Not the expected move but it mates: solved. */
  | { kind: 'solved-alternative'; uci: string }
  /** Not the expected move: ask the engine (`resolveAlternative`) whether it also wins. */
  | { kind: 'check'; uci: string; fen: string; expected: string }
  | { kind: 'illegal' }
  | { kind: 'not-playing' };

/** How an attempt went, for the rating and the scheduler; recorded once per attempt. */
export interface AttemptOutcome {
  solved: boolean;
  hintUsed: boolean;
  /** Wrong moves made before the outcome was recorded. */
  mistakes: number;
  timeMs: number;
  grade: Grade;
}

/** Again for a failure, Hard after a hint, Easy for a quick clean solve, Good otherwise. */
export function gradeAttempt(input: { solved: boolean; hintUsed: boolean; timeMs: number; playerMoves: number }): Grade {
  if (!input.solved) return 1;
  if (input.hintUsed) return 2;
  const perMove = input.timeMs / 1000 / Math.max(1, input.playerMoves);
  return perMove <= EASY_SECONDS_PER_MOVE ? 4 : 3;
}

/**
 * Solving one puzzle: the player's moves are checked against the solution (by the position
 * they lead to), the opponent's replies come from the solution, and a different move is either
 * an immediate mate (accepted) or handed to the caller to check with the engine.
 *
 * The attempt's outcome is fixed the first time it is decided: the first wrong move or showing
 * the solution makes it a failure; otherwise solving it decides it.
 */
export class PuzzleSession {
  private fenNow: string;
  private step = 0;
  private statusNow: PuzzleStatus = 'playing';
  private hintUsed = false;
  private mistakes = 0;
  private outcomeNow: AttemptOutcome | null = null;
  private readonly startedAt: number;
  private pendingAlternative: string | null = null;
  /** Moves played from the start position (player and replies), UCI. */
  private readonly played: string[] = [];

  constructor(
    public readonly puzzle: PreparedPuzzle,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.fenNow = puzzle.startFen;
    this.startedAt = now();
  }

  public get fen(): string {
    return this.fenNow;
  }

  public get status(): PuzzleStatus {
    return this.statusNow;
  }

  /** The attempt's outcome, once decided (null while undecided). */
  public get outcome(): AttemptOutcome | null {
    return this.outcomeNow;
  }

  public get movesPlayed(): readonly string[] {
    return this.played;
  }

  /** The solution move the player is expected to find now. */
  public get expectedMove(): string | null {
    return this.statusNow === 'playing' || this.statusNow === 'checking' ? (this.puzzle.solution[this.step] ?? null) : null;
  }

  public play(uci: string): PlayResult {
    if (this.statusNow !== 'playing') return { kind: 'not-playing' };
    const expected = this.puzzle.solution[this.step]!;
    const adapter = new RulesAdapter(this.fenNow);
    const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
    if (!m) return { kind: 'illegal' };
    try {
      adapter.move({ from: m[1]!, to: m[2]!, ...(m[3] ? { promotion: m[3] } : {}) });
    } catch {
      return { kind: 'illegal' };
    }

    if (sameMove(this.fenNow, uci, expected)) {
      this.advance(expected);
      if (this.step >= this.puzzle.solution.length) {
        this.finishSolved();
        return { kind: 'correct', uci: expected, reply: null, solved: true };
      }
      const reply = this.puzzle.solution[this.step]!;
      this.advance(reply);
      return { kind: 'correct', uci: expected, reply, solved: false };
    }

    if (adapter.isCheckmate()) {
      this.played.push(uci);
      this.fenNow = adapter.fen();
      this.finishSolved();
      return { kind: 'solved-alternative', uci };
    }

    this.statusNow = 'checking';
    this.pendingAlternative = uci;
    return { kind: 'check', uci, fen: this.fenNow, expected };
  }

  /** The engine's verdict on the move handed out by `play` (kind 'check'). */
  public resolveAlternative(accepted: boolean): void {
    if (this.statusNow !== 'checking' || !this.pendingAlternative) return;
    const uci = this.pendingAlternative;
    this.pendingAlternative = null;
    if (accepted) {
      const adapter = new RulesAdapter(this.fenNow);
      adapter.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length > 4 ? { promotion: uci[4] } : {}) });
      this.played.push(uci);
      this.fenNow = adapter.fen();
      this.finishSolved();
      return;
    }
    this.mistakes++;
    this.statusNow = 'playing';
    this.decide(false);
  }

  /** The square of the piece to move (and the attempt counts as hinted). */
  public hint(): Square | null {
    const expected = this.expectedMove;
    if (!expected || this.statusNow !== 'playing') return null;
    this.hintUsed = true;
    return expected.slice(0, 2) as Square;
  }

  /** Gives up: the rest of the solution from the current position (UCI). */
  public showSolution(): string[] {
    if (this.statusNow === 'solved' || this.statusNow === 'shown') return [];
    const rest = this.puzzle.solution.slice(this.step);
    this.pendingAlternative = null;
    this.statusNow = 'shown';
    this.decide(false);
    return rest;
  }

  private advance(uci: string): void {
    const adapter = new RulesAdapter(this.fenNow);
    adapter.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length > 4 ? { promotion: uci[4] } : {}) });
    this.fenNow = adapter.fen();
    this.played.push(uci);
    this.step++;
  }

  private finishSolved(): void {
    this.statusNow = 'solved';
    this.decide(true);
  }

  private decide(solved: boolean): void {
    if (this.outcomeNow) return;
    const timeMs = Math.max(0, this.now() - this.startedAt);
    const playerMoves = Math.ceil(this.puzzle.solution.length / 2);
    this.outcomeNow = {
      solved,
      hintUsed: this.hintUsed,
      mistakes: this.mistakes,
      timeMs,
      grade: gradeAttempt({ solved, hintUsed: this.hintUsed, timeMs, playerMoves }),
    };
  }
}
