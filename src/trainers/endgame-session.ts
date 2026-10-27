import type { EndgamePositionEntry } from '../core/datasets';
import { RulesAdapter, type Color, type ExecutedMove, type MoveInput } from '../core/rules';
import { scoreToCentipawns, type UciScore } from '../engine/uci-parser';
import { endgameGoal, endgamePlayer, type EndgameGoal, type EndgameOutcome } from './endgames';

/** The engine must rate a converted position at least this good for the player (centipawns). */
export const DECISIVE_CP = 500;
/** A draw can be agreed after this many of the player's moves. */
export const HOLD_MIN_MOVES = 10;
/** The engine agrees to a draw while it sees no more than this much for itself (centipawns). */
export const DRAW_AGREE_CP = 30;
/** Win drills warn when the engine sees less than this for the player (centipawns)… */
export const WARN_BELOW_CP = 50;
/** …and hold drills when it sees the opponent ahead by more than this. */
export const WARN_HOLD_CP = 200;

export type EndgameHow =
  | 'checkmate'
  | 'mated'
  | 'stalemate'
  | 'repetition'
  | 'fifty-moves'
  | 'insufficient'
  | 'converted'
  | 'draw-agreed'
  | 'given-up';

export interface EndgameEnd {
  /** The target result (or better) was reached. */
  reached: boolean;
  result: '1-0' | '0-1' | '1/2-1/2' | '*';
  how: EndgameHow;
  /** One sentence for the player. */
  message: string;
}

export type PlayerMoveResult =
  | { kind: 'illegal' }
  | { kind: 'not-playing' }
  | { kind: 'ended'; move: ExecutedMove; end: EndgameEnd }
  /** `check` is true when the move promoted or took the opponent's last piece: ask the engine (judgeConversion). */
  | { kind: 'continue'; move: ExecutedMove; check: boolean };

export type OpponentMoveResult =
  | { kind: 'illegal' }
  | { kind: 'ended'; move: ExecutedMove; end: EndgameEnd }
  | { kind: 'continue'; move: ExecutedMove };

export type DrawOfferResult =
  | { kind: 'not-a-draw' }
  | { kind: 'too-early'; movesLeft: number }
  | { kind: 'declined' }
  | { kind: 'agreed'; end: EndgameEnd };

function toInput(uci: string): MoveInput | null {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
  return m ? { from: m[1]!, to: m[2]!, ...(m[3] ? { promotion: m[3] } : {}) } : null;
}

function hasOnlyKing(adapter: RulesAdapter, color: Color): boolean {
  for (const row of adapter.board()) {
    for (const cell of row) {
      if (cell && cell.color === color && cell.type !== 'k') return false;
    }
  }
  return true;
}

/**
 * One endgame drill: the player plays the side to move from the stored position against the
 * engine. The session knows the rules of the drill (what ends it, what counts as the target
 * result, how many moves the player has made); the engine's answers (the opponent's move, the
 * score that decides a conversion or a draw offer) are passed in by the caller.
 */
export class EndgameSession {
  public readonly player: Color;
  public readonly goal: EndgameGoal;
  private readonly adapter: RulesAdapter;
  private playerMoves = 0;
  private hints = 0;
  private endNow: EndgameEnd | null = null;

  constructor(public readonly entry: EndgamePositionEntry) {
    this.player = endgamePlayer(entry);
    this.goal = endgameGoal(entry);
    this.adapter = new RulesAdapter(entry.fen);
  }

  public get fen(): string {
    return this.adapter.fen();
  }

  public get turn(): Color {
    return this.adapter.turn();
  }

  /** The player's moves so far. */
  public get moves(): number {
    return this.playerMoves;
  }

  public get hintsUsed(): number {
    return this.hints;
  }

  public get end(): EndgameEnd | null {
    return this.endNow;
  }

  public get over(): boolean {
    return this.endNow !== null;
  }

  public get outcome(): EndgameOutcome {
    return { reached: this.endNow?.reached ?? false, moves: this.playerMoves, hintsUsed: this.hints };
  }

  public useHint(): void {
    this.hints++;
  }

