import { isGameKey, type GameSource } from './game-id';

/**
 * The bridge between the website and the capture extension: window messages between the
 * page and the extension's content script on the site's origin.
 *
 * 1. The page says `hello` (on load, on focus, when its tab becomes visible). The bridge
 *    also says `bridge-ready` when it loads, so a page that spoke first says hello again.
 * 2. The bridge answers `hello-ack` (versions, my usernames), then sends ready games in
 *    `games` batches.
 * 3. The page stores them (skipping duplicates by site + game ID) and answers `saved` with
 *    the keys it stored, the keys it already had, and the ones it couldn't store.
 * 4. The extension marks stored and already-stored keys delivered and sends the next batch;
 *    failed games stay ready for the next sync.
 *
 * Both sides check the sender (same window, same origin) and the message shape.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;
export const PAGE_MESSAGE_SOURCE = 'wizard-chess-page';
export const BRIDGE_MESSAGE_SOURCE = 'wizard-chess-extension';

/** Upper bounds that keep a malformed or hostile message from doing much. */
export const BRIDGE_MAX_BATCH = 50;
export const BRIDGE_MAX_PGN_LENGTH = 512 * 1024;
const MAX_TEXT = 200;

/** A captured game as it crosses the bridge. */
export interface BridgeGame {
  /** `lichess:<id>`, `chesscom:<live|daily>-<n>` or `paste:<hash>`. */
  key: string;
  source: GameSource;
  pgn: string;
  /** When the extension captured it (ms since the epoch). */
  capturedAt: number;
  /** Which extraction method produced the PGN, e.g. `lichess-session-export`. */
  method: string;
}

/** My usernames, from the extension's settings ('' when not set). */
export interface MyAccounts {
  lichess: string;
  chesscom: string;
}

export interface FailedDelivery {
  key: string;
  reason: string;
}

export type PageMessage =
  | { source: typeof PAGE_MESSAGE_SOURCE; type: 'hello'; version: number }
  | {
      source: typeof PAGE_MESSAGE_SOURCE;
      type: 'saved';
      version: number;
      batchId: string;
      saved: string[];
      duplicates: string[];
      failed: FailedDelivery[];
    };

