import type { CaptureSite } from '../../src/capture/game-id';
import type { ExtensionSettings } from './settings';

/**
 * When a game counts as "just played" for automatic capture: it ended (or, when the end
 * isn't known, started) this recently. Opening an old game of mine shows the Save button
 * instead of capturing it.
 */
export const RECENT_GAME_MS = 6 * 3600_000;

export function isRecentGame(times: { startedAt?: number | null; endedAt?: number | null }, now: number): boolean {
  const at = times.endedAt ?? times.startedAt ?? null;
  return at !== null && now - at <= RECENT_GAME_MS;
}

export function myUsername(settings: ExtensionSettings, site: CaptureSite): string {
  return (site === 'lichess' ? settings.lichessUsername : settings.chesscomUsername).trim().toLowerCase();
}

/**
 * Did I play this game: my username for the site is one of the players; without a
 * username, what the site says (Lichess's non-spectator view), or null when nothing tells.
 */
export function isMyGame(
  players: { white: string; black: string },
  settings: ExtensionSettings,
  site: CaptureSite,
  viewerIsPlayer: boolean | null,
): boolean | null {
  const me = myUsername(settings, site);
  if (me !== '') return players.white.toLowerCase() === me || players.black.toLowerCase() === me;
  return viewerIsPlayer ? true : null;
}
