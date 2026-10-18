import type { CaptureSite } from '../../src/capture/game-id';

/** Progress of "Import my history" for one site, kept in storage between service-worker runs. */
export interface BackfillSiteState {
  status: 'idle' | 'running' | 'waiting' | 'done' | 'error';
  /** Username the import runs for (the setting when it started). */
  username: string;
  /** Games added to the queue by imports so far. */
  imported: number;
  /** Human-readable progress / reason ("2026/09 of 2026/10", "Rate limited, retrying at 14:05"). */
  message: string;
  updatedAt: number;
}

export const IDLE_BACKFILL: BackfillSiteState = { status: 'idle', username: '', imported: 0, message: '', updatedAt: 0 };

export const BACKFILL_SITES: readonly CaptureSite[] = ['lichess', 'chesscom'];
