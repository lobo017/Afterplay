import type { StoredGameSource } from '../capture/game-id';
import { localDateTime, playedAtDetail, readPgnHeaders, type PlayedAt } from '../capture/pgn-time';
import type { Color } from '../core/rules';
import type { UserAccount } from '../review/perspective';
import type { StoredGameRecord } from '../storage/db';
import { timeClassOf, type TimeClass } from '../story/stats';
import { isStandardGame, mainLineMoves, myColor, resultFor, type MyResult } from './game-record';
import { MIN_REVIEWED_PLIES, readReviewNumbers } from './review-numbers';

/** One library game as the list and the insights see it. */
export interface GameRow {
  record: StoredGameRecord;
  /** My side, when the game is mine. */
  color: Color | null;
  result: MyResult;
  opponent: string;
  opponentElo: number | null;
  myElo: number | null;
  /** My accuracy in my games (the better of the two sides' is not used here: see `gameAccuracy`). */
  accuracy: number | null;
}

export function toRow(record: StoredGameRecord, accounts: readonly UserAccount[]): GameRow {
  const color = myColor(record, accounts);
  const opponentIsBlack = color !== 'b';
  const accuracy =
    color === 'w'
      ? (record.analysis?.whiteAccuracy ?? null)
      : color === 'b'
        ? (record.analysis?.blackAccuracy ?? null)
        : null;
  return {
    record,
    color,
    result: resultFor(record.result, color),
    opponent: color === null ? `${record.white} vs ${record.black}` : opponentIsBlack ? record.black : record.white,
    opponentElo: color === null ? null : opponentIsBlack ? (record.blackElo ?? null) : (record.whiteElo ?? null),
    myElo: color === 'w' ? (record.whiteElo ?? null) : color === 'b' ? (record.blackElo ?? null) : null,
    accuracy,
  };
}

/**
 * The accuracy the filter and the accuracy sort use: mine in my games; in a game that isn't
 * mine, the mean of both sides'. Null when the game has no review.
 */
export function gameAccuracy(row: GameRow): number | null {
  if (row.accuracy !== null) return row.accuracy;
  const a = row.record.analysis;
  if (!a || row.color !== null) return null;
  const sides = [a.whiteAccuracy, a.blackAccuracy].filter((v): v is number => v !== null);
  return sides.length === 0 ? null : sides.reduce((x, y) => x + y, 0) / sides.length;
}

/**
 * The one meaning of "reviewed" everywhere (Games list, Today screen): the game has a review summary stored in advance
 * or a review made on this device. Reads the record only.
 */
export function isReviewed(record: Pick<StoredGameRecord, 'analysis'>): boolean {
  return Boolean(record.analysis);
}

const pliesCache = new WeakMap<object, number>();

/** The moves of the game's main line, counted from the PGN text (cached per record). */
export function gamePlies(record: Pick<StoredGameRecord, 'pgn'>): number {
  let n = pliesCache.get(record);
  if (n === undefined) {
    n = mainLineMoves(record.pgn).length;
    pliesCache.set(record, n);
  }
  return n;
}

/** A game with no review that is too short to get one: under MIN_REVIEWED_PLIES plies (the batch review skips it). */
export function isTooShort(record: Pick<StoredGameRecord, 'analysis' | 'pgn'>): boolean {
  return !isReviewed(record) && gamePlies(record) < MIN_REVIEWED_PLIES;
}

/**
 * The one meaning of "not reviewed": no review of either kind, and a game that can be reviewed in a meaningful way.
 * The variant games the Story leaves out (Chess960, set-up games) and the games too short to review are never counted
 * as waiting for a review.
 */
export function isNotReviewed(record: Pick<StoredGameRecord, 'analysis' | 'pgn'>): boolean {
  return !isReviewed(record) && isStandardGame(readPgnHeaders(record.pgn)) && !isTooShort(record);
}

