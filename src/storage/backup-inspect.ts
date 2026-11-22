import { PREFERENCES_SETTING_KEY, parsePreferences } from '../ui/settings-persistence';
import { assertRestorable, parseBackupText } from './backup-restore';
import { LATEST_SCHEMA_VERSION, type BackupPayload } from './db';

/** What a backup file holds, counted for the confirmation. */
export interface BackupSummary {
  games: number;
  reviews: number;
  puzzles: number;
  cards: number;
  hasPreferences: boolean;
  exportedAt: number | null;
}

/** Counts a parsed backup (the file is not checked: see `inspectBackup`). */
export function summarizeParsed(parsed: Partial<BackupPayload>): BackupSummary {
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const settings = Array.isArray(parsed.settings) ? parsed.settings : [];
  return {
    games: len(parsed.games),
    reviews: len(parsed.reviews),
    puzzles: len(parsed.puzzles),
    cards: len(parsed.srsCards),
    hasPreferences: settings.some((s) => s?.key === PREFERENCES_SETTING_KEY && parsePreferences(s.value) !== null),
    exportedAt: typeof parsed.exportedAt === 'number' ? parsed.exportedAt : null,
  };
}

/** What the confirmation shows of a backup file: its counts, and whether it brings settings and bots. */
export interface BackupInspection extends BackupSummary {
  hasBots: boolean;
}

/**
 * Checks a backup file's text before the confirmation: throws a `BackupRefusedError` (readable message) when it is not
 * JSON, not a backup, from a newer version of the app, or has damaged records. Nothing is written either way.
 */
export function inspectBackup(json: string): BackupInspection {
  const parsed = parseBackupText(json);
  const check = assertRestorable(parsed, LATEST_SCHEMA_VERSION);
  return { ...summarizeParsed(parsed as Partial<BackupPayload>), hasBots: check.hasBotRows };
}
