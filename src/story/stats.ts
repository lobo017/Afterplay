/**
 * The numbers behind the Chess Story, computed from stored game records. Pure: no storage, no network, no clock
 * (the caller passes `now`). `StoryStats` holds no player or opponent name, so nothing built from it (a card, a
 * cache, a shared image) can carry one.
 */
import type { UserAccount } from '../review/perspective';
import type { StoredGameRecord } from '../storage/db';
import { readPgnHeaders } from '../capture/pgn-time';
import { myColor, resultFor } from '../library/game-record';
import { PHASES, openingFamily, type GamePhase } from '../library/insights';
import { readReviewNumbers, type ReviewNumbers } from '../library/review-numbers';
import type { Color } from '../core/rules';
import { totalPhases } from '../review/phase-numbers';

// ---------------------------------------------------------------------------- constants

/** A time class follows base + INCREMENT_WEIGHT × increment, in seconds (the New game card's labels). */
export const INCREMENT_WEIGHT = 40;
/** Bullet is under this many seconds. */
export const BULLET_BELOW_SECONDS = 180;
/** Blitz is under this many seconds. */
export const BLITZ_BELOW_SECONDS = 600;
/** Rapid is under this many seconds; classical starts here. */
export const RAPID_BELOW_SECONDS = 1500;

/** A class percentage is shown from this many games in the class. */
export const MIN_CLASS_GAMES_FOR_PERCENT = 10;
/** An opening is listed from this many games (per colour). */
export const MIN_OPENING_GAMES = 5;
/** Openings listed per colour. */
export const TOP_OPENINGS = 3;
/** Streaks are shown from this many dated, finished games. */
export const MIN_GAMES_FOR_STREAKS = 20;
/** Most cards besides the intro, totals and best win need this many counted games. */
export const MIN_GAMES_FOR_STORY = 20;
/** A game is the same on both sites only from this many plies. */
export const MIN_PLIES_FOR_DUPLICATE = 20;
/** Exact time controls kept per scope. */
export const TOP_CONTROLS = 3;
/** A rating journey is told for a site and class from this many rated games. */
export const MIN_JOURNEY_GAMES = 10;
/** A win from under this chance (win%, my side) is a comeback. */
export const COMEBACK_BELOW = 5;
/** A live game that seems to last longer than this is a clock or header error and adds no time at the board. */
export const MAX_LIVE_GAME_SECONDS = 12 * 3600;

/** The review cards need this many reviewed games (the same number halves the games by date). */
export const MIN_REVIEWED_GAMES = 20;
/** A review row or note (a class, a colour, wins or losses, a year) needs this many reviewed games. */
export const MIN_REVIEWED_ROW = 10;
/** "Most accurate game" is chosen among games with at least this many of my moves. */
export const MIN_MOVES_FOR_BEST_GAME = 25;

export const STATS_VERSION = 4;

export type StoryScope = 'all' | 'chesscom' | 'lichess';
export type StorySite = 'chesscom' | 'lichess';
export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'daily';
export const TIME_CLASSES: readonly TimeClass[] = ['bullet', 'blitz', 'rapid', 'classical', 'daily'];

// ---------------------------------------------------------------------------- types

