import { chessComParts, type SiteGameRef } from '../../../src/capture/game-id';
import { DEFAULT_POSITION } from '../../../src/core/rules';
import { tcnToSan } from './chesscom-tcn';
import { buildPgn, utcDateTime, type BuiltMove } from './pgn-builder';
import type { ExtractContext, ExtractResult, Extractor } from './types';

/**
 * Chess.com game pages carry no game data in their HTML; the page loads it from
 * `/callback/live/game/{id}` (or `/callback/daily/game/{id}`). That JSON has the moves in
 * TCN (`game.moveList`), the PGN headers (`game.pgnHeaders`), the clock after every move
 * for live games (`game.moveTimestamps`, deciseconds), and `isFinished`. This builds the
 * PGN from it. Unofficial: Chess.com can change the endpoint or its fields.
 */
export const CHESSCOM_CALLBACK_METHOD = 'chesscom-callback';

export interface ChessComCallback {
  game: {
    id: number;
    isFinished?: boolean;
    moveList?: string;
    moveTimestamps?: string;
    initialSetup?: string;
    type?: string;
    typeName?: string;
    plyCount?: number;
    endTime?: number;
    resultMessage?: string;
    gameEndReason?: string;
    colorOfWinner?: string;
    pgnHeaders?: Record<string, string | number>;
  };
  players?: Record<string, { username?: string; color?: string; rating?: number }>;
}

export function chessComCallbackUrl(ref: SiteGameRef): string {
  const { type, id } = chessComParts(ref);
  return `https://www.chess.com/callback/${type}/game/${id}`;
}

/** Header values as Chess.com sends them, with its `\'` escapes undone. */
function header(h: Record<string, string | number> | undefined, key: string): string | null {
  const v = h?.[key];
  if (v === undefined || v === null || v === '') return null;
  return String(v).replace(/\\'/g, "'");
}

export function chessComUsernames(data: ChessComCallback): { white: string; black: string } {
  const h = data.game.pgnHeaders;
  return { white: (header(h, 'White') ?? '').toLowerCase(), black: (header(h, 'Black') ?? '').toLowerCase() };
}

/** The game as PGN; clocks (tenths, as Chess.com writes them) for live games. Null without moves. */
export function chessComCallbackToPgn(data: ChessComCallback, ref: SiteGameRef): string | null {
  const g = data.game;
  const tcn = g.moveList ?? '';
  if (tcn === '') return null;
  const h = g.pgnHeaders ?? {};
  const chess960 = g.type === 'chess960' || header(h, 'Variant') === 'Chess960';
  const startFen = g.initialSetup || header(h, 'FEN') || DEFAULT_POSITION;
  const sans = tcnToSan(tcn, startFen, chess960);
  const { type } = chessComParts(ref);
  const clocks = type === 'live' && g.moveTimestamps ? g.moveTimestamps.split(',').map(Number) : [];
  const moves: BuiltMove[] = sans.map((san, i) => ({
    san,
    clockSeconds: Number.isFinite(clocks[i]) ? clocks[i]! / 10 : null,
  }));
  const result = g.isFinished ? (header(h, 'Result') ?? '*') : '*';
  const nonStandard = startFen !== DEFAULT_POSITION;
  // The game data has no start time; its end (UTC, as the archive's EndDate / EndTime) dates the game
  const end = g.isFinished && g.endTime ? utcDateTime(g.endTime * 1000) : null;
  const headers: Array<readonly [string, string | number | null]> = [
    ['Event', header(h, 'Event')],
    ['Site', header(h, 'Site') ?? 'Chess.com'],
    ['Date', header(h, 'Date')],
    ['Round', header(h, 'Round') ?? '-'],
    ['White', header(h, 'White')],
    ['Black', header(h, 'Black')],
    ['Result', result],
    ['Variant', chess960 ? 'Chess960' : null],
    ['SetUp', nonStandard ? '1' : null],
    ['FEN', nonStandard ? startFen : null],
    ['ECO', header(h, 'ECO')],
    ['WhiteElo', header(h, 'WhiteElo')],
    ['BlackElo', header(h, 'BlackElo')],
    ['TimeControl', header(h, 'TimeControl')],
    ['EndDate', end?.date ?? header(h, 'EndDate')],
    ['EndTime', end?.time ?? header(h, 'EndTime')],
    ['Termination', header(h, 'Termination')],
    ['Link', `https://www.chess.com/game/${type}/${g.id}`],
  ];
  const fenParts = startFen.split(/\s+/);
  return buildPgn(headers, moves, result, {
    startsWithBlack: fenParts[1] === 'b',
    firstMoveNumber: Number(fenParts[5]) || 1,
    clockTenths: true,
  });
}

export async function fetchChessComCallback(
  ref: SiteGameRef,
  doFetch: typeof fetch,
): Promise<{ ok: true; data: ChessComCallback } | { ok: false; status: number; reason: string }> {
  const res = await doFetch(chessComCallbackUrl(ref), { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!res.ok) return { ok: false, status: res.status, reason: `The game data answered ${res.status}.` };
  let data: ChessComCallback;
  try {
    data = (await res.json()) as ChessComCallback;
  } catch {
    return { ok: false, status: res.status, reason: 'The game data is not JSON.' };
  }
  const { id } = chessComParts(ref);
  if (!data?.game || String(data.game.id) !== id) return { ok: false, status: res.status, reason: 'The game data is for another game.' };
  return { ok: true, data };
}

export const chessComCallbackExtractor: Extractor = {
  method: CHESSCOM_CALLBACK_METHOD,
  async extract(ctx: ExtractContext): Promise<ExtractResult> {
    const fail = (reason: string, extra: Partial<Extract<ExtractResult, { ok: false }>> = {}): ExtractResult => ({
      ok: false,
      method: CHESSCOM_CALLBACK_METHOD,
      reason,
      ...extra,
    });
    const got = await fetchChessComCallback(ctx.ref, ctx.fetch);
    if (!got.ok) {
      if (got.status === 404) return fail('Chess.com has no game with this ID.', { notFound: true });
      if (got.status === 429) return fail('Rate limited by Chess.com.', { retryAfterMs: 60_000 });
      return fail(got.reason);
    }
    if (!got.data.game.isFinished) return fail('The game is still in progress.', { inProgress: true });
    let pgn: string | null;
    try {
      pgn = chessComCallbackToPgn(got.data, ctx.ref);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (!pgn) return fail('The game data has no moves.');
    return { ok: true, pgn, method: CHESSCOM_CALLBACK_METHOD };
  },
};
