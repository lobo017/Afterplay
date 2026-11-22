import { written, type RestoreReport } from '../storage/backup-restore';

/** The words of the restore dialog and its result line (pure, so they are unit-tested). */

/** A count in words: thousands separated, "1 game", "4,623 games". */
const count = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

const joinWords = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** What the confirmation says about a file. */
export interface RestoreConfirmInfo {
  games: number;
  reviews: number;
  puzzles: number;
  hasPreferences: boolean;
  hasBots: boolean;
}

/** The confirmation before a restore: what the file holds, what is kept, what it replaces. `when` is " from <date>" or "". */
export function restoreConfirmText(info: RestoreConfirmInfo, when: string): string {
  const replaces = [info.hasPreferences ? 'your settings' : '', info.hasBots ? 'your bots' : ''].filter(Boolean);
  const extra = replaces.length > 0 ? ` It also replaces ${replaces.join(' and ')} with the ones in the file.` : '';
  return (
    `Restore this backup${when}? It holds ${count(info.games, 'game')}, ${count(info.reviews, 'review')} and ${count(info.puzzles, 'puzzle')}. ` +
    `Progress that is newer on this device is kept; anything older here is updated from the file and anything missing is added.${extra}`
  );
}

/** What a restore did: what was restored, what was kept because it was newer here, and which puzzle rating stayed. */
export function restoreResultText(report: RestoreReport, settingsRestored: boolean): string {
  const games = written(report.games);
  const reviews = written(report.reviews);
  const puzzles = written(report.puzzles);
  const others =
    written(report.srsCards) +
    written(report.repertoires) +
    written(report.endgameProgress) +
    written(report.progressSettings);
  const keptOthers =
    report.srsCards.keptNewer +
    report.repertoires.keptNewer +
    report.endgameProgress.keptNewer +
    report.progressSettings.keptNewer;
  const kept = joinWords(
    [
      report.games.keptNewer > 0 ? count(report.games.keptNewer, 'game') : '',
      report.reviews.keptNewer > 0 ? count(report.reviews.keptNewer, 'review') : '',
      report.puzzles.keptNewer > 0 ? count(report.puzzles.keptNewer, 'puzzle') : '',
      keptOthers > 0 ? count(keptOthers, 'other record') : '',
    ].filter(Boolean),
  );
  const parts: string[] = [];
  if (games + reviews + puzzles + others === 0 && !settingsRestored) {
    parts.push('Nothing to restore: this device already has everything in the file.');
  } else {
    parts.push(
      `Restored ${count(games, 'game')}, ${count(reviews, 'review')} and ${count(puzzles, 'puzzle')}${settingsRestored ? ', and your settings' : ''}.`,
    );
  }
  if (kept) parts.push(`Kept what was newer here: ${kept}.`);
  if (report.rating === 'this-device') parts.push('Puzzle rating: kept the one on this device.');
  if (report.rating === 'file') parts.push('Puzzle rating: took the one in the file, which was newer.');
  return parts.join(' ');
}

/** The status line when a restore failed before it changed anything. */
export function restoreFailedText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `The restore failed: ${message}${/[.!?]$/.test(message) ? '' : '.'} Nothing was changed.`;
}

/** The status line when the data was restored but a screen could not follow. */
export const RESTORED_BUT_STALE_TEXT = 'Restored, but some screens could not refresh: reload the app.';
