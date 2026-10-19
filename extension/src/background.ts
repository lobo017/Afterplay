import { gameKey, isValidRef, type CaptureSite } from '../../src/capture/game-id';
import { BACKFILL_PAUSE_MS, BACKFILL_SITES, BackfillRunner, type BackfillSiteState } from './backfill';
import { CaptureService, type LinkResolution, type LinkResolver } from './capture-service';
import { lichessIdsExportExtractor } from './extractors/lichess-ids-export';
import { lichessPageDataExtractor } from './extractors/lichess-page-data';
import { describeAttempts, runExtractors, type Extractor } from './extractors/types';
import { chessComUsernames, fetchChessComCallback } from './extractors/chesscom-callback';
import { CHESSCOM_ARCHIVE_METHOD, lookupInArchives, monthOf, previousMonth } from './extractors/chesscom-archive';
import { chromeLocalStore } from './chrome-store';
import type { ExtRequest, StatusReply } from './messages';
import { CaptureQueue } from './queue';
import { accountsOf, loadSettings, saveSettings, siteMatchPattern, validateSettings, type ExtensionSettings } from './settings';

// The background service worker: owns the capture queue and answers content scripts, the
// popup and the bridge. Chrome stops it when idle, so listeners are registered at the top
// level and everything that has to survive (queue, settings, backfill progress) is in storage.

const BRIDGE_SCRIPT_ID = 'wizard-chess-bridge';
const CONTEXT_MENU_ID = 'wizard-chess-save-link';
const FAILURE_NOTIFICATION_ID = 'wizard-chess-capture-failed';
const RETRY_ALARM = 'retry-pending';
/** Wakes a running history import (after a rate limit, or if the worker was stopped mid-import). */
const BACKFILL_ALARM = 'backfill';
/** How often pending games (not yet in Chess.com's archive) are looked for again. */
const RETRY_PERIOD_MINUTES = 15;

/** A link resolved by trying extraction methods in order (from the service worker: no page, no session cookie). */
function resolveWith(extractors: readonly Extractor[]): LinkResolver {
  return async (ref): Promise<LinkResolution> => {
    const { result, attempts } = await runExtractors(extractors, { ref, fetch: (i, init) => fetch(i, init) });
    if (result.ok) return { kind: 'pgn', pgn: result.pgn, method: result.method };
    if (result.retryAfterMs !== undefined) {
      return { kind: 'pending', reason: result.reason, retryAt: Date.now() + result.retryAfterMs };
    }
    return { kind: 'error', error: describeAttempts(attempts) || result.reason };
  };
}

/**
 * A Chess.com link: the game's PGN from the official monthly archive. To know whose archive
 * and which month, the game's own data (the callback the game page loads) names the players
 * and the end time; without it, my archive for this month and the last. A game not in the
 * archive yet stays pending and is looked for again.
 */
const resolveChessComLink: LinkResolver = async (ref): Promise<LinkResolution> => {
  const settings = await loadSettings(chromeLocalStore);
  const me = settings.chesscomUsername.trim();
  const doFetch: typeof fetch = (i, init) => fetch(i, init);
  const meta = await fetchChessComCallback(ref, doFetch).catch(() => null);
  let username: string;
  let months: string[];
  let known: { white?: string; black?: string; date?: string } = {};
  if (meta?.ok) {
    const h = meta.data.game.pgnHeaders ?? {};
    known = { white: String(h.White ?? ''), black: String(h.Black ?? ''), date: String(h.Date ?? '') };
    if (!meta.data.game.isFinished) {
      return { kind: 'pending', reason: 'The game is still in progress.', retryAt: Date.now() + 15 * 60_000, ...known };
    }
    const names = chessComUsernames(meta.data);
    username = me && (names.white === me.toLowerCase() || names.black === me.toLowerCase()) ? me : names.white;
    months = [monthOf(meta.data.game.endTime ? meta.data.game.endTime * 1000 : Date.now())];
  } else {
    if (!me) return { kind: 'error', error: 'Set your Chess.com username in Settings to find this game in your archive.' };
    username = me;
    const now = monthOf(Date.now());
    months = [now, previousMonth(now)];
  }
  const found = await lookupInArchives(doFetch, ref, username, months);
  if (found.status === 'found') return { kind: 'pgn', pgn: found.pgn, method: CHESSCOM_ARCHIVE_METHOD };
  if (found.status === 'pending') {
    return { kind: 'pending', reason: found.reason, retryAt: Date.now() + found.retryAfterMs, ...known };
  }
  return { kind: 'error', error: found.reason };
};

const resolvers: Partial<Record<CaptureSite, LinkResolver>> = {
  // The single-game export needs the Lichess session, which service-worker requests don't carry
  lichess: resolveWith([lichessIdsExportExtractor, lichessPageDataExtractor]),
  chesscom: resolveChessComLink,
};

