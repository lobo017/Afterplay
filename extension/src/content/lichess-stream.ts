/**
 * Lichess's official game stream, `GET https://lichess.org/api/stream/game/{id}` (NDJSON, no
 * login). Recorded (tests/fixtures/capture/lichess/stream-*.ndjson):
 * - the first line describes the game (id, players, createdAt; no `status` while it runs),
 * - then one line per position (`fen`, `lm`, `wc`, `bc`),
 * - when the game ends, the description again with `status` ({id, name}) and `winner`, and
 *   the stream closes. A finished game's stream sends all of it at once.
 * Lines of an ongoing game come a few seconds late (Lichess delays them by 3–60 s by time
 * control). This is the site's own game data, so it tells the end without reading the page.
 */

/** lila's chess.Status: below 25 the game is created or running. */
const FIRST_ENDED_STATUS = 25;
const STATUS_ABORTED = 25;
const STATUS_NO_START = 37;

export type StreamLine =
  | {
      kind: 'game';
      /** The game is over (finished or aborted). */
      ended: boolean;
      aborted: boolean;
      status: string | null;
      winner: string | null;
      white: string;
      black: string;
      createdAt: number | null;
    }
  | { kind: 'move' }
  | { kind: 'other' };

interface StreamPlayer {
  user?: { name?: string; id?: string };
  aiLevel?: number;
  name?: string;
}

function playerName(p: StreamPlayer | undefined): string {
  if (p?.user?.name) return p.user.name;
  if (p?.aiLevel) return `lichess AI level ${p.aiLevel}`;
  return p?.name ?? 'Anonymous';
}

export function classifyStreamLine(line: string): StreamLine {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { kind: 'other' };
  }
  if (!data || typeof data !== 'object') return { kind: 'other' };
  if (typeof data.id === 'string' && data.players && typeof data.players === 'object') {
    const status = data.status as { id?: number; name?: string } | undefined;
    const statusId = typeof status?.id === 'number' ? status.id : null;
    const players = data.players as { white?: StreamPlayer; black?: StreamPlayer };
    return {
      kind: 'game',
      ended: statusId !== null && statusId >= FIRST_ENDED_STATUS,
      aborted: statusId === STATUS_ABORTED || statusId === STATUS_NO_START,
      status: status?.name ?? null,
      winner: typeof data.winner === 'string' ? data.winner : null,
      white: playerName(players.white),
      black: playerName(players.black),
      createdAt: typeof data.createdAt === 'number' ? data.createdAt : null,
    };
  }
  if (typeof data.fen === 'string') return { kind: 'move' };
  return { kind: 'other' };
}

export function gameStreamUrl(gameId: string): string {
  return `https://lichess.org/api/stream/game/${gameId}`;
}

export type StreamOutcome =
  /** The stream ended normally (Lichess closes it when the game ends). */
  | { kind: 'closed'; lines: number }
  | { kind: 'http-error'; status: number }
  | { kind: 'failed'; reason: string }
  | { kind: 'aborted' };

