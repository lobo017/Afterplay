import { parsePgn } from '../core/pgn';
import { DEFAULT_POSITION, RulesAdapter, type Color } from '../core/rules';
import type { StoredGameRecord } from '../storage/db';
import type { BotEngineParams, BotMoveDecision } from './bot';
import type { EngineLine } from './cache';
import type { UciScore } from './uci-parser';

/**
 * Personal opening books for the bot ("plays like me"): built from a user's stored games, looked up before any engine call.
 *
 * Everything here is pure: no storage, no engine, no clock. A book is plain data (position key to a list of moves with
 * counts), so the gift's books can be precomputed offline in Node and embedded in a preset, and the same code builds a
 * book on the device for any other user. The storage helpers live apart (bot-profile-store.ts).
 *
 * Plies: `ply` is the number of half-moves already played before a move, so White's first move is ply 0. A book holds
 * the positions at plies 0 .. pliesCap - 1. The key of a position is the first four FEN fields (placement, side to move,
 * castling, en passant), so transpositions merge and the move counters never matter. The moves recorded are in UCI
 * (`e2e4`, `e7e8q`), checked for legality again when the book is read.
 *
 * Privacy: a book holds hashes of nothing personal: positions, moves and counts only. No name, id, rating, date or game
 * text is stored or can be read back from it.
 */

export interface Book {
  v: 1;
  pliesCap: number;
  /** Position key (first four FEN fields) to its moves, most played first. */
  entries: Record<string, [uci: string, count: number][]>;
}

export const BOOK_VERSION = 1;
export const DEFAULT_PLIES_CAP = 36;
/** Positions before this ply are never pruned (the first six moves of each side). */
export const PRUNE_PROTECTED_PLIES = 12;
const MAX_PLIES_CAP = 200;

export interface BuildOptions {
  /** Whose moves go into the book: the user's own, or the moves played against the user. */
  side: 'own' | 'opponent';
  /** Only games this accepts are used (for example `peakWindow(...)`). */
  include?: (g: StoredGameRecord) => boolean;
  /** How many plies to record (default 36). */
  pliesCap?: number;
  /** Shorthand for a constant `minCountByPly`. When both are given, `minCountByPly` wins. */
  minCount?: number;
  /**
   * The least number of games a move needs at a position of this ply to stay in the book. Default: 1 before ply 20,
   * 2 from ply 20 on. A position that arose at several plies counts at the earliest.
   */
  minCountByPly?: (ply: number) => number;
  /** When the book has more moves than this, the least valuable are pruned (see `pruneOrder`). */
  maxEntries?: number;
  /**
   * Which colour is the user's in a game. Default: the record's stored `playerColor`. The stored value is NOT reliable
   * for a user with no username saved (see `ownColorOf`), so a caller that knows the user's accounts passes
   * `(g) => myColor(g, accounts)` (src/library/game-record.ts). A game this returns null for is skipped.
   */
  ownColor?: (g: StoredGameRecord) => Color | null;
}

export interface BuildStats {
  gamesUsed: number;
  /** Why games were left out, by reason: excluded, unknownColor, nonStandardStart, unparsable, noMoves. */
  skipped: Record<string, number>;
  /** Positions in the finished book. */
  positions: number;
  /** Moves (position, move pairs) in the finished book. */
  entries: number;
  /** Moves removed by `maxEntries`. */
  pruned: number;
  /** The same by the count the pruned move had, e.g. `{ "1": 4000, "2": 120 }` (absent when nothing was pruned). */
  prunedByCount?: Record<string, number>;
}

export interface BuildResult {
  book: Book;
  stats: BuildStats;
}

export function defaultMinCountByPly(ply: number): number {
  return ply < 20 ? 1 : 2;
}

/** The position key of a FEN: its first four fields. */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

const START_KEY = positionKey(DEFAULT_POSITION);
const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const KEY_PATTERN = /^\S+ [wb] \S+ \S+$/;

/**
 * The user's colour in a record, as far as the record alone can tell. `playerColor` is written as 'w' by the record
 * builder for every game that is not one the user played here or one a Chess.com sync or batch restore matched to a
 * username (game-record.ts `buildGameRecord`), and its type has no "unknown". A record cannot say that its 'w' is only
 * the default, so a caller with the user's accounts should pass `ownColor`. Anything but 'w' or 'b' is unknown.
 */
