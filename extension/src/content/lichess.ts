import { parseGameUrl } from '../../../src/capture/game-id';
import { lichessPageDataExtractor, lichessGameState, lichessUsernames, readLichessPageData } from '../extractors/lichess-page-data';
import { lichessSessionExportExtractor } from '../extractors/lichess-session-export';
import { runCapturePage, watchForSelector, type SiteAdapter } from './capture-page';

// Content script on lichess.org. On a game page: the Save button, and auto-capture of my
// game when it ends. Extraction: the official export with the browser's Lichess session
// first, the game page's own data when that wants a login.

/**
 * The round page shows the result block when a game ends (Lichess's `.result-wrap` in
 * the move list). Unofficial: Lichess can rename it.
 */
const GAME_OVER_SELECTOR = '.result-wrap';

const adapter: SiteAdapter = {
  site: 'lichess',
  extractors: [lichessSessionExportExtractor, lichessPageDataExtractor],
  async detect(fresh) {
    const ref = parseGameUrl(location.href);
    if (!ref || ref.site !== 'lichess') return null;
    let data = readLichessPageData(document);
    if (fresh) {
      const res = await fetch(`https://lichess.org/${ref.gameId}`, { credentials: 'include', headers: { Accept: 'text/html' } });
      data = res.ok ? readLichessPageData(await res.text()) : null;
    }
    if (!data || data.game.id !== ref.gameId) return null;
    const names = lichessUsernames(data);
    return {
      ref,
      state: lichessGameState(data),
      white: names.white,
      black: names.black,
      viewerIsPlayer: data.player.spectator === false || (data.player.spectator === undefined && Boolean(data.player.user)),
    };
  },
  watchForEnd(onEnd) {
    return watchForSelector(GAME_OVER_SELECTOR, onEnd);
  },
};

void runCapturePage(adapter);
