import type { IDBPDatabase, StoreNames } from 'idb';
import {
  RELEASE_PENDING_KEY,
  RELEASE_STATE_KEY,
  outcomeOf,
  pickCard,
  pickEndgame,
  pickGame,
  pickPuzzle,
  pickRating,
  pickReleasePair,
  pickRepertoire,
  pickReview,
  pickRow,
  ratingDiffers,
  settingKind,
  type MergeOutcome,
  type MergeVerdict,
} from './backup-merge';
import { checkBackup } from './backup-validate';
import type {
  BackupPayload,
  StoredEndgameProgressRecord,
  StoredGameRecord,
  StoredPuzzleRecord,
  StoredRepertoireRecord,
  StoredReviewRecord,
  StoredSettingRecord,
  StoredSrsCardRecord,
  WizardChessDBSchema,
} from './db';

/**
 * Restoring a backup: validate the whole file, then merge it into the database in ONE read-write transaction, so a failure
 * anywhere leaves everything as it was. What a restore changes is decided by backup-merge.ts: progress that is newer here
 * is kept, older or missing records are filled in from the file, and the settings that are choices rather than progress
 * (preferences, usernames, bots and books, bookkeeping) are replaced by the file's, as a restore always did.
 *
 * Nothing in the transaction waits for anything but the database's own requests (any other wait lets the browser commit it
 * early), and the module reads no clock and touches nothing outside the database it is given.
 */

/** Why a file was not restored; `message` is written for the person who chose the file. */
export type BackupRefusalKind = 'not-json' | 'not-a-backup' | 'newer-schema' | 'damaged';

export class BackupRefusedError extends Error {
  public readonly kind: BackupRefusalKind;
  public constructor(kind: BackupRefusalKind, message: string) {
    super(message);
    this.name = 'BackupRefusedError';
    this.kind = kind;
  }
}

export const NOT_JSON_MESSAGE = 'This file is not an Afterplay backup (not JSON).';
export const NOT_A_BACKUP_MESSAGE = 'This file is not an Afterplay backup.';
export const NEWER_SCHEMA_MESSAGE =
  'This backup was made by a newer version of Afterplay. Update the app, then try again.';

/** Reads a backup's text; throws a `BackupRefusedError` with a readable message when it is not JSON. */
export function parseBackupText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new BackupRefusedError('not-json', NOT_JSON_MESSAGE);
  }
}

/**
 * Throws the refusal a parsed file earns, if any: not a backup, from a newer version of the app, or with damaged records.
 * Returns what the check counted (the lists, whether preferences and bots are in it).
 */
export function assertRestorable(parsed: unknown, latestSchemaVersion: number): ReturnType<typeof checkBackup> {
  const check = checkBackup(parsed, latestSchemaVersion);
  if (check.refusal === 'not-a-backup') throw new BackupRefusedError('not-a-backup', NOT_A_BACKUP_MESSAGE);
  if (check.refusal === 'newer-schema') throw new BackupRefusedError('newer-schema', NEWER_SCHEMA_MESSAGE);
  if (check.damagedTotal > 0) {
    const n = check.damagedTotal;
    throw new BackupRefusedError(
      'damaged',
      `${n.toLocaleString('en-US')} ${n === 1 ? 'record' : 'records'} in this file ${n === 1 ? 'is' : 'are'} damaged.`,
    );
  }
  return check;
}

/** What happened to the records of one list. */
export type StoreCounts = Record<MergeOutcome, number>;

/** How the two puzzle ratings compare: the file had none, they agree, or the one kept (the newer one). */
export type RatingNote = 'none' | 'same' | 'this-device' | 'file';

export interface RestoreReport {
  games: StoreCounts;
  reviews: StoreCounts;
  puzzles: StoreCounts;
  srsCards: StoreCounts;
  repertoires: StoreCounts;
  endgameProgress: StoreCounts;
  /** The progress rows in the settings store: puzzle rating, release schedule, drill statistics, bookkeeping kept. */
  progressSettings: StoreCounts;
  /** Settings rows written exactly as the file has them (preferences, usernames, bots and books, import bookkeeping). */
  overwrittenSettings: number;
  rating: RatingNote;
  /** The file's preferences row (written to the database), or null when the file has none. */
  preferences: unknown;
}

const emptyCounts = (): StoreCounts => ({ added: 0, updated: 0, keptNewer: 0, unchanged: 0 });

/** Records the restore wrote into a list. */
export const written = (counts: StoreCounts): number => counts.added + counts.updated;

/** How many requests are in flight at once while a list is merged. */
const BATCH = 200;

interface LooseStore {
  get(key: string): Promise<unknown>;
  put(value: unknown): Promise<unknown>;
}

const STORES = [
  'settings',
  'games',
  'puzzles',
  'srs_cards',
  'repertoires',
  'endgame_progress',
  'reviews',
] as const satisfies readonly StoreNames<WizardChessDBSchema>[];

/** Merges one list of records (each has a string `id`) into its store. `pick` is null for a list that always overwrites. */
async function mergeList<T extends { id: string }>(
  store: LooseStore,
  records: readonly T[],
  pick: (local: T, file: T) => MergeVerdict,
  counts: StoreCounts,
): Promise<void> {
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const locals = (await Promise.all(chunk.map((record) => store.get(record.id)))) as Array<T | undefined>;
    const puts: Array<Promise<unknown>> = [];
    chunk.forEach((record, j) => {
      const local = locals[j];
      const outcome = outcomeOf(local !== undefined, local === undefined ? 'file' : pick(local, record));
      counts[outcome]++;
      if (outcome === 'added' || outcome === 'updated') puts.push(store.put(record));
    });
    await Promise.all(puts);
  }
}

