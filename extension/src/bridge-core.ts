import {
  BRIDGE_MAX_BATCH,
  bridgeMessage,
  parsePageMessage,
  type BridgeGame,
  type BridgeMessage,
  type MessageEventLike,
  type MessageWindow,
  type MyAccounts,
} from '../../src/capture/protocol';

/** What the bridge asks of the extension's background (chrome.runtime messages in the browser). */
export interface BridgeBackend {
  hello(): Promise<{ extensionVersion: string; accounts: MyAccounts }>;
  takeBatch(max: number, exclude: readonly string[]): Promise<{ games: BridgeGame[]; remaining: number }>;
  markDelivered(keys: readonly string[]): Promise<number>;
}

/** A batch waits this long for the page's answer before the sync gives up (a later hello retries). */
export const BRIDGE_REPLY_TIMEOUT_MS = 30_000;

interface Sync {
  /** The batch sent and not answered yet. */
  batch: { id: string; keys: Set<string> } | null;
  /** Keys the page couldn't store in this sync: not offered again until the next one. */
  failed: Set<string>;
  delivered: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The extension's side of the bridge, running in the content script on the site's origin.
 * Only messages from this window and origin are read; replies go to this origin only.
 */
export class ExtensionBridge {
  private sync: Sync | null = null;
  /** New games arrived during a sync: ask the page for another one when it ends. */
  private again = false;
  private readonly listener = (event: MessageEventLike) => {
    void this.onMessage(event);
  };

  constructor(
    private readonly win: MessageWindow,
    private readonly backend: BridgeBackend,
    private readonly newBatchId: () => string = () => `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    // Wrapped: browsers throw "Illegal invocation" when setTimeout is called as a method of another object
    private readonly timers: {
      set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
      clear: (timer: ReturnType<typeof setTimeout>) => void;
    } = { set: (fn, ms) => setTimeout(fn, ms), clear: (timer) => clearTimeout(timer) },
  ) {}

  public start(): void {
    this.win.addEventListener('message', this.listener);
    this.post(bridgeMessage('bridge-ready', {}));
  }

  public stop(): void {
    this.win.removeEventListener('message', this.listener);
    this.endSync();
  }

  public isSyncing(): boolean {
    return this.sync !== null;
  }

  /**
   * The extension has new games: the page is asked to sync now (`bridge-ready`, to which it
   * says hello), whether or not its tab has focus. During a sync, once that sync is over.
   */
  public nudge(): void {
    if (this.sync) {
      this.again = true;
      return;
    }
    this.post(bridgeMessage('bridge-ready', {}));
  }

  private post(message: BridgeMessage): void {
    this.win.postMessage(message, this.win.location.origin);
  }

  private async onMessage(event: MessageEventLike): Promise<void> {
    if (event.source !== this.win || event.origin !== this.win.location.origin) return;
    const msg = parsePageMessage(event.data);
    if (!msg) return;
    if (msg.type === 'hello') {
      // A running sync already reads the queue afresh for every batch, so games captured
      // meanwhile go out with it; another hello adds nothing
      if (this.sync) return;
      await this.startSync();
      return;
    }
    // 'saved': only an answer to the batch in flight counts, and only for keys in it
    const sync = this.sync;
    if (!sync?.batch || msg.batchId !== sync.batch.id) return;
    const batchKeys = sync.batch.keys;
    sync.batch = null;
    if (sync.timer) this.timers.clear(sync.timer);
    sync.timer = null;
    const acked = [...msg.saved, ...msg.duplicates].filter((k) => batchKeys.has(k));
    for (const f of msg.failed) if (batchKeys.has(f.key)) sync.failed.add(f.key);
    // Anything the page neither stored nor reported failed is retried next sync, not now
    for (const k of batchKeys) if (!acked.includes(k)) sync.failed.add(k);
    try {
      sync.delivered += acked.length > 0 ? await this.backend.markDelivered(acked) : 0;
    } catch {
      this.finishSync();
      return;
    }
    await this.sendNextBatch();
  }

  private async startSync(): Promise<void> {
    this.sync = { batch: null, failed: new Set(), delivered: 0, timer: null };
    try {
      const { extensionVersion, accounts } = await this.backend.hello();
      this.post(bridgeMessage('hello-ack', { extensionVersion, accounts }));
    } catch {
      this.endSync();
      return;
    }
    await this.sendNextBatch();
  }

  private async sendNextBatch(): Promise<void> {
    const sync = this.sync;
    if (!sync) return;
    let next: { games: BridgeGame[]; remaining: number };
    try {
      next = await this.backend.takeBatch(BRIDGE_MAX_BATCH, [...sync.failed]);
    } catch {
      this.finishSync();
      return;
    }
    if (this.sync !== sync) return;
    if (next.games.length === 0) {
      this.finishSync();
      return;
    }
    const id = this.newBatchId();
    sync.batch = { id, keys: new Set(next.games.map((g) => g.key)) };
    sync.timer = this.timers.set(() => {
      if (this.sync === sync && sync.batch?.id === id) this.finishSync();
    }, BRIDGE_REPLY_TIMEOUT_MS);
    this.post(bridgeMessage('games', { batchId: id, games: next.games, remaining: next.remaining }));
  }

  private finishSync(): void {
    const delivered = this.sync?.delivered ?? 0;
    this.endSync();
    this.post(bridgeMessage('sync-done', { delivered }));
    if (this.again) {
      this.again = false;
      this.post(bridgeMessage('bridge-ready', {}));
    }
  }

  private endSync(): void {
    if (this.sync?.timer) this.timers.clear(this.sync.timer);
    this.sync = null;
  }
}
