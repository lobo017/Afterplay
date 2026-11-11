import type { BackupPayload } from '../storage/db';
import type { SyncProgress, SyncReport } from '../sync/chesscom-sync';
import { icon } from './components/icons';
import type { SettingsPanel } from './settings-panel';
import { PREFERENCES_SETTING_KEY, parsePreferences, type PreferencesSnapshot } from './settings-persistence';

export interface BackupBackend {
  /** Everything in the database as backup JSON (games, reviews, puzzles, cards, settings…). */
  exportBackupJson(): Promise<string>;
  importBackupJson(json: string): Promise<{
    gamesImported: number;
    settingsImported: number;
    puzzlesImported: number;
    srsCardsImported: number;
    reviewsImported: number;
  }>;
}

export interface DataSectionOptions {
  panel: SettingsPanel;
  order: number;
  /** The open database, once the library has opened it. */
  getBackend: () => Promise<BackupBackend>;
  /** Writes the current preferences into the database first, so the backup has them. */
  beforeBackup: () => Promise<void>;
  /** Applies a restored backup's preferences on every screen. */
  applyPreferences: (snapshot: PreferencesSnapshot) => void;
  /** After a restore: brings the screens' data up to date (games list, Train). */
  afterRestore: () => Promise<void>;
  /**
   * Runs one Chess.com sync (the only thing in the app that uses the network, and only from this button), reporting
   * progress; aborting `signal` stops it. Resolves with what to tell the user.
   */
  runSync: (onProgress: (progress: SyncProgress) => void, signal: AbortSignal) => Promise<SyncReport>;
}

export interface DataSection {
  /** True while a sync is running (an update of the app waits for it). */
  isSyncRunning: () => boolean;
}

export const SYNC_BUTTON_LABEL = 'Sync my Chess.com games';

/** "7 of 31 months · 12 games added" while a sync runs. */
export function syncProgressText(progress: SyncProgress): string {
  const added = progress.added > 0 ? ` · ${progress.added} ${progress.added === 1 ? 'game' : 'games'} added` : '';
  return `${progress.monthsDone} of ${progress.monthsTotal} ${progress.monthsTotal === 1 ? 'month' : 'months'}${added}`;
}

/** What a backup file holds, counted for the confirmation. */
export interface BackupSummary {
  games: number;
  reviews: number;
  puzzles: number;
  cards: number;
  hasPreferences: boolean;
  exportedAt: number | null;
}

