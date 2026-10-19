import type { SiteGameRef } from '../../src/capture/game-id';
import type { KeyValueStore } from './queue';
import type { TrackedTab } from './tab-tracker';

/**
 * Games I left before the site had their data (Chess.com answers 404 for a live game until it
 * has ended, and a game left in its last seconds may not have ended yet): fetched again after
 * these delays, then left to the background check of my archive. Kept in storage (the
 * service worker stops when idle); the background wakes it with a timer and an alarm.
 */
export const GAME_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000] as const;

export interface GameRetryItem {
  key: string;
  ref: SiteGameRef;
  url: string;
  /** The page as it was when I left it (whose game, seen in progress). */
  tab: TrackedTab;
  /** Retries done so far. */
  attempt: number;
  nextAt: number;
  firstAt: number;
}

/** What one try came to: `retry` when the game's data still isn't there. */
export interface RetryOutcome {
  retry: boolean;
  /** For the Debug view: "captured (added)", "not available yet". */
  result: string;
}

export interface RetryReport {
  key: string;
  url: string;
  site: SiteGameRef['site'];
  /** What happened, with what comes next. */
  result: string;
  done: boolean;
}

export interface GameRetryDeps {
  store: KeyValueStore;
  now: () => number;
  attempt: (item: GameRetryItem) => Promise<RetryOutcome>;
  /** The earliest retry due (null: none left), so the caller can set its timer and alarm. */
  onSchedule: (nextAt: number | null) => void;
}

const RETRIES_KEY = 'gameRetries';

const seconds = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

export class GameRetries {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: GameRetryDeps) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<Record<string, GameRetryItem>> {
    return ((await this.deps.store.get([RETRIES_KEY]))[RETRIES_KEY] as Record<string, GameRetryItem> | undefined) ?? {};
  }

  private async write(items: Record<string, GameRetryItem>): Promise<void> {
    await this.deps.store.set({ [RETRIES_KEY]: items });
    const next = Object.values(items).reduce<number | null>((m, i) => (m === null || i.nextAt < m ? i.nextAt : m), null);
    this.deps.onSchedule(next);
  }

  public list(): Promise<GameRetryItem[]> {
    return this.exclusive(async () => Object.values(await this.read()).sort((a, b) => a.nextAt - b.nextAt));
  }

  /** Schedules the retries of a game (a game already scheduled keeps its schedule). */
  public add(entry: { key: string; ref: SiteGameRef; url: string; tab: TrackedTab }): Promise<GameRetryItem> {
    return this.exclusive(async () => {
      const items = await this.read();
      const existing = items[entry.key];
      if (existing) return existing;
      const now = this.deps.now();
      const item: GameRetryItem = { ...entry, attempt: 0, nextAt: now + GAME_RETRY_DELAYS_MS[0], firstAt: now };
      items[entry.key] = item;
      await this.write(items);
      return item;
    });
  }

  /** "trying again in 30 s (retry 2 of 5)" for a scheduled game. */
  public static describe(item: GameRetryItem, now: number): string {
    return `trying again in ${seconds(Math.max(0, item.nextAt - now))} (retry ${item.attempt + 1} of ${GAME_RETRY_DELAYS_MS.length})`;
  }

  /** Tries every game that is due; returns what came of each. */
  public runDue(): Promise<RetryReport[]> {
    return this.exclusive(async () => {
      const items = await this.read();
      const now = this.deps.now();
      const reports: RetryReport[] = [];
      for (const item of Object.values(items)) {
        if (item.nextAt > now) continue;
        let outcome: RetryOutcome;
        try {
          outcome = await this.deps.attempt(item);
        } catch (err) {
          outcome = { retry: true, result: `failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        const base = { key: item.key, url: item.url, site: item.ref.site };
        if (!outcome.retry) {
          delete items[item.key];
          reports.push({ ...base, result: outcome.result, done: true });
          continue;
        }
        const attempt = item.attempt + 1;
        if (attempt >= GAME_RETRY_DELAYS_MS.length) {
          delete items[item.key];
          reports.push({
            ...base,
            result: `${outcome.result}; gave up after ${GAME_RETRY_DELAYS_MS.length} retries, left to the archive check`,
            done: true,
          });
          continue;
        }
        const next = { ...item, attempt, nextAt: this.deps.now() + GAME_RETRY_DELAYS_MS[attempt]! };
        items[item.key] = next;
        reports.push({ ...base, result: `${outcome.result}; ${GameRetries.describe(next, this.deps.now())}`, done: false });
      }
      await this.write(items);
      return reports;
    });
  }
}
