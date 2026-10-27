import { DEFAULT_POSITION } from '../../../src/core/rules';
import { buildPgn, utcDateTime, type BuiltMove } from './pgn-builder';
import type { ExtractContext, ExtractResult, Extractor } from './types';

/**
 * Lichess game pages boot from `<script type="application/json" id="page-init-data">`,
 * which carries the whole game: players, clock settings, status and one `treeParts` entry
 * per ply (SAN, UCI, FEN and the clock after the move in centiseconds). This turns it into
 * a PGN like Lichess's own export. Unofficial: the page format can change.
 */
export const LICHESS_PAGE_DATA_METHOD = 'lichess-page-data';

interface LichessPlayerData {
  color: 'white' | 'black';
  user?: { username?: string; id?: string };
  name?: string;
  ai?: number;
  rating?: number;
  ratingDiff?: number;
  spectator?: boolean;
}

interface LichessTreePart {
  ply: number;
  fen: string;
  san?: string;
  uci?: string;
  clock?: number;
}

export interface LichessGameData {
  game: {
    id: string;
    variant?: { key?: string; name?: string };
    speed?: string;
    perf?: string;
    rated?: boolean;
    createdAt?: number;
    initialFen?: string;
    status?: { id?: number; name?: string };
    winner?: 'white' | 'black';
    turns?: number;
  };
  clock?: { initial?: number; increment?: number };
  correspondence?: { daysPerTurn?: number };
  player: LichessPlayerData;
  opponent: LichessPlayerData;
  treeParts?: LichessTreePart[];
  steps?: LichessTreePart[];
}

/** Status ids from lila's chess.Status. */
const STATUS_STARTED = 20;
const STATUS_ABORTED = 25;
const STATUS_FIRST_FINISHED = 30;
const STATUS_NO_START = 37;

/** The game data from a page's HTML or Document, or null when the page has none. */
export function readLichessPageData(source: string | Document): LichessGameData | null {
  let json: string | null;
  if (typeof source === 'string') {
    const m = /<script[^>]*\bid="page-init-data"[^>]*>([\s\S]*?)<\/script>/.exec(source);
    json = m?.[1] ?? null;
  } else {
    json = source.getElementById('page-init-data')?.textContent ?? null;
  }
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const root = parsed as { cfg?: { data?: unknown }; data?: unknown };
  const data = (root.cfg?.data ?? root.data) as LichessGameData | undefined;
  if (!data?.game?.id || !data.player || !data.opponent) return null;
  return data;
}

export type LichessGameState = 'in-progress' | 'finished' | 'aborted';

export function lichessGameState(data: LichessGameData): LichessGameState {
  const id = data.game.status?.id ?? 0;
  if (id === STATUS_ABORTED || id === STATUS_NO_START) return 'aborted';
  return id >= STATUS_FIRST_FINISHED ? 'finished' : id <= STATUS_STARTED ? 'in-progress' : 'aborted';
}

function playerName(p: LichessPlayerData): string {
  if (p.user?.username) return p.user.username;
  if (p.ai) return `lichess AI level ${p.ai}`;
  return p.name ?? 'Anonymous';
}

export function lichessPlayers(data: LichessGameData): { white: LichessPlayerData; black: LichessPlayerData } {
  return data.player.color === 'white'
    ? { white: data.player, black: data.opponent }
    : { white: data.opponent, black: data.player };
}

/** The usernames playing, lowercased (for "did I play this game"). */
export function lichessUsernames(data: LichessGameData): { white: string; black: string } {
  const { white, black } = lichessPlayers(data);
  return { white: playerName(white).toLowerCase(), black: playerName(black).toLowerCase() };
}

function resultOf(data: LichessGameData, state: LichessGameState): string {
  if (state !== 'finished') return '*';
  if (data.game.winner === 'white') return '1-0';
  if (data.game.winner === 'black') return '0-1';
  return '1/2-1/2';
}

/** lila's PgnDump termination names. */
function terminationOf(statusName: string | undefined): string {
  switch (statusName) {
    case 'outoftime':
    case 'timeout':
      return 'Time forfeit';
    case 'cheat':
      return 'Rules infraction';
    case 'started':
    case 'created':
      return 'Unterminated';
    case 'aborted':
    case 'noStart':
      return 'Abandoned';
    default:
      return 'Normal';
  }
}

