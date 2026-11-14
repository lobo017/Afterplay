/**
 * The Story's "Start import": what the Chess.com sync's outcome means on Games › Story. The sync itself is
 * `runChessComSync` (sync/chesscom-sync.ts); this file only keeps a small record of how far an import got (so a closed
 * app can offer Continue) and turns a sync's failure into the plain message the Story shows.
 *
 * A failure is one of two things on screen: an error on a username field (the name is wrong), or a pause with
 * Continue (the network, a timeout, the rate limit). Nothing here retries; a pause waits for a press.
 */
import type { SyncFailure } from '../sync/chesscom-sync';

/** The settings key of the sync import's record (the history file's own is `story.import`). */
export const STORY_SYNC_IMPORT_SETTING = 'story.import.chesscom';

export type SyncImportStatus = 'never' | 'running' | 'partial' | 'done';

export interface SyncImportRecord {
  version: 1;
  status: SyncImportStatus;
  /** Months dealt with and months listed, for the account the import was in. */
  monthsDone: number;
  monthsTotal: number;
  /** Games added by the import so far (all its runs and accounts). */
  games: number;
  /** Why it stopped, in words ('' when it did not). */
  failure: string;
  /** Never stored: true when a run was found "running" with nothing behind it (the app was closed mid-import). */
  interrupted?: boolean;
}

export const EMPTY_SYNC_IMPORT: Readonly<SyncImportRecord> = Object.freeze({
  version: 1,
  status: 'never',
  monthsDone: 0,
  monthsTotal: 0,
  games: 0,
  failure: '',
});

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** The stored record. A `running` found at start-up has no live run behind it, so it counts as `partial`. */
export function parseSyncImportRecord(value: unknown): SyncImportRecord {
  if (!value || typeof value !== 'object') return { ...EMPTY_SYNC_IMPORT };
  const v = value as Partial<SyncImportRecord>;
  const status: SyncImportStatus =
    v.status === 'done' ? 'done' : v.status === 'running' || v.status === 'partial' ? 'partial' : 'never';
  return {
    version: 1,
    status,
    monthsDone: count(v.monthsDone),
    monthsTotal: count(v.monthsTotal),
    games: count(v.games),
    failure: typeof v.failure === 'string' ? v.failure : '',
    ...(v.status === 'running' ? { interrupted: true } : {}),
  };
}

const n = (value: number): string => value.toLocaleString('en-US');

/** "Chess.com: 14 of 63 months · 1,240 games"; with several accounts the line says which one it is in. */
export function importProgressLine(p: {
  monthsDone: number;
  monthsTotal: number;
  games: number;
  accountIndex?: number;
  accountCount?: number;
}): string {
  const which = (p.accountCount ?? 1) > 1 ? ` (account ${(p.accountIndex ?? 0) + 1} of ${p.accountCount})` : '';
  const months = `${n(p.monthsDone)} of ${n(p.monthsTotal)} ${p.monthsTotal === 1 ? 'month' : 'months'}`;
  return `Chess.com${which}: ${months} · ${n(p.games)} ${p.games === 1 ? 'game' : 'games'}`;
}

/** What the Story does with a failed sync. */
export type ImportFailure =
  /** The username is wrong: say so on its field. */
  | { kind: 'field'; message: string }
  /** The import stops and waits for Continue. */
  | { kind: 'pause'; message: string };

const KEPT = 'What was read is kept.';

export function importFailureOf(failure: SyncFailure, detail = ''): ImportFailure {
  switch (failure) {
    case 'no-username':
      return { kind: 'field', message: 'Add your Chess.com username first.' };
    case 'bad-username':
      return {
        kind: 'field',
        message: 'That username does not look right. Chess.com names are 3 to 25 letters, digits, - or _.',
      };
    case 'unknown-player':
      return { kind: 'field', message: 'Chess.com does not know a player with that username.' };
    case 'offline':
      return { kind: 'pause', message: `You are offline. Connect to the internet, then press Continue. ${KEPT}` };
    case 'network':
      return {
        kind: 'pause',
        message: `Chess.com could not be reached. Check your connection, then press Continue. ${KEPT}`,
      };
    case 'timeout':
      return { kind: 'pause', message: `Chess.com did not answer in time. Press Continue to try again. ${KEPT}` };
    case 'rate-limited':
      return {
        kind: 'pause',
        message: `Chess.com asked for fewer requests. Wait a few minutes, then press Continue. ${KEPT}`,
      };
    case 'list':
      return {
        kind: 'pause',
        message: `Chess.com's list of your archives could not be read${detail ? ` (${detail})` : ''}. Try Continue in a little while. ${KEPT}`,
      };
  }
}
