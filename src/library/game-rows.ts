import type { StoredGameSource } from '../capture/game-id';
import { localDateTime, playedAtDetail, readPgnHeaders, type PlayedAt } from '../capture/pgn-time';
import type { Color } from '../core/rules';
import type { UserAccount } from '../review/perspective';
import type { StoredGameRecord } from '../storage/db';
import { myColor, resultFor, type MyResult } from './game-record';

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
    color === 'w' ? (record.analysis?.whiteAccuracy ?? null) : color === 'b' ? (record.analysis?.blackAccuracy ?? null) : null;
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

/** When each stored game was played, from its PGN's UTC headers (parsed once per record). */
const playedCache = new WeakMap<StoredGameRecord, PlayedAt | null>();

export function playedOf(record: StoredGameRecord): PlayedAt | null {
  if (!playedCache.has(record)) playedCache.set(record, playedAtDetail(readPgnHeaders(record.pgn)));
  return playedCache.get(record) ?? null;
}

/** The day a game was played, "2026-10-18" in my time zone ('' when the game has no date). */
export function gameDay(record: StoredGameRecord): string {
  const played = playedOf(record);
  if (played?.hasTime) return localDateTime(played.ms).date;
  if (played) return new Date(played.ms).toISOString().slice(0, 10);
  return /^\d{4}\.\d{2}\.\d{2}$/.test(record.date) ? record.date.replace(/\./g, '-') : '';
}

export function sortTime(record: StoredGameRecord): number {
  return record.playedAt ?? record.capturedAt ?? record.createdAt;
}

export type ResultFilter = 'all' | 'win' | 'loss' | 'draw';
export type AnalyzedFilter = 'all' | 'analyzed' | 'not-analyzed';
export type SortKey = 'newest' | 'oldest' | 'opponent' | 'accuracy';

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
    Number(filter.minAccuracy !== null)
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
  if ((filter.result === 'win' || filter.result === 'loss') && (row.color === null || row.result !== filter.result)) return false;
  if (filter.color !== 'all' && row.color !== filter.color) return false;
  const analyzed = Boolean(r.analysis);
  if (filter.analyzed === 'analyzed' && !analyzed) return false;
  if (filter.analyzed === 'not-analyzed' && analyzed) return false;
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
      return rows.sort((a, b) => a.opponent.localeCompare(b.opponent, undefined, { sensitivity: 'base' }) || byTime(a, b));
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
