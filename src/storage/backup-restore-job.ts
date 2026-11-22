import { inspectBackup, type BackupInspection } from './backup-inspect';
import {
  BackupRefusedError,
  parseBackupText,
  type BackupRefusalKind,
  type RestoreList,
  type RestoreReport,
} from './backup-restore';
import { WizardChessStorage } from './db';

/**
 * What the restore worker does for a chosen backup file, with the messages it exchanges with the page. The worker file is
 * a thin shell around `runBackupRestoreRequest`, so the same code runs in unit tests (Node has `File` and the in-memory
 * database), and the page never holds the file's text or its parsed records: it hands over the `File` and gets small
 * answers (counts, a report) back.
 */

export type BackupRestoreRequest =
  /** Reads and checks the file; answers with what the confirmation shows. Writes nothing. */
  | { id: number; kind: 'inspect'; file: Blob }
  /** Reads the file again and merges it into the database in one transaction. */
  | { id: number; kind: 'restore'; file: Blob; dbName?: string };

export type BackupRestoreResponse =
  | { id: number; kind: 'inspected'; info: BackupInspection }
  | { id: number; kind: 'progress'; list: RestoreList }
  | { id: number; kind: 'restored'; report: RestoreReport }
  | { id: number; kind: 'error'; message: string; refusal?: BackupRefusalKind };

const UNREADABLE_MESSAGE = 'The file could not be read. Choose it again.';

async function readText(file: Blob): Promise<string> {
  try {
    return await file.text();
  } catch {
    // (a file changed or moved after it was chosen)
    throw new Error(UNREADABLE_MESSAGE);
  }
}

/** Runs one request and posts its answers (always ending in `inspected`, `restored` or `error`). */
export async function runBackupRestoreRequest(
  msg: BackupRestoreRequest,
  post: (response: BackupRestoreResponse) => void,
): Promise<void> {
  try {
    const text = await readText(msg.file);
    if (msg.kind === 'inspect') {
      post({ id: msg.id, kind: 'inspected', info: inspectBackup(text) });
      return;
    }
    const parsed = parseBackupText(text);
    const storage = await WizardChessStorage.create(msg.dbName ? { dbName: msg.dbName } : undefined);
    try {
      const report = await storage.restoreBackup(parsed, (list) => post({ id: msg.id, kind: 'progress', list }));
      post({ id: msg.id, kind: 'restored', report });
    } finally {
      storage.close();
    }
  } catch (err) {
    post({
      id: msg.id,
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof BackupRefusedError ? { refusal: err.kind } : {}),
    });
  }
}