const diff = (n: number | undefined) => (n === undefined ? null : n > 0 ? `+${n}` : String(n));

/** The game as PGN with `[%clk]` after every move; null when the data has no moves. */
export function lichessDataToPgn(data: LichessGameData): string | null {
  const parts = data.treeParts ?? data.steps ?? [];
  if (parts.length < 2) return null;
  const state = lichessGameState(data);
  const { white, black } = lichessPlayers(data);
  const { date, time } = data.game.createdAt ? utcDateTime(data.game.createdAt) : { date: '????.??.??', time: '' };
  const variantKey = data.game.variant?.key ?? 'standard';
  const startFen = parts[0]!.fen;
  const fromPosition = variantKey === 'chess960' || variantKey === 'fromPosition' || startFen !== DEFAULT_POSITION;
  const timeControl =
    data.clock?.initial !== undefined
      ? `${data.clock.initial}+${data.clock.increment ?? 0}`
      : data.correspondence
        ? '-'
        : null;
  const event = `${data.game.rated ? 'rated' : 'casual'} ${data.game.speed ?? data.game.perf ?? ''} game`.replace(
    /\s+/g,
    ' ',
  );

  const headers: Array<readonly [string, string | number | null | undefined]> = [
    ['Event', event],
    ['Site', `https://lichess.org/${data.game.id}`],
    ['Date', date],
    ['Round', '-'],
    ['White', playerName(white)],
    ['Black', playerName(black)],
    ['Result', resultOf(data, state)],
    ['GameId', data.game.id],
    ['UTCDate', date],
    ['UTCTime', time],
    ['WhiteElo', white.rating ?? '?'],
    ['BlackElo', black.rating ?? '?'],
    ['WhiteRatingDiff', diff(white.ratingDiff)],
    ['BlackRatingDiff', diff(black.ratingDiff)],
    ['Variant', data.game.variant?.name ?? 'Standard'],
    ['TimeControl', timeControl],
    ['SetUp', fromPosition ? '1' : null],
    ['FEN', fromPosition ? startFen : null],
    ['Termination', terminationOf(data.game.status?.name)],
  ];
  const moves: BuiltMove[] = parts.slice(1).map((p) => ({
    san: p.san ?? '',
    clockSeconds: typeof p.clock === 'number' ? p.clock / 100 : null,
  }));
  if (moves.some((m) => m.san === '')) return null;
  const fenParts = startFen.split(/\s+/);
  return buildPgn(headers, moves, resultOf(data, state), {
    startsWithBlack: fenParts[1] === 'b',
    firstMoveNumber: Number(fenParts[5]) || 1,
  });
}

/**
 * From the game page: the current document when it has the finished game, otherwise the
 * page fetched again (a game that ended while the page was open still has the old data).
 */
export const lichessPageDataExtractor: Extractor = {
  method: LICHESS_PAGE_DATA_METHOD,
  async extract(ctx: ExtractContext): Promise<ExtractResult> {
    const fail = (reason: string, extra: Partial<Extract<ExtractResult, { ok: false }>> = {}): ExtractResult => ({
      ok: false,
      method: LICHESS_PAGE_DATA_METHOD,
      reason,
      ...extra,
    });
    let data = ctx.document ? readLichessPageData(ctx.document) : null;
    if (!data || data.game.id !== ctx.ref.gameId || lichessGameState(data) !== 'finished') {
      const res = await ctx.fetch(`https://lichess.org/${ctx.ref.gameId}`, {
        credentials: 'include',
        headers: { Accept: 'text/html' },
      });
      if (res.status === 404) return fail('Lichess has no game with this ID.', { notFound: true });
      if (res.status === 429) return fail('Rate limited by Lichess.', { retryAfterMs: 60_000 });
      if (!res.ok) return fail(`The game page answered ${res.status}.`);
      data = readLichessPageData(await res.text());
    }
    if (!data || data.game.id !== ctx.ref.gameId) return fail('The game page has no game data.');
    const state = lichessGameState(data);
    if (state === 'in-progress') return fail('The game is still in progress.', { inProgress: true });
    if (state === 'aborted') return fail('The game was aborted.');
    const pgn = lichessDataToPgn(data);
    if (!pgn) return fail('The game data has no moves.');
    return { ok: true, pgn, method: LICHESS_PAGE_DATA_METHOD };
  },
};
