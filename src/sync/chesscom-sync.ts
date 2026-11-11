/**
 * "Sync my Chess.com games": reads a player's public monthly archives and adds the games the library does not hold
 * yet, as the same records the restore file holds (hpc/history/lib/history.mjs, buildRestorePayload), so a restore
 * and a sync, in either order and any number of times, keep every game once.
 *
 * The run asks for the archive list, then one month at a time with a second before each. A month that can no longer
 * change (see isMonthFinal) is not asked for again. Each month's new games are stored before the next month is asked
 * for, so a run that stops (offline, an error, Stop) keeps what it has and the next run continues. Nothing is ever
 * deleted or overwritten. Everything the run touches is handed in, so the unit tests run it with a fake network.
 */
import { importProblemOf } from '../capture/pgn-games';
import type { NewGameRecord } from '../library/game-record';
import type { GameLibrary } from '../library/library';
import type { SingleGameCheck } from '../library/pgn-import-core';
import {
  CHESSCOM_SYNC_METHOD,
  archiveMonthUrl,
  archivesListUrl,
  gameKeyFromPgnHeaders,
  isChessComUsername,
  isMonthFinal,
  monthsFromList,
} from './chesscom-archive';

/**
 * With "Auto-analyze new games" on, a run that added at most this many games queues them for review when it ends. A
 * bigger run (a first sync of a long history) queues none and says so: hundreds of reviews would keep a phone's one
 * engine busy for hours.
 */
export const SYNC_AUTO_REVIEW_MAX_GAMES = 100;
/** The status line of a run too big for its reviews to be queued (`{added}`: games added, `{max}`: the limit above). */
export const SYNC_REVIEWS_NOT_QUEUED_LINE = '{added} games added; reviews not queued (more than {max} at once)';

export function reviewsNotQueuedLine(added: number): string {
  return SYNC_REVIEWS_NOT_QUEUED_LINE.replace('{added}', String(added)).replace(
    '{max}',
    String(SYNC_AUTO_REVIEW_MAX_GAMES),
  );
}

/** The settings key of the sync's own record of what it has read. */
export const SYNC_STATE_SETTING = 'sync.chesscom';
/** The API asks for reasonable use: one request at a time, this long before each month. */
export const SYNC_REQUEST_GAP_MS = 1000;
export const SYNC_REQUEST_TIMEOUT_MS = 30_000;
/** How long a "too many requests" answer is waited out before the one retry, when the answer does not say. */
export const SYNC_RATE_LIMIT_WAIT_MS = 15_000;
const RATE_LIMIT_WAIT_MAX_MS = 60_000;

export interface SyncMonthState {
  /** When the month was read (ms since the epoch, the device's clock). */
  at: number;
  /** Games the month's archive held then. */
  games: number;
}

export interface SyncState {
  version: 1;
  /** The player the months belong to, lowercased. */
  player: string;
  months: Record<string, SyncMonthState>;
}

/** The stored state for this player; an empty one when there is none, it is another player's, or it is not readable. */
export function parseSyncState(value: unknown, username: string): SyncState {
  const player = username.toLowerCase();
  const fresh: SyncState = { version: 1, player, months: {} };
  if (!value || typeof value !== 'object') return fresh;
  const v = value as Partial<SyncState>;
  if (v.version !== 1 || v.player !== player || !v.months || typeof v.months !== 'object') return fresh;
  for (const [month, entry] of Object.entries(v.months)) {
    if (!/^\d{4}-\d{2}$/.test(month) || !entry || typeof entry !== 'object') continue;
    const { at, games } = entry as Partial<SyncMonthState>;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    fresh.months[month] = { at, games: typeof games === 'number' && Number.isFinite(games) ? games : 0 };
  }
  return fresh;
}

