import { gameKey, gameUrl, isValidRef, type CaptureSite } from '../../src/capture/game-id';
import { readPgnHeaders } from '../../src/capture/pgn-time';
import { AUTO_SYNC_PERIOD_MINUTES, AutoSync, type AutoSyncReason, type AutoSyncSiteState } from './auto-sync';
import { BACKFILL_PAUSE_MS, BACKFILL_SITES, BackfillRunner, type BackfillSiteState } from './backfill';
import { CaptureService, type LinkResolution, type LinkResolver } from './capture-service';
import { lichessIdsExportExtractor } from './extractors/lichess-ids-export';
import { lichessPageDataExtractor } from './extractors/lichess-page-data';
import { describeAttempts, runExtractors, type Extractor } from './extractors/types';
import { chessComCallbackExtractor, chessComUsernames, fetchChessComCallback } from './extractors/chesscom-callback';
import { CHESSCOM_ARCHIVE_METHOD, lookupInArchives, monthOf, previousMonth } from './extractors/chesscom-archive';
import { chromeLocalStore } from './chrome-store';
import { GameRetries, type GameRetryItem, type RetryOutcome } from './game-retry';
import type { BackgroundDebugInfo, ExtRequest, LeaveRecord, PageStatus, StatusReply, TabRequest } from './messages';
import { classifyPage, pageKey, SITE_CONTENT_SCRIPT, SITE_TAB_PATTERNS } from './pages';
import { CaptureQueue, type KeyValueStore } from './queue';
import {
  accountsOf,
  loadSettings,
  saveSettings,
  siteMatchPatterns,
  siteOrigins,
  validateSettings,
  type ExtensionSettings,
} from './settings';
import {
  hasLeft,
  leaveAction,
  leaveCaptureCheck,
  tabFromReport,
  tabFromUrl,
  TRACKED_TABS_KEY,
  type TrackedTab,
  type TrackedTabs,
} from './tab-tracker';

// The background service worker: owns the capture queue and answers content scripts, the
// popup and the bridge. Chrome stops it when idle, so listeners are registered at the top
// level and everything that has to survive (queue, settings, backfill progress) is in storage.

const BRIDGE_SCRIPT_ID = 'wizard-chess-bridge';
const CONTEXT_MENU_ID = 'wizard-chess-save-link';
const FAILURE_NOTIFICATION_ID = 'wizard-chess-capture-failed';
const RETRY_ALARM = 'retry-pending';
/** Wakes a running history import (after a rate limit, or if the worker was stopped mid-import). */
const BACKFILL_ALARM = 'backfill';
/** The safety net: my recent games, while a game site's tab is open (auto-sync.ts). */
const AUTO_SYNC_ALARM = 'auto-sync';
/** Wakes the retries of games left before the site had their data (game-retry.ts). */
const GAME_RETRY_ALARM = 'game-retry';
/** How often pending games (not yet in Chess.com's archive) are looked for again. */
const RETRY_PERIOD_MINUTES = 15;
/** After I leave a game page, the site is synced this soon, and on every alarm for this long. */
const LEAVE_SYNC_DELAY_MS = 5000;
const LEAVE_FOLLOW_UP_MS = 30 * 60_000;
/** chrome.storage.session keys (gone when the browser closes, like the tabs they describe). */
const FOLLOW_UP_KEY = 'autoSyncFollowUp';
const LAST_LEAVE_KEY = 'lastLeave';

const SITE_NAME: Record<CaptureSite, string> = { lichess: 'Lichess', chesscom: 'Chess.com' };

const sessionStore: KeyValueStore = {
  get: (keys) => chrome.storage.session.get(keys),
  set: (items) => chrome.storage.session.set(items),
  remove: (keys) => chrome.storage.session.remove(keys),
};

/** A PGN with the result "*" is a game still running (the Lichess exports answer for those too). */
function isUnfinished(pgn: string): boolean {
  return (readPgnHeaders(pgn).Result ?? '*') === '*';
}

