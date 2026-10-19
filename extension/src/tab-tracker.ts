import type { CaptureSite } from '../../src/capture/game-id';
import { isMyGame, isRecentGame } from './capture-rules';
import type { CaptureCheck } from './capture-service';
import type { PageStatus } from './messages';
import { classifyPage, pageKey } from './pages';
import type { ExtensionSettings } from './settings';

/**
 * What the background knows about each Lichess / Chess.com tab, so it can act when I leave
 * a game page (close the tab, go elsewhere): the content script's last report, or only
 * the URL when no script reported (a tab opened before the extension was loaded). Kept in
 * chrome.storage.session (the service worker stops when idle; tab IDs don't survive a
 * browser restart, and neither does this).
 */
export interface TrackedTab extends PageStatus {
  tabId: number;
  site: CaptureSite;
  updatedAt: number;
  /** The content script reported this page (false: known from the tab's URL only). */
  reported: boolean;
}

export type TrackedTabs = Record<string, TrackedTab>;

export const TRACKED_TABS_KEY = 'trackedTabs';

/** A tab known from its URL only. */
export function tabFromUrl(tabId: number, url: string, now: number): TrackedTab | null {
  const page = classifyPage(url);
  if (!page) return null;
  return {
    tabId,
    site: page.site,
    url,
    kind: page.kind,
    ref: page.ref,
    refSource: page.ref ? 'the URL' : null,
    state: null,
    stateSource: null,
    white: null,
    black: null,
    mine: null,
    mineReason: 'not reported by the page',
    sawInProgress: false,
    startedAt: null,
    endedAt: null,
    captured: false,
    button: '',
    watching: [],
    updatedAt: now,
    reported: false,
  };
}

/** The tab after its content script's report. */
export function tabFromReport(tabId: number, status: PageStatus, now: number): TrackedTab | null {
  const page = classifyPage(status.url);
  if (!page) return null;
  return { ...status, tabId, site: page.site, updatedAt: now, reported: true };
}

/** The tab now shows another page than the tracked one (`url` undefined: a page off the game sites). */
export function hasLeft(tab: TrackedTab, url: string | undefined): boolean {
  if (url === undefined) return true;
  return pageKey(url) !== pageKey(tab.url);
}

export interface LeaveAction {
  /** Fetch the game from the background and queue it if it's finished and mine. */
  capture: boolean;
  /** Sync the site's recent games (the safety net). */
  sync: boolean;
  /** Why not capture, for the Debug view and the log. */
  reason: string;
}

/** What leaving the tab's page calls for. */
export function leaveAction(tab: TrackedTab): LeaveAction {
  if (tab.kind === 'other') return { capture: false, sync: false, reason: 'not a game page' };
  if (!tab.ref) return { capture: false, sync: true, reason: 'no game ID on the page' };
  if (tab.captured) return { capture: false, sync: true, reason: 'already captured' };
  if (tab.state === 'aborted') return { capture: false, sync: true, reason: 'the game was aborted' };
  if (tab.state === 'not-found') return { capture: false, sync: true, reason: 'the site has no such game' };
  // 'not-available' (Chess.com has no data until a live game ends) is captured, with retries
  if (tab.mine === false) return { capture: false, sync: true, reason: 'not my game' };
  return { capture: true, sync: true, reason: '' };
}

/**
 * The check a game left behind must pass to be queued: mine (my username for the site, or
 * the page said I'm a player), and just played (the page saw it in progress, or it ended
 * or started within the recent window).
 */
export function leaveCaptureCheck(tab: TrackedTab, settings: ExtensionSettings, now: number): CaptureCheck {
  return (facts) => {
    const mine = isMyGame(facts, settings, tab.site, tab.mine);
    if (mine === false) return 'not my game';
    if (mine === null) return `can't tell whether it's my game: set my ${tab.site === 'lichess' ? 'Lichess' : 'Chess.com'} username`;
    if (tab.sawInProgress) return null;
    if (isRecentGame({ startedAt: facts.playedAt ?? tab.startedAt, endedAt: tab.endedAt }, now)) return null;
    return 'not a recent game';
  };
}