export interface SyncResponse {
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type SyncFetch = (url: string, init: RequestInit) => Promise<SyncResponse>;

/** The browser's own fetch: the one place the website asks another host for anything. */
export const browserFetch: SyncFetch = (url, init) => fetch(url, init);

/** A wait that ends early when `signal` is aborted (Stop does not sit out the second before the next month). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** What the run reads and writes: the library, in the app. */
export interface SyncStore {
  listGameIds(): Promise<string[]>;
  checkSingleGame(pgn: string, method: string | null): Promise<SingleGameCheck>;
  /** Stores the games that are not stored yet; returns their ids. Never changes a stored game. */
  saveSyncedGames(records: readonly NewGameRecord[]): Promise<string[]>;
  readState(): Promise<unknown>;
  writeState(state: SyncState): Promise<void>;
}

export function librarySyncStore(library: GameLibrary): SyncStore {
  return {
    listGameIds: () => library.listIds(),
    checkSingleGame: (pgn, method) => library.checkSingleGame(pgn, method),
    saveSyncedGames: (records) => library.saveSyncedGames(records),
    readState: () => library.readSetting<unknown>(SYNC_STATE_SETTING),
    writeState: (state) => library.writeSetting(SYNC_STATE_SETTING, state),
  };
}

export interface SyncProgress {
  /** Months dealt with so far (read, unchanged or failed), of `monthsTotal`. */
  monthsDone: number;
  monthsTotal: number;
  /** Games added so far in this run. */
  added: number;
}

export interface SyncDeps {
  /** The Chess.com username from Settings › Your games. */
  username: string;
  fetchImpl: SyncFetch;
  /** Waits; may return early once `signal` is aborted. */
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  store: SyncStore;
  /** False when the browser knows it has no network (no request is tried then). */
  isOnline?: () => boolean;
  /** Stop: the run ends after the step it is in, keeping what it stored. */
  signal?: AbortSignal;
  onProgress?: (progress: SyncProgress) => void;
  /** Whether "Auto-analyze new games" is on (asked once, when the run ends). */
  isAutoAnalyzeOn: () => boolean | Promise<boolean>;
  /** Queues reviews for games this run added (see SYNC_AUTO_REVIEW_MAX_GAMES). */
  queueReviews: (ids: string[]) => void;
  timeoutMs?: number;
}

export type SyncFailure =
  'no-username' | 'bad-username' | 'offline' | 'unknown-player' | 'list' | 'network' | 'timeout' | 'rate-limited';

/** Games of the archives that were not added, by reason. */
export interface SyncSkipped {
  /** A variant the app does not play. */
  variant: number;
  noMoves: number;
  /** Rejected by the app's PGN check (an illegal move, a broken text). */
  invalid: number;
  /** The archive entry has no PGN. */
  noPgn: number;
  /** An entry that is not a game at all. */
  malformed: number;
  /** The same game a second time in this run (a game can be listed in two months). */
  duplicate: number;
}

export interface SyncResult {
  status: 'done' | 'stopped' | 'failed';
  failure: SyncFailure | null;
  /** A detail of the failure that names no address ("HTTP 500"). */
  detail: string;
  monthsTotal: number;
  /** Months read from the API in this run. */
  monthsRead: number;
  /** Months stored earlier that can no longer change: not asked for. */
  monthsUnchanged: number;
  monthsFailed: Array<{ month: string; reason: string }>;
  /** Ids of the games this run added. */
  added: string[];
  /** Games of the months read that the library already held. */
  present: number;
  skipped: SyncSkipped;
  /** What became of the reviews of the added games (see SYNC_AUTO_REVIEW_MAX_GAMES). */
  reviews: 'queued' | 'not-queued' | 'none';
}

type Got =
  | { kind: 'ok'; body: unknown }
  | { kind: 'http'; status: number; retryAfter: string | null }
  | { kind: 'not-json' }
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'stopped' }
  | { kind: 'rate-limited' };

/** One GET of the API. A failure is a kind, never the error's own text: that can quote the address, which holds a name. */
async function request(deps: SyncDeps, url: string): Promise<Got> {
  const controller = new AbortController();
  const onStop = (): void => controller.abort();
  deps.signal?.addEventListener('abort', onStop, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.timeoutMs ?? SYNC_REQUEST_TIMEOUT_MS);
  const failed = (): Got =>
    deps.signal?.aborted ? { kind: 'stopped' } : timedOut ? { kind: 'timeout' } : { kind: 'network' };
  try {
    if (deps.signal?.aborted) return { kind: 'stopped' };
    let res: SyncResponse;
    try {
      res = await deps.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        mode: 'cors',
        credentials: 'omit',
        // Never followed to another address: only the API's own host is ever asked
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch {
      return failed();
    }
    if (res.status !== 200) {
      return { kind: 'http', status: res.status, retryAfter: res.headers?.get('retry-after') ?? null };
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      return failed();
    }
    try {
      return { kind: 'ok', body: JSON.parse(text) as unknown };
    } catch {
      return { kind: 'not-json' };
    }
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onStop);
  }
}

function rateLimitWaitMs(retryAfter: string | null): number {
  const seconds = retryAfter === null || retryAfter.trim() === '' ? NaN : Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds < 0) return SYNC_RATE_LIMIT_WAIT_MS;
  return Math.min(seconds * 1000, RATE_LIMIT_WAIT_MAX_MS);
}

/** A GET that waits out one "too many requests" answer and tries once more. */
async function get(deps: SyncDeps, url: string): Promise<Got> {
  const first = await request(deps, url);
  if (first.kind !== 'http' || first.status !== 429) return first;
  await deps.sleep(rateLimitWaitMs(first.retryAfter));
  if (deps.signal?.aborted) return { kind: 'stopped' };
  const second = await request(deps, url);
  return second.kind === 'http' && second.status === 429 ? { kind: 'rate-limited' } : second;
}