export interface Wld {
  games: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface ClassStats extends Wld {
  timeClass: TimeClass;
  /** True from MIN_CLASS_GAMES_FOR_PERCENT games: a percentage may be shown. */
  showPercent: boolean;
}

export interface OpeningStats extends Wld {
  /** The opening family, e.g. "Sicilian Defense". */
  name: string;
  /** The most-played named variation of the family ("Alapin Variation"), or null when no game has one. */
  topVariation: { name: string; games: number } | null;
}

/** How a game ended, in a small fixed set read the same way for both sites. */
export type EndKind =
  'checkmate' | 'resignation' | 'time' | 'left' | 'repetition' | 'insufficient' | 'agreement' | 'stalemate' | 'other';
export const END_KINDS: readonly EndKind[] = [
  'checkmate',
  'resignation',
  'time',
  'left',
  'repetition',
  'insufficient',
  'agreement',
  'stalemate',
  'other',
];
export type EndCounts = Record<EndKind, number>;
/** Counts of each ending, for my wins, losses and draws. */
export interface Endings {
  win: EndCounts;
  loss: EndCounts;
  draw: EndCounts;
}

/** An exact time control ("10 min", "15+10", "1 day") with its class. */
export interface ControlStats {
  /** The PGN TimeControl as stored ("600", "900+10", "1/86400"). */
  control: string;
  label: string;
  timeClass: TimeClass | null;
  games: number;
}

export interface JourneyPoint {
  rating: number;
  /** "2025-09" (UTC). */
  month: string;
}

/** My rating in one site and class: the first rated game, the peak (its first month) and the latest. */
export interface JourneySeries {
  site: StorySite;
  timeClass: TimeClass;
  ratedGames: number;
  first: JourneyPoint;
  peak: JourneyPoint;
  latest: JourneyPoint;
}

/** What a long game says about itself: no id, name or link. */
export interface LongGame {
  /** Moves of the whole game: ceil(plies / 2). */
  moves: number;
  playedAt: number | null;
  timeClass: TimeClass | null;
  outcome: 'win' | 'loss' | 'draw';
  ending: EndKind;
}

export interface Records {
  /** Reviewed games the longest game was chosen from (the stored plies come from the review). */
  games: number;
  longest: LongGame;
  longestWin: LongGame | null;
}

/** Hours and days at the board, from the game dates and the UTC clocks of the live games. */
export interface Activity {
  /** Games with a date. */
  datedGames: number;
  /** Seconds of the live games that have both a start and an end time (daily games are left out). */
  liveSeconds: number;
  timedGames: number;
  /** Different UTC days with a game. */
  days: number;
  /** The most days in a row with a game. */
  longestRun: number;
  busiestDay: { day: string; games: number } | null;
  busiestMonth: { month: string; games: number } | null;
  busiestYear: { year: number; games: number } | null;
}

export interface Upset {
  /** Opponent rating minus mine. */
  points: number;
  opponentRating: number;
  myRating: number;
  timeClass: TimeClass | null;
  playedAt: number | null;
}

export interface BestWin {
  opponentRating: number;
  /** My rating in that game, when the game has it. */
  myRating: number | null;
  /** ms since the epoch (UTC), or null when the game has no date. */
  playedAt: number | null;
  timeClass: TimeClass | null;
  opening: string;
  /** The stored game's id, for "Open this game". */
  gameId: string;
}

export interface Streaks {
  /** Dated, finished games the streaks were counted over. */
  datedGames: number;
  /** False below MIN_GAMES_FOR_STREAKS. */
  enough: boolean;
  longestWin: number;
  longestLoss: number;
  /** Games in a row without a loss (wins and draws). */
  longestUnbeaten: number;
}

export interface AccuracyGroup {
  games: number;
  /** Mean of the game accuracies, 0–100. */
  accuracy: number;
}

export interface ReviewClassRow extends AccuracyGroup {
  timeClass: TimeClass;
}

export interface ReviewYearRow extends AccuracyGroup {
  /** Calendar year (UTC). */
  year: number;
  blundersPerGame: number;
}

export interface ReviewHalf extends AccuracyGroup {
  blundersPerGame: number;
}

/** What a picked game says about itself; it holds no id, name or link. */
export interface ReviewedGameRef {
  playedAt: number | null;
  timeClass: TimeClass | null;
  outcome: 'win' | 'loss' | 'draw';
  opponentRating: number | null;
  source: ReviewNumbers['source'];
  depth: number | null;
  preset: ReviewNumbers['preset'];
}

/** My moves in one phase of the game, over the counted reviewed games that have phase numbers. */
export interface PhaseStat {
  phase: GamePhase;
  moves: number;
  /** Mean accuracy of the moves (each game weighted by its moves); null with no moves. */
  accuracy: number | null;
  blunders: number;
  mistakes: number;
  misses: number;
  /** Blunders per 10 moves; null with no moves. */
  blundersPer10: number | null;
  /** Games with at least one move in the phase (for the endgame: the games that reached one). */
  games: number;
}

export interface ReviewStats {
  /** Counted games in the scope (the denominator of "X of Y counted games have an engine review"). */
  counted: number;
  reviewed: number;
  inAdvance: number;
  onDevice: number;
  /** MIN_REVIEWED_GAMES reviewed games: the review cards are made. */
  enough: boolean;
  /** Mean of the game accuracies; null with no reviewed game. */
  accuracy: number | null;
  /** Means per reviewed game; null with no reviewed game. */
  perGame: { blunder: number; mistake: number; inaccuracy: number; moves: number } | null;
  /** Totals over the reviewed games. */
  brilliant: number;
  great: number;
  /** Classes with at least MIN_REVIEWED_ROW reviewed games, in the fixed class order. */
  byClass: ReviewClassRow[];
  /** A group is null below MIN_REVIEWED_ROW reviewed games. */
  white: AccuracyGroup | null;
  black: AccuracyGroup | null;
  wins: AccuracyGroup | null;
  losses: AccuracyGroup | null;
  /** The dated reviewed games split at the median date; null below MIN_REVIEWED_GAMES dated games. */
  halves: { first: ReviewHalf & { endMonth: string }; second: ReviewHalf } | null;
  /** Years with at least MIN_REVIEWED_ROW reviewed games, oldest first. */
  byYear: ReviewYearRow[];
  /** The games that have at least one Brilliant (or Great) move. */
  brilliantGames: number;
  greatGames: number;
  /**
   * `count` is the wins from under COMEBACK_BELOW%. `game` is the most unlikely reviewed win: the one in which my win%
   * was lowest (ties: the highest opponent rating, then the latest game). `reviewedWins` is the pool it was chosen from (reviewed wins that have a
   * lowest win%); `alsoLow` is how many other wins share that lowest value.
   */
  comebacks: { count: number; game: ReviewedGameRef & { low: number }; reviewedWins: number; alsoLow: number } | null;
  /**
   * By phase (opening, middlegame, endgame), over the reviewed games that have phase numbers; `games` is how many
   * those are. Null when no counted game has them.
   */
  phases: { games: number; items: PhaseStat[] } | null;
  /** The most accurate reviewed game of at least MIN_MOVES_FOR_BEST_GAME of my moves (ties: the earliest). */
  bestGame: { game: ReviewedGameRef & { accuracy: number; moves: number }; eligible: number } | null;
}

export interface ScopeStats extends Wld {
  scope: StoryScope;
  /** Games with a time control that fits no class (none, "-", unreadable). They count in the totals only. */
  unclassified: number;
  byClass: ClassStats[];
  /** The class (or classes, on a tie) with the most games; empty when no game has a class. */
  favouriteClasses: TimeClass[];
  white: Wld;
  black: Wld;
  /** False below MIN_GAMES_FOR_STORY. */
  enough: boolean;
  streaks: Streaks;
  openings: { white: OpeningStats[]; black: OpeningStats[]; withoutOpening: number };
  bestWin: BestWin | null;
  /** The win against the biggest rating gap (opponent above me); null when no win was against a higher rating. */
  upset: Upset | null;
  /** Wins against an opponent rated above me. */
  higherRatedWins: number;
  /** How my games ended. */
  endings: Endings;
  /** The most-played exact time controls, most played first (at most TOP_CONTROLS). */
  controls: ControlStats[];
  /** One series per site and class (the sites are never combined), in site then class order. */
  journeys: JourneySeries[];
  /** Longest game and longest win, from the stored plies; null with no reviewed game. */
  records: Records | null;
  activity: Activity;
  /** First and last game, ms since the epoch (UTC), or null. */
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
  /** The engine-review numbers of the games in the scope. */
  review: ReviewStats;
}

export interface ExcludedCounts {
  /** Stored games that were not counted, for any reason. */
  total: number;
  /** Pasted games, games played here against the bot, and games with no known source. */
  pastedOrBot: number;
  /** Site games where none of my accounts is a player (or both are). */
  notMine: number;
  /** Chess960, set-up positions and other variants. */
  nonStandard: number;
  /** Not finished. */
  unfinished: number;
}

export interface StoryStats {
  version: typeof STATS_VERSION;
  /** Stored games read. */
  storedGames: number;
  excluded: ExcludedCounts;
  /** Games on both sites, counted once in `all`. games(all) = games(chesscom) + games(lichess) − onBothSites. */
  onBothSites: number;
  all: ScopeStats;
  chesscom: ScopeStats;
  lichess: ScopeStats;
}

// ---------------------------------------------------------------------------- time classes

/** "180+2" → 260; "600" → 600; null for "1/86400" (daily), "-" or text. */
export function effectiveSeconds(timeControl: string | undefined): number | null {
  const m = /^\s*(\d+)(?:\+(\d+))?\s*$/.exec(timeControl ?? '');
  if (!m) return null;
  return Number(m[1]) + INCREMENT_WEIGHT * Number(m[2] ?? 0);
}

export function classOfSeconds(seconds: number): TimeClass {
  if (seconds < BULLET_BELOW_SECONDS) return 'bullet';
  if (seconds < BLITZ_BELOW_SECONDS) return 'blitz';
  if (seconds < RAPID_BELOW_SECONDS) return 'rapid';
  return 'classical';
}

/** The time class of a PGN TimeControl, or null when it fits none. */
export function timeClassOf(timeControl: string | undefined): TimeClass | null {
  const tc = (timeControl ?? '').trim();
  if (/^1\/\d+$/.test(tc)) return 'daily';
  const seconds = effectiveSeconds(tc);
  return seconds === null ? null : classOfSeconds(seconds);
}

// ---------------------------------------------------------------------------- reading a record

const FINISHED = new Set(['1-0', '0-1', '1/2-1/2']);

/** A counted game: mine, finished, standard, from a site. */
interface CountedGame {
  id: string;
  site: StorySite;
  color: Color;
  outcome: 'win' | 'loss' | 'draw';
  timeClass: TimeClass | null;
  playedAt: number | null;
  /** The UTC day ("2026-03-14") of the game, or '' when it has no date. */
  day: string;
  opponentRating: number | null;
  myRating: number | null;
  opening: string;
  /** The named variation of the opening ("Alapin Variation"), or '' when the name has none. */
  variation: string;
  /** The exact time control as stored ("600", "900+10", "1/86400"), or null when it cannot be read. */
  control: string | null;
  ending: EndKind;
  /** Seconds from the start to the end clock of a live game, or null. */
  liveSeconds: number | null;
  /**
   * Duplicate key between sites, or null when the game is too short or undated. Built on the first call, not when the
   * game is read: it tokenises the whole game, which is the costly part, and nothing needs it unless games from both
   * sites are counted (`countGames`).
   */
  duplicateKey: () => string | null;
  /** My engine-review numbers, or null when the game has none that can be used. */
  review: ReviewNumbers | null;
}

function isStandard(headers: Readonly<Record<string, string>>): boolean {
  const variant = (headers.Variant ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (variant !== '' && variant !== 'standard' && variant !== 'chess') return false;
  if ('FEN' in headers) return false;
  if ((headers.SetUp ?? '').trim() === '1') return false;
  return true;
}

/** "Sicilian Defense: Alapin Variation, Smith-Morra" → "Alapin Variation"; no ":" → ''. */
export function variationOf(openingName: string): string {
  const at = openingName.indexOf(':');
  return at < 0
    ? ''
    : openingName
        .slice(at + 1)
        .split(',')[0]!
        .trim();
}

/** The PGN TimeControl as one comparable key, or null when it is not a live or daily control. */
export function controlKey(timeControl: string | undefined): string | null {
  const tc = (timeControl ?? '').trim();
  return /^\d+(\+\d+)?$/.test(tc) || /^1\/\d+$/.test(tc) ? tc : null;
}

/** "600" → "10 min", "900+10" → "15+10", "30" → "30 sec", "90" → "90 sec", "1/86400" → "1 day". */
export function controlLabel(control: string): string {
  const daily = /^1\/(\d+)$/.exec(control);
  if (daily) {
    const days = Math.max(1, Math.round(Number(daily[1]) / 86400));
    return days === 1 ? '1 day' : `${days} days`;
  }
  const [baseText, incText] = control.split('+');
  const base = Number(baseText);
  const whole = base % 60 === 0;
  if (incText === undefined || Number(incText) === 0) return whole ? `${base / 60} min` : `${base} sec`;
  return `${whole ? base / 60 : `${base} sec`}+${incText}`;
}

const MATE_AT_END = /[A-Za-z0-9=]\+?#(?:\s*\{[^}]*\})?\s*(?:1-0|0-1|1\/2-1\/2|\*)?\s*$/;

/**
 * How the game ended, from the result (outcome) and the ending words of the `Termination` header, never from a name:
 * Chess.com writes "<name> won by resignation" or "Game drawn by repetition", Lichess "Normal", "Time forfeit" or
 * "Abandoned". A header with no usable ending falls back to the last move: a mate sign is a checkmate.
 */
export function endingOf(termination: string | undefined, pgn: string, outcome: CountedGame['outcome']): EndKind {
  const t = (termination ?? '').trim().toLowerCase();
  const mate = (): boolean => MATE_AT_END.test(pgn.slice(-400));
  let kind: EndKind | null = null;
  if (/timeout vs insufficient material$/.test(t)) kind = 'other';
  else if (/by checkmate$/.test(t)) kind = 'checkmate';
  else if (/by resignation$/.test(t)) kind = 'resignation';
  else if (/on time$/.test(t) || t === 'time forfeit') kind = 'time';
  else if (/abandoned$/.test(t)) kind = 'left';
  else if (/by repetition$/.test(t)) kind = 'repetition';
  else if (/by insufficient material$/.test(t)) kind = 'insufficient';
  else if (/by agreement$/.test(t)) kind = 'agreement';
  else if (/by stalemate$/.test(t)) kind = 'stalemate';
  else if (t === 'normal') kind = outcome === 'draw' ? 'other' : mate() ? 'checkmate' : 'resignation';
  if (kind === null) return outcome !== 'draw' && mate() ? 'checkmate' : 'other';
  const decisive: EndKind[] = ['checkmate', 'resignation', 'time', 'left'];
  const drawn: EndKind[] = ['repetition', 'insufficient', 'agreement', 'stalemate'];
  // A win with a draw's ending (or the other way round) is a game the header and the result disagree on
  if (outcome === 'draw' ? decisive.includes(kind) : drawn.includes(kind)) return 'other';
  return kind;
}

/** A "YYYY.MM.DD" date and a "HH:MM:SS" clock as ms since the epoch, or null. Plain slicing: it runs for every game. */
function clockMs(date: string | undefined, time: string | undefined): number | null {
  if (date === undefined || time === undefined || date.length !== 10 || time.length < 7 || time.length > 8) return null;
  const parts = time.split(':');
  if (parts.length !== 3) return null;
  const ms = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    Number(parts[0]),
    Number(parts[1]),
    Number(parts[2]),
  );
  return Number.isFinite(ms) ? ms : null;
}

/** The length of a live game from the PGN's UTC start and end clocks, or null (daily games, no clocks, nonsense). */
function liveSecondsOf(headers: Readonly<Record<string, string>>, control: string | null): number | null {
  if (control === null || control.startsWith('1/')) return null;
  const start = clockMs(headers.UTCDate ?? headers.Date, headers.UTCTime ?? headers.StartTime);
  const end = clockMs(headers.EndDate ?? headers.UTCDate ?? headers.Date, headers.EndTime);
  if (start === null || end === null) return null;
  const seconds = (end - start) / 1000;
  return seconds >= 0 && seconds <= MAX_LIVE_GAME_SECONDS ? seconds : null;
}

/** The main-line SAN tokens: comments, variations, numbers, NAGs and the result removed. */
export function mainLineMoves(pgn: string): string[] {
  const body = pgn
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[.*\]\s*$/.test(line) && !/^\s*%/.test(line))
    .join(' ');
  let out = '';
  let braces = false;
  let depth = 0;
  let lineComment = false;
  for (const ch of body) {
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (braces) {
      if (ch === '}') braces = false;
      continue;
    }
    if (ch === '{') braces = true;
    else if (ch === ';') lineComment = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out
    .replace(/\$\d+/g, ' ')
    .replace(/\d+\s*\.(\s*\.\.)?/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[+#!?]/g, ''))
    .filter((t) => t !== '' && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
}

function utcDay(playedAt: number | null, pgnDate: string): string {
  if (playedAt !== null) return new Date(playedAt).toISOString().slice(0, 10);
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(pgnDate);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** When the game was played: the stored start, else midnight UTC of its PGN date, else null. */
function gameTime(record: StoredGameRecord): number | null {
  if (typeof record.playedAt === 'number' && Number.isFinite(record.playedAt)) return record.playedAt;
  const day = utcDay(null, record.date);
  return day === '' ? null : Date.parse(`${day}T00:00:00Z`);
}

type Reason = 'pastedOrBot' | 'notMine' | 'nonStandard' | 'unfinished';

function readGame(record: StoredGameRecord, accounts: readonly UserAccount[]): CountedGame | Reason {
  const source = record.source;
  if (source !== 'chesscom' && source !== 'lichess') return 'pastedOrBot';
  const color = myColor(record, accounts);
  if (color === null) return 'notMine';
  const pgn = record.pgn;
  const headers = readPgnHeaders(pgn);
  if (!isStandard(headers)) return 'nonStandard';
  if (!FINISHED.has(record.result)) return 'unfinished';
  const outcome = resultFor(record.result, color);
  if (outcome === 'unfinished') return 'unfinished';
  const playedAt = gameTime(record);
  const mine = color === 'w' ? record.whiteElo : record.blackElo;
  const theirs = color === 'w' ? record.blackElo : record.whiteElo;
  const day = utcDay(typeof record.playedAt === 'number' ? record.playedAt : null, record.date);
  let key: string | null | undefined;
  const duplicateKey = (): string | null => {
    if (key === undefined) {
      key = null;
      if (day !== '') {
        const moves = mainLineMoves(record.pgn);
        if (moves.length >= MIN_PLIES_FOR_DUPLICATE) key = `${moves.join(' ')}|${record.result}|${color}|${day}`;
      }
    }
    return key;
  };
  const control = controlKey(record.timeControl);
  return {
    id: record.id,
    site: source,
    color,
    outcome,
    timeClass: timeClassOf(record.timeControl),
    playedAt,
    day,
    opponentRating: typeof theirs === 'number' && theirs > 0 ? theirs : null,
    myRating: typeof mine === 'number' && mine > 0 ? mine : null,
    opening: record.openingName ? openingFamily(record.openingName) : '',
    variation: record.openingName ? variationOf(record.openingName) : '',
    control,
    ending: endingOf(headers.Termination, pgn, outcome),
    liveSeconds: liveSecondsOf(headers, control),
    duplicateKey,
    review: readReviewNumbers(record, color),
  };
}

// ---------------------------------------------------------------------------- one scope

const emptyWld = (): Wld => ({ games: 0, wins: 0, losses: 0, draws: 0 });

function add(into: Wld, outcome: CountedGame['outcome']): void {
  into.games++;
  if (outcome === 'win') into.wins++;
  else if (outcome === 'loss') into.losses++;
  else into.draws++;
}

const byTimeThenId = (a: CountedGame, b: CountedGame) =>
  (a.playedAt ?? 0) - (b.playedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function streaksOf(dated: readonly CountedGame[]): Streaks {
  let win = 0;
  let loss = 0;
  let unbeaten = 0;
  let longestWin = 0;
  let longestLoss = 0;
  let longestUnbeaten = 0;
  for (const g of dated) {
    // A draw ends both the winning and the losing streak, and keeps the unbeaten one going
    win = g.outcome === 'win' ? win + 1 : 0;
    loss = g.outcome === 'loss' ? loss + 1 : 0;
    unbeaten = g.outcome === 'loss' ? 0 : unbeaten + 1;
    longestWin = Math.max(longestWin, win);
    longestLoss = Math.max(longestLoss, loss);
    longestUnbeaten = Math.max(longestUnbeaten, unbeaten);
  }
  return {
    datedGames: dated.length,
    enough: dated.length >= MIN_GAMES_FOR_STREAKS,
    longestWin,
    longestLoss,
    longestUnbeaten,
  };
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function topOpenings(games: readonly CountedGame[], color: Color): OpeningStats[] {
  const map = new Map<string, OpeningStats & { variations: Map<string, number> }>();
  for (const g of games) {
    if (g.color !== color || g.opening === '') continue;
    const entry = map.get(g.opening) ?? { name: g.opening, ...emptyWld(), topVariation: null, variations: new Map() };
    add(entry, g.outcome);
    if (g.variation !== '') entry.variations.set(g.variation, (entry.variations.get(g.variation) ?? 0) + 1);
    map.set(g.opening, entry);
  }
  return [...map.values()]
    .filter((o) => o.games >= MIN_OPENING_GAMES)
    .sort((a, b) => b.games - a.games || byName(a.name, b.name))
    .slice(0, TOP_OPENINGS)
    .map(({ variations, ...o }) => {
      const top = [...variations.entries()].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))[0];
      return { ...o, topVariation: top ? { name: top[0], games: top[1] } : null };
    });
}

function bestWinOf(games: readonly CountedGame[]): BestWin | null {
  let best: CountedGame | null = null;
  for (const g of games) {
    if (g.outcome !== 'win' || g.opponentRating === null) continue;
    if (
      best === null ||
      g.opponentRating > best.opponentRating! ||
      (g.opponentRating === best.opponentRating && byTimeThenId(g, best) < 0)
    ) {
      best = g;
    }
  }
  return best === null
    ? null
    : {
        opponentRating: best.opponentRating!,
        myRating: best.myRating,
        playedAt: best.playedAt,
        timeClass: best.timeClass,
        opening: best.opening,
        gameId: best.id,
      };
}

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

/** The win against the biggest gap above my own rating, and how many wins were against a higher rating. */
function upsetsOf(games: readonly CountedGame[]): { upset: Upset | null; higherRatedWins: number } {
  let best: CountedGame | null = null;
  let higherRatedWins = 0;
  for (const g of games) {
    if (g.outcome !== 'win' || g.opponentRating === null || g.myRating === null) continue;
    const gap = g.opponentRating - g.myRating;
    if (gap <= 0) continue;
    higherRatedWins++;
    if (
      best === null ||
      gap > best.opponentRating! - best.myRating! ||
      (gap === best.opponentRating! - best.myRating! && byTimeThenId(g, best) < 0)
    ) {
      best = g;
    }
  }
  return {
    higherRatedWins,
    upset:
      best === null
        ? null
        : {
            points: best.opponentRating! - best.myRating!,
            opponentRating: best.opponentRating!,
            myRating: best.myRating!,
            timeClass: best.timeClass,
            playedAt: best.playedAt,
          },
  };
}

function endingsOf(games: readonly CountedGame[]): Endings {
  const zero = (): EndCounts => Object.fromEntries(END_KINDS.map((k) => [k, 0])) as EndCounts;
  const out: Endings = { win: zero(), loss: zero(), draw: zero() };
  for (const g of games) out[g.outcome][g.ending]++;
  return out;
}

/** The most-played exact controls; a tie goes to the faster (smaller base) control, so input order never matters. */
function controlsOf(games: readonly CountedGame[]): ControlStats[] {
  const map = new Map<string, number>();
  for (const g of games) if (g.control !== null) map.set(g.control, (map.get(g.control) ?? 0) + 1);
  const seconds = (c: string): number => (c.startsWith('1/') ? Infinity : (effectiveSeconds(c) ?? Infinity));
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || seconds(a[0]) - seconds(b[0]) || byName(a[0], b[0]))
    .slice(0, TOP_CONTROLS)
    .map(([control, count]) => ({
      control,
      label: controlLabel(control),
      timeClass: timeClassOf(control),
      games: count,
    }));
}

/** First, peak and latest rating per site and class (`dated` is sorted by time). The sites are never combined. */
function journeysOf(sites: readonly StorySite[], dated: readonly CountedGame[]): JourneySeries[] {
  const out: JourneySeries[] = [];
  for (const site of sites) {
    for (const timeClass of TIME_CLASSES) {
      const rated = dated.filter((g) => g.site === site && g.timeClass === timeClass && g.myRating !== null);
      if (rated.length < MIN_JOURNEY_GAMES) continue;
      const point = (g: CountedGame): JourneyPoint => ({ rating: g.myRating!, month: monthOf(g.playedAt!) });
      const peak = rated.reduce((best, g) => (g.myRating! > best.myRating! ? g : best));
      out.push({
        site,
        timeClass,
        ratedGames: rated.length,
        first: point(rated[0]!),
        peak: point(peak),
        latest: point(rated[rated.length - 1]!),
      });
    }
  }
  return out;
}

/** Longest busiest-key: the key with the most games (ties: the earliest key). */
function busiest(counts: ReadonlyMap<string, number>): { key: string; games: number } | null {
  let best: { key: string; games: number } | null = null;
  for (const key of [...counts.keys()].sort()) {
    const games = counts.get(key)!;
    if (best === null || games > best.games) best = { key, games };
  }
  return best;
}

function activityOf(dated: readonly CountedGame[]): Activity {
  const perDay = new Map<string, number>();
  const perMonth = new Map<string, number>();
  const perYear = new Map<string, number>();
  let liveSeconds = 0;
  let timedGames = 0;
  for (const g of dated) {
    const day = g.day;
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    perMonth.set(day.slice(0, 7), (perMonth.get(day.slice(0, 7)) ?? 0) + 1);
    perYear.set(day.slice(0, 4), (perYear.get(day.slice(0, 4)) ?? 0) + 1);
    if (g.liveSeconds !== null) {
      liveSeconds += g.liveSeconds;
      timedGames++;
    }
  }
  let longestRun = 0;
  let run = 0;
  let previous = 0;
  for (const day of [...perDay.keys()].sort()) {
    const at = Date.parse(`${day}T00:00:00Z`);
    run = run > 0 && at - previous === 86_400_000 ? run + 1 : 1;
    previous = at;
    longestRun = Math.max(longestRun, run);
  }
  const day = busiest(perDay);
  const month = busiest(perMonth);
  const year = busiest(perYear);
  return {
    datedGames: dated.length,
    liveSeconds,
    timedGames,
    days: perDay.size,
    longestRun,
    busiestDay: day && { day: day.key, games: day.games },
    busiestMonth: month && { month: month.key, games: month.games },
    busiestYear: year && { year: Number(year.key), games: year.games },
  };
}

// ---------------------------------------------------------------------------- engine review numbers

interface ReviewedGame {
  game: CountedGame;
  review: ReviewNumbers;
}

const meanOf = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const meanBy = (items: readonly ReviewedGame[], pick: (r: ReviewNumbers) => number): number =>
  meanOf(items.map((i) => pick(i.review)));
const earliestFirst = (a: ReviewedGame, b: ReviewedGame): number => byTimeThenId(a.game, b.game);

function accuracyGroup(items: readonly ReviewedGame[]): AccuracyGroup | null {
  return items.length >= MIN_REVIEWED_ROW ? { games: items.length, accuracy: meanBy(items, (r) => r.accuracy) } : null;
}

function reviewRef(item: ReviewedGame): ReviewedGameRef {
  return {
    playedAt: item.game.playedAt,
    timeClass: item.game.timeClass,
    outcome: item.game.outcome,
    opponentRating: item.game.opponentRating,
    source: item.review.source,
    depth: item.review.depth,
    preset: item.review.preset,
  };
}

/**
 * Whether win `a` is a more unlikely win than `b`: a lower lowest win%; at the same value the higher opponent rating
 * (no rating counts lowest), then the later game, then the smaller id, so the pick never depends on input order.
 */
function moreUnlikely(a: ReviewedGame, b: ReviewedGame): boolean {
  if (a.review.low !== b.review.low) return a.review.low! < b.review.low!;
  const rating = (i: ReviewedGame): number => i.game.opponentRating ?? -1;
  if (rating(a) !== rating(b)) return rating(a) > rating(b);
  if ((a.game.playedAt ?? 0) !== (b.game.playedAt ?? 0)) return (a.game.playedAt ?? 0) > (b.game.playedAt ?? 0);
  return a.game.id < b.game.id;
}

function reviewStatsOf(games: readonly CountedGame[]): ReviewStats {
  const items: ReviewedGame[] = [];
  for (const game of games) if (game.review) items.push({ game, review: game.review });
  const dated = items.filter((i) => i.game.playedAt !== null).sort(earliestFirst);

  const byClass: ReviewClassRow[] = [];
  for (const timeClass of TIME_CLASSES) {
    const group = accuracyGroup(items.filter((i) => i.game.timeClass === timeClass));
    if (group) byClass.push({ timeClass, ...group });
  }

  let halves: ReviewStats['halves'] = null;
  if (dated.length >= MIN_REVIEWED_GAMES) {
    const first = dated.slice(0, Math.floor(dated.length / 2));
    const second = dated.slice(first.length);
    const half = (part: readonly ReviewedGame[]): ReviewHalf => ({
      games: part.length,
      accuracy: meanBy(part, (r) => r.accuracy),
      blundersPerGame: meanBy(part, (r) => r.blunder),
    });
    halves = {
      first: { ...half(first), endMonth: monthOf(first[first.length - 1]!.game.playedAt!) },
      second: half(second),
    };
  }

  const years = new Map<number, ReviewedGame[]>();
  for (const item of dated) {
    const year = new Date(item.game.playedAt!).getUTCFullYear();
    years.set(year, [...(years.get(year) ?? []), item]);
  }
  const byYear: ReviewYearRow[] = [...years.entries()]
    .filter(([, list]) => list.length >= MIN_REVIEWED_ROW)
    .sort((a, b) => a[0] - b[0])
    .map(([year, list]) => ({
      year,
      games: list.length,
      accuracy: meanBy(list, (r) => r.accuracy),
      blundersPerGame: meanBy(list, (r) => r.blunder),
    }));

  const wins = items.filter((i) => i.game.outcome === 'win' && i.review.low !== null);
  let comebacks: ReviewStats['comebacks'] = null;
  if (wins.length > 0) {
    const pick = wins.reduce((best, i) => (moreUnlikely(i, best) ? i : best));
    comebacks = {
      count: wins.filter((i) => i.review.low! < COMEBACK_BELOW).length,
      game: { ...reviewRef(pick), low: pick.review.low! },
      reviewedWins: wins.length,
      alsoLow: wins.filter((i) => i.review.low === pick.review.low).length - 1,
    };
  }

  const long = items.filter((i) => i.review.moves >= MIN_MOVES_FOR_BEST_GAME);
  let bestGame: ReviewStats['bestGame'] = null;
  if (long.length > 0) {
    const pick = long.reduce((best, i) =>
      i.review.accuracy > best.review.accuracy ||
      (i.review.accuracy === best.review.accuracy && earliestFirst(i, best) < 0)
        ? i
        : best,
    );
    bestGame = {
      game: { ...reviewRef(pick), accuracy: pick.review.accuracy, moves: pick.review.moves },
      eligible: long.length,
    };
  }

  const phased = items.filter((i) => i.review.phases);
  const phases: ReviewStats['phases'] =
    phased.length === 0
      ? null
      : {
          games: phased.length,
          items: totalPhases(phased.map((i) => i.review.phases!)).map((t, p) => ({
            phase: PHASES[p]!,
            moves: t.moves,
            accuracy: t.accuracy,
            blunders: t.blunders,
            mistakes: t.mistakes,
            misses: t.misses,
            blundersPer10: t.moves === 0 ? null : (t.blunders / t.moves) * 10,
            games: t.games,
          })),
        };
  const ofColour = (colour: Color) => items.filter((i) => i.game.color === colour);
  const ofOutcome = (outcome: CountedGame['outcome']) => items.filter((i) => i.game.outcome === outcome);
  return {
    counted: games.length,
    reviewed: items.length,
    inAdvance: items.filter((i) => i.review.source === 'advance').length,
    onDevice: items.filter((i) => i.review.source === 'device').length,
    enough: items.length >= MIN_REVIEWED_GAMES,
    accuracy: items.length === 0 ? null : meanBy(items, (r) => r.accuracy),
    perGame:
      items.length === 0
        ? null
        : {
            blunder: meanBy(items, (r) => r.blunder),
            mistake: meanBy(items, (r) => r.mistake),
            inaccuracy: meanBy(items, (r) => r.inaccuracy),
            moves: meanBy(items, (r) => r.moves),
          },
    brilliant: items.reduce((sum, i) => sum + i.review.brilliant, 0),
    great: items.reduce((sum, i) => sum + i.review.great, 0),
    brilliantGames: items.filter((i) => i.review.brilliant > 0).length,
    greatGames: items.filter((i) => i.review.great > 0).length,
    byClass,
    white: accuracyGroup(ofColour('w')),
    black: accuracyGroup(ofColour('b')),
    wins: accuracyGroup(ofOutcome('win')),
    losses: accuracyGroup(ofOutcome('loss')),
    halves,
    byYear,
    comebacks,
    bestGame,
    phases,
  };
}

/** The longest game and the longest win, by the stored plies (the earliest game wins a tie). */
function recordsOf(games: readonly CountedGame[]): Records | null {
  const reviewed = games.filter((g) => g.review !== null);
  const longestOf = (list: readonly CountedGame[]): LongGame | null => {
    let pick: CountedGame | null = null;
    for (const g of list) {
      if (
        pick === null ||
        g.review!.plies > pick.review!.plies ||
        (g.review!.plies === pick.review!.plies && byTimeThenId(g, pick) < 0)
      ) {
        pick = g;
      }
    }
    return pick === null
      ? null
      : {
          moves: Math.ceil(pick.review!.plies / 2),
          playedAt: pick.playedAt,
          timeClass: pick.timeClass,
          outcome: pick.outcome,
          ending: pick.ending,
        };
  };
  const longest = longestOf(reviewed);
  return longest === null
    ? null
    : { games: reviewed.length, longest, longestWin: longestOf(reviewed.filter((g) => g.outcome === 'win')) };
}

function scopeStats(scope: StoryScope, games: readonly CountedGame[]): ScopeStats {
  const total = emptyWld();
  const white = emptyWld();
  const black = emptyWld();
  const classes = new Map<TimeClass, Wld>();
  let unclassified = 0;
  let withoutOpening = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const g of games) {
    add(total, g.outcome);
    add(g.color === 'w' ? white : black, g.outcome);
    if (g.timeClass === null) unclassified++;
    else {
      const w = classes.get(g.timeClass) ?? emptyWld();
      add(w, g.outcome);
      classes.set(g.timeClass, w);
    }
    if (g.opening === '') withoutOpening++;
    if (g.playedAt !== null) {
      first = first === null ? g.playedAt : Math.min(first, g.playedAt);
      last = last === null ? g.playedAt : Math.max(last, g.playedAt);
    }
  }
  const byClass: ClassStats[] = TIME_CLASSES.filter((c) => classes.has(c)).map((timeClass) => {
    const w = classes.get(timeClass)!;
    return { timeClass, ...w, showPercent: w.games >= MIN_CLASS_GAMES_FOR_PERCENT };
  });
  const most = Math.max(0, ...byClass.map((c) => c.games));
  // Sorted once for the streaks, the rating journeys and the days at the board
  const dated = games.filter((g) => g.playedAt !== null).sort(byTimeThenId);
  const sites: StorySite[] = scope === 'all' ? ['chesscom', 'lichess'] : [scope];
  return {
    scope,
    ...total,
    unclassified,
    byClass,
    favouriteClasses: most === 0 ? [] : byClass.filter((c) => c.games === most).map((c) => c.timeClass),
    white,
    black,
    enough: total.games >= MIN_GAMES_FOR_STORY,
    streaks: streaksOf(dated),
    openings: { white: topOpenings(games, 'w'), black: topOpenings(games, 'b'), withoutOpening },
    bestWin: bestWinOf(games),
    ...upsetsOf(games),
    endings: endingsOf(games),
    controls: controlsOf(games),
    journeys: journeysOf(sites, dated),
    records: recordsOf(games),
    activity: activityOf(dated),
    firstPlayedAt: first,
    lastPlayedAt: last,
    review: reviewStatsOf(games),
  };
}

// ---------------------------------------------------------------------------- everything

/** What the counting step finds in the stored records. */
interface CountedSet {
  counted: CountedGame[];
  chesscom: CountedGame[];
  lichess: CountedGame[];
  excluded: ExcludedCounts;
  /** Ids of the Lichess copies of games that are also on Chess.com (counted once in `all`). */
  dropped: Set<string>;
}

/** Reads every record, leaves out what the Story does not count, and pairs the games found on both sites. */
function countGames(records: readonly StoredGameRecord[], accounts: readonly UserAccount[]): CountedSet {
  const counted: CountedGame[] = [];
  const excluded: ExcludedCounts = { total: 0, pastedOrBot: 0, notMine: 0, nonStandard: 0, unfinished: 0 };
  for (const record of records) {
    const g = readGame(record, accounts);
    if (typeof g === 'string') {
      excluded[g]++;
      excluded.total++;
    } else counted.push(g);
  }
  const chesscom = counted.filter((g) => g.site === 'chesscom');
  const lichess = counted.filter((g) => g.site === 'lichess');

  // Pair each Lichess game with an unpaired Chess.com game of the same key; the Lichess side drops out of the total.
  // With games from one site only nothing can pair, so no key is built (a history from one site is the usual case).
  const dropped = new Set<string>();
  if (chesscom.length > 0 && lichess.length > 0) {
    const open = new Map<string, number>();
    for (const g of chesscom) {
      const key = g.duplicateKey();
      if (key) open.set(key, (open.get(key) ?? 0) + 1);
    }
    for (const g of [...lichess].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const key = g.duplicateKey();
      const n = key ? (open.get(key) ?? 0) : 0;
      if (n > 0) {
        open.set(key!, n - 1);
        dropped.add(g.id);
      }
    }
  }
  return { counted, chesscom, lichess, excluded, dropped };
}

/**
 * The Story's numbers for all, Chess.com and Lichess. A game on both sites (same main-line moves, result, my
 * colour and UTC date, at least MIN_PLIES_FOR_DUPLICATE plies) is counted once in `all` and stays in both site
 * scopes, so all = Chess.com + Lichess − onBothSites.
 */
export function computeStoryStats(records: readonly StoredGameRecord[], accounts: readonly UserAccount[]): StoryStats {
  const { counted, chesscom, lichess, excluded, dropped } = countGames(records, accounts);
  const chesscomStats = scopeStats('chesscom', chesscom);
  const lichessStats = scopeStats('lichess', lichess);
  // With games from one site only, "all" holds the same games as that site: its numbers are reused, not counted again
  const all: ScopeStats =
    lichess.length === 0
      ? { ...chesscomStats, scope: 'all' }
      : chesscom.length === 0
        ? { ...lichessStats, scope: 'all' }
        : scopeStats(
            'all',
            counted.filter((g) => !dropped.has(g.id)),
          );
  return {
    version: STATS_VERSION,
    storedGames: records.length,
    excluded,
    onBothSites: dropped.size,
    all,
    chesscom: chesscomStats,
    lichess: lichessStats,
  };
}

/** A game the Story counts in "all", reduced to what other views need: no id, name or link. */
export interface StoryGame {
  playedAt: number | null;
  outcome: 'win' | 'loss' | 'draw';
  timeClass: TimeClass | null;
  color: Color;
  review: ReviewNumbers | null;
}

/** The games the Story counts in "all" (mine, finished, standard; a game found on both sites once). */
export function storyGames(records: readonly StoredGameRecord[], accounts: readonly UserAccount[]): StoryGame[] {
  const { counted, dropped } = countGames(records, accounts);
  return counted
    .filter((g) => !dropped.has(g.id))
    .map(({ playedAt, outcome, timeClass, color, review }) => ({ playedAt, outcome, timeClass, color, review }));
}
