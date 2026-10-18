/**
 * Game identity shared by the website and the capture extension: which site a game is
 * from and its ID there. A stored game's key is `site:gameId`, so the same game captured
 * twice (or captured and also pasted) is stored once.
 */

export type CaptureSite = 'lichess' | 'chesscom';
/** Where a stored game came from: a site, or a PGN pasted / dropped without a site ID. */
export type GameSource = CaptureSite | 'paste';

export interface SiteGameRef {
  site: CaptureSite;
  /** Lichess: the 8-character game ID. Chess.com: `live-<n>` or `daily-<n>`. */
  gameId: string;
}

export type ChessComGameType = 'live' | 'daily';

/** Lowercase 8-letter Lichess routes that would otherwise look like game IDs. */
const LICHESS_ROUTES = new Set([
  'analysis',
  'training',
  'streamer',
  'practice',
  'timeline',
  'variants',
  'insights',
  'settings',
  'contacts',
  'password',
  'feedback',
  'download',
  'features',
  'resource',
]);

const LICHESS_ID = /^[A-Za-z0-9]{8}$/;
const CHESSCOM_ID = /^(live|daily)-\d{1,15}$/;

export function isLichessGameId(id: string): boolean {
  return LICHESS_ID.test(id) && !LICHESS_ROUTES.has(id);
}

export function isValidRef(ref: SiteGameRef): boolean {
  return ref.site === 'lichess' ? isLichessGameId(ref.gameId) : CHESSCOM_ID.test(ref.gameId);
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
}

/**
 * The game a Lichess or Chess.com URL points at, or null. Lichess: `/{id}`, `/{id}{player}`,
 * `/{id}/white|black`, `/game/export/{id}`, `/embed/game/{id}`. Chess.com: `/game/live/{n}`,
 * `/game/daily/{n}`, `/live/game/{n}`, `/daily/game/{n}`, `/game/{n}`,
 * `/analysis/game/{live|daily}/{n}`, and the old `/live#g={n}`.
 */
export function parseGameUrl(raw: string): SiteGameRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = hostOf(url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'lichess.org') {
    let candidate: string | undefined;
    if (parts[0] === 'game' && parts[1] === 'export') candidate = parts[2];
    else if (parts[0] === 'embed' && parts[1] === 'game') candidate = parts[2];
    else if (parts.length >= 1 && parts.length <= 2) {
      const [first, second] = parts;
      if (parts.length === 2 && second !== 'white' && second !== 'black') return null;
      candidate = first;
    }
    if (!candidate) return null;
    // A 12-character ID is the game ID plus a player suffix
    const id = candidate.length === 12 && /^[A-Za-z0-9]{12}$/.test(candidate) ? candidate.slice(0, 8) : candidate;
    return isLichessGameId(id) ? { site: 'lichess', gameId: id } : null;
  }

  if (host === 'chess.com') {
    const numeric = (s: string | undefined) => (s && /^\d{1,15}$/.test(s) ? s : null);
    let type: ChessComGameType | null = null;
    let id: string | null = null;
    const p = parts[0] === 'analysis' ? parts.slice(1) : parts;
    if (p[0] === 'game' && (p[1] === 'live' || p[1] === 'daily')) {
      type = p[1];
      id = numeric(p[2]);
    } else if ((p[0] === 'live' || p[0] === 'daily') && p[1] === 'game') {
      type = p[0];
      id = numeric(p[2]);
    } else if (p[0] === 'game' && p.length === 2) {
      type = 'live';
      id = numeric(p[1]);
    } else if (p[0] === 'live' && p.length === 1) {
      const m = url.hash.match(/^#g=(\d{1,15})$/);
      type = 'live';
      id = m?.[1] ?? null;
    }
    return type && id ? { site: 'chesscom', gameId: `${type}-${id}` } : null;
  }
  return null;
}

/** The canonical URL of a game. */
export function gameUrl(ref: SiteGameRef): string {
  if (ref.site === 'lichess') return `https://lichess.org/${ref.gameId}`;
  const [type, id] = ref.gameId.split('-');
  return `https://www.chess.com/game/${type}/${id}`;
}

export function chessComParts(ref: SiteGameRef): { type: ChessComGameType; id: string } {
  const [type, id] = ref.gameId.split('-') as [ChessComGameType, string];
  return { type, id };
}

export function gameKey(ref: SiteGameRef): string {
  return `${ref.site}:${ref.gameId}`;
}

const KEY_PATTERN = /^(lichess|chesscom|paste):([A-Za-z0-9-]{1,40})$/;

export function isGameKey(key: string): boolean {
  const m = KEY_PATTERN.exec(key);
  if (!m) return false;
  if (m[1] === 'paste') return /^[0-9a-f]{16}$/.test(m[2]!);
  return isValidRef({ site: m[1] as CaptureSite, gameId: m[2]! });
}

/** The site game a PGN names: Lichess `Site` / `GameId`, Chess.com `Link`. */
export function refFromPgnHeaders(headers: Readonly<Record<string, string>>): SiteGameRef | null {
  for (const field of ['Site', 'Link', 'GameUrl']) {
    const value = headers[field];
    if (value && /^https?:\/\//i.test(value)) {
      const ref = parseGameUrl(value);
      if (ref) return ref;
    }
  }
  const site = (headers.Site ?? '').toLowerCase();
  const id = headers.GameId ?? '';
  if (site.includes('lichess') && isLichessGameId(id)) return { site: 'lichess', gameId: id };
  return null;
}

/** 64-bit FNV-1a as 16 hex digits (two 32-bit lanes with different offsets). */
export function contentHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000197) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * The key for a game with no site ID: a hash of the players, date and moves, so pasting the
 * same game again finds the stored copy.
 */
export function pasteKey(headers: Readonly<Record<string, string>>, sanMoves: readonly string[]): string {
  const id = [headers.White ?? '', headers.Black ?? '', headers.Date ?? '', headers.FEN ?? '', sanMoves.join(' ')].join('|');
  return `paste:${contentHash(id)}`;
}