const queue = new CaptureQueue(chromeLocalStore);
const service = new CaptureService({
  queue,
  store: chromeLocalStore,
  now: Date.now,
  resolvers,
  onQueueChanged: () => void updateBadge(),
});

async function updateBadge(): Promise<void> {
  const counts = await queue.counts();
  const waiting = counts.pending + counts.ready;
  await chrome.action.setBadgeBackgroundColor({ color: '#b8860b' });
  await chrome.action.setBadgeText({ text: waiting === 0 ? '' : waiting > 999 ? '999+' : String(waiting) });
  await chrome.action.setTitle({
    title:
      waiting === 0
        ? "Wizard's Chess capture"
        : `Wizard's Chess capture: ${waiting} game${waiting === 1 ? '' : 's'} not yet on the analysis site`,
  });
}

/** Registers the bridge content script on the configured site URL only (or moves it there). */
async function ensureBridge(settings: ExtensionSettings): Promise<void> {
  const matches = [siteMatchPattern(settings.siteUrl)];
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
  const script = {
    id: BRIDGE_SCRIPT_ID,
    matches,
    js: ['bridge.js'],
    runAt: 'document_start' as const,
    persistAcrossSessions: true,
  };
  if (existing.length === 0) await chrome.scripting.registerContentScripts([script]);
  else if (JSON.stringify(existing[0]!.matches ?? []) !== JSON.stringify(matches)) {
    await chrome.scripting.updateContentScripts([script]);
  }
}

function setupContextMenu(): void {
  void chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Save game to Wizard's Chess",
      contexts: ['link'],
      targetUrlPatterns: ['https://lichess.org/*', 'https://www.chess.com/*', 'https://chess.com/*'],
    });
  });
}

async function notifyFailure(url: string, error: string): Promise<void> {
  await service.recordFailure(url, error);
  await chrome.notifications.create(FAILURE_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: "Couldn't capture the game",
    message: `${error} Click to open the extension and paste the game link or PGN.`,
    priority: 1,
  });
}

async function openPopup(): Promise<void> {
  try {
    await chrome.action.openPopup();
  } catch {
    // No focused browser window to anchor the popup to: open it as a tab instead
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  }
}

const backfill = new BackfillRunner({
  store: chromeLocalStore,
  queue,
  fetch: (i, init) => fetch(i, init),
  now: Date.now,
});

async function readBackfillStates(): Promise<Record<CaptureSite, BackfillSiteState>> {
  const out = {} as Record<CaptureSite, BackfillSiteState>;
  for (const site of BACKFILL_SITES) out[site] = await backfill.state(site);
  return out;
}

let pumping = false;

/**
 * Drives running imports: a step per site (one request), a pause, again, until each is
 * done or waits. A waiting import is woken by an alarm (rate limit), or by the site
 * collecting games. The alarm also restarts an import whose worker was stopped.
 */
async function pumpBackfill(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const active = await backfill.active();
      if (active.length === 0) {
        await chrome.alarms.clear(BACKFILL_ALARM);
        return;
      }
      await chrome.alarms.create(BACKFILL_ALARM, { delayInMinutes: 1 });
      let progressed = false;
      let wakeAt = Number.POSITIVE_INFINITY;
      for (const { site } of active) {
        const r = await backfill.step(site);
        if (r.next === 'continue') progressed = true;
        else if (r.next === 'wait' && r.atMs !== null) wakeAt = Math.min(wakeAt, r.atMs);
      }
      void updateBadge();
      if (!progressed) {
        if (Number.isFinite(wakeAt)) await chrome.alarms.create(BACKFILL_ALARM, { when: Math.max(wakeAt, Date.now() + 30_000) });
        return;
      }
      await new Promise((r) => setTimeout(r, BACKFILL_PAUSE_MS));
    }
  } finally {
    pumping = false;
  }
}

async function init(): Promise<void> {
  await ensureBridge(await loadSettings(chromeLocalStore));
  await updateBadge();
  if (!(await chrome.alarms.get(RETRY_ALARM))) {
    await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: RETRY_PERIOD_MINUTES });
  }
}

const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
const CAPTURE_HOSTS = new Set(['lichess.org', 'www.chess.com', 'chess.com']);

function senderOrigin(sender: chrome.runtime.MessageSender): string | null {
  try {
    return sender.origin ?? (sender.url ? new URL(sender.url).origin : null);
  } catch {
    return null;
  }
}

/** Popup / extension pages. */
function fromExtension(sender: chrome.runtime.MessageSender): boolean {
  return senderOrigin(sender) === extensionOrigin;
}

/** The Lichess / Chess.com content scripts. */
function fromGameSite(sender: chrome.runtime.MessageSender): boolean {
  const origin = senderOrigin(sender);
  return origin !== null && origin.startsWith('https://') && CAPTURE_HOSTS.has(new URL(origin).hostname);
}