/** A link resolved by trying extraction methods in order (from the service worker: no page, no session cookie). */
function resolveWith(extractors: readonly Extractor[]): LinkResolver {
  return async (ref): Promise<LinkResolution> => {
    const { result, attempts } = await runExtractors(extractors, { ref, fetch: (i, init) => fetch(i, init) });
    if (result.ok) {
      return isUnfinished(result.pgn)
        ? { kind: 'in-progress', reason: 'The game is still in progress.' }
        : { kind: 'pgn', pgn: result.pgn, method: result.method };
    }
    if (result.inProgress) return { kind: 'in-progress', reason: result.reason };
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
    if (!me)
      return { kind: 'error', error: 'Set your Chess.com username in Settings to find this game in your archive.' };
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

/**
 * A game I just left: Chess.com's game data gives the PGN at once (the archive can lag by
 * hours). Chess.com answers 404 for a live game until it has ended, so a 404 here means "not
 * yet" (the game is tried again); other failures fall back to the archive. Lichess: as for
 * links.
 */
const leaveResolvers: Record<CaptureSite, LinkResolver> = {
  lichess: resolvers.lichess!,
  chesscom: async (ref) => {
    const { result, attempts } = await runExtractors([chessComCallbackExtractor], {
      ref,
      fetch: (i, init) => fetch(i, init),
    });
    if (result.ok) return { kind: 'pgn', pgn: result.pgn, method: result.method };
    if (result.inProgress) return { kind: 'in-progress', reason: result.reason };
    if (result.notFound) {
      return {
        kind: 'in-progress',
        reason: "Chess.com has no data for this game yet (it shares a live game's data once it has ended).",
      };
    }
    if (result.retryAfterMs !== undefined)
      return { kind: 'in-progress', reason: describeAttempts(attempts) || result.reason };
    return resolveChessComLink(ref);
  },
};

const queue = new CaptureQueue(chromeLocalStore);

function onQueueChanged(): void {
  void updateBadge();
  nudgeSite();
}

const service = new CaptureService({
  queue,
  store: chromeLocalStore,
  now: Date.now,
  resolvers,
  onQueueChanged,
});

async function updateBadge(): Promise<void> {
  const counts = await queue.counts();
  const waiting = counts.pending + counts.ready;
  await chrome.action.setBadgeBackgroundColor({ color: '#b8860b' });
  await chrome.action.setBadgeText({ text: waiting === 0 ? '' : waiting > 999 ? '999+' : String(waiting) });
  await chrome.action.setTitle({
    title:
      waiting === 0
        ? 'Afterplay capture: every captured game is on the analysis site'
        : `Afterplay capture: ${waiting} game${waiting === 1 ? '' : 's'} not on the analysis site yet (sent when it is open in a tab)`,
  });
}

/** Tabs showing the analysis site (where the bridge runs). */
async function siteTabs(settings?: ExtensionSettings): Promise<chrome.tabs.Tab[]> {
  const s = settings ?? (await loadSettings(chromeLocalStore));
  try {
    return await chrome.tabs.query({ url: siteMatchPatterns(s.siteUrl) });
  } catch {
    return [];
  }
}

let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

/** Games are ready: the bridge in every open tab of the analysis site syncs now, focused or not. */
function nudgeSite(): void {
  if (nudgeTimer) return;
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    void (async () => {
      if ((await queue.counts()).ready === 0) return;
      const message: TabRequest = { kind: 'bridge-nudge' };
      for (const tab of await siteTabs()) {
        if (tab.id !== undefined) await chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
      }
    })();
  }, 200);
}

/** Registers the bridge content script on the configured site URL only (or moves it there). */
async function ensureBridge(settings: ExtensionSettings): Promise<void> {
  // Both loopback names: the site opened as localhost or as 127.0.0.1 gets its games
  const matches = siteMatchPatterns(settings.siteUrl);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
  const script = {
    id: BRIDGE_SCRIPT_ID,
    matches,
    js: ['bridge.js'],
    runAt: 'document_start' as const,
    persistAcrossSessions: true,
  };
  if (existing.length === 0) await chrome.scripting.registerContentScripts([script]);
  // Chrome may hand the patterns back in another order
  else if (JSON.stringify([...(existing[0]!.matches ?? [])].sort()) !== JSON.stringify([...matches].sort())) {
    await chrome.scripting.updateContentScripts([script]);
  }
}

