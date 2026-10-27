import { gameKey, isValidRef, parseGameUrl, type CaptureSite, type SiteGameRef } from '../../src/capture/game-id';
import { checkPgnText } from '../../src/capture/pgn-games';
import type { BridgeGame } from '../../src/capture/protocol';
import { readPgnHeaders, playedAtFromHeaders } from '../../src/capture/pgn-time';
import type { AddOutcome, CaptureQueue, CaptureTrigger, KeyValueStore, RejectInput } from './queue';
import type { CaptureReply, LastFailure, SaveTextResult } from './messages';

/** Resolves a game link to its PGN (or to "not available yet"); added per site. */
export type LinkResolution =
  | { kind: 'pgn'; pgn: string; method: string }
  | {
      kind: 'pending';
      reason: string;
      retryAt: number;
      /** What is known about the game already (from the site's game data), for the popup. */
      white?: string;
      black?: string;
      date?: string;
    }
  /** The game hasn't ended yet. */
  | { kind: 'in-progress'; reason: string }
  | { kind: 'error'; error: string };

export type LinkResolver = (ref: SiteGameRef) => Promise<LinkResolution>;

/** What is known about a game when deciding whether to capture it automatically. */
export interface GameFacts {
  white: string;
  black: string;
  /** PGN result ('' while pending). */
  result: string;
  /** When it was played (ms; null when unknown). */
  playedAt: number | null;
}

/** Why a game should not be captured automatically, or null to capture it. */
export type CaptureCheck = (facts: GameFacts) => string | null;

export type FinishedCaptureResult =
  | { outcome: AddOutcome | 'pending'; key: string }
  /** Already ready or delivered: nothing fetched. */
  | { outcome: 'known'; key: string }
  /** `retry`: the game hasn't ended (or the site has no data for it) yet: worth another try later. */
  | { outcome: 'skipped' | 'error'; key: string; reason: string; retry?: boolean };

export interface CaptureServiceDeps {
  queue: CaptureQueue;
  store: KeyValueStore;
  now: () => number;
  /** Per-site link resolution (popup links, the context menu, pending retries). */
  resolvers: Partial<Record<CaptureSite, LinkResolver>>;
  /** Called after anything that may change the undelivered count (the badge). */
  onQueueChanged: () => void;
}

const LAST_FAILURE_KEY = 'lastFailure';
/** A game still pending this long after it was first seen is no longer retried on its own. */
export const PENDING_MAX_AGE_MS = 48 * 3600_000;
const URL_LINE = /^https?:\/\/\S+$/i;

/** "GEU3 vs Lobo017" from a PGN's headers. */
function gameLabel(headers: Readonly<Record<string, string>>): string {
  return `${headers.White || 'White'} vs ${headers.Black || 'Black'}`;
}

/**
 * The extension's capture logic, independent of chrome.* (the background service worker
 * wires it to the browser): checks PGNs before they enter the queue, resolves links, keeps
 * the last failure for the popup.
 */
export class CaptureService {
  constructor(private readonly deps: CaptureServiceDeps) {}

  /** A PGN extracted by a content script. */
  public async saveCapture(
    site: CaptureSite,
    gameId: string,
    pgn: string,
    method: string,
    url: string,
    trigger: CaptureTrigger = 'save-button',
  ): Promise<CaptureReply> {
    const ref = { site, gameId };
    if (!isValidRef(ref)) return { ok: false, error: 'Not a game ID.' };
    const { games, errors } = checkPgnText(pgn);
    if (games.length !== 1) return { ok: false, error: errors[0] ?? 'Expected exactly one game.' };
    const key = gameKey(ref);
    const [outcome] = await this.deps.queue.addReady([{ key, source: site, pgn: games[0]!.pgn, method, url, trigger }]);
    this.deps.onQueueChanged();
    if (outcome === 'not-importable' || outcome === 'already-rejected') {
      const entry = await this.deps.queue.get(key);
      return { ok: true, key, outcome, reason: entry?.rejectReason ?? undefined };
    }
    return { ok: true, key, outcome: outcome! };
  }

