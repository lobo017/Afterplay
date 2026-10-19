import type { CaptureSite, SiteGameRef } from '../../src/capture/game-id';
import type { AutoSyncSiteState } from './auto-sync';
import type { PageKind } from './pages';
import type { BridgeGame, MyAccounts } from '../../src/capture/protocol';
import type { BackfillSiteState } from './backfill';
import type { AddOutcome, CaptureTrigger, QueueCounts, QueueEntry } from './queue';
import type { ExtensionSettings, SettingsProblem } from './settings';

/** Messages to the background service worker (from content scripts and the popup). */
export type ExtRequest =
  | {
      kind: 'capture';
      site: CaptureSite;
      gameId: string;
      pgn: string;
      method: string;
      url: string;
      /** Captured automatically when the game ended (not by the Save button). */
      auto: boolean;
      trigger: CaptureTrigger;
    }
  | { kind: 'page-state'; status: PageStatus }
  | { kind: 'capture-failed'; url: string; error: string; auto: boolean }
  | { kind: 'lookup'; key: string }
  | { kind: 'get-settings' }
  | { kind: 'save-settings'; settings: ExtensionSettings }
  | { kind: 'status' }
  | { kind: 'save-text'; text: string }
  | { kind: 'retry'; key: string }
  | { kind: 'remove'; key: string }
  | { kind: 'dismiss-failure' }
  | { kind: 'backfill-start'; site: CaptureSite }
  | { kind: 'backfill-stop'; site: CaptureSite }
  | { kind: 'bridge-hello' }
  | { kind: 'bridge-batch'; max: number; exclude: string[] }
  | { kind: 'bridge-delivered'; keys: string[] }
  | { kind: 'debug-background'; tabId: number | null; url: string | null }
  | { kind: 'inject-tab'; tabId: number; url: string }
  | { kind: 'sync-now' };

/** Messages the background and the popup send to content scripts (chrome.tabs.sendMessage). */
export type TabRequest = { kind: 'debug-tab' } | { kind: 'bridge-nudge' };

export type GameState = 'checking' | 'in-progress' | 'finished' | 'aborted' | 'not-found';

/**
 * What a game-site content script knows about its page; sent to the background on every
 * change (it decides what to do when the page is left) and shown by "Debug this tab".
 */
export interface PageStatus {
  url: string;
  kind: PageKind;
  /** The game on the page: from the URL, or (Chess.com play pages) from the page's requests. */
  ref: SiteGameRef | null;
  /** Where the game ID came from: "the URL", "the page's requests (…)". */
  refSource: string | null;
  state: GameState | null;
  /** Where the state came from: "page data", "game data (callback)", "Lichess game stream". */
  stateSource: string | null;
  white: string | null;
  black: string | null;
  /** My game: true / false, null when it can't be told (no username, spectator view). */
  mine: boolean | null;
  /** How `mine` was decided, for the Debug view. */
  mineReason: string;
  /** The page saw the game in progress (so it was played or watched live). */
  sawInProgress: boolean;
  startedAt: number | null;
  endedAt: number | null;
  /** The queue has it (ready or delivered), or this page captured it. */
  captured: boolean;
  /** The Save button's state ('' when there is none). */
  button: string;
  /** What is watched for the end: "Lichess game stream: connected, 34 positions", … */
  watching: string[];
}

export interface DebugEvent {
  at: number;
  text: string;
}

/** The content script's answer to "Debug this tab". */
export interface ContentDebugInfo {
  site: CaptureSite;
  extensionVersion: string;
  scriptStartedAt: number;
  status: PageStatus;
  events: DebugEvent[];
}

/** The background's part of "Debug this tab". */
export interface BackgroundDebugInfo {
  settings: { lichessUsername: string; chesscomUsername: string; autoCapture: boolean; siteUrl: string };
  /** What the background last heard from this tab (null: nothing). */
  tracked: (PageStatus & { updatedAt: number }) | null;
  /** The site's automatic sync (null when the tab isn't on a game site). */
  sync: { site: CaptureSite; state: AutoSyncSiteState; enabled: boolean; why: string } | null;
  entry: QueueEntry | null;
  /** The last time a game page of this site was left, and what came of it. */
  lastLeave: LeaveRecord | null;
  siteTabOpen: boolean;
}

export interface LeaveRecord {
  at: number;
  url: string;
  /** "captured (left-page)", "skipped: not my game", "synced only: no game ID on the page". */
  result: string;
}

export type CaptureReply = { ok: true; key: string; outcome: AddOutcome } | { ok: false; error: string };

export interface SaveTextResult {
  /** What was saved: "GEU3 vs Lobo017", or the link. */
  label: string;
  ok: boolean;
  /** For saved games: what happened in the queue ('pending' = waiting for the site's archive). */
  outcome?: AddOutcome | 'pending';
  error?: string;
}

export interface LastFailure {
  url: string;
  error: string;
  at: number;
}

export interface StatusReply {
  entries: QueueEntry[];
  counts: QueueCounts;
  settings: ExtensionSettings;
  lastFailure: LastFailure | null;
  backfill: Record<CaptureSite, BackfillSiteState>;
  autoSync: Record<CaptureSite, AutoSyncSiteState>;
  /** The analysis site is open in a tab (games go to it right away). */
  siteTabOpen: boolean;
  extensionVersion: string;
}

export type SaveSettingsReply = { ok: true; settings: ExtensionSettings } | { ok: false; problem: SettingsProblem };

export interface BridgeHelloReply {
  extensionVersion: string;
  accounts: MyAccounts;
}

export interface BridgeBatchReply {
  games: BridgeGame[];
  remaining: number;
}
