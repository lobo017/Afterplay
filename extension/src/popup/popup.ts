import type { CaptureSite } from '../../../src/capture/game-id';
import { localDateTime } from '../../../src/capture/pgn-time';
import type { AutoSyncSiteState } from '../auto-sync';
import type { BackfillSiteState } from '../backfill';
import { sendToBackground } from '../chrome-store';
import type {
  BackgroundDebugInfo,
  ContentDebugInfo,
  SaveSettingsReply,
  SaveTextResult,
  StatusReply,
  TabRequest,
} from '../messages';
import { classifyPage } from '../pages';
import type { CaptureTrigger, QueueEntry } from '../queue';
import { siteMatchPattern, type ExtensionSettings } from '../settings';

const q = <T extends HTMLElement>(id: string) => document.querySelector(`[data-testid="${id}"]`) as T;

const els = {
  counts: q('popup-counts'),
  deliveryText: q('popup-delivery-text'),
  pendingText: q('popup-pending-text'),
  siteState: q('popup-site-state'),
  openSite: q<HTMLButtonElement>('popup-open-site'),
  failure: q('popup-failure'),
  failureText: q('popup-failure-text'),
  failureUse: q<HTMLButtonElement>('popup-failure-use'),
  failureDismiss: q<HTMLButtonElement>('popup-failure-dismiss'),
  paste: q<HTMLTextAreaElement>('popup-paste'),
  save: q<HTMLButtonElement>('popup-save'),
  result: q('popup-result'),
  entries: q<HTMLUListElement>('popup-entries'),
  autoSummary: q('popup-auto-summary'),
  syncNow: q<HTMLButtonElement>('popup-sync-now'),
  syncResult: q('popup-sync-result'),
  debugBtn: q<HTMLButtonElement>('popup-debug-btn'),
  debugCopy: q<HTMLButtonElement>('popup-debug-copy'),
  debugInject: q<HTMLButtonElement>('popup-debug-inject'),
  debugResult: q('popup-debug-result'),
  debugOutput: q('popup-debug-output'),
  debugRows: q('popup-debug-rows'),
  debugEvents: q<HTMLOListElement>('popup-debug-events'),
  form: q<HTMLFormElement>('popup-settings-form'),
  settingsResult: q('popup-settings-result'),
  lichessUser: q<HTMLInputElement>('popup-lichess-user'),
  chesscomUser: q<HTMLInputElement>('popup-chesscom-user'),
  siteUrl: q<HTMLInputElement>('popup-site-url'),
  autoCapture: q<HTMLInputElement>('popup-auto-capture'),
};

let status: StatusReply | null = null;
let failureUrl = '';

const SITE_NAME: Record<CaptureSite, string> = { lichess: 'Lichess', chesscom: 'Chess.com' };

const SITE_BADGE: Record<QueueEntry['source'], { label: string; title: string }> = {
  lichess: { label: 'L', title: 'Lichess' },
  chesscom: { label: 'C', title: 'Chess.com' },
  paste: { label: 'P', title: 'Pasted PGN' },
};

/** How each game was obtained, as the popup says it (so a capture shows which method worked). */
const METHOD_LABEL: Record<string, string> = {
  'lichess-session-export': 'Lichess export (your session)',
  'lichess-ids-export': 'Lichess export by ID',
  'lichess-page-data': 'Lichess page data',
  'lichess-history': 'Lichess history',
  'lichess-sync': 'Lichess games API',
  'chesscom-callback': 'Chess.com game data',
  'chesscom-share-pgn': 'Chess.com Share dialog',
  'chesscom-archive': 'Chess.com archive',
  'chesscom-archive-history': 'Chess.com archive',
  'chesscom-archive-sync': 'Chess.com archive',
  'pasted-pgn': 'pasted PGN',
};

/** What made the capture happen. */
const TRIGGER_LABEL: Record<CaptureTrigger, string> = {
  'game-end': 'auto: game ended on the page',
  'page-open': 'auto: finished game opened',
  'left-page': 'auto: after leaving the game page',
  sync: 'auto: background check',
  'save-button': 'Save button',
  history: 'history import',
  link: 'link',
  paste: 'pasted',
};

