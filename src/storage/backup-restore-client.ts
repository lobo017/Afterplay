import type { BackupInspection } from './backup-inspect';
import { BackupRefusedError, type RestoreList, type RestoreReport } from './backup-restore';
import type { BackupRestoreRequest, BackupRestoreResponse } from './backup-restore-job';

/** What the page says when the browser would not run the worker. Nothing was read or changed. */
export const RESTORE_WORKER_UNAVAILABLE_MESSAGE =
  'the browser would not start its background worker, so the backup could not be read';

/** The part of a `Worker` the client uses (so tests can stand in for one). */
export interface RestoreWorkerLike {
  postMessage(message: BackupRestoreRequest): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<BackupRestoreResponse>) => void): void;
  addEventListener(type: 'error', listener: (e: { message?: string }) => void): void;
  terminate(): void;
}

export interface BackupRestoreClientOptions {
  /** The database to restore into (the app's own by default). */
  dbName?: string;
  /** Starts the worker; the module worker of the app by default. */
  createWorker?: () => RestoreWorkerLike;
}

const defaultWorker = (): RestoreWorkerLike =>
  new Worker(new URL('./backup-restore.worker.ts', import.meta.url), {
    type: 'module',
    name: 'backup-restore',
  }) as unknown as RestoreWorkerLike;

/**
 * The page's side of Restore. Each request gets its own worker, started only when a file is chosen and ended when the
 * answer is in (so no 15 MB of text or records stays in memory while a confirmation is open, and nothing runs at
 * start-up). There is no fallback that does the work on the page: if the worker cannot start, the request fails and
 * nothing is read or changed.
 */
export class BackupRestoreClient {
  private nextId = 1;
  private readonly options: BackupRestoreClientOptions;

  public constructor(options: BackupRestoreClientOptions = {}) {
    this.options = options;
  }

  /** Reads and checks `file` in the worker; resolves with what the confirmation shows, rejects with the refusal. */
  public inspect(file: Blob): Promise<BackupInspection> {
    return this.request(
      (id) => ({ id, kind: 'inspect', file }),
      () => undefined,
      (response) => (response.kind === 'inspected' ? response.info : undefined),
    );
  }

  /** Restores `file` into the database in the worker; `onProgress` names each list as it is merged. */
  public restore(file: Blob, onProgress: (list: RestoreList) => void = () => undefined): Promise<RestoreReport> {
    return this.request(
      (id) => ({ id, kind: 'restore', file, ...(this.options.dbName ? { dbName: this.options.dbName } : {}) }),
      (response) => {
        if (response.kind === 'progress') onProgress(response.list);
      },
      (response) => (response.kind === 'restored' ? response.report : undefined),
    );
  }

  private request<T>(
    make: (id: number) => BackupRestoreRequest,
    onOther: (response: BackupRestoreResponse) => void,
    result: (response: BackupRestoreResponse) => T | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let worker: RestoreWorkerLike;
      try {
        if (!this.options.createWorker && typeof Worker === 'undefined') throw new Error('no Worker');
        worker = (this.options.createWorker ?? defaultWorker)();
      } catch {
        reject(new Error(RESTORE_WORKER_UNAVAILABLE_MESSAGE));
        return;
      }
      const id = this.nextId++;
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        worker.terminate();
        action();
      };
      worker.addEventListener('message', (e) => {
        const response = e.data;
        if (response.id !== id) return;
        if (response.kind === 'error') {
          finish(() =>
            reject(
              response.refusal
                ? new BackupRefusedError(response.refusal, response.message)
                : new Error(response.message),
            ),
          );
          return;
        }
        const value = result(response);
        if (value !== undefined) finish(() => resolve(value));
        else onOther(response);
      });
      worker.addEventListener('error', () => finish(() => reject(new Error(RESTORE_WORKER_UNAVAILABLE_MESSAGE))));
      try {
        worker.postMessage(make(id));
      } catch {
        finish(() => reject(new Error(RESTORE_WORKER_UNAVAILABLE_MESSAGE)));
      }
    });
  }
}
