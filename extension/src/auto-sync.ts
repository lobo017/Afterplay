import { gameKey, type CaptureSite } from '../../src/capture/game-id';
import { archiveInputs, BACKFILL_MIN_BACKOFF_MS, BACKFILL_QUEUE_LIMIT } from './backfill';
import { fetchArchiveMonth, monthOf, nextMonth, retryAfterMs, type ArchiveGame } from './extractors/chesscom-archive';
import { looksLikePgn } from './extractors/lichess-session-export';
import type { CaptureQueue, KeyValueStore, ReadyInput } from './queue';

/**
 * The safety net behind live capture: my recent games, fetched from the same official
 * endpoints as "Import my history", every few minutes while a Lichess or Chess.com tab is
 * open and right after I leave a game page. Whatever live detection on the page missed
 * comes in this way; games the queue has are skipped as usual.
 *
 * - Lichess: `GET /api/games/user/{me}?since=…&ongoing=true`, oldest first. The cursor is
 *   just after the newest game seen, but a game still running holds it at that game's
 *   start, so the game is fetched again once it has ended (correspondence games excepted:
 *   they would hold it back for days).
 * - Chess.com: the archive months from the cursor's month to the current one, with ETags
 *   (304 = nothing new); games that ended since the cursor minus 12 h, since the archive can
 *   add a game hours after it ended.
 *
 * The first run for an account starts 24 h back: older games are what "Import my history"
 * is for. One request at a time; a 429 waits (at least a minute); nothing runs while the
 * site's history import does, or while 1000 games wait for the analysis site.
 */
export const AUTO_SYNC_PERIOD_MINUTES = 3;
export const AUTO_SYNC_FIRST_WINDOW_MS = 24 * 3600_000;
/** Shortest gap between two runs for a site: on the alarm, and after leaving a game page. */
export const AUTO_SYNC_MIN_GAP_MS = 60_000;
export const AUTO_SYNC_LEAVE_MIN_GAP_MS = 10_000;
export const LICHESS_SYNC_PAGE_SIZE = 100;
export const LICHESS_SYNC_MAX_PAGES = 5;
export const CHESSCOM_ARCHIVE_LAG_MS = 12 * 3600_000;
export const LICHESS_SYNC_METHOD = 'lichess-sync';
export const CHESSCOM_SYNC_METHOD = 'chesscom-archive-sync';

export type AutoSyncReason = 'alarm' | 'left-page' | 'startup' | 'manual';

export interface AutoSyncSiteState {
  /** The account the last run was for. */
  username: string;
  lastRunAt: number | null;
  /** What the last run did: "2 new games", "No new games", "Skipped: …". */
  lastResult: string;
  lastAdded: number;
  totalAdded: number;
  /** Rate limited: no run before this time (ms). */
  backoffUntil: number | null;
  lastError: string | null;
}

export const IDLE_AUTO_SYNC: AutoSyncSiteState = {
  username: '',
  lastRunAt: null,
  lastResult: 'Not run yet.',
  lastAdded: 0,
  totalAdded: 0,
  backoffUntil: null,
  lastError: null,
};

interface LichessSyncCursor {
  /** createdAt (ms) to fetch from. */
  since: number;
}

interface ChessComSyncCursor {
  /** End time (ms) of the newest game seen. */
  since: number;
  /** ETag per archive month URL. */
  etags: Record<string, string>;
}

export interface AutoSyncDeps {
  store: KeyValueStore;
  queue: CaptureQueue;
  fetch: typeof fetch;
  now: () => number;
  /** The site's "Import my history" is running (it fetches the same games). */
  importActive: (site: CaptureSite) => Promise<boolean>;
}

const stateKey = (site: CaptureSite) => `autosync:${site}:state`;
const cursorKey = (site: CaptureSite, username: string) => `autosync:${site}:cursor:${username.toLowerCase()}`;

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

class RateLimited extends Error {
  constructor(public readonly retryAfter: number) {
    super('rate limited');
  }
}

