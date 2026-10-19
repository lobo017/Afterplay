import type { GameSource } from '../../src/capture/game-id';
import { playedAtDetail, readPgnHeaders } from '../../src/capture/pgn-time';
import type { BridgeGame } from '../../src/capture/protocol';

/**
 * The capture queue, kept in the extension's storage.
 *
 * - pending: the game is known but its PGN isn't available yet (a Chess.com game not yet in
 *   the monthly archive); retried later.
 * - ready: the PGN is stored and waits for the website.
 * - delivered: the website stored it. The PGN is dropped; the index row stays, so the game
 *   isn't captured twice and the popup can still list it.
 *
 * Storage layout: one index object (small rows) and one key per waiting PGN, so listing the
 * queue never loads every PGN.
 */
export type QueueStatus = 'pending' | 'ready' | 'delivered';

/** What made the extension capture a game (shown in the popup, so a capture says how it came in). */
export type CaptureTrigger =
  /** The game ended on the open game page (auto-capture). */
  | 'game-end'
  /** A finished game of mine opened on its page (auto-capture). */
  | 'page-open'
  /** I left or closed the game page; the background fetched the game. */
  | 'left-page'
  /** The automatic background sync of my recent games. */
  | 'sync'
  /** The Save button on the game page. */
  | 'save-button'
  /** Import my history. */
  | 'history'
  /** A link (popup, context menu, pending retry). */
  | 'link'
  | 'paste';

export interface QueueEntry {
  key: string;
  source: GameSource;
  status: QueueStatus;
  capturedAt: number;
  updatedAt: number;
  /** Extraction method that produced the PGN (null while pending). */
  method: string | null;
  /** The game's page, when it has one. */
  url: string | null;
  white: string;
  black: string;
  result: string;
  /** PGN date, "YYYY.MM.DD" ('' when unknown). */
  date: string;
  /** When the game was played (ms, from the PGN's UTC date and time; null when unknown). */
  playedAt?: number | null;
  /** How the game was captured (entries from before this field: unknown). */
  trigger?: CaptureTrigger | null;
  /** Why the game is pending, or the last retry's error. */
  error: string | null;
  attempts: number;
  /** When a pending game is tried again (null: not scheduled). */
  nextRetryAt: number | null;
  deliveredAt: number | null;
}

/** The subset of chrome.storage.local the queue needs (an in-memory one in tests). */
export interface KeyValueStore {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface ReadyInput {
  key: string;
  source: GameSource;
  pgn: string;
  method: string;
  url?: string | null;
  trigger?: CaptureTrigger | null;
}

export interface PendingInput {
  key: string;
  source: GameSource;
  url: string | null;
  error: string;
  nextRetryAt: number | null;
  white?: string;
  black?: string;
  date?: string;
  trigger?: CaptureTrigger | null;
}

/**
 * - added: new game, stored.
 * - updated: was pending, now ready.
 * - already-queued: already ready (kept as it was).
 * - already-delivered: the website already has it.
 */
export type AddOutcome = 'added' | 'updated' | 'already-queued' | 'already-delivered';

export interface QueueCounts {
  pending: number;
  ready: number;
  delivered: number;
}

const INDEX_KEY = 'queue:index';
const pgnStorageKey = (key: string) => `queue:pgn:${key}`;

/** Header values from a PGN, without parsing the moves. */
export const pgnHeaderValues = readPgnHeaders;

function playedAtOf(headers: Readonly<Record<string, string>>): number | null {
  const played = playedAtDetail(headers);
  return played?.hasTime ? played.ms : null;
}

export class CaptureQueue {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs queue operations one at a time: each is a read-modify-write of the index. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async readIndex(): Promise<Record<string, QueueEntry>> {
    const raw = (await this.store.get([INDEX_KEY]))[INDEX_KEY];
    return raw && typeof raw === 'object' ? (raw as Record<string, QueueEntry>) : {};
  }

  private writeIndex(index: Record<string, QueueEntry>): Promise<void> {
    return this.store.set({ [INDEX_KEY]: index });
  }

  /** Stores games whose PGN is known. */
  public addReady(inputs: readonly ReadyInput[]): Promise<AddOutcome[]> {
    return this.exclusive(async () => {
      const index = await this.readIndex();
      const now = this.now();
      const pgns: Record<string, string> = {};
      const outcomes = inputs.map((input): AddOutcome => {
        const existing = index[input.key];
        if (existing?.status === 'delivered') return 'already-delivered';
        if (existing?.status === 'ready') return 'already-queued';
        const h = pgnHeaderValues(input.pgn);
        index[input.key] = {
          key: input.key,
          source: input.source,
          status: 'ready',
          capturedAt: existing?.capturedAt ?? now,
          updatedAt: now,
          method: input.method,
          url: input.url ?? existing?.url ?? null,
          white: h.White ?? existing?.white ?? '',
          black: h.Black ?? existing?.black ?? '',
          result: h.Result ?? '',
          date: h.UTCDate ?? h.Date ?? existing?.date ?? '',
          // Only a real time of day: a date alone is shown as written
          playedAt: playedAtOf(h) ?? existing?.playedAt ?? null,
          // A pending game keeps what first captured it
          trigger: existing?.trigger ?? input.trigger ?? null,
          error: null,
          attempts: existing?.attempts ?? 0,
          nextRetryAt: null,
          deliveredAt: null,
        };
        pgns[pgnStorageKey(input.key)] = input.pgn;
        return existing ? 'updated' : 'added';
      });
      if (Object.keys(pgns).length > 0) {
        await this.store.set(pgns);
        await this.writeIndex(index);
      }
      return outcomes;
    });
  }

