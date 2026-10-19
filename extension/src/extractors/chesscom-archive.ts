import { chessComParts, type SiteGameRef } from '../../../src/capture/game-id';

/**
 * Chess.com's official Published-Data API: a player's monthly game archives,
 * `https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}`, each game with its PGN.
 * The archive can lag behind a finished game by up to 12 hours, so a game not in it yet is
 * "pending" rather than an error. The API sends ETags; an unchanged month answers 304.
 */
export const CHESSCOM_ARCHIVE_METHOD = 'chesscom-archive';

export interface ArchiveGame {
  url: string;
  pgn?: string;
  end_time?: number;
  rules?: string;
  time_class?: string;
  white?: { username?: string };
  black?: { username?: string };
}

export type ArchiveFetch =
  | { status: 'ok'; games: ArchiveGame[]; etag: string | null }
  | { status: 'not-modified' }
  | { status: 'not-found' }
  | { status: 'rate-limited'; retryAfterMs: number }
  | { status: 'error'; reason: string };

export function monthKey(year: number, month: number): string {
  return `${year}/${String(month).padStart(2, '0')}`;
}

export function archiveMonthUrl(username: string, month: string): string {
  return `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/${month}`;
}

export function archivesListUrl(username: string): string {
  return `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`;
}

/** Retry-After in ms (seconds or an HTTP date), or the fallback. */
export function retryAfterMs(value: string | null, fallbackMs: number, now = Date.now()): number {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : fallbackMs;
}

/** One request for a JSON resource of the API, with If-None-Match when an ETag is known. */
export async function fetchApiJson<T>(
  doFetch: typeof fetch,
  url: string,
  etag: string | null,
): Promise<{ status: 'ok'; body: T; etag: string | null } | Exclude<ArchiveFetch, { status: 'ok' }>> {
  const res = await doFetch(url, {
    headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) },
    credentials: 'omit',
  });
  if (res.status === 304) return { status: 'not-modified' };
  if (res.status === 404 || res.status === 410) return { status: 'not-found' };
  if (res.status === 429) return { status: 'rate-limited', retryAfterMs: retryAfterMs(res.headers.get('retry-after'), 60_000) };
  if (!res.ok) return { status: 'error', reason: `Chess.com's API answered ${res.status}.` };
  try {
    return { status: 'ok', body: (await res.json()) as T, etag: res.headers.get('etag') };
  } catch {
    return { status: 'error', reason: "Chess.com's API did not answer JSON." };
  }
}

export async function fetchArchiveMonth(
  doFetch: typeof fetch,
  username: string,
  month: string,
  etag: string | null = null,
): Promise<ArchiveFetch> {
  const r = await fetchApiJson<{ games?: ArchiveGame[] }>(doFetch, archiveMonthUrl(username, month), etag);
  if (r.status !== 'ok') return r;
  return { status: 'ok', games: Array.isArray(r.body.games) ? r.body.games : [], etag: r.etag };
}

/** The game in an archive month, matched by its URL. */
export function findArchiveGame(games: readonly ArchiveGame[], ref: SiteGameRef): ArchiveGame | null {
  const { type, id } = chessComParts(ref);
  const pattern = new RegExp(`/(?:game/${type}|${type}/game)/${id}(?:[/?#]|$)`);
  return games.find((g) => pattern.test(g.url)) ?? null;
}

/** "2026/10" for a time in ms (UTC), and the month before it. */
export function monthOf(ms: number): string {
  const d = new Date(ms);
  return monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('/').map(Number) as [number, number];
  return m === 1 ? monthKey(y - 1, 12) : monthKey(y, m - 1);
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('/').map(Number) as [number, number];
  return m === 12 ? monthKey(y + 1, 1) : monthKey(y, m + 1);
}

export type ArchiveLookup =
  | { status: 'found'; pgn: string }
  | { status: 'pending'; reason: string; retryAfterMs: number }
  | { status: 'error'; reason: string };

/** How soon a game not yet in the archive is looked for again. */
export const ARCHIVE_PENDING_RETRY_MS = 15 * 60_000;

/**
 * Looks a game up in the archives of `username` for the given months, one request at a
 * time. Not there (yet): pending.
 */
export async function lookupInArchives(
  doFetch: typeof fetch,
  ref: SiteGameRef,
  username: string,
  months: readonly string[],
): Promise<ArchiveLookup> {
  for (const month of months) {
    const r = await fetchArchiveMonth(doFetch, username, month);
    if (r.status === 'rate-limited') return { status: 'pending', reason: 'Rate limited by Chess.com.', retryAfterMs: r.retryAfterMs };
    if (r.status === 'error') return { status: 'error', reason: r.reason };
    if (r.status !== 'ok') continue;
    const game = findArchiveGame(r.games, ref);
    if (game?.pgn) return { status: 'found', pgn: game.pgn };
  }
  return {
    status: 'pending',
    reason: "Not in Chess.com's archive yet (it can lag up to 12 h).",
    retryAfterMs: ARCHIVE_PENDING_RETRY_MS,
  };
}
