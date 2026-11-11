/**
 * Chess.com's public archive API as the app's own sync uses it: the addresses, which months a player's archive list
 * names, when a stored month can no longer change, and a game's library key from its PGN headers alone.
 *
 * This file holds the only address outside the app's own origin that the website ever asks for, and it is asked for
 * only while a sync the user started is running (AGENTS.md). Nothing here does a request itself.
 */
import { gameKey, refFromPgnHeaders } from '../capture/game-id';
import { readPgnHeaders } from '../capture/pgn-time';

export const CHESSCOM_API_ROOT = 'https://api.chess.com/pub/player';

/**
 * The capture method of a game that came from the monthly archives: the label the extension's "Import my history" and
 * the restore file's builder (hpc/history) give the same games, so the three write the same record.
 */
export const CHESSCOM_SYNC_METHOD = 'chesscom-archive-history';

/** What a Chess.com username can look like; anything else is never put into an address. */
export function isChessComUsername(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{3,25}$/.test(name);
}

export function archivesListUrl(username: string): string {
  return `${CHESSCOM_API_ROOT}/${username.toLowerCase()}/games/archives`;
}

/** The address of one month ("2024-03") of a player's games. */
export function archiveMonthUrl(username: string, month: string): string {
  return `${CHESSCOM_API_ROOT}/${username.toLowerCase()}/games/${month.slice(0, 4)}/${month.slice(5, 7)}`;
}

/** "2024-03" for a monthly archive address of this player, null for anything else. */
export function monthOfArchiveUrl(url: unknown, username: string): string | null {
  if (typeof url !== 'string') return null;
  const prefix = `${CHESSCOM_API_ROOT}/${username.toLowerCase()}/games/`;
  if (!url.toLowerCase().startsWith(prefix)) return null;
  const m = /^(\d{4})\/(\d{2})$/.exec(url.slice(prefix.length));
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${m[1]}-${m[2]}` : null;
}

/**
 * The months an archive list names, oldest first, each once. Only this player's months count: the sync builds every
 * month's address again from its label, so whatever the list holds, only the API's own host is asked. Null when the
 * answer is not an archive list.
 */
export function monthsFromList(body: unknown, username: string): { months: string[]; ignored: number } | null {
  const urls = body && typeof body === 'object' ? (body as { archives?: unknown }).archives : null;
  if (!Array.isArray(urls)) return null;
  const months: string[] = [];
  let ignored = 0;
  for (const url of urls) {
    const month = monthOfArchiveUrl(url, username);
    if (month && !months.includes(month)) months.push(month);
    else ignored++;
  }
  months.sort();
  return { months, ignored };
}

/** When a month ("2024-03") ended: the first instant of the next one, UTC. */
export function monthEndMs(month: string): number {
  return Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
}

/** The archive can be up to 12 hours behind a finished game; a day after a month ended, its archive is complete. */
export const MONTH_FINAL_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * True when a month stored at `storedAt` cannot have changed since: it was read at least a day after it ended. The
 * API's ETags would say the same more directly, but a page can neither read them nor send them (the header is not
 * exposed to scripts and `If-None-Match` is refused by the API's CORS rules), so the calendar decides.
 */
export function isMonthFinal(month: string, storedAt: number): boolean {
  return Number.isFinite(storedAt) && storedAt >= monthEndMs(month) + MONTH_FINAL_AFTER_MS;
}

/**
 * The library key of an archive game from its PGN headers (`chesscom:live-<n>`, `chesscom:daily-<n>`), without reading
 * a move: the key the full check gives a game that names its page. Null when the headers name no game page.
 */
export function gameKeyFromPgnHeaders(pgn: string): string | null {
  const ref = refFromPgnHeaders(readPgnHeaders(pgn));
  return ref ? gameKey(ref) : null;
}
