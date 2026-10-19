import { gameKey, parseGameUrl, type CaptureSite } from '../../src/capture/game-id';
import { looksLikePgn } from './extractors/lichess-session-export';
import {
  archivesListUrl,
  fetchApiJson,
  fetchArchiveMonth,
  monthOf,
  retryAfterMs,
  type ArchiveGame,
} from './extractors/chesscom-archive';
import type { CaptureQueue, CaptureTrigger, KeyValueStore, ReadyInput } from './queue';

/**
 * "Import my history": every game of my account, fetched a page at a time into the
 * capture queue.
 *
 * - Lichess: `GET /api/games/user/{name}` (NDJSON, oldest first, `since` = just after the
 *   newest game already imported, 200 per request).
 * - Chess.com: the monthly archives, oldest first; a month in the past is fetched once, the
 *   current month again on later imports with If-None-Match (304 = nothing new).
 *
 * One request per step, one step at a time across both sites, a pause between steps. A 429
 * backs off (Lichess asks for at least a minute; doubling up to 15 minutes). While 1000 or
 * more games wait for the site, the import pauses, which keeps chrome.storage under its
 * quota. Everything is in storage, so the import survives the service worker stopping.
 */
export interface BackfillSiteState {
  status: 'idle' | 'running' | 'waiting' | 'done' | 'error';
  /** Username the import runs for (the setting when it started). */
  username: string;
  /** Games this import added to the queue. */
  imported: number;
  /** Progress or the reason it waits: "2026/09 of 2026/10", "Rate limited, retrying at 14:05". */
  message: string;
  updatedAt: number;
  /** When a waiting import goes on (ms since the epoch; null: when the site collects games). */
  resumeAt?: number | null;
}

export const IDLE_BACKFILL: BackfillSiteState = { status: 'idle', username: '', imported: 0, message: '', updatedAt: 0 };

export const BACKFILL_SITES: readonly CaptureSite[] = ['lichess', 'chesscom'];

export const LICHESS_HISTORY_METHOD = 'lichess-history';
export const CHESSCOM_HISTORY_METHOD = 'chesscom-archive-history';
export const LICHESS_PAGE_SIZE = 200;
/** Pause between two requests of an import. */
export const BACKFILL_PAUSE_MS = 1500;
/** The import waits while this many games are not yet on the site. */
export const BACKFILL_QUEUE_LIMIT = 1000;
export const BACKFILL_MIN_BACKOFF_MS = 60_000;
export const BACKFILL_MAX_BACKOFF_MS = 15 * 60_000;

interface LichessCursor {
  /** createdAt (ms) of the next game to fetch: just after the newest one imported. */
  since: number;
}

interface ChessComCursor {
  /** Archive months, oldest first ("2026/09"). */
  months: string[];
  /** Months finished for good (in the past when fetched). */
  complete: string[];
  /** ETag per month URL. */
  etags: Record<string, string>;
  /** The archive list was fetched in this import. */
  listFetched: boolean;
}

interface Backoff {
  /** Consecutive rate limits. */
  strikes: number;
}

export type StepResult =
  /** Call step again after the pause. */
  | { next: 'continue'; delayMs: number }
  /** Waiting: for a rate limit (`atMs`) or for the site to collect games (`atMs` null). */
  | { next: 'wait'; atMs: number | null }
  | { next: 'stop' };

export interface BackfillDeps {
  store: KeyValueStore;
  queue: CaptureQueue;
  fetch: typeof fetch;
  now: () => number;
}

