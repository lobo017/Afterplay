import type { Color } from '../core/rules';
import { isErrorClass } from './classification';
import { findKeyMoments } from './review-game';
import type { GameReview, KeyMoment, MoveClassification, ReviewedMove } from './types';

/** Whose review the panel shows: one side's, or both (the two-sided view). */
export type ReviewPerspective = Color | 'both';

export interface UserAccount {
  site: 'lichess' | 'chesscom';
  username: string;
}

/**
 * The fallback for my accounts, used to pick my side of an imported game until the capture
 * extension has sent the usernames from its settings (library/game-record.ts,
 * accountsFromSettings).
 */
export const DEFAULT_USER_ACCOUNTS: readonly UserAccount[] = [{ site: 'lichess', username: 'Lobo017' }];

const SITE_HOST: Record<UserAccount['site'], string> = {
  lichess: 'lichess.org',
  chesscom: 'chess.com',
};

/** The account's site matches the PGN's Site header, or the header doesn't name a site. */
function siteMatches(siteHeader: string | undefined, account: UserAccount): boolean {
  const site = (siteHeader ?? '').toLowerCase();
  const named = Object.values(SITE_HOST).filter((host) => site.includes(host));
  return named.length === 0 || named.includes(SITE_HOST[account.site]);
}

/** My side of the game when exactly one player is one of my accounts; otherwise Both. */
export function defaultPerspective(
  headers: Readonly<Record<string, string>>,
  accounts: readonly UserAccount[] = DEFAULT_USER_ACCOUNTS,
): ReviewPerspective {
  const isMe = (name: string | undefined) => {
    const n = (name ?? '').trim().toLowerCase();
    return n !== '' && accounts.some((a) => a.username.toLowerCase() === n && siteMatches(headers.Site, a));
  };
  const white = isMe(headers.White);
  const black = isMe(headers.Black);
  if (white === black) return 'both';
  return white ? 'w' : 'b';
}

export interface PlayerInfo {
  color: Color;
  /** The player's name, or "White" / "Black" when the PGN has none. */
  name: string;
  rating: number | null;
}

function usable(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  return v === '' || v === '?' || v === '-' ? null : v;
}

export function playerInfo(headers: Readonly<Record<string, string>>, color: Color): PlayerInfo {
  const side = color === 'w' ? 'White' : 'Black';
  const rating = Number(usable(headers[`${side}Elo`]));
  return {
    color,
    name: usable(headers[side]) ?? side,
    rating: Number.isFinite(rating) && rating > 0 ? rating : null,
  };
}

/** What follows the name: "1397 · Black"; the color is left out when it is already the name. */
export function playerMeta(info: PlayerInfo): string {
  const side = info.color === 'w' ? 'White' : 'Black';
  return [info.rating === null ? null : String(info.rating), info.name === side ? null : side]
    .filter((p) => p !== null)
    .join(' · ');
}

/** "Lobo017 · 1397 · Black". */
export function playerHeading(info: PlayerInfo): string {
  return [info.name, playerMeta(info)].filter(Boolean).join(' · ');
}

export function coversMove(perspective: ReviewPerspective, move: ReviewedMove): boolean {
  return perspective === 'both' || move.color === perspective;
}

/** The errors (Inaccuracy, Mistake, Blunder, Miss) a perspective covers, in game order. */
export function perspectiveErrors(moves: readonly ReviewedMove[], perspective: ReviewPerspective): ReviewedMove[] {
  return moves.filter((m) => coversMove(perspective, m) && isErrorClass(m.classification));
}

/** Moves of one class by one side, in game order (what a click on a count cycles through). */
export function movesOfClass(
  moves: readonly ReviewedMove[],
  color: Color,
  classification: MoveClassification,
): ReviewedMove[] {
  return moves.filter((m) => m.color === color && m.classification === classification);
}

export function perspectiveKeyMoments(review: GameReview, perspective: ReviewPerspective): KeyMoment[] {
  return perspective === 'both' ? review.keyMoments : findKeyMoments(review.moves, perspective);
}

/** The win% series from the perspective's side (White's for Both). */
export function perspectiveSeries(
  whiteSeries: ReadonlyArray<number | null>,
  perspective: ReviewPerspective,
): Array<number | null> {
  return whiteSeries.map((w) => (w === null || perspective !== 'b' ? w : 100 - w));
}

/**
 * The next (dir 1) or previous (dir −1) entry after the current ply, wrapping around
 * the ends. Null for an empty list.
 */
export function stepCycle<T extends { ply: number }>(items: readonly T[], currentPly: number, dir: 1 | -1): T | null {
  if (items.length === 0) return null;
  if (dir === 1) return items.find((m) => m.ply > currentPly) ?? items[0]!;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.ply < currentPly) return items[i]!;
  }
  return items[items.length - 1]!;
}