/** Checks a backup file's text; throws with a readable message when it isn't one. */
export function summarizeBackup(json: string): BackupSummary {
  let parsed: Partial<BackupPayload>;
  try {
    parsed = JSON.parse(json) as Partial<BackupPayload>;
  } catch {
    throw new Error('This file is not an Afterplay backup (not JSON).');
  }
  if (parsed.format !== 'wizards-chess-backup') {
    throw new Error('This file is not an Afterplay backup.');
  }
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

/** The preferences a backup carries, if any. */
export function backupPreferences(json: string): PreferencesSnapshot | null {
  try {
    const parsed = JSON.parse(json) as Partial<BackupPayload>;
    const record = (parsed.settings ?? []).find((s) => s?.key === PREFERENCES_SETTING_KEY);
    return record ? parsePreferences(record.value) : null;
  } catch {
    return null;
  }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function backupFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `afterplay-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/**
 * Settings › Your data: download a JSON backup of everything (games, reviews, puzzles and
 * their schedule, and every setting), restore one after a confirmation, and sync new games from Chess.com.
 */
export function mountDataSection(options: DataSectionOptions): DataSection {
  const body = options.panel.addSection('data', 'Your data', options.order);
  body.innerHTML = `
    <p class="wc-setting-hint wc-setting-hint-block">Everything stays on this device. A backup is one JSON file with your games, reviews, puzzles and their schedule, and all of these settings.</p>
    <p class="wc-setting-hint wc-setting-hint-block" data-testid="sync-hint">Sync adds your new Chess.com games, for the username under Your games. It is the only time Afterplay uses the network, and only when you press the button. Chess.com can take up to 12 hours to list a finished game. A sync never deletes anything.</p>
    <div class="wc-action-bar wc-action-bar-wrap">
      <button type="button" class="wc-btn wc-btn-secondary wc-btn-inline" data-testid="btn-backup-download">${icon('download')}Download a backup</button>
      <button type="button" class="wc-btn wc-btn-secondary wc-btn-inline" data-testid="btn-backup-restore">${icon('upload')}Restore a backup…</button>
      <button type="button" class="wc-btn wc-btn-secondary wc-btn-inline wc-sync-btn" data-testid="btn-chesscom-sync" data-state="idle">${icon('games')}<span data-testid="chesscom-sync-label">${SYNC_BUTTON_LABEL}</span></button>
      <input type="file" accept=".json,application/json" class="wc-games-file-input" data-testid="backup-file-input" tabindex="-1" aria-hidden="true" />
    </div>
    <div class="wc-confirm-end" data-testid="backup-confirm" role="alertdialog" aria-label="Restore this backup?" hidden>
      <span data-testid="backup-confirm-text"></span>
      <div class="wc-confirm-end-actions">
        <button type="button" class="wc-btn wc-btn-secondary" data-testid="btn-backup-cancel">Cancel</button>
        <button type="button" class="wc-btn wc-btn-danger" data-testid="btn-backup-confirm">Restore</button>
      </div>
    </div>
    <p class="wc-setting-status" data-testid="backup-status" role="status"></p>
    <div class="wc-sync-report">
      <p class="wc-setting-status wc-sync-progress" data-testid="sync-progress" aria-live="off"></p>
      <div class="wc-sync-status" data-testid="sync-status" role="status" data-tone=""></div>
    </div>`;

  const q = <T extends HTMLElement>(id: string) => body.querySelector(`[data-testid="${id}"]`) as T;
  const status = q<HTMLElement>('backup-status');
  const confirm = q<HTMLElement>('backup-confirm');
  const confirmText = q<HTMLElement>('backup-confirm-text');
  const fileInput = q<HTMLInputElement>('backup-file-input');
  let pending: string | null = null;

  const say = (text: string, tone: 'ok' | 'bad' | '' = ''): void => {
    status.textContent = text;
    status.setAttribute('data-tone', tone);
  };

  q<HTMLButtonElement>('btn-backup-download').addEventListener('click', () => {
    void (async () => {
      try {
        say('Preparing the backup…');
        await options.beforeBackup();
        const json = await (await options.getBackend()).exportBackupJson();
        const s = summarizeBackup(json);
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = backupFileName(new Date());
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        say(`Backup saved: ${plural(s.games, 'game')}, ${plural(s.puzzles, 'puzzle')} and your settings.`, 'ok');
      } catch (err) {
        say(`The backup failed: ${err instanceof Error ? err.message : String(err)}`, 'bad');
      }
    })();
  });

  q<HTMLButtonElement>('btn-backup-restore').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    void file.text().then((text) => {
      try {
        const s = summarizeBackup(text);
        pending = text;
        const when = s.exportedAt ? ` from ${new Date(s.exportedAt).toLocaleDateString()}` : '';
        confirmText.textContent = `Restore this backup${when}? It adds ${plural(s.games, 'game')}, ${plural(s.reviews, 'review')} and ${plural(s.puzzles, 'puzzle')}${
          s.hasPreferences ? ', and replaces your settings' : ''
        }. Anything with the same name here is overwritten.`;
        confirm.hidden = false;
        say('');
        q<HTMLButtonElement>('btn-backup-cancel').focus();
      } catch (err) {
        pending = null;
        confirm.hidden = true;
        say(err instanceof Error ? err.message : String(err), 'bad');
      }
    });
  });
  q<HTMLButtonElement>('btn-backup-cancel').addEventListener('click', () => {
    pending = null;
    confirm.hidden = true;
    q<HTMLButtonElement>('btn-backup-restore').focus();
  });
  // --- Chess.com sync ---
  const syncButton = q<HTMLButtonElement>('btn-chesscom-sync');
  const syncLabel = q<HTMLElement>('chesscom-sync-label');
  const syncProgress = q<HTMLElement>('sync-progress');
  const syncStatus = q<HTMLElement>('sync-status');
  let syncAbort: AbortController | null = null;
  const showSync = (report: SyncReport): void => {
    syncStatus.setAttribute('data-tone', report.tone);
    syncStatus.replaceChildren(
      ...report.lines.map((line) => {
        const p = document.createElement('p');
        p.className = 'wc-setting-status';
        p.textContent = line;
        return p;
      }),
    );
  };
  syncButton.addEventListener('click', () => {
    if (syncAbort) {
      // Pressed again while running: stop after the step it is in
      syncAbort.abort();
      syncLabel.textContent = 'Stopping…';
      syncButton.disabled = true;
      return;
    }
    const abort = new AbortController();
    syncAbort = abort;
    syncButton.setAttribute('data-state', 'running');
    syncLabel.textContent = 'Stop';
    syncProgress.textContent = 'Asking Chess.com for your games…';
    showSync({ tone: '', lines: [] });
    void (async () => {
      try {
        const report = await options.runSync((progress) => {
          if (!abort.signal.aborted) syncProgress.textContent = syncProgressText(progress);
        }, abort.signal);
        showSync(report);
      } catch (err) {
        showSync({ tone: 'bad', lines: [`The sync failed: ${err instanceof Error ? err.message : String(err)}`] });
      } finally {
        syncAbort = null;
        syncProgress.textContent = '';
        syncLabel.textContent = SYNC_BUTTON_LABEL;
        syncButton.disabled = false;
        syncButton.setAttribute('data-state', 'idle');
      }
    })();
  });

  q<HTMLButtonElement>('btn-backup-confirm').addEventListener('click', () => {
    const text = pending;
    if (!text) return;
    pending = null;
    confirm.hidden = true;
    q<HTMLButtonElement>('btn-backup-restore').focus();
    void (async () => {
      try {
        say('Restoring…');
        const counts = await (await options.getBackend()).importBackupJson(text);
        const prefs = backupPreferences(text);
        if (prefs) options.applyPreferences(prefs);
        await options.afterRestore();
        say(
          `Restored ${plural(counts.gamesImported, 'game')}, ${plural(counts.reviewsImported, 'review')}, ${plural(counts.puzzlesImported, 'puzzle')}${
            prefs ? ' and your settings' : ''
          }.`,
          'ok',
        );
      } catch (err) {
        say(`The restore failed: ${err instanceof Error ? err.message : String(err)}`, 'bad');
      }
    })();
  });
  return { isSyncRunning: () => syncAbort !== null };
}
