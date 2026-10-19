import {
  pageMessage,
  parseBridgeMessage,
  type BridgeGame,
  type FailedDelivery,
  type MessageEventLike,
  type MessageWindow,
  type MyAccounts,
  type PageMessage,
} from '../capture/protocol';

export interface SaveOutcome {
  saved: string[];
  duplicates: string[];
  failed: FailedDelivery[];
}

/** Where the page puts what the extension sends. */
export interface BridgeStore {
  saveGames(games: readonly BridgeGame[]): Promise<SaveOutcome>;
  setAccounts(accounts: MyAccounts): Promise<void> | void;
}

export type ExtensionStatus =
  | { state: 'not-detected' }
  | {
      state: 'connected';
      extensionVersion: string;
      syncing: boolean;
      /** Games stored (or already present) in the last finished sync. */
      lastDelivered: number;
      lastSyncAt: number | null;
    };

/**
 * The page's side of the bridge to the capture extension (protocol in capture/protocol.ts).
 * Without the extension nothing answers and the page carries on as usual.
 */
export class ExtensionBridgeClient {
  private status: ExtensionStatus = { state: 'not-detected' };
  private readonly listeners = new Set<(status: ExtensionStatus) => void>();
  /** Batches are stored one at a time, in arrival order. */
  private work: Promise<void> = Promise.resolve();
  private readonly onMessageListener = (event: MessageEventLike) => this.onMessage(event);

  constructor(
    private readonly win: MessageWindow,
    private readonly store: BridgeStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Listens and says hello. `onWake` registers the focus / visible-tab trigger. */
  public start(onWake?: (wake: () => void) => void): void {
    this.win.addEventListener('message', this.onMessageListener);
    onWake?.(() => this.hello());
    this.hello();
  }

  public stop(): void {
    this.win.removeEventListener('message', this.onMessageListener);
  }

  public hello(): void {
    this.post(pageMessage('hello', {}));
  }

  public getStatus(): ExtensionStatus {
    return this.status;
  }

  public onStatus(listener: (status: ExtensionStatus) => void): void {
    this.listeners.add(listener);
  }

  /** Resolves once every batch received so far is stored and answered. */
  public idle(): Promise<void> {
    return this.work;
  }

  private post(message: PageMessage): void {
    this.win.postMessage(message, this.win.location.origin);
  }

  private setStatus(status: ExtensionStatus): void {
    this.status = status;
    for (const l of this.listeners) l(status);
  }

  private connected(): Extract<ExtensionStatus, { state: 'connected' }> | null {
    return this.status.state === 'connected' ? this.status : null;
  }

  private onMessage(event: MessageEventLike): void {
    if (event.source !== this.win || event.origin !== this.win.location.origin) return;
    const msg = parseBridgeMessage(event.data);
    if (!msg) return;
    switch (msg.type) {
      case 'bridge-ready':
        this.hello();
        return;
      case 'hello-ack':
        this.work = this.work.then(async () => {
          await this.store.setAccounts(msg.accounts);
          const prev = this.connected();
          this.setStatus({
            state: 'connected',
            extensionVersion: msg.extensionVersion,
            syncing: true,
            lastDelivered: prev?.lastDelivered ?? 0,
            lastSyncAt: prev?.lastSyncAt ?? null,
          });
        });
        return;
      case 'games':
        this.work = this.work.then(async () => {
          let outcome: SaveOutcome;
          try {
            outcome = await this.store.saveGames(msg.games);
          } catch (err) {
            const reason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
            // Storage trouble: worth another try on the next sync
            outcome = { saved: [], duplicates: [], failed: msg.games.map((g) => ({ key: g.key, kind: 'error' as const, reason })) };
          }
          this.post(pageMessage('saved', { batchId: msg.batchId, ...outcome }));
        });
        return;
      case 'sync-done':
        this.work = this.work.then(() => {
          const prev = this.connected();
          if (!prev) return;
          this.setStatus({ ...prev, syncing: false, lastDelivered: msg.delivered, lastSyncAt: this.now() });
        });
        return;
    }
  }
}
