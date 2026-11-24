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

/**
 * The day a backup was made, as the person reads dates (their locale and time zone), or null when the file has no usable
 * date. The first date formatting of a page costs 20-90 ms (the browser loads its locale data), so the restore worker does
 * it and the page only shows the text: the click on a file never waits for it.
 */
export function formatExportDate(exportedAt: number | null): string | null {
  if (!exportedAt) return null;
  const date = new Date(exportedAt);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

/** What the confirmation shows of a backup file: its counts, whether it brings settings and bots, and its date as text. */
export interface BackupInspection extends BackupSummary {
  hasBots: boolean;
  exportedOn: string | null;
}

/**
 * Checks a backup file's text before the confirmation: throws a `BackupRefusedError` (readable message) when it is not
 * JSON, not a backup, from a newer version of the app, or has damaged records. Nothing is written either way.
 */
export function inspectBackup(json: string): BackupInspection {
  const parsed = parseBackupText(json);
  const check = assertRestorable(parsed, LATEST_SCHEMA_VERSION);
  const summary = summarizeParsed(parsed as Partial<BackupPayload>);
  return { ...summary, hasBots: check.hasBotRows, exportedOn: formatExportDate(summary.exportedAt) };
}
