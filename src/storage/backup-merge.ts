import type {
  StoredEndgameProgressRecord,
  StoredGameRecord,
  StoredPuzzleRecord,
  StoredRepertoireRecord,
  StoredReviewRecord,
  StoredSettingRecord,
  StoredSrsCardRecord,
} from './db';

/**
 * The rules that decide, record by record, what a restored backup changes (pure: no storage, no clock).
 *
 * The file's record and the one already here are compared by the time their progress was last changed, never field by
 * field: the winner is always a whole record. A tie keeps the record that is here, so restoring the same file twice
 * changes nothing. A missing or unusable time counts as 0. Records that are only in the file are added; records that are
 * only here are never touched (a backup cannot say that something was deleted).
 */

/** Which side wins: the file's record, the one here, or neither (a tie: the one here stays). */
export type MergeVerdict = 'file' | 'local' | 'same';

/** What happened to one record of the file. */
export type MergeOutcome = 'added' | 'updated' | 'keptNewer' | 'unchanged';

/** A time or counter as a number; anything that is not a finite number is 0. */
export function stamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Compares the keys in order: the first one that differs decides; all equal is a tie. */
function byKeys(local: readonly number[], file: readonly number[]): MergeVerdict {
  for (let i = 0; i < local.length; i++) {
    const l = local[i]!;
    const f = file[i]!;
    if (f > l) return 'file';
    if (f < l) return 'local';
  }
  return 'same';
}

/** What to tell about a record: it was not here, the file's won, the one here was newer, or they were level. */
export function outcomeOf(hasLocal: boolean, verdict: MergeVerdict): MergeOutcome {
  if (!hasLocal) return 'added';
  if (verdict === 'file') return 'updated';
  return verdict === 'local' ? 'keptNewer' : 'unchanged';
}

// ------------------------------------------------------------------------------------------------ records with ids

/**
 * Reviews: the later `updatedAt` (it is set only when a review is saved).
 */
export function pickReview(local: StoredReviewRecord, file: StoredReviewRecord): MergeVerdict {
  return byKeys([stamp(local.updatedAt)], [stamp(file.updatedAt)]);
}

const savedAtOf = (game: StoredGameRecord): number =>
  stamp((game.analysis as { savedAt?: unknown } | null | undefined)?.savedAt);

/**
 * Games. `updatedAt` is when the record was created on that device (an import, a played game saved), not when a review was
 * saved, so it cannot tell which copy holds the review. So: 1) the copy with the later review (`analysis.savedAt`, none = 0)
 * wins; 2) equal reviews and the same PGN: the same game, nothing to do; 3) equal reviews but another PGN (a played game
 * saved again after a takeback): the later `updatedAt`.
 */
export function pickGame(local: StoredGameRecord, file: StoredGameRecord): MergeVerdict {
  const byReview = byKeys([savedAtOf(local)], [savedAtOf(file)]);
  if (byReview !== 'same') return byReview;
  if (local.pgn === file.pgn) return 'same';
  return byKeys([stamp(local.updatedAt)], [stamp(file.updatedAt)]);
}

/**
 * Puzzles: the later attempt (`lastAttemptAt`), then the higher attempt count. `updatedAt` is not used: the scan of the
 * reviewed games and a release of puzzles change it without any progress.
 */
export function pickPuzzle(local: StoredPuzzleRecord, file: StoredPuzzleRecord): MergeVerdict {
  return byKeys([stamp(local.lastAttemptAt), stamp(local.attempts)], [stamp(file.lastAttemptAt), stamp(file.attempts)]);
}

/** Spaced-repetition cards of every deck: the later review (`lastReviewDate`, a new card = 0), then more repetitions. */
export function pickCard(local: StoredSrsCardRecord, file: StoredSrsCardRecord): MergeVerdict {
  return byKeys([stamp(local.lastReviewDate), stamp(local.reps)], [stamp(file.lastReviewDate), stamp(file.reps)]);
}

/** Repertoires: the later `updatedAt` (set by every save). */
export function pickRepertoire(local: StoredRepertoireRecord, file: StoredRepertoireRecord): MergeVerdict {
  return byKeys([stamp(local.updatedAt)], [stamp(file.updatedAt)]);
}