export class AutoSync {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AutoSyncDeps) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async get<T>(key: string): Promise<T | undefined> {
    return (await this.deps.store.get([key]))[key] as T | undefined;
  }

  public async state(site: CaptureSite): Promise<AutoSyncSiteState> {
    return { ...IDLE_AUTO_SYNC, ...((await this.get<AutoSyncSiteState>(stateKey(site))) ?? {}) };
  }

  private async setState(site: CaptureSite, patch: Partial<AutoSyncSiteState>): Promise<AutoSyncSiteState> {
    const next = { ...(await this.state(site)), ...patch };
    await this.deps.store.set({ [stateKey(site)]: next });
    return next;
  }

  /** One sync of a site for `username`; returns the state after it (with what it did or why it didn't run). */
  public run(site: CaptureSite, username: string, reason: AutoSyncReason): Promise<AutoSyncSiteState> {
    return this.exclusive(async () => {
      const now = this.deps.now();
      const state = await this.state(site);
      const skip = (why: string) => this.setState(site, { lastResult: `Skipped: ${why}` });
      if (state.backoffUntil !== null && state.backoffUntil > now) {
        return skip(`rate limited until ${clock(state.backoffUntil)}.`);
      }
      const gap = reason === 'alarm' ? AUTO_SYNC_MIN_GAP_MS : reason === 'manual' ? 0 : AUTO_SYNC_LEAVE_MIN_GAP_MS;
      if (state.username === username && state.lastRunAt !== null && now - state.lastRunAt < gap) return state;
      if (await this.deps.importActive(site)) return skip('the history import is running.');
      const counts = await this.deps.queue.counts();
      if (counts.pending + counts.ready >= BACKFILL_QUEUE_LIMIT) {
        return skip(`${counts.pending + counts.ready} games wait for the analysis site. Open it to collect them.`);
      }
      try {
        const added = site === 'lichess' ? await this.syncLichess(username, now) : await this.syncChessCom(username, now);
        return this.setState(site, {
          username,
          lastRunAt: now,
          lastAdded: added,
          totalAdded: (state.username === username ? state.totalAdded : 0) + added,
          lastResult: added === 0 ? 'No new games.' : `${plural(added, 'new game')}.`,
          backoffUntil: null,
          lastError: null,
        });
      } catch (err) {
        if (err instanceof RateLimited) {
          const until = now + Math.max(err.retryAfter, BACKFILL_MIN_BACKOFF_MS);
          return this.setState(site, {
            username,
            lastRunAt: now,
            lastAdded: 0,
            backoffUntil: until,
            lastResult: `Rate limited; trying again after ${clock(until)}.`,
            lastError: 'Rate limited.',
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        return this.setState(site, { username, lastRunAt: now, lastAdded: 0, lastResult: `Failed: ${message}`, lastError: message });
      }
    });
  }

  private async addGames(inputs: ReadyInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const outcomes = await this.deps.queue.addReady(inputs);
    return outcomes.filter((o) => o === 'added' || o === 'updated').length;
  }

  // --- Lichess

  private async syncLichess(username: string, now: number): Promise<number> {
    const key = cursorKey('lichess', username);
    const cursor = (await this.get<LichessSyncCursor>(key)) ?? { since: now - AUTO_SYNC_FIRST_WINDOW_MS };
    let since = cursor.since;
    let newest = cursor.since - 1;
    /** The start of the oldest game still running: the next run fetches from there. */
    let holdBack = Number.POSITIVE_INFINITY;
    let added = 0;
    for (let page = 0; page < LICHESS_SYNC_MAX_PAGES; page++) {
      const url =
        `https://lichess.org/api/games/user/${encodeURIComponent(username)}` +
        `?since=${since}&max=${LICHESS_SYNC_PAGE_SIZE}&sort=dateAsc&ongoing=true&clocks=true&evals=false&opening=true&pgnInJson=true`;
      const res = await this.deps.fetch(url, { headers: { Accept: 'application/x-ndjson' }, credentials: 'omit' });
      if (res.status === 429) throw new RateLimited(retryAfterMs(res.headers.get('retry-after'), BACKFILL_MIN_BACKOFF_MS));
      if (res.status === 404) throw new Error(`Lichess has no user "${username}".`);
      if (!res.ok) throw new Error(`Lichess answered ${res.status}.`);
      const lines = (await res.text()).split('\n').filter((l) => l.trim() !== '');
      const inputs: ReadyInput[] = [];
      for (const line of lines) {
        let game: { id?: string; createdAt?: number; pgn?: string; status?: string; speed?: string };
        try {
          game = JSON.parse(line) as typeof game;
        } catch {
          continue;
        }
        if (typeof game.createdAt === 'number') newest = Math.max(newest, game.createdAt);
        if (game.status === 'started' || game.status === 'created') {
          if (game.speed !== 'correspondence' && typeof game.createdAt === 'number') holdBack = Math.min(holdBack, game.createdAt);
          continue;
        }
        if (game.status === 'aborted' || game.status === 'noStart') continue;
        if (!game.id || !game.pgn || !looksLikePgn(game.pgn)) continue;
        inputs.push({
          key: gameKey({ site: 'lichess', gameId: game.id }),
          source: 'lichess',
          pgn: game.pgn.trim(),
          method: LICHESS_SYNC_METHOD,
          url: `https://lichess.org/${game.id}`,
          trigger: 'sync',
        });
      }
      added += await this.addGames(inputs);
      if (lines.length < LICHESS_SYNC_PAGE_SIZE) break;
      since = newest + 1;
    }
    const next = Number.isFinite(holdBack) ? holdBack : Math.max(cursor.since, newest + 1);
    await this.deps.store.set({ [key]: { since: next } satisfies LichessSyncCursor });
    return added;
  }

  // --- Chess.com

  private async syncChessCom(username: string, now: number): Promise<number> {
    const key = cursorKey('chesscom', username);
    const cursor = (await this.get<ChessComSyncCursor>(key)) ?? { since: now - AUTO_SYNC_FIRST_WINDOW_MS, etags: {} };
    const from = cursor.since - CHESSCOM_ARCHIVE_LAG_MS;
    const months: string[] = [];
    for (let m = monthOf(from); m <= monthOf(now) && months.length < 3; m = nextMonth(m)) months.push(m);
    let newest = cursor.since;
    let added = 0;
    const etags = { ...cursor.etags };
    for (const month of months) {
      const monthUrl = `https://api.chess.com/pub/player/${username.toLowerCase()}/games/${month}`;
      const r = await fetchArchiveMonth(this.deps.fetch, username, month, etags[monthUrl] ?? null);
      if (r.status === 'rate-limited') throw new RateLimited(r.retryAfterMs);
      if (r.status === 'error') throw new Error(r.reason);
      if (r.status !== 'ok') continue;
      if (r.etag) etags[monthUrl] = r.etag;
      const recent: ArchiveGame[] = r.games.filter((g) => typeof g.end_time === 'number' && g.end_time * 1000 >= from);
      for (const g of recent) newest = Math.max(newest, g.end_time! * 1000);
      added += await this.addGames(archiveInputs(recent, CHESSCOM_SYNC_METHOD, 'sync'));
    }
    // Only the months still in reach keep their ETags
    const kept: Record<string, string> = {};
    for (const [url, tag] of Object.entries(etags)) if (months.some((m) => url.endsWith(`/${m}`))) kept[url] = tag;
    await this.deps.store.set({ [key]: { since: newest, etags: kept } satisfies ChessComSyncCursor });
    return added;
  }
}
