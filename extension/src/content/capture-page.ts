import { gameKey, type SiteGameRef } from '../../../src/capture/game-id';
import { sendToBackground } from '../chrome-store';
import { describeAttempts, runExtractors, type Extractor } from '../extractors/types';
import type { CaptureReply } from '../messages';
import type { QueueEntry } from '../queue';
import type { ExtensionSettings } from '../settings';
import { SaveButton } from './save-button';

/** The game on the current page, as a site adapter sees it. */
export interface PageGame {
  ref: SiteGameRef;
  state: 'in-progress' | 'finished' | 'aborted';
  /** Usernames, lowercased. */
  white: string;
  black: string;
  /** The site itself says the viewer is a player (e.g. Lichess's non-spectator view). */
  viewerIsPlayer: boolean;
}

/** One site's part of the content script: finding the game, watching for its end, extracting it. */
export interface SiteAdapter {
  readonly site: SiteGameRef['site'];
  /** The game on this page (`fresh`: reload the site's data, e.g. after the game ended). */
  detect(fresh: boolean): Promise<PageGame | null>;
  /**
   * Calls back when the game may have ended; returns a stop function. `shown`: the page
   * showed the end (worth a few checks while the site catches up); otherwise a periodic check.
   */
  watchForEnd(onEnd: (shown: boolean) => void): () => void;
  readonly extractors: readonly Extractor[];
}

/** Waiting this long after the end shows on the page lets the site finish writing the game. */
const END_SETTLE_MS = 1500;
/** When the page shows the end but the site's data doesn't yet: checks, this far apart. */
const END_CHECKS = 3;
const END_CHECK_GAP_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isMine(game: PageGame, settings: ExtensionSettings, site: SiteGameRef['site']): boolean {
  const me = (site === 'lichess' ? settings.lichessUsername : settings.chesscomUsername).trim().toLowerCase();
  if (me !== '') return game.white === me || game.black === me;
  return game.viewerIsPlayer;
}

function stateForEntry(entry: QueueEntry | null): 'already-queued' | 'already-delivered' | null {
  if (entry?.status === 'delivered') return 'already-delivered';
  if (entry?.status === 'ready') return 'already-queued';
  return null;
}

/**
 * Runs the capture UI for one game page: the Save button, and auto-capture when a game I
 * played ends while the page is open (if that setting is on). Returns a stop function.
 */
export async function runCapturePage(adapter: SiteAdapter): Promise<() => void> {
  const game = await adapter.detect(false);
  if (!game || game.state === 'aborted') return () => undefined;

  let stopWatching: (() => void) | null = null;
  let stopped = false;
  let busy = false;
  let checking = false;
  const ref = game.ref;
  const url = location.href;

  const capture = async (auto: boolean): Promise<void> => {
    if (busy) return;
    busy = true;
    button.set('saving');
    try {
      const outcome = await runExtractors(adapter.extractors, { ref, fetch: (i, init) => fetch(i, init), document });
      if (!outcome.result.ok) {
        if (outcome.result.inProgress) {
          button.set('in-progress', 'Save it when the game has ended.');
          return;
        }
        const error = describeAttempts(outcome.attempts) || outcome.result.reason;
        button.set('failed', 'Open the extension to paste the link or PGN.');
        await sendToBackground({ kind: 'capture-failed', url, error, auto });
        return;
      }
      const reply = await sendToBackground<CaptureReply>({
        kind: 'capture',
        site: ref.site,
        gameId: ref.gameId,
        pgn: outcome.result.pgn,
        method: outcome.result.method,
        url,
        auto,
      });
      if (!reply.ok) {
        button.set('failed', reply.error);
        return;
      }
      if (reply.outcome === 'already-delivered') button.set('already-delivered');
      else if (reply.outcome === 'already-queued') button.set('already-queued');
      else button.set('saved', auto ? 'Captured automatically; it goes to the analysis site next time it opens.' : '');
    } finally {
      busy = false;
    }
  };

  const button = new SaveButton(() => {
    void capture(false);
  });
  const entry = await sendToBackground<QueueEntry | null>({ kind: 'lookup', key: gameKey(ref) });
  const known = stateForEntry(entry);

  if (game.state === 'finished') {
    button.set(known ?? 'ready');
  } else {
    button.set(known ?? 'in-progress', known ? '' : 'Save it when the game has ended.');
    const onEndSignal = async (shown: boolean) => {
      if (checking || stopped || !stopWatching) return;
      checking = true;
      try {
        if (shown) await sleep(END_SETTLE_MS);
        let ended: PageGame | null = null;
        for (let i = 0; i < (shown ? END_CHECKS : 1) && !stopped; i++) {
          if (i > 0) await sleep(END_CHECK_GAP_MS);
          ended = await adapter.detect(true);
          if (ended?.state === 'finished') break;
        }
        // Not over after all (or not yet in the site's data): keep watching
        if (stopped || !ended || ended.state !== 'finished') return;
        stopWatching?.();
        stopWatching = null;
        if (known) return;
        const settings = await sendToBackground<ExtensionSettings>({ kind: 'get-settings' });
        if (settings.autoCapture && isMine(ended, settings, adapter.site)) await capture(true);
        else button.set('ready');
      } finally {
        checking = false;
      }
    };
    stopWatching = adapter.watchForEnd((shown) => void onEndSignal(shown));
  }

  return () => {
    stopped = true;
    stopWatching?.();
    button.remove();
  };
}

/** Calls `onMatch` (at most once) when an element matching `selector` is in the page. */
export function watchForSelector(selector: string, onMatch: (shown: boolean) => void): () => void {
  let done = false;
  let scheduled = false;
  const check = () => {
    scheduled = false;
    if (done || !document.querySelector(selector)) return;
    done = true;
    observer.disconnect();
    onMatch(true);
  };
  const observer = new MutationObserver(() => {
    if (!scheduled) {
      scheduled = true;
      setTimeout(check, 250);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  check();
  return () => {
    done = true;
    observer.disconnect();
  };
}