function setupContextMenu(): void {
  void chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Save game to Afterplay',
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

/**
 * Chrome runs manifest content scripts only in pages loaded after the extension: tabs that
 * were open when it was installed or updated get the script now (an orphaned older copy
 * sees the newer one and stops). Returns how many tabs got it.
 */
async function injectIntoOpenTabs(): Promise<number> {
  let injected = 0;
  for (const site of BACKFILL_SITES) {
    const tabs = await chrome.tabs.query({ url: SITE_TAB_PATTERNS[site] }).catch(() => [] as chrome.tabs.Tab[]);
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [SITE_CONTENT_SCRIPT[site]] });
        injected++;
      } catch {
        // A tab that can't take scripts (discarded, an error page): it gets one when reloaded
      }
    }
  }
  return injected;
}

const backfill = new BackfillRunner({
  store: chromeLocalStore,
  queue,
  fetch: (i, init) => fetch(i, init),
  now: Date.now,
});

const autoSync = new AutoSync({
  store: chromeLocalStore,
  queue,
  fetch: (i, init) => fetch(i, init),
  now: Date.now,
  importActive: async (site) => {
    const state = await backfill.state(site);
    return state.status === 'running' || state.status === 'waiting';
  },
});

async function readBackfillStates(): Promise<Record<CaptureSite, BackfillSiteState>> {
  const out = {} as Record<CaptureSite, BackfillSiteState>;
  for (const site of BACKFILL_SITES) out[site] = await backfill.state(site);
  return out;
}

async function readAutoSyncStates(): Promise<Record<CaptureSite, AutoSyncSiteState>> {
  const out = {} as Record<CaptureSite, AutoSyncSiteState>;
  for (const site of BACKFILL_SITES) out[site] = await autoSync.state(site);
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
      onQueueChanged();
      if (!progressed) {
        if (Number.isFinite(wakeAt))
          await chrome.alarms.create(BACKFILL_ALARM, { when: Math.max(wakeAt, Date.now() + 30_000) });
        return;
      }
      await new Promise((r) => setTimeout(r, BACKFILL_PAUSE_MS));
    }
  } finally {
    pumping = false;
  }
}

// --- Automatic sync (the safety net)

function usernameFor(settings: ExtensionSettings, site: CaptureSite): string {
  return (site === 'lichess' ? settings.lichessUsername : settings.chesscomUsername).trim();
}

/** Syncs one site's recent games, if automatic capture is on and my username is set. */
async function runAutoSync(site: CaptureSite, reason: AutoSyncReason): Promise<AutoSyncSiteState | null> {
  const settings = await loadSettings(chromeLocalStore);
  const username = usernameFor(settings, site);
  if (!settings.autoCapture || username === '') return null;
  const before = await queue.counts();
  const state = await autoSync.run(site, username, reason);
  const after = await queue.counts();
  if (after.ready !== before.ready || after.pending !== before.pending) onQueueChanged();
  return state;
}

/** Which game sites have a tab open. */
async function openGameSites(): Promise<Record<CaptureSite, boolean>> {
  const out = { lichess: false, chesscom: false } as Record<CaptureSite, boolean>;
  for (const site of BACKFILL_SITES) {
    const tabs = await chrome.tabs.query({ url: SITE_TAB_PATTERNS[site] }).catch(() => [] as chrome.tabs.Tab[]);
    out[site] = tabs.length > 0;
  }
  return out;
}

async function followUps(): Promise<Partial<Record<CaptureSite, number>>> {
  return ((await sessionStore.get([FOLLOW_UP_KEY]))[FOLLOW_UP_KEY] as Partial<Record<CaptureSite, number>>) ?? {};
}

/** The alarm: each site with a tab open (or a game page left in the last 30 min) is synced. */
async function onAutoSyncAlarm(): Promise<void> {
  const open = await openGameSites();
  const follow = await followUps();
  const now = Date.now();
  for (const site of BACKFILL_SITES) {
    if (open[site] || (follow[site] ?? 0) > now) await runAutoSync(site, 'alarm');
  }
}

// --- Retries of games left before the site had their data