/** Runs one sync. Never throws for anything the network or the archives do; a storage failure does throw. */
export async function runChessComSync(deps: SyncDeps): Promise<SyncResult> {
  const result: SyncResult = {
    status: 'done',
    failure: null,
    detail: '',
    monthsTotal: 0,
    monthsRead: 0,
    monthsUnchanged: 0,
    monthsFailed: [],
    added: [],
    present: 0,
    skipped: { variant: 0, noMoves: 0, invalid: 0, noPgn: 0, malformed: 0, duplicate: 0 },
    reviews: 'none',
  };
  const finish = async (
    status: SyncResult['status'],
    failure: SyncFailure | null = null,
    detail = '',
  ): Promise<SyncResult> => {
    result.status = status;
    result.failure = failure;
    result.detail = detail;
    // The reviews of what this run added, however it ended. Reviews queued before are not touched.
    if (result.added.length > 0 && (await deps.isAutoAnalyzeOn())) {
      if (result.added.length > SYNC_AUTO_REVIEW_MAX_GAMES) {
        result.reviews = 'not-queued';
      } else {
        deps.queueReviews([...result.added]);
        result.reviews = 'queued';
      }
    }
    return result;
  };
  /** How a request that did not give a body ends the run, or null when the run goes on. */
  const endOf = (got: Got): Promise<SyncResult> | null => {
    if (got.kind === 'stopped') return finish('stopped');
    if (got.kind === 'network') return finish('failed', 'network');
    if (got.kind === 'timeout') return finish('failed', 'timeout');
    if (got.kind === 'rate-limited') return finish('failed', 'rate-limited');
    return null;
  };
  const stopped = (): boolean => deps.signal?.aborted === true;

  const username = deps.username.trim();
  if (username === '') return finish('failed', 'no-username');
  if (!isChessComUsername(username)) return finish('failed', 'bad-username');
  if (deps.isOnline && !deps.isOnline()) return finish('failed', 'offline');
  const me = username.toLowerCase();

  const list = await get(deps, archivesListUrl(username));
  const listEnd = endOf(list);
  if (listEnd) return listEnd;
  if (list.kind === 'http') {
    if (list.status === 404 || list.status === 410) return finish('failed', 'unknown-player');
    return finish('failed', 'list', `HTTP ${list.status}`);
  }
  const listed = list.kind === 'ok' ? monthsFromList(list.body, username) : null;
  if (!listed) return finish('failed', 'list', 'not an archive list');

  const { months } = listed;
  result.monthsTotal = months.length;
  const known = new Set(await deps.store.listGameIds());
  /** Every game met in this run, added or already here: a game can be listed in two months. */
  const seen = new Set<string>();
  let state = parseSyncState(await deps.store.readState(), username);
  let monthsDone = 0;
  const report = (): void => deps.onProgress?.({ monthsDone, monthsTotal: months.length, added: result.added.length });
  report();

  for (const month of months) {
    if (stopped()) return finish('stopped');
    const stored = state.months[month];
    if (stored && isMonthFinal(month, stored.at)) {
      result.monthsUnchanged++;
      monthsDone++;
      report();
      continue;
    }
    await deps.sleep(SYNC_REQUEST_GAP_MS);
    if (stopped()) return finish('stopped');
    const got = await get(deps, archiveMonthUrl(username, month));
    const end = endOf(got);
    if (end) return end;
    const games =
      got.kind === 'ok' && got.body && typeof got.body === 'object' ? (got.body as { games?: unknown }).games : null;
    if (!Array.isArray(games)) {
      // This month is asked for again next time; the others go on
      const reason =
        got.kind === 'http' ? `HTTP ${got.status}` : got.kind === 'not-json' ? 'not JSON' : 'no games list';
      result.monthsFailed.push({ month, reason });
      monthsDone++;
      report();
      continue;
    }
    const readAt = deps.now();

    const records: NewGameRecord[] = [];
    let cutShort = false;
    for (const game of games as unknown[]) {
      if (stopped()) {
        cutShort = true;
        break;
      }
      if (!game || typeof game !== 'object') {
        result.skipped.malformed++;
        continue;
      }
      const pgn = typeof (game as { pgn?: unknown }).pgn === 'string' ? (game as { pgn: string }).pgn : '';
      if (pgn.trim() === '') {
        result.skipped.noPgn++;
        continue;
      }
      const problem = importProblemOf(pgn);
      if (problem) {
        if (problem.kind === 'variant') result.skipped.variant++;
        else result.skipped.noMoves++;
        continue;
      }
      // A game the library holds is found by its headers alone: no move is read for it
      const quick = gameKeyFromPgnHeaders(pgn);
      if (quick !== null && seen.has(quick)) {
        result.skipped.duplicate++;
        continue;
      }
      if (quick !== null && known.has(quick)) {
        seen.add(quick);
        result.present++;
        continue;
      }
      const checked = await deps.store.checkSingleGame(pgn, CHESSCOM_SYNC_METHOD);
      if ('problem' in checked) {
        if (checked.problem === 'no-moves') result.skipped.noMoves++;
        else result.skipped.invalid++;
        continue;
      }
      const record = checked.record;
      if (seen.has(record.id)) {
        result.skipped.duplicate++;
        continue;
      }
      seen.add(record.id);
      if (known.has(record.id)) {
        result.present++;
        continue;
      }
      const isWhite = record.white.toLowerCase() === me;
      const isBlack = record.black.toLowerCase() === me;
      records.push({ ...record, playerColor: isBlack && !isWhite ? 'b' : 'w' });
    }

    const saved = await deps.store.saveSyncedGames(records);
    result.added.push(...saved);
    // A game that reached the library some other way meanwhile was left as it is
    result.present += records.length - saved.length;
    if (cutShort) return finish('stopped');

    state = { ...state, months: { ...state.months, [month]: { at: readAt, games: games.length } } };
    await deps.store.writeState(state);
    result.monthsRead++;
    monthsDone++;
    report();
  }
  return finish('done');
}