async function handle(msg: ExtRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.kind) {
    case 'capture': {
      if (!fromGameSite(sender) && !fromExtension(sender)) return { ok: false, error: 'Not allowed.' };
      const reply = await service.saveCapture(msg.site, msg.gameId, msg.pgn, msg.method, msg.url);
      if (!reply.ok && msg.auto) await notifyFailure(msg.url, reply.error);
      return reply;
    }
    case 'capture-failed':
      if (!fromGameSite(sender)) return { ok: false };
      await notifyFailure(msg.url, msg.error);
      return { ok: true };
    case 'lookup': {
      if (!fromGameSite(sender) && !fromExtension(sender)) return null;
      return queue.get(msg.key);
    }
    case 'get-settings':
      if (!fromGameSite(sender) && !fromExtension(sender)) return null;
      return loadSettings(chromeLocalStore);
    case 'bridge-hello':
    case 'bridge-batch':
    case 'bridge-delivered': {
      const settings = await loadSettings(chromeLocalStore);
      if (senderOrigin(sender) !== settings.siteUrl) return { error: 'Not the configured site.' };
      if (msg.kind === 'bridge-hello') {
        return { extensionVersion: chrome.runtime.getManifest().version, accounts: accountsOf(settings) };
      }
      if (msg.kind === 'bridge-batch') return service.takeBatch(Math.min(Math.max(1, msg.max), 50), msg.exclude);
      const delivered = await service.markDelivered(msg.keys);
      // An import paused for a full queue can go on now
      if (delivered > 0) void pumpBackfill();
      return { delivered };
    }
    default:
      break;
  }

  // Everything below is the popup's
  if (!fromExtension(sender)) return { error: 'Not allowed.' };
  switch (msg.kind) {
    case 'status': {
      const reply: StatusReply = {
        entries: (await queue.list()).slice(0, 100),
        counts: await queue.counts(),
        settings: await loadSettings(chromeLocalStore),
        lastFailure: await service.lastFailure(),
        backfill: await readBackfillStates(),
        extensionVersion: chrome.runtime.getManifest().version,
      };
      return reply;
    }
    case 'save-settings': {
      const checked = validateSettings(msg.settings);
      if ('problem' in checked) return { ok: false, problem: checked.problem };
      await saveSettings(chromeLocalStore, checked.settings);
      await ensureBridge(checked.settings);
      return { ok: true, settings: checked.settings };
    }
    case 'save-text':
      return service.saveText(msg.text);
    case 'retry':
      await service.retryPending(msg.key);
      return queue.get(msg.key);
    case 'remove': {
      const removed = await queue.remove(msg.key);
      await updateBadge();
      return { removed };
    }
    case 'dismiss-failure':
      await service.dismissFailure();
      return { ok: true };
    case 'backfill-start': {
      const settings = await loadSettings(chromeLocalStore);
      const username = msg.site === 'lichess' ? settings.lichessUsername : settings.chesscomUsername;
      if (!username) return { ok: false, error: 'Set your username in Settings first.' };
      const state = await backfill.start(msg.site, username);
      void pumpBackfill();
      return { ok: true, state };
    }
    case 'backfill-stop':
      return { ok: true, state: await backfill.stop(msg.site) };
    default:
      return { error: `Unknown request ${(msg as { kind: string }).kind}.` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof (message as { kind?: unknown }).kind !== 'string') return;
  handle(message as ExtRequest, sender).then(sendResponse, (err: unknown) =>
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
  void init();
});
chrome.runtime.onStartup.addListener(() => {
  void init();
  void pumpBackfill();
});

/** "Save game to Wizard's Chess" on a game link. */
async function onContextMenuClick(info: chrome.contextMenus.OnClickData): Promise<void> {
  if (info.menuItemId !== CONTEXT_MENU_ID || !info.linkUrl) return;
  const link = info.linkUrl;
  const result = await service.saveLink(link);
  if (!result.ok) await notifyFailure(link, result.error ?? 'The link could not be saved.');
}

chrome.contextMenus.onClicked.addListener((info) => void onContextMenuClick(info));

chrome.notifications.onClicked.addListener((id) => {
  if (id !== FAILURE_NOTIFICATION_ID) return;
  void chrome.notifications.clear(id);
  void openPopup();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) void service.retryPending();
  if (alarm.name === BACKFILL_ALARM) void pumpBackfill();
});

/** Test and debugging hook, like the site's window.__wizardChess* objects. */
(self as unknown as { __wizardChessCapture: unknown }).__wizardChessCapture = {
  service,
  queue,
  updateBadge,
  onContextMenuClick,
  contextMenuId: CONTEXT_MENU_ID,
  backfill,
  pumpBackfill,
  gameKey,
  isValidRef,
};
