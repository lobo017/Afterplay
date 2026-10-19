import type { SiteGameRef } from '../../../src/capture/game-id';
import { chessComCallbackExtractor, fetchChessComCallback, type ChessComCallback } from '../extractors/chesscom-callback';
import { chessComShareExtractor } from '../extractors/chesscom-share';
import { chessComRefFromRequest } from '../pages';
import { watchForSelector, type PageGame } from './capture-page';
import { startPageRunner, type PageRunnerAdapter } from './page-runner';
import { startPoller } from './poller';

// Content script on www.chess.com. On a game page: the Save button, and auto-capture of my
// game when it ends. The end comes from the game's own data (the callback JSON the page
// loads, checked while the game runs); the game-over dialog is a faster hint. On /play
// pages, where the URL has no game ID, the game is found from the page's own requests.
// Extraction: the game data (TCN moves) first, the site's Share → PGN dialog when that fails.

/**
 * Elements Chess.com shows when a game ends (the game-over dialog / header). Unofficial:
 * Chess.com can rename them; the game-data check doesn't depend on them.
 */
const GAME_OVER_SELECTOR = [
  '.game-over-modal-content',
  '.game-over-modal-container',
  '.game-over-header-component',
  '[data-cy="game-over-modal"]',
].join(', ');
/** The game data is checked this often while a game is in progress (visible tab / hidden tab). */
const POLL_VISIBLE_MS = 10_000;
const POLL_HIDDEN_MS = 30_000;

function header(h: Record<string, string | number> | undefined, key: string): string {
  return String(h?.[key] ?? '').replace(/\\'/g, "'");
}

function gameFromCallback(ref: SiteGameRef, data: ChessComCallback, source: string): PageGame {
  const h = data.game.pgnHeaders;
  return {
    ref,
    state: data.game.isFinished ? 'finished' : 'in-progress',
    white: header(h, 'White'),
    black: header(h, 'Black'),
    viewerIsPlayer: null,
    startedAt: null,
    endedAt: data.game.isFinished && data.game.endTime ? data.game.endTime * 1000 : null,
    source,
  };
}

const adapter: PageRunnerAdapter = {
  site: 'chesscom',
  extractors: [chessComCallbackExtractor, chessComShareExtractor],
  async detect(ref) {
    // The page's HTML has no game data; the game data request is the same one the page makes
    const got = await fetchChessComCallback(ref, (i, init) => fetch(i, init));
    if (!got.ok) {
      if (got.status === 404) return { notFound: `Chess.com has no game ${ref.gameId}.` };
      throw new Error(got.reason);
    }
    return { game: gameFromCallback(ref, got.data, 'game data (callback)') };
  },
  watchForEnd(ref, _game, onEnd, log) {
    const stopDom = watchForSelector(GAME_OVER_SELECTOR, () => onEnd({ source: 'the game-over dialog appeared', fromData: false }));
    let rateLimited = false;
    const poller = startPoller({
      intervalMs: () => (document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS),
      check: async () => {
        const got = await fetchChessComCallback(ref, (i, init) => fetch(i, init));
        if (!got.ok) {
          if (got.status === 429 && !rateLimited) log('Game data check: rate limited by Chess.com; trying again later.');
          rateLimited = got.status === 429;
          return 'continue';
        }
        if (got.data.game.isFinished) {
          onEnd({ source: 'game data (callback): finished', fromData: true, game: gameFromCallback(ref, got.data, 'game data (callback)') });
        }
        // Stopped by the runner once it has confirmed the end
        return 'continue';
      },
    });
    // Hidden tabs get few timer runs: check when the tab is hidden or shown again
    const onVisibility = () => poller.poke();
    document.addEventListener('visibilitychange', onVisibility);
    return {
      stop() {
        stopDom();
        poller.stop();
        document.removeEventListener('visibilitychange', onVisibility);
      },
      describe: () => [
        `game data (callback) every ${POLL_VISIBLE_MS / 1000} s, ${POLL_HIDDEN_MS / 1000} s while hidden (${poller.runs()} checks so far)`,
        'the game-over dialog',
      ],
    };
  },
  watchForGameId(onFound) {
    let best: { key: string; at: number } | null = null;
    const consider = (entries: readonly PerformanceEntry[]) => {
      let found: { ref: SiteGameRef; at: number; path: string } | null = null;
      for (const e of entries) {
        const ref = chessComRefFromRequest(e.name);
        if (ref && (!found || e.startTime >= found.at)) found = { ref, at: e.startTime, path: new URL(e.name).pathname };
      }
      if (!found || (best && found.at < best.at)) return;
      const key = found.ref.gameId;
      if (best?.key === key) return;
      best = { key, at: found.at };
      onFound(found.ref, `the page's requests (${found.path})`);
    };
    consider(performance.getEntriesByType('resource'));
    const observer = new PerformanceObserver((list) => consider(list.getEntries()));
    observer.observe({ type: 'resource' });
    return () => observer.disconnect();
  },
};

startPageRunner(adapter);