export function ownColorOf(g: StoredGameRecord, ownColor?: BuildOptions['ownColor']): Color | null {
  const color = ownColor ? ownColor(g) : g.playerColor;
  return color === 'w' || color === 'b' ? color : null;
}

// ------------------------------------------------------------------------------------------------ building

interface Resolved {
  side: 'own' | 'opponent';
  include?: (g: StoredGameRecord) => boolean;
  pliesCap: number;
  minCountByPly: (ply: number) => number;
  maxEntries?: number;
  ownColor?: BuildOptions['ownColor'];
}

function resolve(opts: BuildOptions): Resolved {
  const cap = opts.pliesCap ?? DEFAULT_PLIES_CAP;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_PLIES_CAP) {
    throw new RangeError(`pliesCap must be a whole number from 1 to ${MAX_PLIES_CAP}`);
  }
  const constant = opts.minCount;
  return {
    side: opts.side,
    ...(opts.include ? { include: opts.include } : {}),
    pliesCap: cap,
    minCountByPly: opts.minCountByPly ?? (constant !== undefined ? () => Math.max(1, constant) : defaultMinCountByPly),
    ...(opts.maxEntries !== undefined ? { maxEntries: opts.maxEntries } : {}),
    ...(opts.ownColor ? { ownColor: opts.ownColor } : {}),
  };
}

interface Accumulator {
  /** position key -> move -> games */
  counts: Map<string, Map<string, number>>;
  /** position key -> the earliest ply it was seen at */
  minPly: Map<string, number>;
  gamesUsed: number;
  skipped: Record<string, number>;
}

function newAccumulator(): Accumulator {
  return { counts: new Map(), minPly: new Map(), gamesUsed: 0, skipped: {} };
}

function skip(acc: Accumulator, reason: string): void {
  acc.skipped[reason] = (acc.skipped[reason] ?? 0) + 1;
}

function addGame(acc: Accumulator, g: StoredGameRecord, r: Resolved): void {
  if (r.include && !r.include(g)) return skip(acc, 'excluded');
  const own = ownColorOf(g, r.ownColor);
  if (!own) return skip(acc, 'unknownColor');
  let tree;
  try {
    tree = parsePgn(g.pgn);
  } catch {
    return skip(acc, 'unparsable');
  }
  const headers = tree.getHeaders();
  if (
    tree.isChess960() ||
    headers.FEN !== undefined ||
    headers.SetUp === '1' ||
    positionKey(tree.root.fen) !== START_KEY
  ) {
    return skip(acc, 'nonStandardStart');
  }
  const line = tree.getMainLine();
  if (line.length === 0) return skip(acc, 'noMoves');
  acc.gamesUsed++;
  const last = Math.min(line.length, r.pliesCap);
  for (let ply = 0; ply < last; ply++) {
    const node = line[ply]!;
    const mover: Color = ply % 2 === 0 ? 'w' : 'b';
    if ((mover === own) !== (r.side === 'own')) continue;
    const uci = node.uci.toLowerCase();
    if (!UCI_PATTERN.test(uci)) continue;
    const before = ply === 0 ? tree.root.fen : line[ply - 1]!.fen;
    const key = positionKey(before);
    let moves = acc.counts.get(key);
    if (!moves) {
      moves = new Map();
      acc.counts.set(key, moves);
    }
    moves.set(uci, (moves.get(uci) ?? 0) + 1);
    const seen = acc.minPly.get(key);
    if (seen === undefined || ply < seen) acc.minPly.set(key, ply);
  }
}

interface Candidate {
  key: string;
  uci: string;
  count: number;
  ply: number;
}

/**
 * The order moves are pruned in when a book is over `maxEntries`, first to go first: fewest games, then deepest ply, then
 * key and move (so the result is always the same). So: moves seen once, deepest first; then moves seen twice, deepest
 * first; then three times, and so on. Positions before ply 12 are never pruned.
 */
function pruneOrder(a: Candidate, b: Candidate): number {
  return (
    a.count - b.count ||
    b.ply - a.ply ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
    (a.uci < b.uci ? -1 : a.uci > b.uci ? 1 : 0)
  );
}

