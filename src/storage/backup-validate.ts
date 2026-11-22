/**
 * Checks a parsed backup before anything is written (pure: no storage, no DOM). A file is refused whole, never in part:
 * a restore that skipped damaged records would be a half restore, and one that wrote them would stop in the middle.
 *
 * The rules, by name (the names are what a count of problems is reported under, never a record):
 * - `field-type`: a list that should be a list is something else;
 * - `record-not-object`: a record that is not an object;
 * - `record-key`: a record without a usable key (`id`, or `key` for a setting);
 * - `stamp-type`: a time or counter a rule reads (`updatedAt`, `lastAttemptAt`, `analysis.savedAt` ...) that is present
 *   and is not a number (an absent one, or null, is fine: it counts as 0);
 * - `duplicate-key`: the same key twice in one list.
 */
export type DamageRule = 'field-type' | 'record-not-object' | 'record-key' | 'stamp-type' | 'duplicate-key';

export const DAMAGE_RULES: readonly DamageRule[] = [
  'field-type',
  'record-not-object',
  'record-key',
  'stamp-type',
  'duplicate-key',
];

/** The lists of a backup, the field that is a record's key, and the fields a restore rule reads as numbers. */
const LISTS = [
  { list: 'games', key: 'id', stamps: ['updatedAt', 'analysis.savedAt'] },
  { list: 'settings', key: 'key', stamps: ['updatedAt'] },
  { list: 'puzzles', key: 'id', stamps: ['lastAttemptAt', 'attempts'] },
  { list: 'srsCards', key: 'id', stamps: ['lastReviewDate', 'reps'] },
  { list: 'repertoires', key: 'id', stamps: ['updatedAt'] },
  { list: 'endgameProgress', key: 'id', stamps: ['lastAttemptAt', 'updatedAt', 'attempts'] },
  { list: 'reviews', key: 'id', stamps: ['updatedAt'] },
] as const;

export type BackupList = (typeof LISTS)[number]['list'];

export type BackupRefusal = 'not-a-backup' | 'newer-schema';

export interface BackupCheck {
  /** Why the file cannot be restored at all, if so. */
  refusal: BackupRefusal | null;
  schemaVersion: number | null;
  /** Records per list (a list that is missing or not a list counts 0). */
  counts: Record<BackupList, number>;
  /** How many problems each rule found. */
  damaged: Record<DamageRule, number>;
  damagedTotal: number;
  /** Whether the file has a row for the preferences (the check of what is in it is the restore's, not this one's). */
  hasPreferencesRow: boolean;
  /** Whether the file has any row of the personal bots' books. */
  hasBotRows: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function stampProblem(record: Record<string, unknown>, path: string): boolean {
  let value: unknown = record;
  for (const part of path.split('.')) {
    if (value === null || value === undefined) return false;
    if (!isObject(value)) return false;
    value = value[part];
  }
  if (value === undefined || value === null) return false;
  return typeof value !== 'number' || !Number.isFinite(value);
}

export function checkBackup(parsed: unknown, latestSchemaVersion: number): BackupCheck {
  const counts = Object.fromEntries(LISTS.map((l) => [l.list, 0])) as Record<BackupList, number>;
  const damaged = Object.fromEntries(DAMAGE_RULES.map((r) => [r, 0])) as Record<DamageRule, number>;
  const result: BackupCheck = {
    refusal: null,
    schemaVersion: null,
    counts,
    damaged,
    damagedTotal: 0,
    hasPreferencesRow: false,
    hasBotRows: false,
  };
  if (!isObject(parsed) || parsed.format !== 'wizards-chess-backup') {
    result.refusal = 'not-a-backup';
    return result;
  }
  const version = parsed.schemaVersion;
  if (version !== undefined) {
    if (typeof version !== 'number' || !Number.isFinite(version)) {
      result.refusal = 'not-a-backup';
      return result;
    }
    result.schemaVersion = version;
    if (version > latestSchemaVersion) {
      result.refusal = 'newer-schema';
      return result;
    }
  }

  for (const { list, key, stamps } of LISTS) {
    const records = parsed[list];
    if (records === undefined) continue;
    if (!Array.isArray(records)) {
      damaged['field-type']++;
      continue;
    }
    counts[list] = records.length;
    const seen = new Set<string>();
    for (const record of records) {
      if (!isObject(record)) {
        damaged['record-not-object']++;
        continue;
      }
      const id = record[key];
      if (typeof id !== 'string' || id === '') {
        damaged['record-key']++;
      } else if (seen.has(id)) {
        damaged['duplicate-key']++;
      } else {
        seen.add(id);
      }
      if (stamps.some((path) => stampProblem(record, path))) damaged['stamp-type']++;
      if (list === 'settings' && typeof id === 'string') {
        if (id === 'app.preferences') result.hasPreferencesRow = true;
        if (id.startsWith('bots.')) result.hasBotRows = true;
      }
    }
  }
  result.damagedTotal = DAMAGE_RULES.reduce((sum, rule) => sum + damaged[rule], 0);
  return result;
}
