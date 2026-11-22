/// <reference lib="webworker" />
import { runBackupRestoreRequest, type BackupRestoreRequest, type BackupRestoreResponse } from './backup-restore-job';

/**
 * Restores a chosen backup file away from the page: reads it, parses it (once to check it, again to restore it, so the
 * parsed records are not kept alive while the confirmation is open), and merges it into the database in one transaction.
 * Only small answers go back to the page (see backup-restore-job.ts). Started when a file is chosen, never before.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', (e: MessageEvent<BackupRestoreRequest>) => {
  void runBackupRestoreRequest(e.data, (response: BackupRestoreResponse) => scope.postMessage(response));
});
