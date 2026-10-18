import type { SiteGameRef } from '../../../src/capture/game-id';

/** What an extraction method gets: the game, a fetch (the page's or the service worker's) and maybe the page. */
export interface ExtractContext {
  ref: SiteGameRef;
  fetch: typeof fetch;
  /** The game's page, when the method runs in its content script. */
  document?: Document;
  now?: () => number;
}

export type ExtractResult =
  | { ok: true; pgn: string; method: string }
  | {
      ok: false;
      method: string;
      reason: string;
      /** The site wants a login for this method (Lichess's single-game export). */
      loginRequired?: boolean;
      /** The game isn't finished yet (nothing to capture). */
      inProgress?: boolean;
      /** The site doesn't have the game (yet); Chess.com's archive lags behind. */
      notFound?: boolean;
      /** Rate limited: try again after this many ms. */
      retryAfterMs?: number;
    };

/** One way of getting a game's PGN. Every site has several, tried in order. */
export interface Extractor {
  readonly method: string;
  extract(ctx: ExtractContext): Promise<ExtractResult>;
}

export interface ExtractionOutcome {
  result: ExtractResult;
  /** Every method tried, in order, with why it failed. */
  attempts: Array<{ method: string; reason: string }>;
}

/** Tries the methods in order and returns the first PGN; stops early on "game in progress". */
export async function runExtractors(extractors: readonly Extractor[], ctx: ExtractContext): Promise<ExtractionOutcome> {
  const attempts: ExtractionOutcome['attempts'] = [];
  let last: ExtractResult = { ok: false, method: 'none', reason: 'No extraction method.' };
  for (const extractor of extractors) {
    let result: ExtractResult;
    try {
      result = await extractor.extract(ctx);
    } catch (err) {
      result = { ok: false, method: extractor.method, reason: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) return { result, attempts };
    attempts.push({ method: result.method, reason: result.reason });
    last = result;
    if (result.inProgress) break;
  }
  return { result: last, attempts };
}

/** "lichess-ids-export: rate limited; lichess-page-data: no game data" for messages. */
export function describeAttempts(attempts: ExtractionOutcome['attempts']): string {
  return attempts.map((a) => `${a.method}: ${a.reason}`).join('; ');
}
