/**
 * Stores the games of a link's history file (preset/first-run.ts fetches it). Batches of 200 go through
 * `saveSyncedGames`, which only adds: a stored game is never overwritten, so a load that stopped part-way continues
 * by skipping what is stored. The sync's month record is written only when the load finished and the device has none
 * (otherwise a half-loaded file would make the first sync skip months whose games are missing).
 */
import type { NewGameRecord } from '../library/game-record';
import type { HistoryGame, HistorySettingRecord } from '../preset/first-run';

export const HISTORY_BATCH_SIZE = 200;
/** The settings key of what the Story's imports have done (per source; only the link's file in this version). */
export const STORY_IMPORT_SETTING = 'story.import';

/** A record as it is stored (the parsed one's interrupted flag is derived, never stored). */
export function importRecordOf(file: Omit<FileImportState, 'interrupted'>): StoryImportRecord {
  return { version: 1, file };
}

export type ImportStatus = 'never' | 'running' | 'partial' | 'done';

export interface FileImportState {
  status: ImportStatus;
  /** Games of the file that are stored (new or already there). */
  loaded: number;
  total: number;
  /** The link the file belongs to ('' before any). */
  slug: string;
  /** Why it stopped, in words ('' when it did not). */
  failure: string;
  /** Never stored: true when a run was found "running" with nothing behind it (the app was closed or reloaded mid-load). */
  interrupted?: boolean;
}

export interface StoryImportRecord {
  version: 1;
  file: FileImportState;
}

export interface HistoryStore {
  listIds(): Promise<string[]>;
  saveSyncedGames(records: readonly NewGameRecord[]): Promise<string[]>;
  readSetting<T>(key: string): Promise<T | undefined>;
  writeSetting<T>(key: string, value: T): Promise<void>;
}

const NEVER: FileImportState = { status: 'never', loaded: 0, total: 0, slug: '', failure: '' };

/**
 * The stored record. A `running` found at start-up has no live run behind it, so it counts as `partial`: the Story
 * shows what is stored and offers Continue.
 */
export function parseImportRecord(value: unknown): StoryImportRecord {
  const file = (value as Partial<StoryImportRecord> | undefined)?.file;
  if (!file || typeof file !== 'object') return { version: 1, file: { ...NEVER } };
  const status: ImportStatus =
    file.status === 'done' ? 'done' : file.status === 'running' || file.status === 'partial' ? 'partial' : 'never';
  const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  return {
    version: 1,
    file: {
      status,
      loaded: num(file.loaded),
      total: num(file.total),
      slug: typeof file.slug === 'string' ? file.slug : '',
      failure: typeof file.failure === 'string' ? file.failure : '',
      ...(file.status === 'running' ? { interrupted: true } : {}),
    },
  };
}

export async function readImportRecord(store: Pick<HistoryStore, 'readSetting'>): Promise<StoryImportRecord> {
  return parseImportRecord(await store.readSetting<unknown>(STORY_IMPORT_SETTING));
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface StoreHistoryOptions {
  slug: string;
  games: readonly HistoryGame[];
  monthRecord: HistorySettingRecord | null;
  store: HistoryStore;
  /** After every batch (and once at the start): games of the file stored so far, of all. */
  onProgress?: (loaded: number, total: number) => void;
  /** Called with the saved ids after each batch (the Story recounts, at most every 2 s). */
  onBatch?: () => void;
}

export interface StoreHistoryResult {
  state: FileImportState;
  /** Games newly stored by this run. */
  added: number;
}

/** Stores a file's games. Never throws: a failure ends as a `partial` state that Continue picks up. */
export async function storeHistory(options: StoreHistoryOptions): Promise<StoreHistoryResult> {
  const { slug, games, store } = options;
  const total = games.length;
  let state: FileImportState = { status: 'running', loaded: 0, total, slug, failure: '' };
  let added = 0;
  const save = async (next: FileImportState): Promise<void> => {
    state = next;
    await store
      .writeSetting<StoryImportRecord>(STORY_IMPORT_SETTING, { version: 1, file: next })
      .catch(() => undefined);
  };
  try {
    const stored = new Set(await store.listIds());
    const fresh = games.filter((g) => !stored.has(g.id));
    let loaded = total - fresh.length;
    await save({ ...state, loaded });
    options.onProgress?.(loaded, total);
    for (let i = 0; i < fresh.length; i += HISTORY_BATCH_SIZE) {
      const batch = fresh.slice(i, i + HISTORY_BATCH_SIZE);
      const saved = await store.saveSyncedGames(batch as unknown as NewGameRecord[]);
      added += saved.length;
      loaded += batch.length;
      await save({ ...state, loaded });
      options.onProgress?.(loaded, total);
      options.onBatch?.();
      await yieldToEventLoop();
    }
    if (options.monthRecord && (await store.readSetting(options.monthRecord.key)) === undefined) {
      await store.writeSetting(options.monthRecord.key, options.monthRecord.value);
    }
    await save({ ...state, status: 'done', loaded: total });
  } catch (err) {
    await save({
      ...state,
      status: 'partial',
      failure: `Stopped: ${err instanceof Error ? err.message : 'the games could not be stored'}.`,
    });
  }
  return { state, added };
}
