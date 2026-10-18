import type { CaptureSite } from '../../src/capture/game-id';
import type { BridgeGame, MyAccounts } from '../../src/capture/protocol';
import type { BackfillSiteState } from './backfill';
import type { AddOutcome, QueueCounts, QueueEntry } from './queue';
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
    }
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
  | { kind: 'bridge-delivered'; keys: string[] };

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
