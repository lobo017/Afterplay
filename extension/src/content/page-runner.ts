import { gameKey, type SiteGameRef } from '../../../src/capture/game-id';
import { sendToBackground } from '../chrome-store';
import type { ContentDebugInfo, PageStatus, TabRequest } from '../messages';
import { classifyPage, pageKey, type PageKind } from '../pages';
import { runCapturePage, type CapturePageHandle, type SiteAdapter } from './capture-page';
import { DebugLog } from './debug-log';

export interface PageRunnerAdapter extends SiteAdapter {
  /**
   * On a page where games are played without the game in the URL (Chess.com /play/…):
   * watches the page for the current game's ID. Returns a stop function.
   */
  watchForGameId?(onFound: (ref: SiteGameRef, source: string) => void, log: (text: string) => void): () => void;
}

/** The URL is checked this often: both sites change pages without reloading (history API). */
const URL_CHECK_MS = 1000;
/** Reports to the background are batched this long. */
const REPORT_DELAY_MS = 150;
const INSTANCE_ATTR = 'data-wc-capture';

const KIND_LABEL: Record<PageKind, string> = { game: 'game page', play: 'play page', other: 'not a game page' };

function blankStatus(url: string, kind: PageKind): PageStatus {
  return {
    url,
    kind,
    ref: null,
    refSource: null,
    state: null,
    stateSource: null,
    white: null,
    black: null,
    mine: null,
    mineReason: '',
    sawInProgress: false,
    startedAt: null,
    endedAt: null,
    captured: false,
    button: '',
    watching: [],
  };
}

/** The extension that injected this script is still loaded (not reloaded or removed since). */
function contextValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

/**
 * The content script's main loop on a game site: follows the page's URL (both sites move
 * between pages without reloading), runs capture for the game shown, tells the background
 * what the page shows (so it can act when I leave the page) and answers "Debug this tab".
 *
 * One live instance per page: each instance marks <html> with its token, and an instance
 * that sees another token (a newer one was injected, e.g. after the extension was
 * updated) or whose extension was reloaded stops and removes its button.
 */
export function startPageRunner(adapter: PageRunnerAdapter): void {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const root = document.documentElement;
  root.setAttribute(INSTANCE_ATTR, token);
  const startedAt = Date.now();
  const debug = new DebugLog();
  const log = (text: string) => debug.add(text);
  let status: PageStatus = blankStatus(location.href, 'other');
  let current = '';
  let generation = 0;
  let page: CapturePageHandle | null = null;
  let stopHint: (() => void) | null = null;
  let reportTimer: ReturnType<typeof setTimeout> | null = null;
  let dead = false;

  const alive = () => !dead && root.getAttribute(INSTANCE_ATTR) === token && contextValid();
  const snapshot = (): PageStatus => ({ ...status, watching: page?.watching() ?? [] });

  const report = () => {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      if (!alive()) return;
      sendToBackground({ kind: 'page-state', status: snapshot() }).catch(() => undefined);
    }, REPORT_DELAY_MS);
  };
  const update = (patch: Partial<PageStatus>) => {
    status = { ...status, ...patch };
    report();
  };

  const startGame = (ref: SiteGameRef, source: string) => {
    page?.stop();
    page = null;
    const mine = ++generation;
    const base = blankStatus(status.url, status.kind);
    status = { ...base, ref, refSource: source };
    report();
    void runCapturePage(adapter, ref, {
      log,
      update: (patch) => {
        if (mine === generation) update(patch);
      },
      isActive: () => alive() && mine === generation,
    }).then(
      (handle) => {
        if (mine !== generation || !alive()) handle.stop();
        else page = handle;
      },
      (err: unknown) => log(`Capture stopped: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  const shutdown = () => {
    if (dead) return;
    dead = true;
    clearInterval(timer);
    window.removeEventListener('popstate', onUrl);
    page?.stop();
    page = null;
    stopHint?.();
    stopHint = null;
  };

  const onUrl = () => {
    if (!alive()) {
      shutdown();
      return;
    }
    const key = pageKey(location.href);
    if (key === current) return;
    current = key;
    generation++;
    page?.stop();
    page = null;
    stopHint?.();
    stopHint = null;
    const info = classifyPage(location.href);
    const kind = info?.kind ?? 'other';
    status = blankStatus(location.href, kind);
    log(`Page: ${location.pathname}${location.search} (${KIND_LABEL[kind]}).`);
    report();
    if (info?.ref) {
      startGame(info.ref, 'the URL');
    } else if (kind === 'play' && adapter.watchForGameId) {
      log("No game ID in the URL: watching the page's requests for the current game.");
      stopHint = adapter.watchForGameId((ref, source) => {
        if (status.ref && gameKey(status.ref) === gameKey(ref)) return;
        log(`Game ID ${ref.gameId} from ${source}.`);
        startGame(ref, source);
      }, log);
    }
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!alive() || sender.id !== chrome.runtime.id) return;
    const msg = message as TabRequest | null;
    if (msg?.kind !== 'debug-tab') return;
    const info: ContentDebugInfo = {
      site: adapter.site,
      extensionVersion: chrome.runtime.getManifest().version,
      scriptStartedAt: startedAt,
      status: snapshot(),
      events: debug.list(),
    };
    sendResponse(info);
  });

  log(`Capture script started (extension v${chrome.runtime.getManifest().version}).`);
  const timer = setInterval(onUrl, URL_CHECK_MS);
  window.addEventListener('popstate', onUrl);
  onUrl();
}
