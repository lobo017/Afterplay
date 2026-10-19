import { gameKey, type SiteGameRef } from '../../../src/capture/game-id';
import { readPgnHeaders } from '../../../src/capture/pgn-time';
import { isMyGame, isRecentGame, RECENT_GAME_MS } from '../capture-rules';
import { sendToBackground } from '../chrome-store';
import { describeAttempts, runExtractors, type ExtractResult, type Extractor } from '../extractors/types';
import type { CaptureReply, PageStatus } from '../messages';
import type { CaptureTrigger, QueueEntry } from '../queue';
import type { ExtensionSettings } from '../settings';
import { SaveButton, type SaveButtonState } from './save-button';

/** The game on the current page, as a site adapter sees it. */
export interface PageGame {
  ref: SiteGameRef;
  state: 'in-progress' | 'finished' | 'aborted';
  /** Usernames as the site writes them. */
  white: string;
  black: string;
  /** The site itself says the viewer is a player (Lichess's non-spectator view); null: it doesn't say. */
  viewerIsPlayer: boolean | null;
  /** When the game started / ended (ms), when the site's data tells. */
  startedAt: number | null;
  endedAt: number | null;
  /** Where this came from, for the Debug view: "page data", "game data (callback)". */
  source: string;
}

/**
 * `notFound`: the site has no such game. `unavailable`: no data for it yet (Chess.com, while a
 * live game runs): watched like a game in progress until the data appears.
 */
export type DetectResult = { game: PageGame } | { notFound: string } | { unavailable: string };

/** "The game may have ended", from one of the things an adapter watches. */
export interface EndSignal {
  /** What noticed it, for the Debug view. */
  source: string;
  /** The site's own game data says so (check now); otherwise the page showed it (give the site a moment). */
  fromData: boolean;
  /** The ended game, when the signal carries it (no need to fetch it again). */
  game?: PageGame;
}

export interface EndWatch {
  stop(): void;
  /** What is being watched, for the Debug view. */
  describe(): string[];
}

/** One site's part of the content script: finding the game, watching for its end, extracting it. */
export interface SiteAdapter {
  readonly site: SiteGameRef['site'];
  /** The game (`fresh`: reload the site's data, e.g. after the game ended). */
  detect(ref: SiteGameRef, fresh: boolean): Promise<DetectResult>;
  /** Calls `onEnd` when the game may have ended. */
  watchForEnd(ref: SiteGameRef, game: PageGame, onEnd: (signal: EndSignal) => void, log: (text: string) => void): EndWatch;
  readonly extractors: readonly Extractor[];
}

/** How the runner tells the page runner what it found. */
export interface PageHooks {
  log(text: string): void;
  update(patch: Partial<PageStatus>): void;
  /** False once a newer content script took over the page (or the extension was reloaded). */
  isActive(): boolean;
}

export interface CapturePageHandle {
  stop(): void;
  watching(): string[];
}

/** A page showed the end: the site gets this long to finish writing the game. */
const END_SETTLE_MS = 1500;
/** When the page shows the end but the site's data doesn't yet: checks, this far apart. */
const END_CHECKS = 3;
const END_CHECK_GAP_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const STOPPED: CapturePageHandle = { stop: () => undefined, watching: () => [] };

const STATE_LABEL: Record<PageGame['state'], string> = { 'in-progress': 'in progress', finished: 'finished', aborted: 'aborted' };
const TRIGGER_LABEL: Partial<Record<CaptureTrigger, string>> = {
  'game-end': 'the game ended on this page',
  'page-open': 'a recent game of mine was opened',
  'save-button': 'the Save button',
};

function stateForEntry(entry: QueueEntry | null): 'already-queued' | 'already-delivered' | null {
  if (entry?.status === 'delivered') return 'already-delivered';
  if (entry?.status === 'ready') return 'already-queued';
  return null;
}

function mineReason(game: PageGame, settings: ExtensionSettings, site: SiteGameRef['site'], mine: boolean | null): string {
  const named = site === 'lichess' ? settings.lichessUsername : settings.chesscomUsername;
  const siteName = site === 'lichess' ? 'Lichess' : 'Chess.com';
  if (named.trim() !== '') {
    return mine
      ? `yes: ${named} plays ${game.white.toLowerCase() === named.trim().toLowerCase() ? 'White' : 'Black'}`
      : `no: ${named} is neither ${game.white} nor ${game.black}`;
  }
  if (mine) return `yes: the page shows the player's view (no ${siteName} username set)`;
  return `unknown: no ${siteName} username set in Settings`;
}

/**
 * Runs capture for one game on the page: the Save button, and automatic capture of a game of
 * mine when it ends while the page is open, or when it is opened already finished within
 * the last few hours.
 */
