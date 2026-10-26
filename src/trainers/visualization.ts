import type { GameNode, GameTree } from '../core/game-tree';
import { RulesAdapter, type Color, type ExecutedMove, type PieceSymbol, type Square } from '../core/rules';
import type { Grade } from './fsrs';
import { sameMove } from './puzzle-format';

const FILES = 'abcdefgh';

export const ALL_SQUARES: readonly Square[] = Array.from({ length: 64 }, (_, i) => `${FILES[i % 8]}${Math.floor(i / 8) + 1}` as Square);

/** The target of each drill: its card in the `visualization` deck. */
export type VisualizationKind = 'coordinates' | 'blindfold' | 'guess';

export function visualizationCardTarget(kind: VisualizationKind, gameId?: string): string {
  return kind === 'guess' ? `guess:${gameId ?? ''}` : kind;
}

// ---------------------------------------------------------------------------- coordinates

/** A round lasts this long. */
export const COORDINATE_ROUND_MS = 30_000;

/** Clicking the square a name asks for, as many times as fit in the round. */
export class CoordinateRound {
  public correct = 0;
  public wrong = 0;
  private targetNow: Square;

  constructor(private readonly random: () => number = Math.random) {
    this.targetNow = this.pick(null);
  }

  public get target(): Square {
    return this.targetNow;
  }

  private pick(not: Square | null): Square {
    for (;;) {
      const sq = ALL_SQUARES[Math.floor(this.random() * 64)]!;
      if (sq !== not) return sq;
    }
  }

  /** Whether the clicked square was the target; either way the round goes on to a new one. */
  public answer(square: Square): boolean {
    const ok = square === this.targetNow;
    if (ok) this.correct++;
    else this.wrong++;
    this.targetNow = this.pick(this.targetNow);
    return ok;
  }

  public get accuracy(): number {
    const n = this.correct + this.wrong;
    return n === 0 ? 0 : this.correct / n;
  }
}

/** Again below 10 right or 60%, Hard to 20 right and 80%, Good to 35 and 90%, Easy from there. */
export function gradeCoordinates(r: { correct: number; wrong: number }): Grade {
  const n = r.correct + r.wrong;
  const accuracy = n === 0 ? 0 : r.correct / n;
  if (r.correct >= 35 && accuracy >= 0.9) return 4;
  if (r.correct >= 20 && accuracy >= 0.8) return 3;
  if (r.correct >= 10 && accuracy >= 0.6) return 2;
  return 1;
}

// ---------------------------------------------------------------------------- blindfold

export const BLINDFOLD_MIN_PLIES = 4;
export const BLINDFOLD_MAX_PLIES = 60;
export const BLINDFOLD_START_PLIES = 8;
export const BLINDFOLD_QUESTIONS = 5;

const PIECE_NAME: Record<PieceSymbol, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const COLOR_NAME: Record<Color, string> = { w: 'white', b: 'black' };

export function pieceName(piece: PieceSymbol): string {
  return PIECE_NAME[piece];
}

export interface BlindfoldMove {
  san: string;
  uci: string;
  color: Color;
  /** "Knight to f3", "Bishop takes on c6", "Castles kingside". */
  spoken: string;
}

export interface BlindfoldQuestion {
  color: Color;
  piece: PieceSymbol;
  /** Every square holding that piece (two knights: either is right). */
  squares: Square[];
  text: string;
}

export interface BlindfoldDrill {
  label: string;
  moves: BlindfoldMove[];
  questions: BlindfoldQuestion[];
  finalFen: string;
}

/** A line to read out: SAN or UCI moves from the start position. */
export interface SequenceSource {
  label: string;
  moves: readonly string[];
}

