import { parseGameUrl, type CaptureSite, type SiteGameRef } from '../../src/capture/game-id';

/**
 * What a Lichess or Chess.com page is, for capture:
 * - game: the URL names a game (lichess.org/{id}, chess.com/game/live/{n}, …);
 * - play: a Chess.com page where games are played without the game in the URL
 *   (chess.com/play/online, /play/computer, …);
 * - other: anything else on the site (home, profile, puzzles).
 */
export type PageKind = 'game' | 'play' | 'other';

export interface SitePage {
  site: CaptureSite;
  kind: PageKind;
  /** The game in the URL (kind 'game'). */
  ref: SiteGameRef | null;
}

export function siteOfUrl(raw: string | undefined): CaptureSite | null {
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (host === 'lichess.org') return 'lichess';
    if (host === 'www.chess.com' || host === 'chess.com') return 'chesscom';
  } catch {
    return null;
  }
  return null;
}

/** The page a URL shows, or null when it isn't on Lichess or Chess.com. */
export function classifyPage(raw: string | undefined): SitePage | null {
  const site = siteOfUrl(raw);
  if (!site || !raw) return null;
  const ref = parseGameUrl(raw);
  if (ref && ref.site === site) return { site, kind: 'game', ref };
  if (site === 'chesscom' && /^\/play(\/|$)/.test(new URL(raw).pathname)) return { site, kind: 'play', ref: null };
  return { site, kind: 'other', ref: null };
}

const CHESSCOM_GAME_REQUEST = /\/(?:callback\/)?(?:(live|daily)\/game|game\/(live|daily))\/(\d{1,15})(?=[/?#]|$)/;

/**
 * The game a request of a Chess.com page is about: its game data (`/callback/live/game/{n}`)
 * or a game page or link (`/game/live/{n}`, `/live/game/{n}`). On /play pages, where the URL
 * has no game ID, the page's own requests are how the content script learns the game.
 */
export function chessComRefFromRequest(raw: string): SiteGameRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname !== 'www.chess.com' && url.hostname !== 'chess.com') return null;
  const m = CHESSCOM_GAME_REQUEST.exec(url.pathname);
  if (!m) return null;
  return { site: 'chesscom', gameId: `${m[1] ?? m[2]}-${m[3]}` };
}

/** The part of a URL that tells pages apart (no hash, except Chess.com's old #g= game links). */
export function pageKey(raw: string): string {
  const [base, hash] = raw.split('#');
  return hash && /^g=\d+$/.test(hash) ? `${base}#${hash}` : base!;
}

/** Match patterns of the game sites' pages (tabs.query, content-script injection). */
export const SITE_TAB_PATTERNS: Record<CaptureSite, string[]> = {
  lichess: ['https://lichess.org/*'],
  chesscom: ['https://www.chess.com/*', 'https://chess.com/*'],
};

/** The content script for each site, as built into dist-ext/. */
export const SITE_CONTENT_SCRIPT: Record<CaptureSite, string> = {
  lichess: 'lichess.js',
  chesscom: 'chesscom.js',
};