  public playerMove(input: MoveInput): PlayerMoveResult {
    if (this.over || this.adapter.turn() !== this.player) return { kind: 'not-playing' };
    let move: ExecutedMove;
    try {
      move = this.adapter.move(input);
    } catch {
      return { kind: 'illegal' };
    }
    this.playerMoves++;
    const end = this.ruleEnd(move.color);
    if (end) return { kind: 'ended', move, end };
    const opponent: Color = this.player === 'w' ? 'b' : 'w';
    return {
      kind: 'continue',
      move,
      check: this.goal === 'convert' && (move.isPromotion || (move.isCapture && hasOnlyKing(this.adapter, opponent))),
    };
  }

  public opponentMove(uci: string): OpponentMoveResult {
    const input = toInput(uci);
    if (!input || this.over || this.adapter.turn() === this.player) return { kind: 'illegal' };
    let move: ExecutedMove;
    try {
      move = this.adapter.move(input);
    } catch {
      return { kind: 'illegal' };
    }
    const end = this.ruleEnd(move.color);
    return end ? { kind: 'ended', move, end } : { kind: 'continue', move };
  }

  /**
   * After a move that promoted or won the last piece (`check` of a player move): the drill is
   * won when the engine rates the position at least `DECISIVE_CP` for the player. `score` is
   * the player's score (positive: the player is better).
   */
  public judgeConversion(score: UciScore | null): EndgameEnd | null {
    if (this.over || this.goal !== 'convert' || !score) return null;
    if (scoreToCentipawns(score) < DECISIVE_CP) return null;
    return this.finish({
      reached: true,
      result: this.winResult(),
      how: 'converted',
      message: 'The win is decided: the engine sees no way back.',
    });
  }

  /** The player offers a draw (hold drills only). `score` is the player's score. */
  public offerDraw(score: UciScore | null): DrawOfferResult {
    if (this.over || this.goal !== 'hold') return { kind: 'not-a-draw' };
    if (this.playerMoves < HOLD_MIN_MOVES) return { kind: 'too-early', movesLeft: HOLD_MIN_MOVES - this.playerMoves };
    if (!score || scoreToCentipawns(score) < -DRAW_AGREE_CP) return { kind: 'declined' };
    const end = this.finish({
      reached: true,
      result: '1/2-1/2',
      how: 'draw-agreed',
      message: 'Draw agreed: the engine found nothing better than equality.',
    });
    return { kind: 'agreed', end };
  }

  public giveUp(): EndgameEnd {
    return (
      this.endNow ??
      this.finish({
        reached: false,
        result: '*',
        how: 'given-up',
        message: 'Given up. The position is yours to try again.',
      })
    );
  }

  /**
   * Whether the engine's score for the player says the target is slipping: a win that is down to
   * equality, or a draw that is going wrong. A hint to the player, not an end of the drill.
   */
  public slipping(score: UciScore | null): boolean {
    if (!score) return false;
    const cp = scoreToCentipawns(score);
    return this.goal === 'hold' ? cp < -WARN_HOLD_CP : cp < WARN_BELOW_CP;
  }

  private winResult(): '1-0' | '0-1' {
    return this.player === 'w' ? '1-0' : '0-1';
  }

  private finish(end: EndgameEnd): EndgameEnd {
    this.endNow = end;
    return end;
  }

  /** The end the rules give after `mover` just moved, or null. */
  private ruleEnd(mover: Color): EndgameEnd | null {
    const a = this.adapter;
    if (a.isCheckmate()) {
      const playerMated = mover !== this.player;
      return this.finish(
        playerMated
          ? {
              reached: false,
              result: this.player === 'w' ? '0-1' : '1-0',
              how: 'mated',
              message: 'Checkmate: you were mated.',
            }
          : { reached: true, result: this.winResult(), how: 'checkmate', message: 'Checkmate!' },
      );
    }
    const draw = (how: EndgameHow, why: string): EndgameEnd => {
      const reached = this.goal === 'hold';
      return this.finish({
        reached,
        result: '1/2-1/2',
        how,
        message: reached ? `Drawn by ${why}: the draw is held.` : `Drawn by ${why}: the win got away.`,
      });
    };
    if (a.isStalemate()) return draw('stalemate', 'stalemate');
    if (a.isInsufficientMaterial()) return draw('insufficient', 'insufficient material');
    if (a.isThreefoldRepetition()) return draw('repetition', 'repetition');
    if (a.isDrawByFiftyMoves()) return draw('fifty-moves', 'the 50-move rule');
    return null;
  }
}
