import { parseGameUrl } from '../../../src/capture/game-id';
import { chessComCallbackExtractor, chessComUsernames, fetchChessComCallback } from '../extractors/chesscom-callback';
import { chessComShareExtractor } from '../extractors/chesscom-share';
import { runCapturePage, watchForSelector, type SiteAdapter } from './capture-page';

// Content script on www.chess.com. On a game page: the Save button, and auto-capture of my
// game when it ends. Extraction: the game data the page itself loads (callback JSON with
// TCN moves) first, the site's Share → PGN dialog when that fails.

/**
 * Elements Chess.com shows when a game ends (the game-over dialog / header). Unofficial:
 * Chess.com can rename them, so a slow periodic check backs this up while a game runs.
 */
const GAME_OVER_SELECTOR = [
  '.game-over-modal-content',
  '.game-over-modal-container',
  '.game-over-header-component',
  '[data-cy="game-over-modal"]',
].join(', ');
/** The periodic check while a game is in progress and its tab is visible. */
const IN_PROGRESS_CHECK_MS = 30_000;
/** Chess.com changes games without reloading the page: the URL is checked this often. */
const URL_CHECK_MS = 1000;

const adapter: SiteAdapter = {
  site: 'chesscom',
  extractors: [chessComCallbackExtractor, chessComShareExtractor],
  async detect() {
    const ref = parseGameUrl(location.href);
    if (!ref || ref.site !== 'chesscom') return null;
    // The page's HTML has no game data; the game data request is the same one the page makes
    const got = await fetchChessComCallback(ref, (i, init) => fetch(i, init));
    if (!got.ok) return null;
    const names = chessComUsernames(got.data);
    return {
      ref,
      state: got.data.game.isFinished ? 'finished' : 'in-progress',
      white: names.white,
      black: names.black,
      viewerIsPlayer: false,
    };
  },
  watchForEnd(onEnd) {
    const stopDom = watchForSelector(GAME_OVER_SELECTOR, onEnd);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') onEnd(false);
    }, IN_PROGRESS_CHECK_MS);
    return () => {
      stopDom();
      clearInterval(timer);
    };
  },
};

let current = '';
let generation = 0;
let stop: (() => void) | null = null;

async function onUrl(): Promise<void> {
  const href = location.href.split('#')[0]!;
  if (href === current) return;
  current = href;
  const mine = ++generation;
  stop?.();
  stop = null;
  // The full URL: the old live player kept the game ID in the hash (#g=…)
  const ref = parseGameUrl(location.href);
  if (!ref || ref.site !== 'chesscom') return;
  const stopPage = await runCapturePage(adapter);
  // The URL changed again while this page was being set up
  if (mine !== generation) stopPage();
  else stop = stopPage;
}

void onUrl();
setInterval(() => void onUrl(), URL_CHECK_MS);