  /** Records a game whose PGN isn't available yet (or updates its retry state). */
  public addPending(input: PendingInput): Promise<AddOutcome> {
    return this.exclusive(async () => {
      const index = await this.readIndex();
      const existing = index[input.key];
      if (existing?.status === 'delivered') return 'already-delivered';
      if (existing?.status === 'ready') return 'already-queued';
      const now = this.now();
      index[input.key] = {
        key: input.key,
        source: input.source,
        status: 'pending',
        capturedAt: existing?.capturedAt ?? now,
        updatedAt: now,
        method: null,
        url: input.url ?? existing?.url ?? null,
        white: input.white ?? existing?.white ?? '',
        black: input.black ?? existing?.black ?? '',
        result: '',
        date: input.date ?? existing?.date ?? '',
        playedAt: existing?.playedAt ?? null,
        // A pending game keeps what first captured it
        trigger: existing?.trigger ?? input.trigger ?? null,
        error: input.error,
        attempts: (existing?.attempts ?? 0) + (existing ? 1 : 0),
        nextRetryAt: input.nextRetryAt,
        deliveredAt: null,
      };
      await this.writeIndex(index);
      return existing ? 'updated' : 'added';
    });
  }

  public get(key: string): Promise<QueueEntry | null> {
    return this.exclusive(async () => (await this.readIndex())[key] ?? null);
  }

  /** Every entry, newest capture first. */
  public list(): Promise<QueueEntry[]> {
    return this.exclusive(async () => Object.values(await this.readIndex()).sort((a, b) => b.capturedAt - a.capturedAt));
  }

  public counts(): Promise<QueueCounts> {
    return this.exclusive(async () => {
      const counts: QueueCounts = { pending: 0, ready: 0, delivered: 0 };
      for (const e of Object.values(await this.readIndex())) counts[e.status]++;
      return counts;
    });
  }

  /** Ready games for the website, oldest capture first, skipping `exclude`. */
  public takeBatch(max: number, exclude: ReadonlySet<string> = new Set()): Promise<{ games: BridgeGame[]; remaining: number }> {
    return this.exclusive(async () => {
      const ready = Object.values(await this.readIndex())
        .filter((e) => e.status === 'ready' && !exclude.has(e.key))
        .sort((a, b) => a.capturedAt - b.capturedAt || a.key.localeCompare(b.key));
      const picked = ready.slice(0, max);
      const stored = picked.length > 0 ? await this.store.get(picked.map((e) => pgnStorageKey(e.key))) : {};
      const games: BridgeGame[] = [];
      for (const e of picked) {
        const pgn = stored[pgnStorageKey(e.key)];
        if (typeof pgn !== 'string') continue;
        games.push({ key: e.key, source: e.source, pgn, capturedAt: e.capturedAt, method: e.method ?? 'unknown' });
      }
      return { games, remaining: ready.length - picked.length };
    });
  }

  /** Marks the website's stored games delivered and drops their PGNs; returns how many changed. */
  public markDelivered(keys: readonly string[]): Promise<number> {
    return this.exclusive(async () => {
      const index = await this.readIndex();
      const now = this.now();
      const changed: string[] = [];
      for (const key of new Set(keys)) {
        const e = index[key];
        if (!e || e.status !== 'ready') continue;
        index[key] = { ...e, status: 'delivered', updatedAt: now, deliveredAt: now };
        changed.push(key);
      }
      if (changed.length > 0) {
        await this.writeIndex(index);
        await this.store.remove(changed.map(pgnStorageKey));
      }
      return changed.length;
    });
  }

  /** Pending games whose retry time has come. */
  public dueRetries(): Promise<QueueEntry[]> {
    return this.exclusive(async () => {
      const now = this.now();
      return Object.values(await this.readIndex()).filter(
        (e) => e.status === 'pending' && e.nextRetryAt !== null && e.nextRetryAt <= now,
      );
    });
  }

  /** Removes an entry that isn't delivered (the popup's "remove" on a pending game). */
  public remove(key: string): Promise<boolean> {
    return this.exclusive(async () => {
      const index = await this.readIndex();
      const e = index[key];
      if (!e || e.status === 'delivered') return false;
      delete index[key];
      await this.writeIndex(index);
      await this.store.remove([pgnStorageKey(key)]);
      return true;
    });
  }
}

/** An in-memory KeyValueStore (tests, and anything that needs a scratch queue). */
export class MemoryStore implements KeyValueStore {
  public readonly data = new Map<string, unknown>();

  public async get(keys: string[] | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of keys ?? [...this.data.keys()]) {
      if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    }
    return out;
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }

  public async remove(keys: string[]): Promise<void> {
    for (const k of keys) this.data.delete(k);
  }
}
