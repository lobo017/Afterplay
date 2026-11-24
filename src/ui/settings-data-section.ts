import { summarizeParsed, type BackupSummary } from '../storage/backup-inspect';
import type { BackupRestoreClient } from '../storage/backup-restore-client';
import { BackupRefusedError, type RestoreReport } from '../storage/backup-restore';
import type { BackupPayload } from '../storage/db';
import type { SyncProgress, SyncReport } from '../sync/chesscom-sync';
import { icon } from './components/icons';
import {
  RESTORED_BUT_STALE_TEXT,
  restoreConfirmText,
  restoreFailedText,
  restoreProgressText,
  restoreResultText,
} from './restore-text';
import type { SettingsPanel } from './settings-panel';
import { PREFERENCES_SETTING_KEY, parsePreferences, type PreferencesSnapshot } from './settings-persistence';

export interface BackupBackend {
  /** Everything in the database as backup JSON (games, reviews, puzzles, cards, settings…). */
  exportBackupJson(): Promise<string>;
}

// (what a backup holds, and the check before the confirmation, live in storage/backup-inspect.ts and run in the restore
// worker; they are re-exported here for the tests and callers that always imported them from this file)
export { inspectBackup, type BackupInspection, type BackupSummary } from '../storage/backup-inspect';

export interface DataSectionOptions {
  panel: SettingsPanel;
  order: number;
  /** The open database, once the library has opened it (for the backup download). */
  getBackend: () => Promise<BackupBackend>;
  /**
   * Reads, checks and restores a chosen backup file in a background worker: in one transaction, progress that is newer
   * here is kept and the rest of the file is merged in. Nothing is parsed or written on the page.
   */
  restoreClient: BackupRestoreClient;
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
  return summarizeParsed(parsed);
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
    <p class="wc-setting-hint wc-setting-hint-block">Everything stays on this device. A backup is one file with your games, reviews, puzzles and settings.</p>
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
  let pending: File | null = null;

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
    if (!file) return;
    pending = null;
    confirm.hidden = true;
    say('Checking the backup…');
    void options.restoreClient
      .inspect(file)
      .then((s) => {
        pending = file;
        // (the worker formatted the date: the page's first Intl call would be a long task on this click)
        const when = s.exportedOn ? ` from ${s.exportedOn}` : '';
        confirmText.textContent = restoreConfirmText(s, when);
        confirm.hidden = false;
        say('');
        q<HTMLButtonElement>('btn-backup-cancel').focus();
      })
      .catch((err: unknown) => {
        pending = null;
        confirm.hidden = true;
        // A refusal is worded for the person; anything else (the worker could not start) is a failure, and says so
        say(err instanceof BackupRefusedError ? err.message : restoreFailedText(err), 'bad');
      })
      .finally(() => {
        fileInput.value = '';
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
    const file = pending;
    if (!file) return;
    pending = null;
    confirm.hidden = true;
    q<HTMLButtonElement>('btn-backup-restore').focus();
    void (async () => {
      // Two stages, because they fail differently: before the database changed (nothing was changed), and after it (the
      // data is restored, a screen could not follow)
      let report: RestoreReport;
      try {
        say('Restoring…');
        report = await options.restoreClient.restore(file, (list) => say(restoreProgressText(list)));
      } catch (err) {
        say(restoreFailedText(err), 'bad');
        return;
      }
      try {
        const prefs = report.preferences === null ? null : parsePreferences(report.preferences);
        if (prefs) options.applyPreferences(prefs);
        await options.afterRestore();
        say(restoreResultText(report, prefs !== null), 'ok');
      } catch {
        say(RESTORED_BUT_STALE_TEXT, 'bad');
      }
    })();
  });
  return { isSyncRunning: () => syncAbort !== null };
}