let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** A timer for the next retry (seconds away), and an alarm in case the worker stops before it. */
function scheduleRetryWake(nextAt: number | null): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (nextAt === null) {
    void chrome.alarms.clear(GAME_RETRY_ALARM);
    return;
  }
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      void runRetries();
    },
    Math.max(0, nextAt - Date.now()),
  );
  // Chrome runs alarms 30 s from now at the soonest
  void chrome.alarms.create(GAME_RETRY_ALARM, { when: Math.max(nextAt, Date.now() + 30_000) });
}

/** Captures a game I left, as on leaving the page; `retry` when its data isn't there yet. */
async function captureLeftGame(tab: TrackedTab): Promise<RetryOutcome & { reason?: string }> {
  const settings = await loadSettings(chromeLocalStore);
  if (!settings.autoCapture || !tab.ref) return { retry: false, result: 'nothing done: automatic capture is off' };
  const r = await service.captureFinished(
    tab.ref,
    gameUrl(tab.ref),
    leaveResolvers[tab.site],
    leaveCaptureCheck(tab, settings, Date.now()),
    'left-page',
  );
  if (r.outcome === 'skipped' || r.outcome === 'error') {
    return {
      retry: r.outcome === 'skipped' && r.retry === true,
      result: `${r.outcome === 'skipped' ? 'not captured' : 'failed'}: ${r.reason}`,
    };
  }
  return { retry: false, result: r.outcome === 'known' ? 'already captured' : `captured (${r.outcome})` };
}

const retries = new GameRetries({
  store: sessionStore,
  now: Date.now,
  attempt: (item: GameRetryItem) => captureLeftGame(item.tab),
  onSchedule: scheduleRetryWake,
});

async function runRetries(): Promise<void> {
  for (const report of await retries.runDue()) {
    await recordLeave(report.site, { at: Date.now(), url: report.url, result: `retry: ${report.result}` });
  }
}

const syncTimers: Partial<Record<CaptureSite, ReturnType<typeof setTimeout>>> = {};

function scheduleSync(site: CaptureSite, reason: AutoSyncReason, delayMs: number): void {
  if (syncTimers[site]) return;
  syncTimers[site] = setTimeout(() => {
    delete syncTimers[site];
    void runAutoSync(site, reason);
  }, delayMs);
}

// --- Tabs: what each game-site tab shows, and leaving a game page

let tabsChain: Promise<unknown> = Promise.resolve();

async function readTabs(): Promise<TrackedTabs> {
  return ((await sessionStore.get([TRACKED_TABS_KEY]))[TRACKED_TABS_KEY] as TrackedTabs | undefined) ?? {};
}

/** Read-modify-write of the tracked tabs, one at a time. */
function editTabs<T>(fn: (tabs: TrackedTabs) => T): Promise<T> {
  const run = tabsChain.then(async () => {
    const tabs = await readTabs();
    const out = fn(tabs);
    await sessionStore.set({ [TRACKED_TABS_KEY]: tabs });
    return out;
  });
  tabsChain = run.catch(() => undefined);
  return run;
}

async function recordLeave(site: CaptureSite, record: LeaveRecord): Promise<void> {
  const all =
    ((await sessionStore.get([LAST_LEAVE_KEY]))[LAST_LEAVE_KEY] as Partial<Record<CaptureSite, LeaveRecord>>) ?? {};
  await sessionStore.set({ [LAST_LEAVE_KEY]: { ...all, [site]: record } });
}

/**
 * I left a game page (closed the tab, went to another page): the game is fetched from here
 * and queued if it has ended and is mine, since the page may have gone before it could
 * capture it; then the site's recent games are synced, and synced again on the alarm for a
 * while (Chess.com's archive lags).
 */