// --- What the user is told ---------------------------------------------------------------------------------------

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const KEPT = 'What was read so far is kept: sync again to continue.';

const FAILURE_TEXT: Record<SyncFailure, string> = {
  'no-username': 'Add your Chess.com username under Your games first.',
  'bad-username':
    'That Chess.com username does not look right (3 to 25 letters, digits, - or _). Check it under Your games.',
  offline: 'You are offline. Connect to the internet and sync again.',
  'unknown-player': 'Chess.com does not know a player with that username. Check it under Your games.',
  list: "Chess.com's list of your archives could not be read",
  network: `Chess.com could not be reached; you may be offline. ${KEPT}`,
  timeout: `Chess.com did not answer in time. ${KEPT}`,
  'rate-limited': `Chess.com asked for fewer requests. Wait a few minutes. ${KEPT}`,
};

export interface SyncReport {
  tone: 'ok' | 'bad' | '';
  /** One sentence or more per line, the outcome first. */
  lines: string[];
}

/** The final count of a run, in words. Never a name and never an address. */
export function describeSyncResult(result: SyncResult): SyncReport {
  const lines: string[] = [];
  if (result.status === 'failed' && result.failure) {
    const text = FAILURE_TEXT[result.failure];
    lines.push(result.failure === 'list' ? `${text} (${result.detail}). Try again later.` : text);
  } else if (result.status === 'stopped') {
    lines.push(`Stopped. ${KEPT}`);
  }

  const read = result.monthsRead > 0 || result.added.length > 0 || result.present > 0;
  if (result.status === 'done' || read) {
    const added = result.added.length;
    const parts = [added === 0 ? 'No new games.' : `Added ${count(added, 'game')}.`];
    if (result.present > 0) parts.push(`${result.present} ${result.present === 1 ? 'was' : 'were'} already here.`);
    lines.push(parts.join(' '));
  }

  const s = result.skipped;
  const unreadable = s.invalid + s.noPgn + s.malformed;
  const reasons = [
    s.variant > 0 ? count(s.variant, 'variant game', 'variant games') + ' the app does not play' : '',
    s.noMoves > 0 ? `${s.noMoves} with no moves` : '',
    unreadable > 0 ? `${unreadable} that could not be read` : '',
    s.duplicate > 0 ? `${s.duplicate} listed twice` : '',
  ].filter((r) => r !== '');
  if (reasons.length > 0) {
    const total = s.variant + s.noMoves + unreadable + s.duplicate;
    lines.push(`Skipped ${count(total, 'game')}: ${reasons.join(', ')}.`);
  }

  if (result.monthsFailed.length > 0) {
    const shown = result.monthsFailed.slice(0, 3).map((f) => `${f.month}: ${f.reason}`);
    const more = result.monthsFailed.length > 3 ? ', …' : '';
    lines.push(
      `${count(result.monthsFailed.length, 'month')} could not be read (${shown.join(', ')}${more}). Sync again to read ${
        result.monthsFailed.length === 1 ? 'it' : 'them'
      }.`,
    );
  }
  if (result.monthsUnchanged > 0) {
    lines.push(
      `${count(result.monthsUnchanged, 'earlier month')} ${
        result.monthsUnchanged === 1 ? 'was' : 'were'
      } already stored and not asked for again.`,
    );
  }
  if (result.reviews === 'not-queued') lines.push(reviewsNotQueuedLine(result.added.length));
  else if (result.reviews === 'queued') lines.push('Quick reviews are queued for the new games.');

  const bad = result.status === 'failed' || result.monthsFailed.length > 0;
  return { tone: bad ? 'bad' : result.status === 'done' ? 'ok' : '', lines };
}
