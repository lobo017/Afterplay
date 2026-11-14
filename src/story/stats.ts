/**
 * The numbers behind the Chess Story, computed from stored game records. Pure: no storage, no network, no clock
 * (the caller passes `now`). `StoryStats` holds no player or opponent name, so nothing built from it (a card, a
 * cache, a shared image) can carry one.
 */
import type { UserAccount } from '../review/perspective';
import type { StoredGameRecord } from '../storage/db';
import { readPgnHeaders } from '../capture/pgn-time';
import { myColor, resultFor } from '../library/game-record';
import { openingFamily } from '../library/insights';
import type { Color } from '../core/rules';

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
/** The rating trend covers this many calendar months, the current one included. */
export const TREND_MONTHS = 12;
/** A trend needs this many rated games in the window... */
export const MIN_TREND_GAMES = 10;
/** ...in at least this many different months. */
export const MIN_TREND_MONTHS = 2;

export const STATS_VERSION = 1;

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
}

export interface BestWin {
  opponentRating: number;
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
}

export interface TrendPoint {
  /** "2026-03" (UTC). */
  month: string;
  /** My rating in the last game of that month. */
  rating: number;
}

export interface TrendSeries {
  site: StorySite;
  timeClass: TimeClass;
  /** Months with games in the window, oldest first. */
  points: TrendPoint[];
  /** Rated games in the window. */
  ratedGames: number;
  /** MIN_TREND_GAMES rated games in at least MIN_TREND_MONTHS months. */
  enough: boolean;
  /** The latest month with any game in this site and class ("2024-03"), or null. */
  lastGameMonth: string | null;
  /** False when no game of this site and class falls in the window. */
  anyInWindow: boolean;
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
  /** One series per site in the scope (the sites are never combined); empty when the site has no games. */
  trends: TrendSeries[];
  /** First and last game, ms since the epoch (UTC), or null. */
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
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
  opponentRating: number | null;
  myRating: number | null;
  opening: string;
  /** Duplicate key between sites, or null when the game is too short or undated. */
  duplicateKey: string | null;
}

