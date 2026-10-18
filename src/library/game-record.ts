import { lookupGameOpening } from '../analysis/opening-lookup';
import type { Color } from '../core/rules';
import type { GameSource } from '../capture/game-id';
import { gameUrl } from '../capture/game-id';
import type { ValidGame } from '../capture/pgn-games';
import type { MyAccounts } from '../capture/protocol';
import { DEFAULT_USER_ACCOUNTS, type UserAccount } from '../review/perspective';
import type { StoredGameRecord } from '../storage/db';

export type NewGameRecord = Omit<StoredGameRecord, 'schemaVersion' | 'createdAt' | 'updatedAt'>;

export interface CaptureMeta {
  capturedAt?: number | null;
  method?: string | null;
}

function usable(value: string | undefined): string {
  const v = (value ?? '').trim();
  return v === '' || v === '?' || v === '-' ? '' : v;
}

function rating(value: string | undefined): number | null {
  const n = Number(usable(value));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** "2026.10.04" from a PGN date ('' when unknown or partly unknown). */
function pgnDate(headers: Readonly<Record<string, string>>): string {
  for (const field of ['UTCDate', 'Date']) {
    const v = usable(headers[field]);
    if (/^\d{4}\.\d{2}\.\d{2}$/.test(v)) return v;
  }
  return '';
}

/** When the game was played, from UTCDate + UTCTime (or Date + StartTime), in ms. */
export function playedAtFromHeaders(headers: Readonly<Record<string, string>>): number | null {
  const date = pgnDate(headers);
  if (!date) return null;
  const time = usable(headers.UTCTime) || usable(headers.StartTime) || '00:00:00';
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  const [y, mo, d] = date.split('.').map(Number) as [number, number, number];
  const ms = Date.UTC(y, mo - 1, d, m ? Number(m[1]) : 0, m ? Number(m[2]) : 0, m?.[3] ? Number(m[3]) : 0);
  return Number.isFinite(ms) ? ms : null;
}

/** A stored game from a checked PGN game. */
export function buildGameRecord(game: ValidGame, meta: CaptureMeta = {}): NewGameRecord {
  const h = game.headers;
  const mainLine = game.tree.getMainLine();
  const last = mainLine[mainLine.length - 1];
  const opening = last ? lookupGameOpening(game.tree, last.id) : null;
  return {
    id: game.key,
    white: usable(h.White) || 'White',
    black: usable(h.Black) || 'Black',
    // Best effort: my side is worked out again whenever the list is shown, since my
    // usernames can arrive after the game
    playerColor: 'w',
    result: game.tree.result,
    date: pgnDate(h),
    openingEco: opening?.eco ?? '',
    openingName: opening?.name ?? '',
    accuracy: null,
    pgn: game.pgn,
    tags: [],
    source: game.source,
    url: game.ref ? gameUrl(game.ref) : null,
    whiteElo: rating(h.WhiteElo),
    blackElo: rating(h.BlackElo),
    timeControl: usable(h.TimeControl),
    playedAt: playedAtFromHeaders(h),
    capturedAt: meta.capturedAt ?? null,
    captureMethod: meta.method ?? null,
    analysis: null,
  };
}

/** My accounts as the review's perspective uses them; the built-in default until set. */
export function accountsFromSettings(accounts: MyAccounts | null | undefined): UserAccount[] {
  const out: UserAccount[] = [];
  if (accounts?.lichess.trim()) out.push({ site: 'lichess', username: accounts.lichess.trim() });
  if (accounts?.chesscom.trim()) out.push({ site: 'chesscom', username: accounts.chesscom.trim() });
  return out.length > 0 ? out : [...DEFAULT_USER_ACCOUNTS];
}

/** My color in a stored game: when exactly one player is one of my accounts on its site. */
export function myColor(
  record: Pick<StoredGameRecord, 'white' | 'black' | 'source'>,
  accounts: readonly UserAccount[],
): Color | null {
  const source: GameSource = record.source ?? 'paste';
  const names = accounts
    .filter((a) => source === 'paste' || a.site === source)
    .map((a) => a.username.toLowerCase());
  const white = names.includes(record.white.toLowerCase());
  const black = names.includes(record.black.toLowerCase());
  if (white === black) return null;
  return white ? 'w' : 'b';
}

export type MyResult = 'win' | 'loss' | 'draw' | 'unfinished';

/** The result from my side (or White's, when it isn't my game). */
export function resultFor(result: StoredGameRecord['result'], color: Color | null): MyResult {
  if (result === '1/2-1/2') return 'draw';
  if (result === '*') return 'unfinished';
  const whiteWon = result === '1-0';
  return (color ?? 'w') === 'w' ? (whiteWon ? 'win' : 'loss') : whiteWon ? 'loss' : 'win';
}

/** "2+1", "3+0", "1 day", "–" from a PGN TimeControl. */
export function formatTimeControl(tc: string | undefined): string {
  const v = (tc ?? '').trim();
  const daily = /^1\/(\d+)$/.exec(v);
  if (daily) {
    const days = Math.round(Number(daily[1]) / 86400);
    return days === 1 ? '1 day' : `${days} days`;
  }
  const live = /^(\d+)(?:\+(\d+))?$/.exec(v);
  if (live) {
    const base = Number(live[1]);
    const minutes = base % 60 === 0 ? String(base / 60) : (base / 60).toFixed(base < 60 ? 2 : 1).replace(/\.?0+$/, '');
    return `${base < 60 ? `${base}s` : minutes}+${live[2] ?? '0'}`;
  }
  return v === '' || v === '-' ? '–' : v;
}