export type BridgeMessage =
  | { source: typeof BRIDGE_MESSAGE_SOURCE; type: 'bridge-ready'; version: number }
  | {
      source: typeof BRIDGE_MESSAGE_SOURCE;
      type: 'hello-ack';
      version: number;
      extensionVersion: string;
      accounts: MyAccounts;
    }
  | {
      source: typeof BRIDGE_MESSAGE_SOURCE;
      type: 'games';
      version: number;
      batchId: string;
      games: BridgeGame[];
      /** Ready games left after this batch. */
      remaining: number;
    }
  | { source: typeof BRIDGE_MESSAGE_SOURCE; type: 'sync-done'; version: number; delivered: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShortString(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isKeyList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= BRIDGE_MAX_BATCH && value.every((k) => typeof k === 'string' && isGameKey(k));
}

const BATCH_ID = /^[A-Za-z0-9-]{1,40}$/;

function isBridgeGame(value: unknown): value is BridgeGame {
  if (!isRecord(value)) return false;
  return (
    typeof value.key === 'string' &&
    isGameKey(value.key) &&
    (value.source === 'lichess' || value.source === 'chesscom' || value.source === 'paste') &&
    value.key.startsWith(`${value.source}:`) &&
    typeof value.pgn === 'string' &&
    value.pgn.length > 0 &&
    value.pgn.length <= BRIDGE_MAX_PGN_LENGTH &&
    typeof value.capturedAt === 'number' &&
    Number.isFinite(value.capturedAt) &&
    isShortString(value.method, 60)
  );
}

/** The page's message, or null if it isn't a well-formed one of this protocol version. */
export function parsePageMessage(data: unknown): PageMessage | null {
  if (!isRecord(data) || data.source !== PAGE_MESSAGE_SOURCE || data.version !== BRIDGE_PROTOCOL_VERSION) return null;
  if (data.type === 'hello') return { source: PAGE_MESSAGE_SOURCE, type: 'hello', version: BRIDGE_PROTOCOL_VERSION };
  if (data.type === 'saved') {
    if (typeof data.batchId !== 'string' || !BATCH_ID.test(data.batchId)) return null;
    if (!isKeyList(data.saved) || !isKeyList(data.duplicates)) return null;
    const failed = data.failed;
    if (
      !Array.isArray(failed) ||
      failed.length > BRIDGE_MAX_BATCH ||
      !failed.every((f) => isRecord(f) && typeof f.key === 'string' && isGameKey(f.key) && isShortString(f.reason))
    ) {
      return null;
    }
    return {
      source: PAGE_MESSAGE_SOURCE,
      type: 'saved',
      version: BRIDGE_PROTOCOL_VERSION,
      batchId: data.batchId,
      saved: [...data.saved],
      duplicates: [...data.duplicates],
      failed: (failed as FailedDelivery[]).map((f) => ({ key: f.key, reason: f.reason })),
    };
  }
  return null;
}

/** The extension's message, or null if it isn't a well-formed one of this protocol version. */
export function parseBridgeMessage(data: unknown): BridgeMessage | null {
  if (!isRecord(data) || data.source !== BRIDGE_MESSAGE_SOURCE || data.version !== BRIDGE_PROTOCOL_VERSION) return null;
  const base = { source: BRIDGE_MESSAGE_SOURCE, version: BRIDGE_PROTOCOL_VERSION } as const;
  switch (data.type) {
    case 'bridge-ready':
      return { ...base, type: 'bridge-ready' };
    case 'hello-ack': {
      const a = data.accounts;
      if (!isShortString(data.extensionVersion, 40) || !isRecord(a)) return null;
      if (!isShortString(a.lichess, 40) || !isShortString(a.chesscom, 40)) return null;
      return {
        ...base,
        type: 'hello-ack',
        extensionVersion: data.extensionVersion,
        accounts: { lichess: a.lichess, chesscom: a.chesscom },
      };
    }
    case 'games': {
      if (typeof data.batchId !== 'string' || !BATCH_ID.test(data.batchId)) return null;
      if (!Array.isArray(data.games) || data.games.length > BRIDGE_MAX_BATCH || !data.games.every(isBridgeGame)) return null;
      if (typeof data.remaining !== 'number' || !Number.isInteger(data.remaining) || data.remaining < 0) return null;
      return {
        ...base,
        type: 'games',
        batchId: data.batchId,
        games: data.games.map((g: BridgeGame) => ({ ...g })),
        remaining: data.remaining,
      };
    }
    case 'sync-done':
      if (typeof data.delivered !== 'number' || !Number.isInteger(data.delivered) || data.delivered < 0) return null;
      return { ...base, type: 'sync-done', delivered: data.delivered };
    default:
      return null;
  }
}

export function pageMessage<T extends PageMessage['type']>(
  type: T,
  body: Omit<Extract<PageMessage, { type: T }>, 'source' | 'type' | 'version'>,
): Extract<PageMessage, { type: T }> {
  return { source: PAGE_MESSAGE_SOURCE, type, version: BRIDGE_PROTOCOL_VERSION, ...body } as Extract<PageMessage, { type: T }>;
}

export function bridgeMessage<T extends BridgeMessage['type']>(
  type: T,
  body: Omit<Extract<BridgeMessage, { type: T }>, 'source' | 'type' | 'version'>,
): Extract<BridgeMessage, { type: T }> {
  return { source: BRIDGE_MESSAGE_SOURCE, type, version: BRIDGE_PROTOCOL_VERSION, ...body } as Extract<
    BridgeMessage,
    { type: T }
  >;
}

/** Minimal window surface both sides use, so tests can wire them without a browser. */
export interface MessageWindow {
  readonly location: { readonly origin: string };
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
}

export interface MessageEventLike {
  data: unknown;
  origin: string;
  source: unknown;
}
