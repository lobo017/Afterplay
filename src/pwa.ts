/**
 * Registers the app's service worker (src/sw.ts) and reports what it is doing: whether the app
 * is cached for offline use, and when a newer build is waiting.
 *
 * Updates: when a newer build is waiting (found at launch, or when the app comes back to the
 * front: a home-screen app on a phone resumes rather than relaunches, so that is when it looks),
 * it is applied by itself if nothing is in progress (ui/activity.ts) and the page has not been
 * touched for a moment. Otherwise the "new version" banner shows, and the build waits for Reload.
 */
import { activitiesInProgress } from './ui/activity';

declare global {
  interface Window {
    /** Test hook: what the update flow would wait for now (ui/activity.ts). */
    __wizardChessUpdate?: { inProgress: () => string[] };
  }
}

export type OfflineState =
  /** Not a production build, or the browser has no service workers. */
  | { kind: 'unavailable'; reason: string }
  /** The worker is installing, or still caching the files. */
  | { kind: 'caching' }
  /** Every file of the build is cached: the app runs with no network. */
  | { kind: 'ready'; files: number }
  /** Registration or caching failed. */
  | { kind: 'failed'; message: string };

export function describeOffline(state: OfflineState): string {
  switch (state.kind) {
    case 'unavailable':
      return state.reason;
    case 'caching':
      return 'Caching the app for offline use…';
    case 'ready':
      return `Ready: all ${state.files} files are cached`;
    case 'failed':
      return `Not available: ${state.message}`;
  }
}

type StatusReply = { type: 'STATUS'; files: number; cached: number };

const listeners = new Set<(state: OfflineState) => void>();
const updateListeners = new Set<(waiting: boolean) => void>();
let current: OfflineState = { kind: 'unavailable', reason: 'Only in the built app (npm run build, npm run serve)' };
let registration: ServiceWorkerRegistration | null = null;

function set(state: OfflineState): void {
  current = state;
  for (const l of listeners) l(state);
}

/** The offline state now, and again whenever it changes. */
export function watchOffline(listener: (state: OfflineState) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

/** Called with true when a newer build is installed and waiting to take over. */
export function watchUpdate(listener: (waiting: boolean) => void): () => void {
  updateListeners.add(listener);
  if (registration?.waiting) listener(true);
  return () => updateListeners.delete(listener);
}

/** How long the page must have been left alone before an update reloads it by itself. */
export const UPDATE_QUIET_MS = 2000;
/** At most one update check per this long when the app keeps coming back to the front. */
const UPDATE_CHECK_INTERVAL_MS = 60_000;

let lastInputAt = -Infinity;
let quietTimer: ReturnType<typeof setTimeout> | null = null;
let lastCheckAt = -Infinity;

function showBanner(): void {
  for (const l of updateListeners) l(true);
}

/** A newer build is waiting: take it now if nothing would be lost, otherwise leave it to the banner. */
function announceUpdate(): void {
  if (!registration?.waiting) return;
  if (activitiesInProgress().length > 0) {
    showBanner();
    return;
  }
  const quietFor = performance.now() - lastInputAt;
  if (quietFor >= UPDATE_QUIET_MS) {
    applyUpdate();
    return;
  }
  // The user is tapping around right now: decide again once they pause
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    quietTimer = null;
    announceUpdate();
  }, UPDATE_QUIET_MS - quietFor);
}

/** Asks the server for a newer build (no-op when offline, or when it asked a moment ago). */
function checkForUpdate(): void {
  if (!registration || performance.now() - lastCheckAt < UPDATE_CHECK_INTERVAL_MS) return;
  lastCheckAt = performance.now();
  void registration.update().catch(() => undefined);
}

/** Asks the worker how many of the build's files are cached. */
function askStatus(): void {
  const worker = navigator.serviceWorker.controller ?? registration?.active;
  worker?.postMessage({ type: 'STATUS' });
}

/** Lets the waiting build take over and reloads into it. */
let applying = false;

export function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting || applying) return;
  applying = true;
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

const ISOLATION_RELOAD_KEY = 'wc-isolation-reload';

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    set({ kind: 'unavailable', reason: 'This browser has no service workers' });
    return;
  }
  if (!import.meta.env.PROD) return;
  set({ kind: 'caching' });
  window.__wizardChessUpdate = { inProgress: activitiesInProgress };

  const noteInput = (): void => {
    lastInputAt = performance.now();
  };
  window.addEventListener('pointerdown', noteInput, { capture: true, passive: true });
  window.addEventListener('keydown', noteInput, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Coming back to the front counts as a launch: a build that waited may go in now, and a newer one may exist
    if (registration?.waiting && navigator.serviceWorker.controller) announceUpdate();
    checkForUpdate();
  });

  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<StatusReply>) => {
    if (e.data?.type !== 'STATUS') return;
    set(e.data.cached >= e.data.files ? { kind: 'ready', files: e.data.files } : { kind: 'caching' });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    askStatus();
    // A page that was not sent with isolation headers (a plain static host) gets them once the worker serves it
    if (!window.crossOriginIsolated && !sessionStorage.getItem(ISOLATION_RELOAD_KEY)) {
      sessionStorage.setItem(ISOLATION_RELOAD_KEY, '1');
      window.location.reload();
    }
  });

  const start = (): void => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        registration = reg;
        // The browser checks for a newer worker on this load; resumes check again (above)
        lastCheckAt = performance.now();
        const watch = (worker: ServiceWorker | null): void => {
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) announceUpdate();
            if (worker.state === 'activated') askStatus();
            if (worker.state === 'redundant')
              set({ kind: 'failed', message: 'the worker could not install (is the network up?)' });
          });
        };
        watch(reg.installing);
        reg.addEventListener('updatefound', () => watch(reg.installing));
        if (reg.waiting && navigator.serviceWorker.controller) announceUpdate();
        if (reg.active) askStatus();
        void navigator.serviceWorker.ready.then(askStatus);
      })
      .catch((err: unknown) => set({ kind: 'failed', message: err instanceof Error ? err.message : String(err) }));
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