const STATUS_LABEL: Record<QueueEntry['status'], string> = {
  pending: 'not available yet',
  ready: 'ready to send',
  delivered: 'on the site',
};

const STATUS_TITLE: Record<QueueEntry['status'], string> = {
  pending: "Known, but its PGN isn't available yet (Chess.com's archive can lag); tried again every 15 min.",
  ready: 'Captured and kept in the extension; copied to the analysis site as soon as it is open in a tab.',
  delivered: "In the analysis site's Games list.",
};

function setResult(el: HTMLElement, text: string, tone: 'ok' | 'bad' | 'info' = 'info'): void {
  el.textContent = text;
  el.setAttribute('data-tone', tone);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** "14:05" today, "2026-10-17 14:05" otherwise; local time. */
function shortTime(ms: number): string {
  const t = localDateTime(ms);
  return t.date === localDateTime(Date.now()).date ? t.time : `${t.date} ${t.time}`;
}

/** When the game was played, in my time zone (from the PGN's UTC date and time). */
function playedText(e: QueueEntry): string {
  if (e.playedAt) {
    const t = localDateTime(e.playedAt);
    return `${t.date} ${t.time}`;
  }
  return e.date ? e.date.replace(/\./g, '-') : '';
}

function renderEntries(entries: readonly QueueEntry[]): void {
  els.entries.replaceChildren();
  if (entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing captured yet.';
    els.entries.appendChild(li);
    return;
  }
  for (const e of entries.slice(0, 40)) {
    const li = document.createElement('li');
    li.setAttribute('data-testid', 'popup-entry');
    li.setAttribute('data-key', e.key);
    li.setAttribute('data-status', e.status);
    li.setAttribute('data-trigger', e.trigger ?? '');
    const site = document.createElement('span');
    site.className = `site site-${e.source}`;
    site.textContent = SITE_BADGE[e.source].label;
    site.title = SITE_BADGE[e.source].title;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = e.white || e.black ? `${e.white || '?'} vs ${e.black || '?'}` : (e.url ?? e.key);
    const sub = document.createElement('small');
    const method = e.method ? (METHOD_LABEL[e.method] ?? e.method) : null;
    sub.setAttribute('data-method', e.method ?? '');
    const played = document.createElement('span');
    played.setAttribute('data-testid', 'popup-entry-played');
    played.textContent = playedText(e);
    // A pasted game's method already says so
    const trigger = e.trigger && e.trigger !== 'paste' ? TRIGGER_LABEL[e.trigger] : null;
    const rest = [method, trigger, `captured ${timeAgo(e.capturedAt)}`, e.status === 'pending' ? e.error : null]
      .filter(Boolean)
      .join(' · ');
    if (e.result) sub.append(`${e.result} · `);
    if (played.textContent) sub.append(played, ' · ');
    sub.append(rest);
    who.appendChild(sub);
    who.title = [who.firstChild?.textContent, sub.textContent].filter(Boolean).join('\n');
    const st = document.createElement('span');
    st.className = `status status-${e.status}`;
    st.textContent = STATUS_LABEL[e.status];
    st.title = STATUS_TITLE[e.status];
    li.append(site, who, st);
    if (e.status === 'pending') {
      const actions = document.createElement('div');
      actions.className = 'entry-actions';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry now';
      retry.setAttribute('data-testid', 'popup-entry-retry');
      retry.addEventListener('click', () => {
        retry.disabled = true;
        void sendToBackground({ kind: 'retry', key: e.key }).then(refresh);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        void sendToBackground({ kind: 'remove', key: e.key }).then(refresh);
      });
      actions.append(retry, remove);
      li.appendChild(actions);
    }
    els.entries.appendChild(li);
  }
}

function backfillText(state: BackfillSiteState): string {
  switch (state.status) {
    case 'idle':
      return 'Not imported yet.';
    case 'running':
      return state.message || 'Importing…';
    case 'waiting':
    case 'error':
      return state.message;
    case 'done':
      return state.message || `Up to date · ${state.imported} game${state.imported === 1 ? '' : 's'} imported`;
  }
}

function renderBackfill(site: CaptureSite, state: BackfillSiteState, settings: ExtensionSettings): void {
  const btn = q<HTMLButtonElement>(`popup-backfill-${site}-btn`);
  const text = q(`popup-backfill-${site}-status`);
  const username = site === 'lichess' ? settings.lichessUsername : settings.chesscomUsername;
  const busy = state.status === 'running' || state.status === 'waiting';
  btn.textContent = busy ? 'Stop' : site === 'lichess' ? 'Lichess' : 'Chess.com';
  btn.setAttribute('data-action', busy ? 'stop' : 'start');
  btn.disabled = !busy && username === '';
  text.textContent = username === '' && !busy ? 'Set your username in Settings first.' : backfillText(state);
}

function syncText(site: CaptureSite, state: AutoSyncSiteState, settings: ExtensionSettings): string {
  if (!settings.autoCapture) return 'Off (automatic capture is off in Settings).';
  const username = site === 'lichess' ? settings.lichessUsername : settings.chesscomUsername;
  if (username === '') return 'Set your username in Settings to check your recent games.';
  if (state.lastRunAt === null) return `Not checked yet. ${state.lastResult.startsWith('Skipped') ? state.lastResult : ''}`.trim();
  return `Checked ${shortTime(state.lastRunAt)} · ${state.lastResult}`;
}

function render(s: StatusReply): void {
  status = s;
  const { pending, ready, delivered } = s.counts;
  const waiting = pending + ready;
  els.counts.textContent =
    waiting === 0
      ? `No games waiting · ${plural(delivered, 'game')} on the analysis site`
      : `${plural(waiting, 'game')} waiting for the analysis site`;
  els.counts.classList.toggle('big', waiting > 0);
  els.counts.title = `Extension v${s.extensionVersion}`;
  els.deliveryText.textContent =
    waiting === 0
      ? 'Every game the extension captured is in the analysis site’s Games list.'
      : `“Waiting” means captured and kept here in the extension, but not yet copied into the analysis site’s Games list. ` +
        `They go there as soon as the site (${s.settings.siteUrl}) is open in a tab.` +
        (delivered > 0 ? ` ${plural(delivered, 'game')} ${delivered === 1 ? 'is' : 'are'} there already.` : '');
  els.pendingText.hidden = pending === 0;
  els.pendingText.textContent =
    pending === 0
      ? ''
      : `${pending === waiting ? (pending === 1 ? 'It isn’t' : 'They aren’t') : `${pending} of them aren’t`} available from Chess.com yet (its archive can lag behind by hours); tried again every 15 min.`;
  els.siteState.textContent = s.siteTabOpen
    ? ready > 0
      ? 'The analysis site is open: sending now.'
      : 'The analysis site is open in a tab.'
    : 'The analysis site isn’t open in any tab.';
  els.siteState.setAttribute('data-open', String(s.siteTabOpen));
  els.openSite.textContent = s.siteTabOpen ? 'Show the analysis site' : 'Open the analysis site';

  renderEntries(s.entries);
  for (const site of ['lichess', 'chesscom'] as const) {
    renderBackfill(site, s.backfill[site], s.settings);
    q(`popup-sync-${site}-status`).textContent = syncText(site, s.autoSync[site], s.settings);
  }
  els.autoSummary.textContent = s.settings.autoCapture
    ? 'On. Games of mine are captured when they end on the page, when I leave a game page, and by checking my recent games every 3 minutes while a Lichess or Chess.com tab is open.'
    : 'Off: only the Save button, links and imports add games. Switch it on in Settings.';
  els.syncNow.disabled = !s.settings.autoCapture || (s.settings.lichessUsername === '' && s.settings.chesscomUsername === '');

  if (s.lastFailure) {
    failureUrl = s.lastFailure.url;
    els.failure.hidden = false;
    els.failureText.textContent = `${s.lastFailure.url} — ${s.lastFailure.error}`;
  } else {
    els.failure.hidden = true;
  }
  document.body.setAttribute('data-loaded', 'true');
}

function fillSettings(settings: ExtensionSettings): void {
  els.lichessUser.value = settings.lichessUsername;
  els.chesscomUser.value = settings.chesscomUsername;
  els.siteUrl.value = settings.siteUrl;
  els.autoCapture.checked = settings.autoCapture;
}

async function refresh(): Promise<void> {
  render(await sendToBackground<StatusReply>({ kind: 'status' }));
}

function describe(results: readonly SaveTextResult[]): { text: string; tone: 'ok' | 'bad' } {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const parts = ok.map((r) => {
    switch (r.outcome) {
      case 'pending':
        return `${r.label}: not in Chess.com's archive yet, will retry`;
      case 'already-delivered':
        return `${r.label}: already on the site`;
      case 'already-queued':
        return `${r.label}: already waiting`;
      default:
        return `Saved ${r.label}`;
    }
  });
  for (const r of bad) parts.push(`${r.label === 'PGN' ? '' : `${r.label}: `}${r.error}`);
  return { text: parts.join(' · ') || 'Nothing to save.', tone: bad.length > 0 && ok.length === 0 ? 'bad' : 'ok' };
}

// --- Debug this tab

/**
 * The tab to debug: the active tab of the popup's window, or `?tab=<id>` when the popup is
 * opened as a page of its own (then its own tab is the active one).
 */
async function targetTab(): Promise<chrome.tabs.Tab | null> {
  const param = new URLSearchParams(location.search).get('tab');
  if (param && /^\d+$/.test(param)) {
    const id = Number(param);
    const all = await chrome.tabs.query({});
    return all.find((t) => t.id === id) ?? { id };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

const STATE_TEXT: Record<string, string> = {
  checking: 'checking…',
  'in-progress': 'in progress',
  finished: 'finished',
  aborted: 'aborted',
  'not-found': 'not found on the site',
};

let lastReport = '';
let debugTarget: { id: number; url: string } | null = null;

function clockTime(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function renderDebug(
  tab: chrome.tabs.Tab | null,
  content: ContentDebugInfo | null,
  contentError: string | null,
  bg: BackgroundDebugInfo | null,
): void {
  const rows: Array<[string, string, ('ok' | 'bad')?]> = [];
  const url = content?.status.url ?? tab?.url ?? '';
  const page = classifyPage(url || undefined);
  rows.push(['Tab', url || '(not a Lichess or Chess.com page: the extension can’t see its address)']);
  if (!content) {
    rows.push([
      'Capture script',
      page
        ? `not running on this tab${contentError ? ` (${contentError})` : ''}. It was probably open before the extension was loaded or updated: reload the tab, or press “Start capture on this tab”.`
        : 'none (it only runs on lichess.org and www.chess.com)',
      page ? 'bad' : undefined,
    ]);
  } else {
    const st = content.status;
    rows.push(['Capture script', `running since ${clockTime(content.scriptStartedAt)} (v${content.extensionVersion})`, 'ok']);
    rows.push([
      'Page',
      st.kind === 'game' ? 'game page' : st.kind === 'play' ? 'play page (no game ID in the URL)' : 'not a game page',
    ]);
    rows.push(['Game ID', st.ref ? `${st.ref.gameId} (from ${st.refSource ?? '?'})` : 'none detected', st.ref ? 'ok' : undefined]);
    rows.push([
      'Game state',
      st.state ? `${STATE_TEXT[st.state] ?? st.state}${st.stateSource ? ` (${st.stateSource})` : ''}` : '—',
    ]);
    if (st.white || st.black) rows.push(['Players', `${st.white ?? '?'} (White) vs ${st.black ?? '?'} (Black)`]);
    if (st.ref) rows.push(['My game', st.mineReason || '—', st.mine === true ? 'ok' : st.mine === false ? undefined : 'bad']);
    if (st.ref) rows.push(['Seen in progress', st.sawInProgress ? 'yes' : 'no']);
    if (st.watching.length > 0) rows.push(['Watching for the end', st.watching.join('; ')]);
    if (st.button) rows.push(['Save button', st.button]);
    const last = content.events[content.events.length - 1];
    rows.push(['Last detection event', last ? `${clockTime(last.at)} ${last.text}` : '—']);
  }
  if (bg) {
    const s = bg.settings;
    rows.push([
      'Settings',
      `automatic capture ${s.autoCapture ? 'on' : 'off'}; Lichess ${s.lichessUsername || '(no username)'}; Chess.com ${s.chesscomUsername || '(no username)'}`,
      s.autoCapture ? undefined : 'bad',
    ]);
    if (bg.sync) {
      const st = bg.sync.state;
      rows.push([
        `${SITE_NAME[bg.sync.site]} check`,
        `${bg.sync.enabled ? 'on' : 'off'}: ${bg.sync.why}. Last check: ${st.lastRunAt ? `${clockTime(st.lastRunAt)}, ${st.lastResult}` : 'none yet.'}`,
        bg.sync.enabled ? undefined : 'bad',
      ]);
    }
    if (bg.tracked) rows.push(['Background sees', `${bg.tracked.url} (${bg.tracked.state ?? 'state unknown'}, updated ${clockTime(bg.tracked.updatedAt)})`]);
    if (content?.status.ref || bg.entry) {
      const e = bg.entry;
      rows.push([
        'This game',
        e
          ? `${STATUS_LABEL[e.status]}; ${e.method ? (METHOD_LABEL[e.method] ?? e.method) : '—'}${e.trigger ? `, ${TRIGGER_LABEL[e.trigger]}` : ''}, captured ${clockTime(e.capturedAt)}`
          : 'not captured',
        e ? 'ok' : undefined,
      ]);
    }
    if (bg.lastLeave) rows.push(['Last game page left', `${clockTime(bg.lastLeave.at)} ${bg.lastLeave.url} → ${bg.lastLeave.result}`]);
    rows.push(['Analysis site', bg.siteTabOpen ? `open in a tab (${s.siteUrl})` : `not open (${s.siteUrl})`]);
  }

  els.debugRows.replaceChildren();
  for (const [label, value, tone] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dd.setAttribute('data-label', label);
    if (tone) dd.setAttribute('data-tone', tone);
    els.debugRows.append(dt, dd);
  }
  els.debugEvents.replaceChildren();
  for (const e of content?.events ?? []) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = clockTime(e.at);
    li.append(time, e.text);
    els.debugEvents.appendChild(li);
  }
  if (!content?.events.length) {
    const li = document.createElement('li');
    li.textContent = 'none';
    els.debugEvents.appendChild(li);
  }
  els.debugOutput.hidden = false;
  els.debugCopy.hidden = false;
  els.debugInject.hidden = !(page && !content && tab?.id !== undefined);
  lastReport = [
    `Wizard's Chess capture — debug report ${new Date().toISOString()}`,
    ...rows.map(([l, v]) => `${l}: ${v}`),
    'Events:',
    ...(content?.events ?? []).map((e) => `  ${clockTime(e.at)} ${e.text}`),
  ].join('\n');
}

async function runDebug(): Promise<void> {
  els.debugBtn.disabled = true;
  setResult(els.debugResult, 'Asking the tab…');
  try {
    const tab = await targetTab();
    let content: ContentDebugInfo | null = null;
    let contentError: string | null = null;
    if (tab?.id !== undefined) {
      try {
        const message: TabRequest = { kind: 'debug-tab' };
        content = (await chrome.tabs.sendMessage<ContentDebugInfo | undefined>(tab.id, message)) ?? null;
      } catch (err) {
        contentError = err instanceof Error ? err.message : String(err);
      }
    }
    const url = content?.status.url ?? tab?.url ?? null;
    debugTarget = tab?.id !== undefined && url ? { id: tab.id, url } : null;
    const bg = await sendToBackground<BackgroundDebugInfo>({ kind: 'debug-background', tabId: tab?.id ?? null, url });
    renderDebug(tab, content, contentError, bg);
    setResult(els.debugResult, '');
  } catch (err) {
    setResult(els.debugResult, err instanceof Error ? err.message : String(err), 'bad');
  } finally {
    els.debugBtn.disabled = false;
  }
}

els.debugBtn.addEventListener('click', () => void runDebug());

els.debugCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(lastReport).then(
    () => setResult(els.debugResult, 'Copied.', 'ok'),
    () => setResult(els.debugResult, 'Couldn’t copy: select the text below instead.', 'bad'),
  );
});

els.debugInject.addEventListener('click', () => {
  if (!debugTarget) return;
  els.debugInject.disabled = true;
  void sendToBackground<{ ok: boolean; error?: string }>({ kind: 'inject-tab', tabId: debugTarget.id, url: debugTarget.url })
    .then(async (reply) => {
      if (!reply.ok) {
        setResult(els.debugResult, reply.error ?? 'Couldn’t start it.', 'bad');
        return;
      }
      // Give the script a moment to read the page
      await new Promise((r) => setTimeout(r, 800));
      await runDebug();
    })
    .finally(() => {
      els.debugInject.disabled = false;
    });
});

// --- Other controls

els.openSite.addEventListener('click', () => {
  const siteUrl = status?.settings.siteUrl;
  if (!siteUrl) return;
  void chrome.tabs.query({ url: siteMatchPattern(siteUrl) }).then(async (tabs) => {
    const tab = tabs[0];
    if (tab?.id !== undefined) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: `${siteUrl}/#games` });
    }
  });
});

