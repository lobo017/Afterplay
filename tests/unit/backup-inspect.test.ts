import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatExportDate, inspectBackup } from '../../src/storage/backup-inspect';
import { runBackupRestoreRequest, type BackupRestoreResponse } from '../../src/storage/backup-restore-job';
import { groupThousands, restoreConfirmText } from '../../src/ui/restore-text';

const AT = Date.UTC(2026, 10, 12, 12, 0, 0);

const backupText = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    format: 'wizards-chess-backup',
    schemaVersion: 4,
    exportedAt: AT,
    settings: [],
    games: [],
    puzzles: [],
    ...extra,
  });

describe('the date of a backup file, formatted where the worker runs', () => {
  it('is the person-readable date of the export (the same text the page used to build itself)', () => {
    expect(formatExportDate(AT)).toBe(new Date(AT).toLocaleDateString());
  });

  it('is null when the file has no usable date', () => {
    expect(formatExportDate(null)).toBeNull();
    expect(formatExportDate(0)).toBeNull();
    expect(formatExportDate(8.7e15)).toBeNull();
    expect(formatExportDate(Number.NaN)).toBeNull();
  });

  it('comes with the inspection of a file, as text', () => {
    const info = inspectBackup(backupText());
    expect(info.exportedOn).toBe(new Date(AT).toLocaleDateString());
    expect(info.exportedAt).toBe(AT);
  });

  it('is null in the inspection of a file without a date', () => {
    expect(inspectBackup(backupText({ exportedAt: undefined })).exportedOn).toBeNull();
  });

  it('reaches the page in the answer of the worker job, so the page has nothing left to format', async () => {
    const out: BackupRestoreResponse[] = [];
    await runBackupRestoreRequest({ id: 1, kind: 'inspect', file: new Blob([backupText()]) }, (r) => out.push(r));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'inspected', info: { exportedOn: new Date(AT).toLocaleDateString() } });
  });
});

describe('the counts of the dialog, without the browser number formatter', () => {
  it('group thousands exactly as toLocaleString("en-US") does', () => {
    for (const n of [
      0, 1, 9, 10, 99, 100, 999, 1000, 1001, 9999, 10_000, 99_999, 100_000, 123_456, 1_234_567, 4623, 4640,
    ]) {
      expect(groupThousands(n)).toBe(n.toLocaleString('en-US'));
    }
  });

  it('keep the confirmation text as it was', () => {
    const info = { games: 4623, reviews: 1, puzzles: 1_200_000, hasPreferences: false, hasBots: false };
    expect(restoreConfirmText(info, '')).toContain('It holds 4,623 games, 1 review and 1,200,000 puzzles.');
  });

  it('are not formatted with Intl in the words of the dialog (the first call costs 20 ms on a slow CPU)', () => {
    expect(readFileSync('src/ui/restore-text.ts', 'utf8')).not.toMatch(/\.toLocale\w*String\(|\bIntl\./);
  });
});

describe('the Settings page and the first date formatting', () => {
  it('does not format dates itself on the click that chooses a backup file (that call is made by the worker)', () => {
    const source = readFileSync('src/ui/settings-data-section.ts', 'utf8');
    expect(source).not.toMatch(/toLocale(Date|Time)?String\(/);
    expect(source).not.toMatch(/Intl\.DateTimeFormat/);
  });
});
