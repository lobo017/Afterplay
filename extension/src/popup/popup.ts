import type { CaptureSite } from '../../../src/capture/game-id';
import type { BackfillSiteState } from '../backfill';
import { sendToBackground } from '../chrome-store';
import type { SaveSettingsReply, SaveTextResult, StatusReply } from '../messages';
import type { QueueEntry } from '../queue';
import type { ExtensionSettings } from '../settings';

const q = <T extends HTMLElement>(id: string) => document.querySelector(`[data-testid="${id}"]`) as T;

const els = {
  counts: q('popup-counts'),
  failure: q('popup-failure'),
  failureText: q('popup-failure-text'),
  failureUse: q<HTMLButtonElement>('popup-failure-use'),
  failureDismiss: q<HTMLButtonElement>('popup-failure-dismiss'),
  paste: q<HTMLTextAreaElement>('popup-paste'),
  save: q<HTMLButtonElement>('popup-save'),
  result: q('popup-result'),
  entries: q<HTMLUListElement>('popup-entries'),
  form: q<HTMLFormElement>('popup-settings-form'),
  settingsResult: q('popup-settings-result'),
  lichessUser: q<HTMLInputElement>('popup-lichess-user'),
  chesscomUser: q<HTMLInputElement>('popup-chesscom-user'),
  siteUrl: q<HTMLInputElement>('popup-site-url'),
  autoCapture: q<HTMLInputElement>('popup-auto-capture'),
};

let status: StatusReply | null = null;
let failureUrl = '';

const SITE_BADGE: Record<QueueEntry['source'], { label: string; title: string }> = {
  lichess: { label: 'L', title: 'Lichess' },
  chesscom: { label: 'C', title: 'Chess.com' },
  paste: { label: 'P', title: 'Pasted PGN' },
};

const STATUS_LABEL: Record<QueueEntry['status'], string> = {
  pending: 'pending',
  ready: 'waiting for site',
  delivered: 'on the site',
};

function setResult(el: HTMLElement, text: string, tone: 'ok' | 'bad' | 'info' = 'info'): void {
  el.textContent = text;
  el.setAttribute('data-tone', tone);
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
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
    const site = document.createElement('span');
    site.className = `site site-${e.source}`;
    site.textContent = SITE_BADGE[e.source].label;
    site.title = SITE_BADGE[e.source].title;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = e.white || e.black ? `${e.white || '?'} vs ${e.black || '?'}` : (e.url ?? e.key);
    const sub = document.createElement('small');
    sub.textContent = [e.result, e.date, timeAgo(e.capturedAt), e.status === 'pending' ? e.error : null]
      .filter(Boolean)
      .join(' · ');
    who.appendChild(sub);
    const st = document.createElement('span');
    st.className = `status status-${e.status}`;
    st.textContent = STATUS_LABEL[e.status];
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

function render(s: StatusReply): void {
  status = s;
  const waiting = s.counts.pending + s.counts.ready;
  els.counts.textContent = `${waiting} waiting · ${s.counts.delivered} on the site · v${s.extensionVersion}`;
  renderEntries(s.entries);
  for (const site of ['lichess', 'chesscom'] as const) renderBackfill(site, s.backfill[site], s.settings);

  if (s.lastFailure) {
    failureUrl = s.lastFailure.url;
    els.failure.hidden = false;
    els.failureText.textContent = `${s.lastFailure.url} — ${s.lastFailure.error}`;
  } else {
    els.failure.hidden = true;
  }
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
    void sendToBackground({ kind, site }).then(refresh);
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

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void refresh();
});

void sendToBackground<StatusReply>({ kind: 'status' }).then((s) => {
  fillSettings(s.settings);
  render(s);
  if (status?.lastFailure && els.paste.value === '') els.paste.placeholder = `For example: ${status.lastFailure.url}`;
});