els.syncNow.addEventListener('click', () => {
  els.syncNow.disabled = true;
  setResult(els.syncResult, 'Checking…');
  void sendToBackground<{ ok: boolean; states: Partial<Record<CaptureSite, AutoSyncSiteState | null>> }>({ kind: 'sync-now' })
    .then(async (reply) => {
      const parts = (['lichess', 'chesscom'] as const)
        .map((site) => (reply.states[site] ? `${SITE_NAME[site]}: ${reply.states[site]!.lastResult}` : null))
        .filter(Boolean);
      setResult(els.syncResult, parts.join(' · ') || 'Nothing to check: set a username in Settings.', 'ok');
      await refresh();
    })
    .finally(() => {
      els.syncNow.disabled = false;
    });
});

els.save.addEventListener('click', () => {
  const text = els.paste.value;
  if (text.trim() === '') {
    setResult(els.result, 'Paste a link or a PGN first.', 'bad');
    return;
  }
  els.save.disabled = true;
  setResult(els.result, 'Saving…');
  void sendToBackground<SaveTextResult[]>({ kind: 'save-text', text })
    .then((results) => {
      const { text: msg, tone } = describe(results);
      setResult(els.result, msg, tone);
      if (tone === 'ok') els.paste.value = '';
      return refresh();
    })
    .finally(() => {
      els.save.disabled = false;
    });
});