export async function runCapturePage(adapter: SiteAdapter, pageRef: SiteGameRef, hooks: PageHooks): Promise<CapturePageHandle> {
  /** The game: as the URL names it, until the site's data says otherwise (Chess.com daily vs live). */
  let ref = pageRef;
  const { log, update } = hooks;
  const url = location.href;
  let stopped = false;
  let watch: EndWatch | null = null;
  let busy = false;
  let checking = false;
  let button: SaveButton | null = null;

  update({ state: 'checking', stateSource: null });
  let detected: DetectResult;
  try {
    detected = await adapter.detect(ref, false);
  } catch (err) {
    log(`Couldn't read the game's data: ${errorText(err)}`);
    update({ state: null, stateSource: null });
    return STOPPED;
  }
  if ('notFound' in detected) {
    log(detected.notFound);
    update({ state: 'not-found' });
    return STOPPED;
  }
  const unavailable = 'unavailable' in detected;
  // Without data yet, the game is watched as one in progress (players unknown until it appears)
  let game: PageGame =
    'game' in detected
      ? detected.game
      : { ref, state: 'in-progress', white: '', black: '', viewerIsPlayer: null, startedAt: null, endedAt: null, source: '' };
  if ('unavailable' in detected) {
    log(detected.unavailable);
    update({ state: 'not-available', stateSource: null, sawInProgress: true });
  } else {
    if (gameKey(game.ref) !== gameKey(ref)) {
      log(`The site's data says this is ${game.ref.gameId}.`);
      ref = game.ref;
      update({ ref });
    }
    update({
      state: game.state,
      stateSource: game.source,
      white: game.white,
      black: game.black,
      startedAt: game.startedAt,
      endedAt: game.endedAt,
      sawInProgress: game.state === 'in-progress',
    });
    log(`Game ${ref.gameId}: ${STATE_LABEL[game.state]} (${game.source}).`);
  }
  if (game.state === 'aborted' || !hooks.isActive()) return STOPPED;

  let settings: ExtensionSettings;
  let known: ReturnType<typeof stateForEntry>;
  try {
    settings = await sendToBackground<ExtensionSettings>({ kind: 'get-settings' });
    known = stateForEntry(await sendToBackground<QueueEntry | null>({ kind: 'lookup', key: gameKey(ref) }));
  } catch (err) {
    log(`The extension doesn't answer (${errorText(err)}); reload the tab.`);
    return STOPPED;
  }
  const decideMine = (g: PageGame): boolean | null => {
    const mine = isMyGame(g, settings, adapter.site, g.viewerIsPlayer);
    update({ mine, mineReason: mineReason(g, settings, adapter.site, mine) });
    return mine;
  };
  let mine: boolean | null = null;
  if (unavailable) {
    update({ mine: null, mineReason: "unknown until the site has the game's data (players)" });
  } else {
    mine = decideMine(game);
  }
  update({ captured: known !== null });
  if (stopped || !hooks.isActive()) return STOPPED;

  const setButton = (state: SaveButtonState, note = '') => {
    button?.set(state, note);
    update({ button: state });
  };

  const capture = async (trigger: CaptureTrigger): Promise<void> => {
    if (busy) return;
    busy = true;
    const auto = trigger !== 'save-button';
    setButton('saving');
    try {
      const outcome = await runExtractors(adapter.extractors, { ref, fetch: (i, init) => fetch(i, init), document });
      let result: ExtractResult = outcome.result;
      // The Lichess export answers for running games too, with the result "*"
      if (result.ok && (readPgnHeaders(result.pgn).Result ?? '*') === '*') {
        result = { ok: false, method: result.method, reason: 'The game is still in progress.', inProgress: true };
      }
      if (!result.ok) {
        if (result.inProgress) {
          setButton('in-progress', 'Save it when the game has ended.');
          log(`Capture: the game is still in progress (${result.method}).`);
          return;
        }
        const error = describeAttempts(outcome.attempts) || result.reason;
        log(`Capture failed: ${error}`);
        // Report first, so the notification is up when the button says so
        await sendToBackground({ kind: 'capture-failed', url, error, auto });
        setButton('failed', 'Open the extension to paste the link or PGN.');
        return;
      }
      const reply = await sendToBackground<CaptureReply>({
        kind: 'capture',
        site: ref.site,
        gameId: ref.gameId,
        pgn: result.pgn,
        method: result.method,
        url,
        auto,
        trigger,
      });
      if (!reply.ok) {
        log(`Capture refused: ${reply.error}`);
        setButton('failed', reply.error);
        return;
      }
      update({ captured: true });
      log(`Captured with ${result.method} (${TRIGGER_LABEL[trigger] ?? trigger}): ${reply.outcome}.`);
      if (reply.outcome === 'not-importable' || reply.outcome === 'already-rejected') {
        setButton('not-imported', `The analysis site doesn't take this game (${reply.reason ?? 'variant or no moves'}).`);
        log(`Not imported: ${reply.reason ?? reply.outcome}.`);
        return;
      }
      if (reply.outcome === 'already-delivered') setButton('already-delivered');
      else if (reply.outcome === 'already-queued') setButton('already-queued');
      else setButton('saved', auto ? 'Captured automatically. It goes to the analysis site as soon as that is open.' : '');
    } catch (err) {
      log(`Capture error: ${errorText(err)}`);
      setButton('failed', 'Open the extension to paste the link or PGN.');
    } finally {
      busy = false;
    }
  };

  button = new SaveButton(() => void capture('save-button'));

  if (game.state === 'finished') {
    if (known) {
      setButton(known);
      log(known === 'already-delivered' ? 'Already on the analysis site.' : 'Already captured; waiting for the analysis site.');
    } else if (!settings.autoCapture) {
      setButton('ready');
      log('Finished game; automatic capture is off in Settings.');
    } else if (!mine) {
      setButton('ready');
      log(`Finished game, not captured automatically: ${mine === false ? 'not my game' : "can't tell whether it's my game"}.`);
    } else if (!isRecentGame(game, Date.now())) {
      setButton('ready');
      log(`Finished game of mine, older than ${RECENT_GAME_MS / 3600_000} h: not captured automatically.`);
    } else {
      log('Finished game of mine from the last few hours: capturing automatically.');
      await capture('page-open');
    }
  } else {
    setButton(
      known ?? 'in-progress',
      known ? '' : unavailable ? 'Captured when the game has ended (Chess.com shares it then).' : 'Save it when the game has ended.',
    );
    const onEndSignal = async (signal: EndSignal) => {
      if (checking || stopped || !watch) return;
      checking = true;
      try {
        log(`End signal: ${signal.source}.`);
        let ended: PageGame | null = signal.game && signal.game.state !== 'in-progress' ? signal.game : null;
        if (!ended) {
          if (!signal.fromData) await sleep(END_SETTLE_MS);
          const checks = signal.fromData ? 2 : END_CHECKS;
          for (let i = 0; i < checks && !stopped; i++) {
            if (i > 0) await sleep(END_CHECK_GAP_MS);
            const r = await adapter.detect(ref, true).catch(() => null);
            if (r && 'game' in r) {
              ended = r.game;
              if (ended.state !== 'in-progress') break;
            }
          }
        }
        if (stopped) return;
        if (!ended || ended.state === 'in-progress') {
          log("The site's data still says in progress; watching on.");
          return;
        }
        watch?.stop();
        watch = null;
        game = { ...ended, viewerIsPlayer: ended.viewerIsPlayer ?? game.viewerIsPlayer };
        if (gameKey(game.ref) !== gameKey(ref)) {
          ref = game.ref;
          update({ ref });
        }
        update({
          state: game.state,
          stateSource: game.source,
          white: game.white,
          black: game.black,
          endedAt: game.endedAt ?? Date.now(),
        });
        log(`Game ${ref.gameId}: ${STATE_LABEL[game.state]} (${game.source}).`);
        if (game.state === 'aborted') {
          button?.remove();
          button = null;
          update({ button: '' });
          return;
        }
        if (known) return;
        settings = await sendToBackground<ExtensionSettings>({ kind: 'get-settings' });
        mine = decideMine(game);
        if (settings.autoCapture && mine) {
          log('Game over: capturing automatically.');
          await capture('game-end');
        } else {
          setButton('ready');
          log(
            `Game over, not captured automatically: ${!settings.autoCapture ? 'automatic capture is off' : mine === false ? 'not my game' : "can't tell whether it's my game"}.`,
          );
        }
      } catch (err) {
        log(`Checking the end failed: ${errorText(err)}`);
      } finally {
        checking = false;
      }
    };
    watch = adapter.watchForEnd(ref, game, (signal) => void onEndSignal(signal), log);
  }

  return {
    stop() {
      stopped = true;
      watch?.stop();
      watch = null;
      button?.remove();
      button = null;
    },
    watching: () => watch?.describe() ?? [],
  };
}

/** Calls `onMatch` (at most once) when an element matching `selector` is in the page. */
export function watchForSelector(selector: string, onMatch: () => void): () => void {
  let done = false;
  let scheduled = false;
  const check = () => {
    scheduled = false;
    if (done || !document.querySelector(selector)) return;
    done = true;
    observer.disconnect();
    onMatch();
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