async function onLeftPage(tab: TrackedTab): Promise<void> {
  const action = leaveAction(tab);
  if (!action.capture && !action.sync) return;
  const settings = await loadSettings(chromeLocalStore);
  const now = Date.now();
  if (!settings.autoCapture) {
    await recordLeave(tab.site, { at: now, url: tab.url, result: 'nothing done: automatic capture is off' });
    return;
  }
  const follow = await followUps();
  await sessionStore.set({ [FOLLOW_UP_KEY]: { ...follow, [tab.site]: now + LEAVE_FOLLOW_UP_MS } });
  let result = action.capture ? '' : `synced only: ${action.reason}`;
  if (action.capture && tab.ref) {
    try {
      const r = await captureLeftGame(tab);
      result = r.result;
      if (r.retry) {
        const item = await retries.add({ key: gameKey(tab.ref), ref: tab.ref, url: tab.url, tab });
        result += `; ${GameRetries.describe(item, Date.now())}`;
      }
    } catch (err) {
      result = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  await recordLeave(tab.site, { at: now, url: tab.url, result });
  if (action.sync) scheduleSync(tab.site, 'left-page', LEAVE_SYNC_DELAY_MS);
}

async function onPageState(tabId: number, tabUrl: string | undefined, status: PageStatus): Promise<void> {
  // A report from a page the tab has already left (sent just before it navigated) is stale
  if (tabUrl !== undefined && pageKey(tabUrl) !== pageKey(status.url)) return;
  const left = await editTabs((tabs) => {
    const prev = tabs[tabId];
    const next = tabFromReport(tabId, status, Date.now());
    if (next) tabs[tabId] = next;
    else delete tabs[tabId];
    return prev && hasLeft(prev, status.url) ? prev : null;
  });
  if (left) await onLeftPage(left);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url === undefined && changeInfo.status !== 'loading') return;
  // Without host permission for the new page (it's off the game sites), Chrome leaves the URL out
  const url = changeInfo.url ?? tab.url;
  void (async () => {
    const left = await editTabs((tabs) => {
      const prev = tabs[tabId];
      if (prev && !hasLeft(prev, url)) return null;
      const next = url ? tabFromUrl(tabId, url, Date.now()) : null;
      if (next) tabs[tabId] = next;
      else delete tabs[tabId];
      return prev ?? null;
    });
    if (left) await onLeftPage(left);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const left = await editTabs((tabs) => {
      const prev = tabs[tabId] ?? null;
      delete tabs[tabId];
      return prev;
    });
    if (left) await onLeftPage(left);
  })();
});