function spoken(move: ExecutedMove): string {
  if (move.isKingsideCastle) return 'Castles kingside';
  if (move.isQueensideCastle) return 'Castles queenside';
  const name = PIECE_NAME[move.piece][0]!.toUpperCase() + PIECE_NAME[move.piece].slice(1);
  const promo = move.promotion ? `, promotes to ${PIECE_NAME[move.promotion]}` : '';
  return `${name} ${move.isCapture ? 'takes on' : 'to'} ${move.to}${promo}`;
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * A blindfold drill: the first `plies` moves of a line, read out one at a time with the
 * board hidden, then questions about where pieces stand ("Where is the black queen?").
 * Pieces that moved in the line are asked about first.
 */
export function buildBlindfoldDrill(
  source: SequenceSource,
  plies: number,
  random: () => number = Math.random,
  questionCount: number = BLINDFOLD_QUESTIONS,
): BlindfoldDrill {
  const adapter = new RulesAdapter();
  const moves: BlindfoldMove[] = [];
  const moved = new Set<string>();
  for (const raw of source.moves.slice(0, plies)) {
    const m = adapter.move(raw);
    moves.push({ san: m.san, uci: m.uci, color: m.color, spoken: spoken(m) });
    moved.add(`${m.color}${m.piece}`);
  }
  const groups = new Map<string, BlindfoldQuestion>();
  for (const row of adapter.board()) {
    for (const cell of row) {
      if (!cell || cell.type === 'p') continue;
      const key = `${cell.color}${cell.type}`;
      const group = groups.get(key);
      if (group) group.squares.push(cell.square);
      else {
        groups.set(key, {
          color: cell.color,
          piece: cell.type,
          squares: [cell.square],
          text: `Where is the ${COLOR_NAME[cell.color]} ${PIECE_NAME[cell.type]}?`,
        });
      }
    }
  }
  const all = [...groups.entries()];
  const first = shuffled(all.filter(([k]) => moved.has(k)), random);
  const rest = shuffled(all.filter(([k]) => !moved.has(k)), random);
  const questions = [...first, ...rest].slice(0, questionCount).map(([, q]) => q);
  return { label: source.label, moves, questions, finalFen: adapter.fen() };
}

/** All right is Good, one miss is Hard, more is Again. */
export function gradeBlindfold(r: { correct: number; total: number }): Grade {
  if (r.total === 0 || r.correct === r.total) return r.total === 0 ? 1 : 3;
  return r.total - r.correct === 1 ? 2 : 1;
}

/** The next level: two more plies after a perfect drill, two fewer after missing more than one. */
export function nextBlindfoldLevel(plies: number, r: { correct: number; total: number }): number {
  const missed = r.total - r.correct;
  const next = missed === 0 ? plies + 2 : missed >= 2 ? plies - 2 : plies;
  return Math.min(BLINDFOLD_MAX_PLIES, Math.max(BLINDFOLD_MIN_PLIES, next));
}

/** Lines to read out from: opening lines (SAN) that are long enough, picked at random, plus any extra lines. */
export function pickBlindfoldSource(
  lines: readonly SequenceSource[],
  plies: number,
  random: () => number = Math.random,
): SequenceSource | null {
  const fit = lines.filter((l) => l.moves.length >= plies);
  if (fit.length === 0) return null;
  return fit[Math.floor(random() * fit.length)]!;
}

// ---------------------------------------------------------------------------- guess the move

/** Positions to ask per game. */
export const GUESS_MAX_POSITIONS = 10;

export interface GuessPosition {
  ply: number;
  nodeId: string;
  /** The position before my move. */
  fen: string;
  /** The move I played. */
  uci: string;
  san: string;
  /** "12.Nf3" / "12...Nf6". */
  label: string;
  /** The review's best move for the position, when the game was reviewed. */
  bestUci: string | null;
}

/**
 * The positions of my game to guess: my moves, leaving out the first few (the opening is
 * played from memory), forced moves, and keeping at most `max`, spread over the game.
 */
export function guessPositions(
  game: GameTree,
  color: Color,
  bestMoves: ReadonlyMap<number, string> = new Map(),
  max: number = GUESS_MAX_POSITIONS,
): GuessPosition[] {
  const all: GuessPosition[] = [];
  let before = game.root;
  for (const node of game.getMainLine()) {
    if (node.moveColor === color) {
      let legal = 2;
      try {
        legal = new RulesAdapter(before.fen).sanMoves().length;
      } catch {
        legal = 2;
      }
      if (legal > 1) all.push(toGuessPosition(before, node, bestMoves.get(node.ply) ?? null));
    }
    before = node;
  }
  const skip = all.length >= 8 ? 3 : all.length >= 4 ? 1 : 0;
  const pool = all.slice(skip);
  if (pool.length <= max) return pool;
  // Evenly spread, always including the first and the last
  return Array.from({ length: max }, (_, i) => pool[Math.round((i * (pool.length - 1)) / (max - 1))]!);
}

function toGuessPosition(before: GameNode, node: GameNode, bestUci: string | null): GuessPosition {
  return {
    ply: node.ply,
    nodeId: node.id,
    fen: before.fen,
    uci: node.uci,
    san: node.san,
    label: `${node.moveNumber}${node.moveColor === 'b' ? '...' : '.'}${node.san}`,
    bestUci,
  };
}

export type GuessVerdict = 'played' | 'best' | 'other';

/** My guess against the move I played, and against the review's best move when there is one. */
export function judgeGuess(position: GuessPosition, uci: string): GuessVerdict {
  if (sameMove(position.fen, position.uci, uci)) return 'played';
  if (position.bestUci && sameMove(position.fen, position.bestUci, uci)) return 'best';
  return 'other';
}

/** Good from 70% of the guesses matching (the move played or the review's best), Hard from 40%. */
export function gradeGuess(r: { hits: number; total: number }): Grade {
  if (r.total === 0) return 1;
  const share = r.hits / r.total;
  if (share >= 0.7) return 3;
  return share >= 0.4 ? 2 : 1;
}