  /** Pasted text from the popup: one or more links (one per line), or PGN. */
  public async saveText(text: string): Promise<SaveTextResult[]> {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0 && lines.every((l) => URL_LINE.test(l))) {
      const out: SaveTextResult[] = [];
      for (const link of lines) out.push(await this.saveLink(link));
      return out;
    }
    const { games, errors } = checkPgnText(text);
    const results: SaveTextResult[] = errors.map((error) => ({ label: 'PGN', ok: false, error }));
    if (games.length > 0) {
      const outcomes = await this.deps.queue.addReady(
        games.map((g) => ({
          key: g.key,
          source: g.source,
          pgn: g.pgn,
          method: 'pasted-pgn',
          url: null,
          trigger: 'paste' as const,
        })),
      );
      for (const [i, g] of games.entries()) {
        const outcome = outcomes[i]!;
        const entry =
          outcome === 'not-importable' || outcome === 'already-rejected' ? await this.deps.queue.get(g.key) : null;
        results.push({ label: gameLabel(g.headers), ok: true, outcome, reason: entry?.rejectReason ?? undefined });
      }
      this.deps.onQueueChanged();
    }
    return results;
  }

  /** A game link: resolved now, or queued as pending when its site doesn't have it yet. */
  public async saveLink(link: string): Promise<SaveTextResult> {
    const ref = parseGameUrl(link);
    if (!ref) return { label: link, ok: false, error: 'Not a Lichess or Chess.com game link.' };
    const key = gameKey(ref);
    const existing = await this.deps.queue.get(key);
    if (existing?.status === 'delivered' || existing?.status === 'ready') {
      return { label: link, ok: true, outcome: existing.status === 'ready' ? 'already-queued' : 'already-delivered' };
    }
    const resolver = this.deps.resolvers[ref.site];
    if (!resolver) return { label: link, ok: false, error: `${ref.site} links can't be resolved.` };
    const resolution = await resolver(ref);
    const result = await this.applyResolution(ref, link, resolution);
    this.deps.onQueueChanged();
    return result;
  }

  private async applyResolution(ref: SiteGameRef, link: string, resolution: LinkResolution): Promise<SaveTextResult> {
    const key = gameKey(ref);
    if (resolution.kind === 'pgn') {
      const { games, errors } = checkPgnText(resolution.pgn);
      if (games.length !== 1) return { label: link, ok: false, error: errors[0] ?? 'Expected exactly one game.' };
      const [outcome] = await this.deps.queue.addReady([
        { key, source: ref.site, pgn: games[0]!.pgn, method: resolution.method, url: link, trigger: 'link' },
      ]);
      return { label: gameLabel(games[0]!.headers), ok: true, outcome: outcome! };
    }
    if (resolution.kind === 'pending') {
      const existing = await this.deps.queue.get(key);
      const tooOld = existing !== null && this.deps.now() - existing.capturedAt > PENDING_MAX_AGE_MS;
      await this.deps.queue.addPending({
        key,
        source: ref.site,
        url: link,
        error: tooOld
          ? `${resolution.reason} Gave up retrying after 48 h: press Retry now, or open the game page and press Save.`
          : resolution.reason,
        nextRetryAt: tooOld ? null : resolution.retryAt,
        white: resolution.white,
        black: resolution.black,
        date: resolution.date,
        trigger: 'link',
      });
      return { label: link, ok: true, outcome: 'pending' };
    }
    if (resolution.kind === 'in-progress') {
      return { label: link, ok: false, error: `${resolution.reason} Save it when the game has ended.` };
    }
    return { label: link, ok: false, error: resolution.error };
  }

  /**
   * A game captured without a click (e.g. after I left its page): resolved with `resolver`,
   * and queued only if it has ended and `check` accepts it. Nothing is fetched for a game the
   * queue already has.
   */
  public async captureFinished(
    ref: SiteGameRef,
    url: string,
    resolver: LinkResolver,
    check: CaptureCheck,
    trigger: CaptureTrigger,
  ): Promise<FinishedCaptureResult> {
    const key = gameKey(ref);
    const existing = await this.deps.queue.get(key);
    if (existing && existing.status !== 'pending') return { outcome: 'known', key };
    const resolution = await resolver(ref);
    if (resolution.kind === 'in-progress') return { outcome: 'skipped', key, reason: resolution.reason, retry: true };
    if (resolution.kind === 'error') return { outcome: 'error', key, reason: resolution.error };
    if (resolution.kind === 'pending') {
      const skip = check({ white: resolution.white ?? '', black: resolution.black ?? '', result: '', playedAt: null });
      if (skip) return { outcome: 'skipped', key, reason: skip };
      await this.deps.queue.addPending({
        key,
        source: ref.site,
        url,
        error: resolution.reason,
        nextRetryAt: resolution.retryAt,
        white: resolution.white,
        black: resolution.black,
        date: resolution.date,
        trigger,
      });
      this.deps.onQueueChanged();
      return { outcome: 'pending', key };
    }
    const { games, errors } = checkPgnText(resolution.pgn);
    if (games.length !== 1) return { outcome: 'error', key, reason: errors[0] ?? 'Expected exactly one game.' };
    const h = readPgnHeaders(games[0]!.pgn);
    if ((h.Result ?? '*') === '*')
      return { outcome: 'skipped', key, reason: 'The game is still in progress.', retry: true };
    const skip = check({
      white: h.White ?? '',
      black: h.Black ?? '',
      result: h.Result ?? '',
      playedAt: playedAtFromHeaders(h),
    });
    if (skip) return { outcome: 'skipped', key, reason: skip };
    const [outcome] = await this.deps.queue.addReady([
      { key, source: ref.site, pgn: games[0]!.pgn, method: resolution.method, url, trigger },
    ]);
    this.deps.onQueueChanged();
    return { outcome: outcome!, key };
  }

  /** Tries pending games again: all that are due, or one (the popup's retry). */
  public async retryPending(onlyKey?: string): Promise<number> {
    const due = onlyKey
      ? [await this.deps.queue.get(onlyKey)].filter((e) => e?.status === 'pending')
      : await this.deps.queue.dueRetries();
    let resolved = 0;
    for (const entry of due) {
      if (!entry?.url) continue;
      const result = await this.saveLink(entry.url);
      if (result.ok && result.outcome !== 'pending') resolved++;
    }
    return resolved;
  }

  public async recordFailure(url: string, error: string): Promise<void> {
    const failure: LastFailure = { url, error, at: this.deps.now() };
    await this.deps.store.set({ [LAST_FAILURE_KEY]: failure });
  }

  public async lastFailure(): Promise<LastFailure | null> {
    const raw = (await this.deps.store.get([LAST_FAILURE_KEY]))[LAST_FAILURE_KEY];
    return raw && typeof raw === 'object' ? (raw as LastFailure) : null;
  }

  public async dismissFailure(): Promise<void> {
    await this.deps.store.remove([LAST_FAILURE_KEY]);
  }

  // --- bridge

  public takeBatch(max: number, exclude: readonly string[]): Promise<{ games: BridgeGame[]; remaining: number }> {
    return this.deps.queue.takeBatch(max, new Set(exclude));
  }

  public async markRejected(items: readonly RejectInput[]): Promise<number> {
    const n = await this.deps.queue.markRejected(items);
    if (n > 0) this.deps.onQueueChanged();
    return n;
  }

  public async markDelivered(keys: readonly string[]): Promise<number> {
    const n = await this.deps.queue.markDelivered(keys);
    if (n > 0) this.deps.onQueueChanged();
    return n;
  }
}
