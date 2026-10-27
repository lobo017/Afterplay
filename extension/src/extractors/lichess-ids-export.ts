import { classifyLichessExport } from './lichess-session-export';
import type { ExtractContext, ExtractResult, Extractor } from './types';

/**
 * Lichess's official "export games by IDs", `POST /api/games/export/_ids?clocks=true` with
 * the ID in the body. Unlike the single-game export it still answers without a login, so
 * the service worker uses it for links (where no session cookie goes along).
 */
export const LICHESS_IDS_EXPORT_METHOD = 'lichess-ids-export';

export const lichessIdsExportExtractor: Extractor = {
  method: LICHESS_IDS_EXPORT_METHOD,
  async extract(ctx: ExtractContext): Promise<ExtractResult> {
    const res = await ctx.fetch('https://lichess.org/api/games/export/_ids?clocks=true&evals=false&opening=true', {
      method: 'POST',
      body: ctx.ref.gameId,
      headers: { 'Content-Type': 'text/plain', Accept: 'application/x-chess-pgn' },
      credentials: 'omit',
    });
    const body = await res.text();
    // An unknown ID is not an error here: the answer is just empty
    if (res.ok && body.trim() === '') {
      return {
        ok: false,
        method: LICHESS_IDS_EXPORT_METHOD,
        reason: 'Lichess has no game with this ID.',
        notFound: true,
      };
    }
    const result = classifyLichessExport(res, body, LICHESS_IDS_EXPORT_METHOD);
    if (result.ok && !result.pgn.includes(`"https://lichess.org/${ctx.ref.gameId}"`)) {
      return { ok: false, method: LICHESS_IDS_EXPORT_METHOD, reason: 'The export returned a different game.' };
    }
    return result;
  },
};