/** The settings rows, each by its own rule; the report gets the rating comparison and the preferences row. */
async function mergeSettings(
  store: LooseStore,
  rows: readonly StoredSettingRecord[],
  report: RestoreReport,
): Promise<void> {
  const counts = report.progressSettings;
  const byKey = new Map(rows.map((row) => [row.key, row] as const));
  let schedule = false;
  for (const row of rows) {
    const kind = settingKind(row.key);
    if (kind === 'overwrite') {
      await store.put(row);
      report.overwrittenSettings++;
      if (row.key === 'app.preferences') report.preferences = row.value;
      continue;
    }
    if (kind === 'release-pair') {
      if (schedule) continue;
      schedule = true;
      const fileState = byKey.get(RELEASE_STATE_KEY);
      const filePending = byKey.get(RELEASE_PENDING_KEY);
      const localState = (await store.get(RELEASE_STATE_KEY)) as StoredSettingRecord | undefined;
      const localPending = (await store.get(RELEASE_PENDING_KEY)) as StoredSettingRecord | undefined;
      const verdict = pickReleasePair(localState, fileState);
      const pair: Array<[StoredSettingRecord | undefined, StoredSettingRecord | undefined]> = [
        [localState, fileState],
        [localPending, filePending],
      ];
      for (const [local, file] of pair) {
        if (!file) continue;
        // Both sides without a schedule: a row this device lacks is added; with a schedule on either side the pair
        // goes entirely to the winner
        const take = verdict === 'file' || (verdict === 'same' && !localState && !fileState && !local);
        counts[take ? (local ? 'updated' : 'added') : verdict === 'local' ? 'keptNewer' : 'unchanged']++;
        if (take) await store.put(file);
      }
      continue;
    }
    const local = (await store.get(row.key)) as StoredSettingRecord | undefined;
    let verdict: MergeVerdict = 'file';
    if (local) {
      if (kind === 'keep-local') verdict = 'local';
      else if (kind === 'rating') verdict = pickRating(local, row);
      else verdict = pickRow(local, row);
    }
    if (kind === 'rating' && local) {
      report.rating = !ratingDiffers(local, row) ? 'same' : verdict === 'file' ? 'file' : 'this-device';
    }
    // A bookkeeping row that is kept is not "newer here": it is simply left alone
    const outcome = kind === 'keep-local' && local ? 'unchanged' : outcomeOf(local !== undefined, verdict);
    counts[outcome]++;
    if (outcome === 'added' || outcome === 'updated') await store.put(row);
  }
}

const listOf = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/**
 * Restores a parsed backup into `db`: checks the file (throws `BackupRefusedError`, changing nothing), then merges every
 * list inside one transaction. Any other error aborts the transaction, so nothing is changed, and is rethrown.
 */
export async function restoreBackupPayload(
  db: IDBPDatabase<WizardChessDBSchema>,
  parsed: unknown,
  latestSchemaVersion: number,
): Promise<RestoreReport> {
  assertRestorable(parsed, latestSchemaVersion);
  const file = parsed as Partial<BackupPayload>;
  const report: RestoreReport = {
    games: emptyCounts(),
    reviews: emptyCounts(),
    puzzles: emptyCounts(),
    srsCards: emptyCounts(),
    repertoires: emptyCounts(),
    endgameProgress: emptyCounts(),
    progressSettings: emptyCounts(),
    overwrittenSettings: 0,
    rating: 'none',
    preferences: null,
  };

  // A list for a store this database does not have (an old schema) is skipped, as it always was
  const names = STORES.filter((name) => db.objectStoreNames.contains(name));
  const tx = db.transaction(names, 'readwrite');
  const store = (name: (typeof STORES)[number]): LooseStore => tx.objectStore(name) as unknown as LooseStore;
  try {
    await mergeSettings(store('settings'), listOf<StoredSettingRecord>(file.settings), report);
    await mergeList(store('games'), listOf<StoredGameRecord>(file.games), pickGame, report.games);
    if (names.includes('puzzles')) {
      await mergeList(store('puzzles'), listOf<StoredPuzzleRecord>(file.puzzles), pickPuzzle, report.puzzles);
    }
    if (names.includes('srs_cards')) {
      await mergeList(store('srs_cards'), listOf<StoredSrsCardRecord>(file.srsCards), pickCard, report.srsCards);
    }
    if (names.includes('repertoires')) {
      await mergeList(
        store('repertoires'),
        listOf<StoredRepertoireRecord>(file.repertoires),
        pickRepertoire,
        report.repertoires,
      );
    }
    if (names.includes('endgame_progress')) {
      await mergeList(
        store('endgame_progress'),
        listOf<StoredEndgameProgressRecord>(file.endgameProgress),
        pickEndgame,
        report.endgameProgress,
      );
    }
    if (names.includes('reviews')) {
      await mergeList(store('reviews'), listOf<StoredReviewRecord>(file.reviews), pickReview, report.reviews);
    }
    await tx.done;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Already finished or aborted
    }
    await tx.done.catch(() => undefined);
    throw err;
  }
  return report;
}

/** The counts `importBackupJson` has always returned, now of the records written (added or replaced). */
export function legacyCounts(report: RestoreReport): {
  gamesImported: number;
  settingsImported: number;
  puzzlesImported: number;
  srsCardsImported: number;
  repertoiresImported: number;
  endgameProgressImported: number;
  reviewsImported: number;
} {
  return {
    gamesImported: written(report.games),
    settingsImported: written(report.progressSettings) + report.overwrittenSettings,
    puzzlesImported: written(report.puzzles),
    srsCardsImported: written(report.srsCards),
    repertoiresImported: written(report.repertoires),
    endgameProgressImported: written(report.endgameProgress),
    reviewsImported: written(report.reviews),
  };
}
