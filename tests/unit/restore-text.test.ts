import { describe, expect, it } from 'vitest';
import { BackupRefusedError, type RestoreReport } from '../../src/storage/backup-restore';
import { inspectBackup } from '../../src/ui/settings-data-section';
import { restoreConfirmText, restoreFailedText, restoreResultText } from '../../src/ui/restore-text';

const none = () => ({ added: 0, updated: 0, keptNewer: 0, unchanged: 0 });
const report = (over: Partial<RestoreReport> = {}): RestoreReport => ({
  games: none(),
  reviews: none(),
  puzzles: none(),
  srsCards: none(),
  repertoires: none(),
  endgameProgress: none(),
  progressSettings: none(),
  overwrittenSettings: 0,
  rating: 'none',
  preferences: null,
  ...over,
});

describe('the restore dialog and result words', () => {
  it('the confirmation says what the file holds, what is kept and what it replaces', () => {
    const text = restoreConfirmText(
      { games: 4623, reviews: 31, puzzles: 1, hasPreferences: true, hasBots: true },
      ' from 12 Nov 2026',
    );
    expect(text).toBe(
      'Restore this backup from 12 Nov 2026? It holds 4,623 games, 31 reviews and 1 puzzle. ' +
        'Progress that is newer on this device is kept; anything older here is updated from the file and anything missing is added. ' +
        'It also replaces your settings and your bots with the ones in the file.',
    );
    // The two phrases the earlier end-to-end test looks for
    expect(
      restoreConfirmText({ games: 1, reviews: 0, puzzles: 0, hasPreferences: true, hasBots: false }, ''),
    ).toContain('1 game');
    expect(
      restoreConfirmText({ games: 1, reviews: 0, puzzles: 0, hasPreferences: true, hasBots: false }, ''),
    ).toContain('replaces your settings');
  });

  it('says nothing about settings or bots a file does not have', () => {
    const text = restoreConfirmText({ games: 2, reviews: 0, puzzles: 0, hasPreferences: false, hasBots: false }, '');
    expect(text).not.toMatch(/replaces/);
    expect(
      restoreConfirmText({ games: 2, reviews: 0, puzzles: 0, hasPreferences: false, hasBots: true }, ''),
    ).toContain('It also replaces your bots with the ones in the file.');
  });

  it('the result starts with what was restored (the earlier end-to-end test looks for "Restored 1 game")', () => {
    const text = restoreResultText(report({ games: { ...none(), added: 1 } }), true);
    expect(text).toBe('Restored 1 game, 0 reviews and 0 puzzles, and your settings.');
    expect(text.startsWith('Restored 1 game')).toBe(true);
  });

  it('counts what was written, tells what was kept because it was newer here, and which rating stayed', () => {
    const text = restoreResultText(
      report({
        games: { added: 25, updated: 5, keptNewer: 2, unchanged: 4000 },
        reviews: { ...none(), updated: 2 },
        puzzles: { added: 10, updated: 2, keptNewer: 12, unchanged: 0 },
        srsCards: { ...none(), keptNewer: 3 },
        progressSettings: { ...none(), keptNewer: 1 },
        rating: 'this-device',
      }),
      false,
    );
    expect(text).toBe(
      'Restored 30 games, 2 reviews and 12 puzzles. ' +
        'Kept what was newer here: 2 games, 12 puzzles and 4 other records. ' +
        'Puzzle rating: kept the one on this device.',
    );
    expect(restoreResultText(report({ games: { ...none(), updated: 1 }, rating: 'file' }), false)).toContain(
      'Puzzle rating: took the one in the file, which was newer.',
    );
    expect(restoreResultText(report({ games: { ...none(), updated: 1 }, rating: 'same' }), false)).not.toContain(
      'rating',
    );
  });

  it('says so when there was nothing to restore', () => {
    expect(restoreResultText(report({ games: { ...none(), unchanged: 9 }, overwrittenSettings: 3 }), false)).toBe(
      'Nothing to restore: this device already has everything in the file.',
    );
    expect(restoreResultText(report({ games: { ...none(), keptNewer: 3 } }), false)).toBe(
      'Nothing to restore: this device already has everything in the file. Kept what was newer here: 3 games.',
    );
  });

  it('a failure says that nothing was changed', () => {
    expect(restoreFailedText(new Error('3 records in this file are damaged.'))).toBe(
      'The restore failed: 3 records in this file are damaged. Nothing was changed.',
    );
    expect(restoreFailedText(new Error('Quota exceeded'))).toBe(
      'The restore failed: Quota exceeded. Nothing was changed.',
    );
  });
});

describe('inspecting a file before the confirmation', () => {
  const file = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      format: 'wizards-chess-backup',
      schemaVersion: 4,
      exportedAt: 5,
      games: [{ id: 'a' }],
      settings: [{ key: 'bots.book.me', value: 'x', updatedAt: 1 }],
      ...over,
    });

  it('counts the file and finds the bots', () => {
    expect(inspectBackup(file())).toMatchObject({
      games: 1,
      reviews: 0,
      hasPreferences: false,
      hasBots: true,
      exportedAt: 5,
    });
  });

  it('refuses with the messages the dialog shows', () => {
    const refusal = (text: string) => {
      try {
        inspectBackup(text);
      } catch (err) {
        expect(err).toBeInstanceOf(BackupRefusedError);
        return (err as Error).message;
      }
      return '';
    };
    expect(refusal('nope')).toBe('This file is not an Afterplay backup (not JSON).');
    expect(refusal('{"hello":1}')).toBe('This file is not an Afterplay backup.');
    expect(refusal(file({ schemaVersion: 99 }))).toBe(
      'This backup was made by a newer version of Afterplay. Update the app, then try again.',
    );
    expect(refusal(file({ games: [{ id: 'a' }, { id: 'a' }, 7] }))).toBe('2 records in this file are damaged.');
  });
});
