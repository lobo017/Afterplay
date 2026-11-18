import { defaultFetch } from '../preset/first-run';
import { puzzlesUrl } from '../preset/start-path';
import type { StoredGameRecord } from '../storage/db';
import { localDay, parseHistoryPuzzleFileAsync, type HistoryPuzzleFile } from './history-puzzles';
import type { PuzzleStore } from './puzzle-store';

/**
 * Fetches a link's puzzle file (`/start/<slug>/puzzles.json`, beside its history) and hands it to the puzzle store.
 * Same origin, no press, only for a device whose link has its games loaded; nothing is ever shown about it: a missing
 * file, a page where the file should be, a bad file or no network all leave the app as it was.
 */

export type PuzzleFileResult =
  /** No file (a 404, or the host answered with a page) or a file this version refuses. */
  | { kind: 'none' }
  | ({ kind: 'loaded' } & HistoryPuzzleFile)
  /** The request stopped (offline, timeout, a server error): try again at the next start. */
  | { kind: 'failed' };

export interface PuzzleFileOptions {
  slug: string;
  fetchFile?: (url: string, signal: AbortSignal) => Promise<Response>;
  timeoutMs?: number;
}

/** Never throws. */
export async function loadPuzzleFile(options: PuzzleFileOptions): Promise<PuzzleFileResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await (options.fetchFile ?? defaultFetch)(puzzlesUrl(options.slug), controller.signal);
    if (response.status === 404) return { kind: 'none' };
    if (!response.ok) return { kind: 'failed' };
    // A host that answers every unknown path with the app's page
    if (/text\/html/i.test(response.headers?.get('content-type') ?? '')) return { kind: 'none' };
    const parsed = await parseHistoryPuzzleFileAsync(await response.text());
    return parsed.ok ? { kind: 'loaded', input: parsed.input, entries: parsed.entries } : { kind: 'none' };
  } catch {
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

export interface SyncHistoryPuzzlesOptions {
  slug: string;
  store: PuzzleStore;
  /** All stored games (their dates order the puzzles), read only when a file is loaded. */
  listGames: () => Promise<readonly Pick<StoredGameRecord, 'id' | 'date' | 'playedAt'>[]>;
  getGame: (id: string) => Promise<Pick<StoredGameRecord, 'id' | 'date'> | undefined>;
  /** The clock (a test passes its own). */
  now?: () => number;
  fetchFile?: PuzzleFileOptions['fetchFile'];
  /**
   * The browser's lock manager (`navigator.locks`); by default the page's own. Without one the load and release run
   * unguarded, and the transaction in the store still keeps them consistent.
   */
  locks?: LockManagerLike | null;
}

/** The part of `navigator.locks` used here. */
export interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>;
}

/** One name for every page and tab of this origin: only one of them loads or releases puzzles at a time. */
export const HISTORY_PUZZLES_LOCK = 'afterplay-history-puzzles';

function pageLocks(): LockManagerLike | null {
  try {
    return typeof navigator !== 'undefined' && navigator.locks ? (navigator.locks as unknown as LockManagerLike) : null;
  } catch {
    return null;
  }
}

/**
 * One visit of the app: loads the puzzle file when this device has none yet (at most one request a local day while the
 * link has no usable file) and releases what is due. Returns how many puzzles were released. Never throws.
 */
export async function syncHistoryPuzzles(options: SyncHistoryPuzzlesOptions): Promise<number> {
  const locks = options.locks === undefined ? pageLocks() : options.locks;
  try {
    // Exclusive and waiting: a second page or tab asks after the first has finished, and then reads what it saved
    return locks
      ? await locks.request(HISTORY_PUZZLES_LOCK, { mode: 'exclusive' }, () => syncUnlocked(options))
      : await syncUnlocked(options);
  } catch {
    return 0;
  }
}

async function syncUnlocked(options: SyncHistoryPuzzlesOptions): Promise<number> {
  const { store, slug } = options;
  const clock = options.now ?? Date.now;
  try {
    if (!(await store.historyPuzzleState())) {
      if ((await store.historyPuzzleMissDay(slug)) === localDay(clock())) return 0;
      const result = await loadPuzzleFile({ slug, ...(options.fetchFile ? { fetchFile: options.fetchFile } : {}) });
      if (result.kind === 'failed') return 0;
      if (result.kind === 'none') {
        await store.markHistoryPuzzleMiss(slug, clock());
        return 0;
      }
      await store.loadHistoryPuzzles(result, slug, await options.listGames(), clock());
    }
    return await store.releaseHistoryPuzzles(options.getGame, clock());
  } catch {
    return 0;
  }
}