/** Games that are not reviewed (the Today screen's count and the Games list's "Not reviewed" filter). */
export function countUnreviewed(records: readonly StoredGameRecord[]): number {
  return records.filter(isNotReviewed).length;
}

/**
 * True for a game of mine whose engine numbers come from a batch review (a summary only). It is the reader the Story and
 * Insights use, so a game counts only with a usable review of my side (at least MIN_REVIEWED_PLIES plies). A game
 * reviewed on this device has no `summaryOnly`: it is in "analyzed", never here, so never counted twice. Reads the
 * record only, no PGN.
 */
export function reviewedInAdvance(row: Pick<GameRow, 'record' | 'color'>): boolean {
  return row.color !== null && readReviewNumbers(row.record, row.color)?.source === 'advance';
}

const count = (v: number): string => v.toLocaleString('en-US');

/**
 * "4,623 games · 4,580 reviewed". Reviewed means on this device (`analyzed`) or in advance (`inAdvance`); the two never
 * overlap, because a review made here replaces the one made in advance.
 */
export function gamesSummary(c: { games: number; analyzed: number; inAdvance: number }): string {
  return `${count(c.games)} game${c.games === 1 ? '' : 's'} · ${count(c.analyzed + c.inAdvance)} reviewed`;
}

/** When each stored game was played, from its PGN's UTC headers (parsed once per record). */
const playedCache = new WeakMap<StoredGameRecord, PlayedAt | null>();

export function playedOf(record: StoredGameRecord): PlayedAt | null {
  if (!playedCache.has(record)) playedCache.set(record, playedAtDetail(readPgnHeaders(record.pgn)));
  return playedCache.get(record) ?? null;
}

/** When a daily game ended (ms), cached per record: null for a live game or a daily without a usable, later end. */
const dailyEndCache = new WeakMap<StoredGameRecord, number | null>();

function dailyEndMs(record: StoredGameRecord): number | null {
  if (dailyEndCache.has(record)) return dailyEndCache.get(record) ?? null;
  let end: number | null = null;
  const start = playedOf(record);
  // Daily: the TimeControl is 1/N (days per move). A game with no start of its own keeps what it has.
  if (start && !start.isEnd && timeClassOf(record.timeControl) === 'daily') {
    const headers = readPgnHeaders(record.pgn);
    const candidate = playedAtDetail({ UTCDate: headers.EndDate ?? '', UTCTime: headers.EndTime ?? '' });
    if (candidate?.hasTime && candidate.ms > start.ms) end = candidate.ms;
  }
  dailyEndCache.set(record, end);
  return end;
}

/**
 * When the Library places a game: the time it started, except for a daily game (TimeControl 1/N) whose PGN has a later
 * EndDate and EndTime, which is placed by its end (a daily takes days, and the end is when it left the "in progress"
 * state). The stored `playedAt` and `playedAtDetail` stay the start; Story buckets use the start.
 */
export function libraryPlayedOf(record: StoredGameRecord): PlayedAt | null {
  const end = dailyEndMs(record);
  return end === null ? playedOf(record) : { ms: end, hasTime: true, isEnd: true };
}

/** The day a game is shown under, "2026-10-18" in my time zone ('' when the game has no date). */
export function gameDay(record: StoredGameRecord): string {
  const played = libraryPlayedOf(record);
  if (played?.hasTime) return localDateTime(played.ms).date;
  if (played) return new Date(played.ms).toISOString().slice(0, 10);
  return /^\d{4}\.\d{2}\.\d{2}$/.test(record.date) ? record.date.replace(/\./g, '-') : '';
}

export function sortTime(record: StoredGameRecord): number {
  return dailyEndMs(record) ?? record.playedAt ?? record.capturedAt ?? record.createdAt;
}

export type ResultFilter = 'all' | 'win' | 'loss' | 'draw';
export type AnalyzedFilter = 'all' | 'analyzed' | 'not-analyzed';
export type SortKey = 'newest' | 'oldest' | 'opponent' | 'accuracy';
/** The Story's time classes (a 1/N time control is Daily); a game whose class cannot be read shows under 'all' only. */
export type TimeClassFilter = 'all' | TimeClass;

