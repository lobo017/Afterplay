/**
 * Registers the app's service worker (src/sw.ts) and reports what it is doing: whether the app
 * is cached for offline use, and when a newer build is waiting.
 */

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

function announceUpdate(): void {
  for (const l of updateListeners) l(true);
}

/** Asks the worker how many of the build's files are cached. */
function askStatus(): void {
  const worker = navigator.serviceWorker.controller ?? registration?.active;
  worker?.postMessage({ type: 'STATUS' });
}

/** Lets the waiting build take over and reloads into it. */
export function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting) return;
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
