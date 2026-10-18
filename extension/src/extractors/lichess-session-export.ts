import type { ExtractContext, ExtractResult, Extractor } from './types';

/**
 * Lichess's official single-game export, `GET /game/export/{id}?clocks=true`, sent with the
 * browser's Lichess session. Lichess now answers anonymous requests with a redirect to
 * /signup (or 401 "Login required"), so this only works where the session cookie goes
 * along: from a content script on lichess.org, not from the extension's service worker.
 */
export const LICHESS_SESSION_EXPORT_METHOD = 'lichess-session-export';

/** A PGN body (starts with a header), not an HTML page or a JSON error. */
export function looksLikePgn(text: string): boolean {
  return /^\s*\[[A-Za-z0-9_]+\s+"/.test(text) && !/^\s*</.test(text);
}

/** Classifies an export response: the PGN, or why it isn't one. */
export function classifyLichessExport(
  res: { status: number; url: string; redirected: boolean; headers: { get(name: string): string | null } },
  body: string,
  method: string,
): ExtractResult {
  const fail = (reason: string, extra: Partial<Extract<ExtractResult, { ok: false }>> = {}): ExtractResult => ({
    ok: false,
    method,
    reason,
    ...extra,
  });
  let path = '';
  try {
    path = new URL(res.url).pathname;
  } catch {
    path = '';
  }
  if (res.status === 401 || (res.redirected && /^\/(signup|login)\b/.test(path)) || /"error"\s*:\s*"Login required"/i.test(body)) {
    return fail('Lichess wants a login for this export.', { loginRequired: true });
  }
  if (res.status === 429) return fail('Rate limited by Lichess.', { retryAfterMs: 60_000 });
  if (res.status === 404) return fail('Lichess has no game with this ID.', { notFound: true });
  if (res.status < 200 || res.status >= 300) return fail(`The export answered ${res.status}.`);
  if (!looksLikePgn(body)) return fail('The export did not return a PGN.');
  return { ok: true, pgn: body.trim(), method };
}

export const lichessSessionExportExtractor: Extractor = {
  method: LICHESS_SESSION_EXPORT_METHOD,
  async extract(ctx: ExtractContext): Promise<ExtractResult> {
    const res = await ctx.fetch(
      `https://lichess.org/game/export/${ctx.ref.gameId}?clocks=true&evals=false&literate=false&opening=true`,
      { credentials: 'include', headers: { Accept: 'application/x-chess-pgn' } },
    );
    return classifyLichessExport(res, await res.text(), LICHESS_SESSION_EXPORT_METHOD);
  },
};
