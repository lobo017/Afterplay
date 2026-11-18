import type { Color } from '../core/rules';
import { isErrorClass } from './classification';
import { findKeyMoments, KEY_MOMENT_MIN_SWING } from './review-game';
import type { GameReview, KeyMoment, MoveClassification, ReviewedMove } from './types';

/** Whose review the panel shows: one side's, or both (the two-sided view). */
export type ReviewPerspective = Color | 'both';

export interface UserAccount {
  site: 'lichess' | 'chesscom';
  username: string;
}

/**
 * My accounts before any are saved: none. Until a username is entered (Settings › Your games), comes with a
 * first-run link's preset, or is sent by the capture extension, no game is taken for mine: a review opens on Both,
 * and a stored game has no "my color" (library/game-record.ts, accountsFromSettings).
 */
export const DEFAULT_USER_ACCOUNTS: readonly UserAccount[] = [];

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

/** A key moment as the panel shows it. */
export interface ShownKeyMoment extends KeyMoment {
  /**
   * Set on a Brilliant or Great move that is shown for its class, not for its swing (such a move barely changes the
   * winning chances, so the swings alone never include it).
   */
  highlight?: 'Brilliant' | 'Great';
}

/** The most key moments shown: five chips are three rows on a phone, and three rows are reserved. */
export const KEY_MOMENTS_SHOWN_MAX = 5;
/** The largest swings that a Brilliant or Great move never pushes out. */
const KEY_MOMENT_SWINGS_KEPT = 3;
/** The most Brilliant and Great moves added to the swings. */
const KEY_MOMENT_HIGHLIGHTS_MAX = 2;

/** The move's signed change in White's win% (what a key moment's `swing` holds). */
function whiteSwing(move: ReviewedMove): number {
  const whiteBefore = move.color === 'w' ? move.winBefore : 100 - move.winBefore;
  return move.whiteWinAfter - whiteBefore;
}

/**
 * The key moments shown for a perspective, in game order: the review's swings (the game's for Both, one side's drops
 * otherwise) plus up to two of the perspective's Brilliant and Great moves, five at most.
 *
 * - The three largest swings always stay.
 * - Then the highlights: Brilliant before Great, then the larger swing, then the earlier move.
 * - What room is left goes to the next largest swings.
 *
 * With no Brilliant or Great move to add, the swings are returned as they are (for Both, `review.keyMoments` itself).
 */
export function perspectiveKeyMoments(review: GameReview, perspective: ReviewPerspective): ShownKeyMoment[] {
  const swings = perspective === 'both' ? review.keyMoments : findKeyMoments(review.moves, perspective);
  const highlights = review.moves
    .filter(
      (m): m is ReviewedMove & { classification: 'Brilliant' | 'Great' } =>
        coversMove(perspective, m) && (m.classification === 'Brilliant' || m.classification === 'Great'),
    )
    .map((move) => ({ move, swing: whiteSwing(move) }))
    .sort(
      (a, b) =>
        Number(b.move.classification === 'Brilliant') - Number(a.move.classification === 'Brilliant') ||
        Math.abs(b.swing) - Math.abs(a.swing) ||
        a.move.ply - b.move.ply,
    );
  if (highlights.length === 0) return swings;

  const bySize = [...swings].sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing) || a.ply - b.ply);
  const shown = new Map<string, ShownKeyMoment>();
  for (const k of bySize.slice(0, KEY_MOMENT_SWINGS_KEPT)) shown.set(k.nodeId, k);
  let added = 0;
  for (const { move, swing } of highlights) {
    if (added >= KEY_MOMENT_HIGHLIGHTS_MAX || shown.size >= KEY_MOMENTS_SHOWN_MAX) break;
    // Already shown for its swing: once is enough, and it keeps its swing
    if (shown.has(move.nodeId)) continue;
    const asSwing = swings.find((k) => k.nodeId === move.nodeId);
    shown.set(
      move.nodeId,
      asSwing ?? {
        ply: move.ply,
        nodeId: move.nodeId,
        swing,
        label: `${move.moveNumber}${move.color === 'w' ? '.' : '...'} ${move.san} — ${move.classification}`,
        highlight: move.classification,
      },
    );
    added++;
  }
  for (const k of bySize.slice(KEY_MOMENT_SWINGS_KEPT)) {
    if (shown.size >= KEY_MOMENTS_SHOWN_MAX) break;
    if (!shown.has(k.nodeId)) shown.set(k.nodeId, k);
  }
  return [...shown.values()].sort((a, b) => a.ply - b.ply);
}

/**
 * The one key moment a stored summary (made in advance, no per-move data) can name: my move with the largest win% loss.
 * `swing` is in my favour (negative: the loss), as a key moment's swing is for that side. Null when the summary names no
 * move, the move is not one of my plies, or the loss is under the review's own key-moment minimum. Does not use
 * `findKeyMoments`.
 */
export function storedKeyMoment(
  side: { drop: number; dropPly: number | null } | undefined,
  color: Color,
): { ply: number; swing: number } | null {
  const ply = side?.dropPly;
  if (!side || typeof ply !== 'number' || !Number.isInteger(ply) || ply < 1) return null;
  if ((ply % 2 === 1) !== (color === 'w')) return null;
  if (!Number.isFinite(side.drop) || side.drop < KEY_MOMENT_MIN_SWING) return null;
  return { ply, swing: -side.drop };
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