/** Reads one connection of the stream, calling `onLine` for each line as it arrives. */
export async function readGameStream(
  gameId: string,
  doFetch: typeof fetch,
  onLine: (line: StreamLine) => void,
  signal?: AbortSignal,
): Promise<StreamOutcome> {
  let res: Response;
  try {
    res = await doFetch(gameStreamUrl(gameId), { headers: { Accept: 'application/x-ndjson' }, credentials: 'omit', signal });
  } catch (err) {
    if (signal?.aborted) return { kind: 'aborted' };
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { kind: 'http-error', status: res.status };
  let lines = 0;
  const emit = (raw: string) => {
    if (raw.trim() === '') return;
    lines++;
    onLine(classifyStreamLine(raw));
  };
  try {
    if (!res.body) {
      for (const raw of (await res.text()).split('\n')) emit(raw);
      return { kind: 'closed', lines };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        emit(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    emit(buffer + decoder.decode());
  } catch (err) {
    if (signal?.aborted) return { kind: 'aborted' };
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  return { kind: 'closed', lines };
}

export interface StreamTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: StreamTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Reconnect delays after the stream closed without an end, or failed. */
export const STREAM_RETRY_MS = [3000, 10_000, 30_000, 60_000] as const;
/** Lichess allows few streams per IP; a 429 waits this long. */
export const STREAM_RATE_LIMIT_MS = 60_000;

export interface GameStreamWatch {
  stop(): void;
  /** For the Debug view: "connected, 34 positions", "reconnecting in 10 s (closed)". */
  describe(): string;
}

/**
 * Keeps the stream open until it reports the end (`onEnd` with the final line) or the watch
 * is stopped. A stream that closes without an end line reports `onClosed` (the caller may
 * check the game); it, or one that failed, is opened again after a delay.
 */
export function watchGameStream(options: {
  gameId: string;
  fetch: typeof fetch;
  onEnd: (line: Extract<StreamLine, { kind: 'game' }>) => void;
  onClosed?: (why: string) => void;
  log?: (text: string) => void;
  timers?: StreamTimers;
}): GameStreamWatch {
  const timers = options.timers ?? defaultTimers;
  const log = options.log ?? (() => undefined);
  let stopped = false;
  let ended = false;
  let controller: AbortController | null = null;
  let retryHandle: unknown = null;
  let failures = 0;
  let positions = 0;
  let status = 'connecting';

  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    status = 'connecting (waiting for Lichess to answer)';
    positions = 0;
    let first = true;
    const outcome = await readGameStream(
      options.gameId,
      options.fetch,
      (line) => {
        if (first) {
          first = false;
          status = 'connected';
          log('Lichess game stream connected.');
        }
        if (line.kind === 'move') positions++;
        if (line.kind === 'game' && line.ended && !ended && !stopped) {
          ended = true;
          log(`Lichess game stream: the game ended (${line.status ?? 'over'}${line.winner ? `, ${line.winner} won` : ''}).`);
          options.onEnd(line);
        }
      },
      controller.signal,
    );
    controller = null;
    if (stopped || ended || outcome.kind === 'aborted') return;
    let why: string;
    let delay: number;
    if (outcome.kind === 'http-error') {
      why = `answered ${outcome.status}`;
      delay = outcome.status === 429 ? STREAM_RATE_LIMIT_MS : STREAM_RETRY_MS[Math.min(failures, STREAM_RETRY_MS.length - 1)]!;
    } else if (outcome.kind === 'failed') {
      why = `failed: ${outcome.reason}`;
      delay = STREAM_RETRY_MS[Math.min(failures, STREAM_RETRY_MS.length - 1)]!;
    } else {
      // A stream that delivered lines was healthy: start the back-off again
      if (outcome.lines > 0) failures = 0;
      why = `closed after ${outcome.lines} line${outcome.lines === 1 ? '' : 's'}`;
      delay = STREAM_RETRY_MS[Math.min(failures, STREAM_RETRY_MS.length - 1)]!;
    }
    failures++;
    status = `reconnecting in ${Math.round(delay / 1000)} s (${why})`;
    log(`Lichess game stream ${why}; reconnecting in ${Math.round(delay / 1000)} s.`);
    // Lichess closes the stream when the game ends: a normal close is worth a check
    if (outcome.kind === 'closed') options.onClosed?.(why);
    retryHandle = timers.set(() => {
      retryHandle = null;
      void connect();
    }, delay);
  };
  void connect();

  return {
    stop() {
      stopped = true;
      controller?.abort();
      if (retryHandle !== null) timers.clear(retryHandle);
      retryHandle = null;
    },
    describe() {
      if (ended) return 'Lichess game stream: ended';
      return status === 'connected' ? `Lichess game stream: connected, ${positions} positions` : `Lichess game stream: ${status}`;
    },
  };
}