async function init(): Promise<void> {
  await ensureBridge(await loadSettings(chromeLocalStore));
  // Waiting games queued before the queue knew variants and games without moves
  await queue.classifyWaiting();
  await updateBadge();
  if (!(await chrome.alarms.get(RETRY_ALARM))) {
    await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: RETRY_PERIOD_MINUTES });
  }
  if (!(await chrome.alarms.get(AUTO_SYNC_ALARM))) {
    await chrome.alarms.create(AUTO_SYNC_ALARM, { periodInMinutes: AUTO_SYNC_PERIOD_MINUTES });
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

async function debugBackground(tabId: number | null, url: string | null): Promise<BackgroundDebugInfo> {
  const settings = await loadSettings(chromeLocalStore);
  const tracked = tabId !== null ? ((await readTabs())[tabId] ?? null) : null;
  const page = classifyPage(url ?? tracked?.url);
  let sync: BackgroundDebugInfo['sync'] = null;
  let lastLeave: LeaveRecord | null = null;
  let retrying: BackgroundDebugInfo['retrying'] = [];
  if (page) {
    const site = page.site;
    const username = usernameFor(settings, site);
    const enabled = settings.autoCapture && username !== '';
    const why = !settings.autoCapture
      ? 'automatic capture is off in Settings'
      : username === ''
        ? `set your ${SITE_NAME[site]} username in Settings`
        : `every ${AUTO_SYNC_PERIOD_MINUTES} min while a ${SITE_NAME[site]} tab is open, and when you leave a game page`;
    sync = { site, state: await autoSync.state(site), enabled, why };
    retrying = (await retries.list())
      .filter((r) => r.ref.site === site)
      .map((r) => ({ key: r.key, url: r.url, description: GameRetries.describe(r, Date.now()) }));
    const leaves =
      ((await sessionStore.get([LAST_LEAVE_KEY]))[LAST_LEAVE_KEY] as Partial<Record<CaptureSite, LeaveRecord>>) ?? {};
    lastLeave = leaves[site] ?? null;
  }
  const ref = tracked?.ref ?? page?.ref ?? null;
  return {
    settings: {
      lichessUsername: settings.lichessUsername,
      chesscomUsername: settings.chesscomUsername,
      autoCapture: settings.autoCapture,
      siteUrl: settings.siteUrl,
    },
    tracked,
    sync,
    entry: ref ? await queue.get(gameKey(ref)) : null,
    lastLeave,
    retrying,
    siteTabOpen: (await siteTabs(settings)).length > 0,
  };
}

async function handle(msg: ExtRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.kind) {
    case 'capture': {
      if (!fromGameSite(sender) && !fromExtension(sender)) return { ok: false, error: 'Not allowed.' };
      const reply = await service.saveCapture(msg.site, msg.gameId, msg.pgn, msg.method, msg.url, msg.trigger);
      if (!reply.ok && msg.auto) await notifyFailure(msg.url, reply.error);
      return reply;
    }
    case 'capture-failed':
      if (!fromGameSite(sender)) return { ok: false };
      await notifyFailure(msg.url, msg.error);
      return { ok: true };
    case 'page-state':
      if (!fromGameSite(sender) || sender.tab?.id === undefined) return { ok: false };
      await onPageState(sender.tab.id, sender.tab.url, msg.status);
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
    case 'bridge-delivered':
    case 'bridge-rejected': {
      const settings = await loadSettings(chromeLocalStore);
      const origin = senderOrigin(sender);
      if (origin === null || !siteOrigins(settings.siteUrl).includes(origin))
        return { error: 'Not the configured site.' };
      if (msg.kind === 'bridge-rejected') {
        const items = (Array.isArray(msg.items) ? msg.items : []).filter(
          (i) =>
            i &&
            typeof i.key === 'string' &&
            (i.kind === 'variant' || i.kind === 'no-moves' || i.kind === 'invalid') &&
            typeof i.reason === 'string',
        );
        return {
          rejected: await service.markRejected(
            items.map((i) => ({ key: i.key, kind: i.kind, reason: i.reason.slice(0, 200) })),
          ),
        };
      }
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
      const settings = await loadSettings(chromeLocalStore);
      const reply: StatusReply = {
        entries: (await queue.list()).slice(0, 100),
        rejected: (await queue.list()).filter((e) => e.status === 'rejected' && !e.dismissed).slice(0, 200),
        counts: await queue.counts(),
        settings,
        lastFailure: await service.lastFailure(),
        backfill: await readBackfillStates(),
        autoSync: await readAutoSyncStates(),
        siteTabOpen: (await siteTabs(settings)).length > 0,
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
    case 'retry-rejected': {
      const retried = await queue.retryRejected(msg.key);
      if (retried) onQueueChanged();
      return { retried };
    }
    case 'dismiss-rejected': {
      const dismissed = await queue.dismissRejected(msg.key);
      if (dismissed) onQueueChanged();
      return { dismissed };
    }
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
    case 'debug-background':
      return debugBackground(msg.tabId, msg.url);
    case 'inject-tab': {
      const page = classifyPage(msg.url);
      if (!page) return { ok: false, error: 'Not a Lichess or Chess.com page.' };
      try {
        await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: [SITE_CONTENT_SCRIPT[page.site]] });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    case 'sync-now': {
      const out: Partial<Record<CaptureSite, AutoSyncSiteState | null>> = {};
      for (const site of BACKFILL_SITES) out[site] = await runAutoSync(site, 'manual');
      return { ok: true, states: out };
    }
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

chrome.runtime.onInstalled.addListener((details) => {
  setupContextMenu();
  void init();
  if (details.reason === 'install' || details.reason === 'update') void injectIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(() => {
  void init();
  void pumpBackfill();
  // Games played while the browser was closed (or elsewhere)
  for (const site of BACKFILL_SITES) void runAutoSync(site, 'startup');
});

/** "Save game to Afterplay" on a game link. */
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
  if (alarm.name === AUTO_SYNC_ALARM) void onAutoSyncAlarm();
  if (alarm.name === GAME_RETRY_ALARM) void runRetries();
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
  autoSync,
  onAutoSyncAlarm,
  runAutoSync,
  readTabs,
  injectIntoOpenTabs,
  retries,
  runRetries,
  gameKey,
  isValidRef,
};