export interface GameFilter {
  source: 'all' | StoredGameSource;
  result: ResultFilter;
  /** My side. */
  color: 'all' | Color;
  analyzed: AnalyzedFilter;
  /** Text in "C20 King's Pawn Game" (case-insensitive); '' for any. */
  opening: string;
  /** Days, "2026-10-18" (inclusive); '' for no limit. */
  from: string;
  to: string;
  /** My accuracy at least this, in percent; null for any. */
  minAccuracy: number | null;
  /** The game's time class, the one the Story uses. */
  timeClass: TimeClassFilter;
}

export const NO_FILTER: Readonly<GameFilter> = Object.freeze({
  source: 'all',
  result: 'all',
  color: 'all',
  analyzed: 'all',
  opening: '',
  from: '',
  to: '',
  minAccuracy: null,
  timeClass: 'all',
});

/** The number of filters that are set. */
export function activeFilters(filter: GameFilter): number {
  return (
    Number(filter.source !== 'all') +
    Number(filter.result !== 'all') +
    Number(filter.color !== 'all') +
    Number(filter.analyzed !== 'all') +
    Number(filter.opening.trim() !== '') +
    Number(filter.from !== '' || filter.to !== '') +
    Number(filter.minAccuracy !== null) +
    Number(filter.timeClass !== 'all')
  );
}

export function openingLabel(record: StoredGameRecord): string {
  return record.openingName ? `${record.openingEco ? `${record.openingEco} ` : ''}${record.openingName}` : '';
}

export function matchesFilter(row: GameRow, filter: GameFilter): boolean {
  const r = row.record;
  if (filter.source !== 'all' && (r.source ?? 'paste') !== filter.source) return false;
  if (filter.result === 'draw' && row.result !== 'draw') return false;
  // Wins and losses are mine: a game I'm not in has neither
  if ((filter.result === 'win' || filter.result === 'loss') && (row.color === null || row.result !== filter.result))
    return false;
  if (filter.color !== 'all' && row.color !== filter.color) return false;
  // Reviewed: a review made here or one stored in advance. Not reviewed: neither, and not a variant game
  if (filter.analyzed === 'analyzed' && !isReviewed(r)) return false;
  if (filter.analyzed === 'not-analyzed' && !isNotReviewed(r)) return false;
  if (filter.timeClass !== 'all' && timeClassOf(r.timeControl) !== filter.timeClass) return false;
  const opening = filter.opening.trim().toLowerCase();
  if (opening !== '' && !openingLabel(r).toLowerCase().includes(opening)) return false;
  if (filter.from !== '' || filter.to !== '') {
    const day = gameDay(r);
    if (day === '') return false;
    if (filter.from !== '' && day < filter.from) return false;
    if (filter.to !== '' && day > filter.to) return false;
  }
  if (filter.minAccuracy !== null) {
    const accuracy = gameAccuracy(row);
    if (accuracy === null || accuracy < filter.minAccuracy) return false;
  }
  return true;
}

export function sortRows(rows: GameRow[], sort: SortKey): GameRow[] {
  const byTime = (a: GameRow, b: GameRow) => sortTime(b.record) - sortTime(a.record);
  switch (sort) {
    case 'newest':
      return rows.sort(byTime);
    case 'oldest':
      return rows.sort((a, b) => -byTime(a, b));
    case 'opponent':
      return rows.sort(
        (a, b) => a.opponent.localeCompare(b.opponent, undefined, { sensitivity: 'base' }) || byTime(a, b),
      );
    case 'accuracy':
      return rows.sort((a, b) => (gameAccuracy(b) ?? -2) - (gameAccuracy(a) ?? -2) || byTime(a, b));
  }
}

/** The distinct openings of the games (for suggestions), most played first. */
export function openingChoices(records: readonly StoredGameRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const label = openingLabel(r);
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label]) => label);
}