const drillTimeOf = (p: StoredEndgameProgressRecord): number =>
  p.lastAttemptAt !== undefined ? stamp(p.lastAttemptAt) : stamp(p.updatedAt);

/** Endgame drills: the later attempt (`lastAttemptAt`, else `updatedAt`, which only an attempt writes), then more attempts. */
export function pickEndgame(local: StoredEndgameProgressRecord, file: StoredEndgameProgressRecord): MergeVerdict {
  return byKeys([drillTimeOf(local), stamp(local.attempts)], [drillTimeOf(file), stamp(file.attempts)]);
}

// ------------------------------------------------------------------------------------------------ settings rows

/**
 * How a settings row is restored:
 * - `rating`: the puzzle rating, the row with the later rated attempt;
 * - `release-pair`: the schedule of the link's puzzle file (state and pending list), decided together;
 * - `newest-row`: drill statistics, the row with the later `updatedAt`;
 * - `keep-local`: bookkeeping that is derived on each device, taken from the file only when this device has none;
 * - `overwrite`: everything else (preferences, profile, usernames, bots and books, import and sync bookkeeping): choices
 *   and bookkeeping, not progress, so the file's row replaces the one here, as it always did.
 */
export type SettingKind = 'rating' | 'release-pair' | 'newest-row' | 'keep-local' | 'overwrite';

export const RATING_KEY = 'puzzles.rating';
export const RELEASE_STATE_KEY = 'puzzles.fromHistory.state';
export const RELEASE_PENDING_KEY = 'puzzles.fromHistory.pending';

export function settingKind(key: string): SettingKind {
  if (key === RATING_KEY) return 'rating';
  if (key === RELEASE_STATE_KEY || key === RELEASE_PENDING_KEY) return 'release-pair';
  if (key === 'puzzles.fromHistory.miss' || key === 'puzzles.personalSync') return 'keep-local';
  if (key.startsWith('viz.')) return 'newest-row';
  return 'overwrite';
}

/** Drill statistics: the later row `updatedAt`. */
export function pickRow(local: StoredSettingRecord, file: StoredSettingRecord): MergeVerdict {
  return byKeys([stamp(local.updatedAt)], [stamp(file.updatedAt)]);
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The time of the last rated attempt in a rating row (the latest `history[].at`), else the row's own `updatedAt`. */
export function ratingStamp(row: StoredSettingRecord): number {
  const history = asObject(row.value)?.history;
  let latest = 0;
  if (Array.isArray(history)) {
    for (const entry of history) latest = Math.max(latest, stamp(asObject(entry)?.at));
  }
  return latest > 0 ? latest : stamp(row.updatedAt);
}

/** The puzzle rating: the row with the later rated attempt. */
export function pickRating(local: StoredSettingRecord, file: StoredSettingRecord): MergeVerdict {
  return byKeys([ratingStamp(local)], [ratingStamp(file)]);
}

/** True when two rating rows say different things (the rating or the number of rated puzzles). */
export function ratingDiffers(local: StoredSettingRecord, file: StoredSettingRecord): boolean {
  const a = asObject(local.value);
  const b = asObject(file.value);
  return stamp(a?.rating) !== stamp(b?.rating) || stamp(a?.games) !== stamp(b?.games);
}

interface ReleaseInfo {
  input: string;
  released: number;
}

function releaseInfo(row: StoredSettingRecord | undefined): ReleaseInfo | null {
  const v = asObject(row?.value);
  if (!v || typeof v.input !== 'string') return null;
  const released = v.released;
  if (typeof released !== 'number' || !Number.isInteger(released) || released < 0) return null;
  return { input: v.input, released };
}

/**
 * The schedule of the link's puzzle file: the state row and the pending list are always taken from the same side, never
 * mixed. Both sides have a state for the same puzzle file (same `input`): the one with more puzzles released wins. Another
 * puzzle file: this device's stays. Only one side has a state: that side. Neither: a tie.
 */
export function pickReleasePair(
  localState: StoredSettingRecord | undefined,
  fileState: StoredSettingRecord | undefined,
): MergeVerdict {
  const l = releaseInfo(localState);
  const f = releaseInfo(fileState);
  if (!l && !f) return 'same';
  if (!l) return 'file';
  if (!f) return 'local';
  if (l.input !== f.input) return 'local';
  return byKeys([l.released], [f.released]);
}