const stateKey = (site: CaptureSite) => `backfill:${site}:state`;
const cursorKey = (site: CaptureSite, username: string) => `backfill:${site}:cursor:${username.toLowerCase()}`;
const backoffKey = (site: CaptureSite) => `backfill:${site}:backoff`;

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export class BackfillRunner {
  /** Steps of both sites run one after another: one request at a time in all. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BackfillDeps) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async get<T>(key: string): Promise<T | undefined> {
    return (await this.deps.store.get([key]))[key] as T | undefined;
  }

  private set(key: string, value: unknown): Promise<void> {
    return this.deps.store.set({ [key]: value });
  }

  public async state(site: CaptureSite): Promise<BackfillSiteState> {
    return (await this.get<BackfillSiteState>(stateKey(site))) ?? { ...IDLE_BACKFILL };
  }

  private async setState(site: CaptureSite, patch: Partial<BackfillSiteState>): Promise<BackfillSiteState> {
    const next = { ...(await this.state(site)), ...patch, updatedAt: this.deps.now() };
    await this.set(stateKey(site), next);
    return next;
  }

  /** Starts (or restarts) an import for `username`. */
  public start(site: CaptureSite, username: string): Promise<BackfillSiteState> {
    return this.exclusive(async () => {
      const current = await this.state(site);
      if ((current.status === 'running' || current.status === 'waiting') && current.username === username) return current;
      await this.set(backoffKey(site), { strikes: 0 } satisfies Backoff);
      if (site === 'chesscom') {
        // A new import reads the archive list again and looks at the current month again
        // (with its ETag); past months already imported are skipped
        const cursor = await this.get<ChessComCursor>(cursorKey(site, username));
        const current = monthOf(this.deps.now());
        if (cursor) {
          await this.set(cursorKey(site, username), {
            ...cursor,
            listFetched: false,
            complete: cursor.complete.filter((m) => m < current),
          } satisfies ChessComCursor);
        }
      }
      return this.setState(site, { status: 'running', username, imported: 0, message: 'Starting…', resumeAt: null });
    });
  }

  public stop(site: CaptureSite): Promise<BackfillSiteState> {
    return this.exclusive(() => this.setState(site, { status: 'idle', message: 'Stopped.', resumeAt: null }));
  }

  /** Imports that are running or waiting, with the time a waiting one may go on. */
  public async active(): Promise<Array<{ site: CaptureSite; state: BackfillSiteState }>> {
    const out: Array<{ site: CaptureSite; state: BackfillSiteState }> = [];
    for (const site of BACKFILL_SITES) {
      const state = await this.state(site);
      if (state.status === 'running' || state.status === 'waiting') out.push({ site, state });
    }
    return out;
  }

  /** One request of an import (or none, when it has to wait). */
  public step(site: CaptureSite): Promise<StepResult> {
    return this.exclusive(async () => {
      const state = await this.state(site);
      if (state.status !== 'running' && state.status !== 'waiting') return { next: 'stop' };
      const now = this.deps.now();
      if (state.status === 'waiting' && state.resumeAt && state.resumeAt > now) return { next: 'wait', atMs: state.resumeAt };
      const counts = await this.deps.queue.counts();
      const waiting = counts.pending + counts.ready;
      if (waiting >= BACKFILL_QUEUE_LIMIT) {
        await this.setState(site, {
          status: 'waiting',
          resumeAt: null,
          message: `Paused: ${waiting} games wait for the analysis site. Open it to collect them.`,
        });
        return { next: 'wait', atMs: null };
      }
      try {
        return site === 'lichess' ? await this.stepLichess(state) : await this.stepChessCom(state);
      } catch (err) {
        await this.setState(site, { status: 'error', message: `Stopped: ${err instanceof Error ? err.message : String(err)}` });
        return { next: 'stop' };
      }
    });
  }

  private async rateLimited(site: CaptureSite, retryAfter: number): Promise<StepResult> {
    const backoff = (await this.get<Backoff>(backoffKey(site))) ?? { strikes: 0 };
    const strikes = backoff.strikes + 1;
    const wait = Math.min(BACKFILL_MAX_BACKOFF_MS, Math.max(retryAfter, BACKFILL_MIN_BACKOFF_MS * 2 ** (strikes - 1)));
    const atMs = this.deps.now() + wait;
    await this.set(backoffKey(site), { strikes } satisfies Backoff);
    await this.setState(site, { status: 'waiting', resumeAt: atMs, message: `Rate limited; going on at ${clock(atMs)}.` });
    return { next: 'wait', atMs };
  }

  private async progressed(site: CaptureSite, added: number, message: string): Promise<void> {
    await this.set(backoffKey(site), { strikes: 0 } satisfies Backoff);
    const state = await this.state(site);
    await this.setState(site, { status: 'running', resumeAt: null, imported: state.imported + added, message });
  }

  private async addGames(inputs: ReadyInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const outcomes = await this.deps.queue.addReady(inputs);
    return outcomes.filter((o) => o === 'added').length;
  }

  // --- Lichess

  private async stepLichess(state: BackfillSiteState): Promise<StepResult> {
    const site: CaptureSite = 'lichess';
    const key = cursorKey(site, state.username);
    const cursor = (await this.get<LichessCursor>(key)) ?? { since: 0 };
    const url =
      `https://lichess.org/api/games/user/${encodeURIComponent(state.username)}` +
      `?since=${cursor.since}&max=${LICHESS_PAGE_SIZE}&sort=dateAsc&clocks=true&evals=false&opening=true&pgnInJson=true`;
    const res = await this.deps.fetch(url, { headers: { Accept: 'application/x-ndjson' }, credentials: 'omit' });
    if (res.status === 429) return this.rateLimited(site, retryAfterMs(res.headers.get('retry-after'), BACKFILL_MIN_BACKOFF_MS));
    if (res.status === 404) {
      await this.setState(site, { status: 'error', message: `Lichess has no user "${state.username}".` });
      return { next: 'stop' };
    }
    if (!res.ok) throw new Error(`Lichess answered ${res.status}.`);
    const lines = (await res.text()).split('\n').filter((l) => l.trim() !== '');
    const inputs: ReadyInput[] = [];
    let newest = cursor.since - 1;
    for (const line of lines) {
      let game: { id?: string; createdAt?: number; pgn?: string };
      try {
        game = JSON.parse(line) as typeof game;
      } catch {
        continue;
      }
      if (typeof game.createdAt === 'number') newest = Math.max(newest, game.createdAt);
      if (!game.id || !game.pgn || !looksLikePgn(game.pgn)) continue;
      const ref = { site, gameId: game.id };
      inputs.push({
        key: gameKey(ref),
        source: site,
        pgn: game.pgn.trim(),
        method: LICHESS_HISTORY_METHOD,
        url: `https://lichess.org/${game.id}`,
        trigger: 'history',
      });
    }
    const added = await this.addGames(inputs);
    await this.set(key, { since: newest + 1 } satisfies LichessCursor);
    if (lines.length < LICHESS_PAGE_SIZE) {
      const total = (await this.state(site)).imported + added;
      await this.set(backoffKey(site), { strikes: 0 } satisfies Backoff);
      await this.setState(site, {
        status: 'done',
        imported: total,
        resumeAt: null,
        message: `Up to date · ${total} new game${total === 1 ? '' : 's'} imported`,
      });
      return { next: 'stop' };
    }
    await this.progressed(site, added, `Imported up to ${new Date(newest).toISOString().slice(0, 10)}…`);
    return { next: 'continue', delayMs: BACKFILL_PAUSE_MS };
  }

  // --- Chess.com

  private async stepChessCom(state: BackfillSiteState): Promise<StepResult> {
    const site: CaptureSite = 'chesscom';
    const key = cursorKey(site, state.username);
    const cursor: ChessComCursor = (await this.get<ChessComCursor>(key)) ?? { months: [], complete: [], etags: {}, listFetched: false };

    if (!cursor.listFetched) {
      const listUrl = archivesListUrl(state.username);
      const r = await fetchApiJson<{ archives?: string[] }>(this.deps.fetch, listUrl, cursor.etags[listUrl] ?? null);
      if (r.status === 'rate-limited') return this.rateLimited(site, r.retryAfterMs);
      if (r.status === 'not-found') {
        await this.setState(site, { status: 'error', message: `Chess.com has no user "${state.username}".` });
        return { next: 'stop' };
      }
      if (r.status === 'error') throw new Error(r.reason);
      if (r.status === 'ok') {
        cursor.months = (r.body.archives ?? [])
          .map((u) => /\/games\/(\d{4}\/\d{2})$/.exec(u)?.[1])
          .filter((m): m is string => Boolean(m))
          .sort();
        if (r.etag) cursor.etags[listUrl] = r.etag;
      }
      cursor.listFetched = true;
      await this.set(key, cursor);
      await this.progressed(site, 0, `${cursor.months.length} months of games to check…`);
      return { next: 'continue', delayMs: BACKFILL_PAUSE_MS };
    }

    const month = cursor.months.find((m) => !cursor.complete.includes(m));
    if (!month) {
      const total = state.imported;
      await this.setState(site, {
        status: 'done',
        resumeAt: null,
        message: `Up to date · ${total} new game${total === 1 ? '' : 's'} imported`,
      });
      await this.set(key, { ...cursor, listFetched: false });
      return { next: 'stop' };
    }
    const monthUrl = `https://api.chess.com/pub/player/${state.username.toLowerCase()}/games/${month}`;
    const r = await fetchArchiveMonth(this.deps.fetch, state.username, month, cursor.etags[monthUrl] ?? null);
    if (r.status === 'rate-limited') return this.rateLimited(site, r.retryAfterMs);
    if (r.status === 'error') throw new Error(r.reason);
    let added = 0;
    if (r.status === 'ok') {
      added = await this.addGames(archiveInputs(r.games));
      if (r.etag) cursor.etags[monthUrl] = r.etag;
    }
    // Done for this import; a past month doesn't change any more, the current one is
    // looked at again by the next import (start())
    cursor.complete.push(month);
    await this.set(key, cursor);
    const done = cursor.complete.length;
    await this.progressed(site, added, `Checked ${month} (${done} of ${cursor.months.length} months)…`);
    return { next: 'continue', delayMs: BACKFILL_PAUSE_MS };
  }
}

/** Standard and Chess960 games of an archive month as queue entries. */
export function archiveInputs(
  games: readonly ArchiveGame[],
  method: string = CHESSCOM_HISTORY_METHOD,
  trigger: CaptureTrigger = 'history',
): ReadyInput[] {
  const inputs: ReadyInput[] = [];
  for (const g of games) {
    if (g.rules && g.rules !== 'chess' && g.rules !== 'chess960') continue;
    const ref = parseGameUrl(g.url);
    if (!ref || ref.site !== 'chesscom' || !g.pgn || !looksLikePgn(g.pgn)) continue;
    inputs.push({ key: gameKey(ref), source: 'chesscom', pgn: g.pgn.trim(), method, url: g.url, trigger });
  }
  return inputs;
}