function finish(acc: Accumulator, r: Resolved): BuildResult {
  const kept: Candidate[] = [];
  for (const [key, moves] of acc.counts) {
    const ply = acc.minPly.get(key) ?? 0;
    const need = Math.max(1, r.minCountByPly(ply));
    for (const [uci, count] of moves) if (count >= need) kept.push({ key, uci, count, ply });
  }

  let pruned = 0;
  const prunedByCount: Record<string, number> = {};
  let survivors = kept;
  if (r.maxEntries !== undefined && kept.length > r.maxEntries) {
    const prunable = kept.filter((c) => c.ply >= PRUNE_PROTECTED_PLIES).sort(pruneOrder);
    const excess = kept.length - Math.max(0, r.maxEntries);
    const drop = new Set<Candidate>(prunable.slice(0, excess));
    for (const c of drop) prunedByCount[String(c.count)] = (prunedByCount[String(c.count)] ?? 0) + 1;
    pruned = drop.size;
    survivors = kept.filter((c) => !drop.has(c));
  }

  const byKey = new Map<string, [string, number][]>();
  for (const c of survivors) {
    let list = byKey.get(c.key);
    if (!list) {
      list = [];
      byKey.set(c.key, list);
    }
    list.push([c.uci, c.count]);
  }
  const entries: Book['entries'] = {};
  for (const key of [...byKey.keys()].sort()) {
    entries[key] = byKey.get(key)!.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  return {
    book: { v: BOOK_VERSION, pliesCap: r.pliesCap, entries },
    stats: {
      gamesUsed: acc.gamesUsed,
      skipped: { ...acc.skipped },
      positions: byKey.size,
      entries: survivors.length,
      pruned,
      ...(pruned > 0 ? { prunedByCount } : {}),
    },
  };
}

/** Builds a book from stored games (synchronously: use `buildBookAsync` on a page, so it can yield). */
export function buildBook(games: readonly StoredGameRecord[], opts: BuildOptions): BuildResult {
  const resolved = resolve(opts);
  const acc = newAccumulator();
  for (const g of games) addGame(acc, g, resolved);
  return finish(acc, resolved);
}

export interface AsyncBuildOptions {
  /** Games between yields (default 50). */
  chunk?: number;
  /** Lets other work run (default: a zero-delay timer). */
  yieldFn?: () => Promise<void>;
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The same result as `buildBook`, yielding every `chunk` games. */
export async function buildBookAsync(
  games: readonly StoredGameRecord[],
  opts: BuildOptions,
  { chunk = 50, yieldFn = defaultYield }: AsyncBuildOptions = {},
): Promise<BuildResult> {
  const resolved = resolve(opts);
  const acc = newAccumulator();
  const every = Math.max(1, Math.floor(chunk));
  for (let i = 0; i < games.length; i++) {
    addGame(acc, games[i]!, resolved);
    if ((i + 1) % every === 0) await yieldFn();
  }
  return finish(acc, resolved);
}

export interface PeakWindowOptions {
  /** How far below the peak a game's rating may be (default 100). */
  within?: number;
  /** Only games with exactly this PGN TimeControl count, for the peak and for the window (e.g. "600"). */
  timeControl?: string;
  /** As `BuildOptions.ownColor`. */
  ownColor?: BuildOptions['ownColor'];
}

/**
 * A predicate for `BuildOptions.include`: the games played within `within` rating points of the user's best rating.
 * The user's rating in a game is `whiteElo` when playing White, `blackElo` when playing Black; a game without it is
 * ignored (and is not in the window). The peak is the highest of those over `games`.
 *
 * Caveat: Chess.com ratings are per time class (bullet, blitz, rapid, daily), so a history that mixes classes mixes
 * scales and the "peak" belongs to whichever class is highest. Pass `timeControl` to restrict to one.
 */
export function peakWindow(
  games: readonly StoredGameRecord[],
  { within = 100, timeControl, ownColor }: PeakWindowOptions = {},
): (g: StoredGameRecord) => boolean {
  const ratingOf = (g: StoredGameRecord): number | null => {
    if (timeControl !== undefined && g.timeControl !== timeControl) return null;
    const color = ownColorOf(g, ownColor);
    if (!color) return null;
    const rating = color === 'w' ? g.whiteElo : g.blackElo;
    return typeof rating === 'number' && Number.isFinite(rating) && rating > 0 ? rating : null;
  };
  let peak = -Infinity;
  for (const g of games) {
    const rating = ratingOf(g);
    if (rating !== null && rating > peak) peak = rating;
  }
  if (peak === -Infinity) return () => false; // no rated game: no window
  return (g) => {
    const rating = ratingOf(g);
    return rating !== null && rating >= peak - within;
  };
}

// ------------------------------------------------------------------------------------------------ lookup

function legalUcis(fen: string): Set<string> | null {
  try {
    return new Set(new RulesAdapter(fen).verboseMoves().map((m) => m.uci.toLowerCase()));
  } catch {
    return null;
  }
}

/**
 * A move from the books for this position, or null. The books are tried in order (the caller chains them: for example
 * the peak book, then the all-games book); the first one that has a legal move for the position answers, and the later
 * ones are not read. A move is chosen with weight `count ** alpha` (alpha 1 by default; 0 makes every move equally
 * likely; below 1 flattens toward rarer lines). A recorded move that is not legal in this position counts as missing.
 * Exactly one `rng()` draw is used when a move is returned and none on a miss.
 */
export function lookupBook(
  books: Book | readonly Book[],
  fen: string,
  rng: () => number,
  opts: { alpha?: number } = {},
): string | null {
  const list: readonly Book[] = Array.isArray(books) ? (books as readonly Book[]) : [books as Book];
  const alpha = opts.alpha ?? 1;
  const key = positionKey(fen);
  let legal: Set<string> | null | undefined;
  for (const book of list) {
    const recorded = Object.hasOwn(book.entries, key) ? book.entries[key] : undefined;
    if (!recorded || recorded.length === 0) continue;
    if (legal === undefined) legal = legalUcis(fen);
    if (!legal) return null;
    const usable = recorded.filter(([uci]) => legal!.has(uci));
    if (usable.length === 0) continue;
    const weights = usable.map(([, count]) => Math.pow(Math.max(1, count), alpha));
    const total = weights.reduce((a, b) => a + b, 0);
    const point = Math.min(Math.max(rng(), 0), 0.999999999) * total;
    let cumulative = 0;
    for (let i = 0; i < usable.length; i++) {
      cumulative += weights[i]!;
      if (point < cumulative) return usable[i]![0];
    }
    return usable[usable.length - 1]![0];
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ storage form

/** The book as JSON text (keys sorted, so the same book is always the same text). */
export function serializeBook(book: Book): string {
  const entries: Book['entries'] = {};
  for (const key of Object.keys(book.entries).sort()) entries[key] = book.entries[key]!;
  return JSON.stringify({ v: book.v, pliesCap: book.pliesCap, entries });
}

/** A book from its JSON text, or null when the text is not a valid book (nothing is guessed or repaired). */
export function parseBook(json: string): Book | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const { v, pliesCap, entries } = data as Record<string, unknown>;
  if (v !== BOOK_VERSION) return null;
  if (typeof pliesCap !== 'number' || !Number.isInteger(pliesCap) || pliesCap < 1 || pliesCap > MAX_PLIES_CAP)
    return null;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return null;
  const out: Book['entries'] = {};
  for (const [key, list] of Object.entries(entries)) {
    if (!KEY_PATTERN.test(key) || !Array.isArray(list) || list.length === 0) return null;
    const moves: [string, number][] = [];
    for (const item of list) {
      if (!Array.isArray(item) || item.length !== 2) return null;
      const [uci, count] = item as [unknown, unknown];
      if (typeof uci !== 'string' || !UCI_PATTERN.test(uci)) return null;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null;
      moves.push([uci, count]);
    }
    out[key] = moves;
  }
  return { v: BOOK_VERSION, pliesCap, entries: out };
}

// ------------------------------------------------------------------------------------------------ coverage

export interface Coverage {
  games: number;
  /** How the playouts ended: the bot missed, the opponent missed first, or the bot book's pliesCap was reached. */
  outcomes: { botLeft: number; opponentLeft: number; capReached: number };
  /**
   * The ply at which the bot first had no move in its book, over the playouts where that happened (null when none did).
   * Playouts that ended another way are not in these numbers: read `outcomes` beside them.
   */
  botLeavesAtPly: { min: number; p10: number; median: number; p90: number } | null;
  /** Of ALL playouts, the share in which the bot left book before this ply. */
  shareLeavingBefore: { ply10: number; ply16: number; ply24: number };
  /** Different move sequences among the playouts (a playout's sequence runs to where it ended). */
  distinctSequences: number;
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

/**
 * Plays `botBook` against `opponentBook` from the start position, the bot as White in half of the games (the first, the
 * third, ...) and as Black in the other half, each side choosing through `lookupBook`. A playout ends when a side has no
 * move in its book or when the bot book's `pliesCap` is reached. Deterministic for a seeded `rng`.
 *
 * It measures how long a bot stays in book against a given opponent population: pass the opponent book built from the
 * moves of the people the user plays (or the user's own book, to see how it copes with games like his own).
 */
export function bookCoverage(
  botBook: Book,
  opponentBook: Book,
  opts: { games: number; rng: () => number; alpha?: number },
): Coverage {
  const total = Math.max(0, Math.floor(opts.games));
  const lookupOpts = opts.alpha === undefined ? {} : { alpha: opts.alpha };
  const leaves: number[] = [];
  const sequences = new Set<string>();
  const outcomes = { botLeft: 0, opponentLeft: 0, capReached: 0 };
  for (let game = 0; game < total; game++) {
    const botIsWhite = game % 2 === 0;
    const adapter = new RulesAdapter();
    const played: string[] = [];
    let ended = false;
    for (let ply = 0; ply < botBook.pliesCap; ply++) {
      const botToMove = (adapter.turn() === 'w') === botIsWhite;
      const uci = lookupBook(botToMove ? botBook : opponentBook, adapter.fen(), opts.rng, lookupOpts);
      if (uci === null) {
        if (botToMove) {
          outcomes.botLeft++;
          leaves.push(ply);
        } else {
          outcomes.opponentLeft++;
        }
        ended = true;
        break;
      }
      adapter.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length === 5 ? { promotion: uci[4] } : {}) });
      played.push(uci);
    }
    if (!ended) outcomes.capReached++;
    sequences.add(played.join(' '));
  }
  leaves.sort((a, b) => a - b);
  const before = (ply: number): number => (total === 0 ? 0 : leaves.filter((p) => p < ply).length / total);
  return {
    games: total,
    outcomes,
    botLeavesAtPly:
      leaves.length === 0
        ? null
        : {
            min: leaves[0]!,
            p10: percentile(leaves, 0.1),
            median: percentile(leaves, 0.5),
            p90: percentile(leaves, 0.9),
          },
    shareLeavingBefore: { ply10: before(10), ply16: before(16), ply24: before(24) },
    distinctSequences: sequences.size,
  };
}

// ------------------------------------------------------------------------------------------------ the bot's hook

export interface PersonalBots {
  /** Tried in order: pass the more specific book first (peak, then all games). */
  books: Book | Book[];
  alpha?: number;
}

/** A book move as the decision the bot returns: no engine ran, so there is no evaluation (see `bookLine`). */
export function personalBookDecision(
  fen: string,
  personal: PersonalBots,
  rng: () => number,
  params: BotEngineParams,
): BotMoveDecision | null {
  const uci = lookupBook(personal.books, fen, rng, personal.alpha === undefined ? {} : { alpha: personal.alpha });
  if (uci === null) return null;
  const executedMove = new RulesAdapter(fen).verboseMoves().find((m) => m.uci.toLowerCase() === uci);
  if (!executedMove) return null;
  const line = bookLine(uci);
  return {
    uci: executedMove.uci,
    san: executedMove.san,
    executedMove,
    selectedLine: line,
    candidates: [
      {
        uci: executedMove.uci,
        san: executedMove.san,
        multipv: 1,
        evalCp: 0,
        dropCp: 0,
        styleBonusCp: 0,
        weight: 1,
        probability: 1,
        line,
      },
    ],
    params,
    fromBook: true,
  };
}

/**
 * The evaluation a bot move gives the Play screen: the engine's score from White's side, or null for a book move (no
 * engine ran, so there is nothing to show and the shown evaluation stays as it was).
 */
export function decisionEvaluation(decision: BotMoveDecision): { scoreWhite: UciScore; whiteCp: number } | null {
  if (decision.fromBook) return null;
  return {
    scoreWhite: decision.selectedLine.scoreWhite,
    whiteCp: decision.selectedLine.evalCp * (decision.executedMove.color === 'w' ? 1 : -1),
  };
}

/**
 * The engine line a book move carries: depth 0, no nodes, score 0 cp, the move as its whole line. The 0 is a placeholder,
 * not an evaluation: a caller that shows the evaluation should check `BotMoveDecision.fromBook` and leave it alone.
 */
function bookLine(uci: string): EngineLine {
  const score = { type: 'cp', value: 0 } as const;
  return {
    multipv: 1,
    depth: 0,
    seldepth: 0,
    score,
    scoreWhite: score,
    evalCp: 0,
    nodes: 0,
    nps: 0,
    timeMs: 0,
    pv: [uci],
  };
}