function isStandard(headers: Readonly<Record<string, string>>): boolean {
  const variant = (headers.Variant ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (variant !== '' && variant !== 'standard' && variant !== 'chess') return false;
  if ('FEN' in headers) return false;
  if ((headers.SetUp ?? '').trim() === '1') return false;
  return true;
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
  const headers = readPgnHeaders(record.pgn);
  if (!isStandard(headers)) return 'nonStandard';
  if (!FINISHED.has(record.result)) return 'unfinished';
  const outcome = resultFor(record.result, color);
  if (outcome === 'unfinished') return 'unfinished';
  const playedAt = gameTime(record);
  const mine = color === 'w' ? record.whiteElo : record.blackElo;
  const theirs = color === 'w' ? record.blackElo : record.whiteElo;
  let duplicateKey: string | null = null;
  const day = utcDay(typeof record.playedAt === 'number' ? record.playedAt : null, record.date);
  if (day !== '') {
    const moves = mainLineMoves(record.pgn);
    if (moves.length >= MIN_PLIES_FOR_DUPLICATE) duplicateKey = `${moves.join(' ')}|${record.result}|${color}|${day}`;
  }
  return {
    id: record.id,
    site: source,
    color,
    outcome,
    timeClass: timeClassOf(record.timeControl),
    playedAt,
    opponentRating: typeof theirs === 'number' && theirs > 0 ? theirs : null,
    myRating: typeof mine === 'number' && mine > 0 ? mine : null,
    opening: record.openingName ? openingFamily(record.openingName) : '',
    duplicateKey,
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

function streaksOf(games: readonly CountedGame[]): Streaks {
  const dated = games.filter((g) => g.playedAt !== null).sort(byTimeThenId);
  let win = 0;
  let loss = 0;
  let longestWin = 0;
  let longestLoss = 0;
  for (const g of dated) {
    // A draw ends both streaks
    win = g.outcome === 'win' ? win + 1 : 0;
    loss = g.outcome === 'loss' ? loss + 1 : 0;
    longestWin = Math.max(longestWin, win);
    longestLoss = Math.max(longestLoss, loss);
  }
  return { datedGames: dated.length, enough: dated.length >= MIN_GAMES_FOR_STREAKS, longestWin, longestLoss };
}

function topOpenings(games: readonly CountedGame[], color: Color): OpeningStats[] {
  const map = new Map<string, OpeningStats>();
  for (const g of games) {
    if (g.color !== color || g.opening === '') continue;
    const entry = map.get(g.opening) ?? { name: g.opening, ...emptyWld() };
    add(entry, g.outcome);
    map.set(g.opening, entry);
  }
  return [...map.values()]
    .filter((o) => o.games >= MIN_OPENING_GAMES)
    .sort((a, b) => b.games - a.games || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, TOP_OPENINGS);
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
        playedAt: best.playedAt,
        timeClass: best.timeClass,
        opening: best.opening,
        gameId: best.id,
      };
}

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

/** The TREND_MONTHS month labels ending with the month of `now`, oldest first. */
export function trendWindow(now: number): string[] {
  const d = new Date(now);
  const out: string[] = [];
  for (let i = TREND_MONTHS - 1; i >= 0; i--) {
    out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }
  return out;
}

function trendOf(site: StorySite, games: readonly CountedGame[], now: number): TrendSeries | null {
  const mine = games.filter((g) => g.site === site && g.timeClass !== null);
  if (mine.length === 0) return null;
  const counts = new Map<TimeClass, number>();
  for (const g of mine) counts.set(g.timeClass!, (counts.get(g.timeClass!) ?? 0) + 1);
  // Most-played class; a tie goes to the faster class (fixed order), so the result never depends on input order
  const timeClass = TIME_CLASSES.filter((c) => counts.has(c)).sort((a, b) => counts.get(b)! - counts.get(a)!)[0]!;
  const ofClass = mine.filter((g) => g.timeClass === timeClass && g.playedAt !== null).sort(byTimeThenId);
  const window = new Set(trendWindow(now));
  const inWindow = ofClass.filter((g) => window.has(monthOf(g.playedAt!)));
  const last = new Map<string, number>();
  let rated = 0;
  for (const g of inWindow) {
    if (g.myRating === null) continue;
    rated++;
    last.set(monthOf(g.playedAt!), g.myRating);
  }
  const points = [...last.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, rating]) => ({ month, rating }));
  const latest = ofClass[ofClass.length - 1];
  return {
    site,
    timeClass,
    points,
    ratedGames: rated,
    enough: rated >= MIN_TREND_GAMES && points.length >= MIN_TREND_MONTHS,
    lastGameMonth: latest ? monthOf(latest.playedAt!) : null,
    anyInWindow: inWindow.length > 0,
  };
}

function scopeStats(scope: StoryScope, games: readonly CountedGame[], now: number): ScopeStats {
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
    streaks: streaksOf(games),
    openings: { white: topOpenings(games, 'w'), black: topOpenings(games, 'b'), withoutOpening },
    bestWin: bestWinOf(games),
    trends: sites.map((s) => trendOf(s, games, now)).filter((t): t is TrendSeries => t !== null),
    firstPlayedAt: first,
    lastPlayedAt: last,
  };
}

// ---------------------------------------------------------------------------- everything

/**
 * The Story's numbers for all, Chess.com and Lichess. A game on both sites (same main-line moves, result, my
 * colour and UTC date, at least MIN_PLIES_FOR_DUPLICATE plies) is counted once in `all` and stays in both site
 * scopes, so all = Chess.com + Lichess − onBothSites. `now` (ms since the epoch) fixes the trend's 12 months.
 */
export function computeStoryStats(
  records: readonly StoredGameRecord[],
  accounts: readonly UserAccount[],
  now: number,
): StoryStats {
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

  // Pair each Lichess game with an unpaired Chess.com game of the same key; the Lichess side drops out of the total
  const open = new Map<string, number>();
  for (const g of chesscom) if (g.duplicateKey) open.set(g.duplicateKey, (open.get(g.duplicateKey) ?? 0) + 1);
  const dropped = new Set<string>();
  for (const g of [...lichess].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const n = g.duplicateKey ? (open.get(g.duplicateKey) ?? 0) : 0;
    if (n > 0) {
      open.set(g.duplicateKey!, n - 1);
      dropped.add(g.id);
    }
  }
  return {
    version: STATS_VERSION,
    storedGames: records.length,
    excluded,
    onBothSites: dropped.size,
    all: scopeStats(
      'all',
      counted.filter((g) => !dropped.has(g.id)),
      now,
    ),
    chesscom: scopeStats('chesscom', chesscom, now),
    lichess: scopeStats('lichess', lichess, now),
  };
}
