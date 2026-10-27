import { chessComParts, type SiteGameRef } from '../../../src/capture/game-id';
import { chessComCallbackExtractor, fetchChessComGame, type ChessComCallback } from '../extractors/chesscom-callback';
import { chessComShareExtractor } from '../extractors/chesscom-share';
import { chessComRefFromRequest } from '../pages';
import { watchForSelector, type PageGame } from './capture-page';
import { startPageRunner, type PageRunnerAdapter } from './page-runner';
import { startPoller } from './poller';

// Content script on www.chess.com. On a game page: the Save button, and auto-capture of my
// game when it ends. The end comes from the game's own data (the callback JSON), checked
// while the game runs: Chess.com answers 404 for a live game until it has ended, then the
// data. The page's own requests about the game and the game-over dialog are faster hints.
// On /play pages, where the URL has no game ID, the game is found from the page's requests.
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

const NOT_AVAILABLE =
  "Chess.com has no data for this game yet: it shares a live game's data once the game has ended. Checking again every 10 s.";

/** The page's URL names the game without its type (`/game/{n}`, as during a live game). */
function untypedUrl(ref: SiteGameRef): boolean {
  const m = /^\/game\/(\d+)(?:[/?#]|$)/.exec(location.pathname);
  return m !== null && m[1] === chessComParts(ref).id;
}

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
    const got = await fetchChessComGame(ref, (i, init) => fetch(i, init), untypedUrl(ref));
    if (!got.ok) {
      // A live game has no data until it ends: not available yet, not "no such game"
      if (got.status === 404) return { unavailable: NOT_AVAILABLE };
      throw new Error(got.reason);
    }
    return { game: gameFromCallback(got.ref, got.data, 'game data (callback)') };
  },
  watchForEnd(ref, _game, onEnd, log) {
    const untyped = untypedUrl(ref);
    const { id } = chessComParts(ref);
    const stopDom = watchForSelector(GAME_OVER_SELECTOR, () =>
      onEnd({ source: 'the game-over dialog appeared', fromData: false }),
    );
    let rateLimited = false;
    let lastAnswer = '';
    const poller = startPoller({
      intervalMs: () => (document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS),
      check: async () => {
        const got = await fetchChessComGame(ref, (i, init) => fetch(i, init), untyped);
        const answer = got.ok
          ? got.data.game.isFinished
            ? 'finished'
            : 'in progress'
          : got.status === 404
            ? 'not available yet (404)'
            : `answered ${got.status}`;
        if (answer !== lastAnswer) log(`Game data check: ${answer}.`);
        lastAnswer = answer;
        if (!got.ok) {
          if (got.status === 429 && !rateLimited)
            log('Game data check: rate limited by Chess.com; trying again later.');
          rateLimited = got.status === 429;
          return 'continue';
        }
        if (got.data.game.isFinished) {
          onEnd({
            source: 'game data (callback): finished',
            fromData: true,
            game: gameFromCallback(got.ref, got.data, 'game data (callback)'),
          });
        }
        // Stopped by the runner once it has confirmed the end
        return 'continue';
      },
    });
    // Hidden tabs get few timer runs: check when the tab is hidden or shown again
    const onVisibility = () => poller.poke();
    document.addEventListener('visibilitychange', onVisibility);

    // The page's own requests that mention the game (other than the game-data checks above):
    // listed in the Debug log, and each one is a reason to check the game data now (the page
    // loads things about a game when it ends: its review, its PGN, its result)
    const ownPaths = new Set([`/callback/live/game/${id}`, `/callback/daily/game/${id}`]);
    const seenPaths = new Set<string>();
    let pageRequests = 0;
    let lastPoke = 0;
    const consider = (entries: readonly PerformanceEntry[], poke: boolean) => {
      for (const e of entries) {
        if (!e.name.includes(id)) continue;
        let url: URL;
        try {
          url = new URL(e.name);
        } catch {
          continue;
        }
        if (url.hostname === location.hostname && ownPaths.has(url.pathname)) continue;
        pageRequests++;
        const label = `${url.hostname === location.hostname ? '' : url.hostname}${url.pathname}`;
        if (!seenPaths.has(label) && seenPaths.size < 20) {
          seenPaths.add(label);
          log(`Page request about this game: ${label}`);
        }
        if (poke && Date.now() - lastPoke > 3000) {
          lastPoke = Date.now();
          poller.poke();
        }
      }
    };
    consider(performance.getEntriesByType('resource'), false);
    const observer = new PerformanceObserver((list) => consider(list.getEntries(), true));
    observer.observe({ type: 'resource' });

    return {
      stop() {
        stopDom();
        poller.stop();
        observer.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
      },
      describe: () => [
        `game data (callback) every ${POLL_VISIBLE_MS / 1000} s, ${POLL_HIDDEN_MS / 1000} s while hidden (${poller.runs()} check${poller.runs() === 1 ? '' : 's'} so far${lastAnswer ? `, last: ${lastAnswer}` : ''})`,
        `the page's requests about the game (${pageRequests} so far)`,
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
        if (ref && (!found || e.startTime >= found.at))
          found = { ref, at: e.startTime, path: new URL(e.name).pathname };
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