els.failureUse.addEventListener('click', () => {
  els.paste.value = failureUrl;
  els.paste.focus();
  void sendToBackground({ kind: 'dismiss-failure' }).then(refresh);
});
els.failureDismiss.addEventListener('click', () => {
  void sendToBackground({ kind: 'dismiss-failure' }).then(refresh);
});

for (const site of ['lichess', 'chesscom'] as const) {
  const btn = q<HTMLButtonElement>(`popup-backfill-${site}-btn`);
  btn.addEventListener('click', () => {
    const kind = btn.getAttribute('data-action') === 'stop' ? 'backfill-stop' : 'backfill-start';
    btn.disabled = true;
    void sendToBackground<{ ok: boolean; error?: string }>({ kind, site }).then(async (reply) => {
      await refresh();
      if (!reply.ok && reply.error) q(`popup-backfill-${site}-status`).textContent = reply.error;
    });
  });
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const settings: ExtensionSettings = {
    lichessUsername: els.lichessUser.value,
    chesscomUsername: els.chesscomUser.value,
    siteUrl: els.siteUrl.value,
    autoCapture: els.autoCapture.checked,
  };
  void sendToBackground<SaveSettingsReply>({ kind: 'save-settings', settings }).then((reply) => {
    if (reply.ok) {
      fillSettings(reply.settings);
      setResult(els.settingsResult, 'Saved.', 'ok');
      void refresh();
    } else {
      setResult(els.settingsResult, reply.problem.message, 'bad');
    }
  });
});

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local' || refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 300);
});

void sendToBackground<StatusReply>({ kind: 'status' }).then((s) => {
  fillSettings(s.settings);
  render(s);
  if (status?.lastFailure && els.paste.value === '') els.paste.placeholder = `For example: ${status.lastFailure.url}`;
});
