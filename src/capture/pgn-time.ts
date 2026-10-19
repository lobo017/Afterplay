/**
 * When a game was played, from its PGN headers, and how to show that time. Shared by the
 * website (Games list) and the capture extension (popup), which both show it in the
 * viewer's local time zone.
 *
 * PGN dates and times from Lichess and Chess.com are UTC: Lichess writes UTCDate / UTCTime
 * (the start); Chess.com's archive writes UTCDate / UTCTime / StartTime and EndDate /
 * EndTime; the PGN the extension builds from Chess.com's game data has Date and EndDate /
 * EndTime only (the game data has no start time).
 */

/** Header values from a PGN, without parsing the moves (the first value of a repeated tag wins). */
export function readPgnHeaders(pgn: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\s*\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) {
    if (!(m[1]! in out)) out[m[1]!] = m[2]!.replace(/\\(["\\])/g, '$1');
  }
  return out;
}

const DATE = /^(\d{4})\.(\d{2})\.(\d{2})$/;
/** "16:37:15", "9:34:36", "16:37", optionally followed by " GMT+0000" / " UTC" / "Z". */
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(?:GMT|UTC)?\s*\+?0{0,4}|Z)?$/i;

function usable(value: string | undefined): string {
  const v = (value ?? '').trim();
  return v === '?' || v.includes('?') ? '' : v;
}

/** ms since the epoch for a PGN date and an optional UTC time; null when the date isn't complete. */
function utcMs(date: string | undefined, time: string | undefined): number | null {
  const d = DATE.exec(usable(date));
  if (!d) return null;
  const t = TIME.exec(usable(time));
  const ms = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), t ? Number(t[1]) : 0, t ? Number(t[2]) : 0, t?.[3] ? Number(t[3]) : 0);
  return Number.isFinite(ms) ? ms : null;
}

/** True when the header has a usable time of day. */
function hasTime(value: string | undefined): boolean {
  return TIME.test(usable(value));
}

export interface PlayedAt {
  /** ms since the epoch. */
  ms: number;
  /** False when only the date is known (the time is midnight UTC and shouldn't be shown). */
  hasTime: boolean;
  /** The time is when the game ended (no start time in the PGN). */
  isEnd: boolean;
}

/**
 * When the game was played: UTCDate + UTCTime, then Date + StartTime, then EndDate + EndTime
 * (the end, for PGNs without a start time), then the date alone.
 */
export function playedAtDetail(headers: Readonly<Record<string, string>>): PlayedAt | null {
  const date = usable(headers.UTCDate) || usable(headers.Date);
  if (hasTime(headers.UTCTime) && DATE.test(date)) return { ms: utcMs(date, headers.UTCTime)!, hasTime: true, isEnd: false };
  if (hasTime(headers.StartTime) && DATE.test(date)) return { ms: utcMs(date, headers.StartTime)!, hasTime: true, isEnd: false };
  const endDate = usable(headers.EndDate) || date;
  if (hasTime(headers.EndTime) && DATE.test(endDate)) return { ms: utcMs(endDate, headers.EndTime)!, hasTime: true, isEnd: true };
  const ms = utcMs(date, undefined);
  return ms === null ? null : { ms, hasTime: false, isEnd: false };
}

/** When the game was played, in ms since the epoch (see playedAtDetail). */
export function playedAtFromHeaders(headers: Readonly<Record<string, string>>): number | null {
  return playedAtDetail(headers)?.ms ?? null;
}

export interface LocalDateTime {
  /** "2026-10-18" */
  date: string;
  /** "14:05" (24-hour) */
  time: string;
  /** The time zone it is shown in, e.g. "Europe/Lisbon". */
  timeZone: string;
}

/** A time in the viewer's time zone (or `timeZone`, for tests). */
export function localDateTime(ms: number, timeZone?: string): LocalDateTime {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    timeZone: fmt.resolvedOptions().timeZone,
  };
}

/** "2026-10-18 14:05" in local time, or the date alone when the PGN has no time. */
export function formatPlayedAt(played: PlayedAt, timeZone?: string): string {
  if (!played.hasTime) {
    // A date without a time is a calendar date: show it as written, not shifted
    const d = new Date(played.ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const local = localDateTime(played.ms, timeZone);
  return `${local.date} ${local.time}`;
}
