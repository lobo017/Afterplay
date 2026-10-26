/// <reference lib="webworker" />
/**
 * The app's one service worker: it makes the site work with no network at all, and it keeps the
 * page cross-origin isolated (COOP/COEP) when it serves it, so the multi-threaded engine works
 * offline and in the installed app, where no server sends those headers.
 *
 * - Install: every file of the build (the list is injected by vite-plugin-pwa) goes into a
 *   cache. Hashed files are fetched once; the few un-hashed ones are re-fetched when their
 *   revision changes. Nothing else is ever cached, and nothing is requested at runtime.
 * - Fetch: a precached file comes from the cache; a page navigation (the app uses hash routes)
 *   gets index.html. Whatever is served from the same origin gets the isolation headers.
 * - Update: a new worker waits until the page says to take over (`SKIP_WAITING`, from the
 *   "Update ready" banner), so an open game is never reloaded under its player. The first
 *   install takes over at once.
 */

interface PrecacheEntry {
  url: string;
  revision: string | null;
}

const sw = self as unknown as ServiceWorkerGlobalScope;
const manifest = (self as unknown as { __WB_MANIFEST: Array<PrecacheEntry | string> }).__WB_MANIFEST.map(
  (e): PrecacheEntry => (typeof e === 'string' ? { url: e, revision: null } : e),
);

const CACHE = 'wizards-chess-precache-v1';

/** The cache key of an entry: its URL, plus its revision when the URL is not hashed. */
function keyOf(entry: PrecacheEntry): string {
  const url = new URL(entry.url, sw.registration.scope);
  if (entry.revision) url.searchParams.set('__rev', entry.revision);
  return url.href;
}

const byPath = new Map<string, string>();
for (const entry of manifest) byPath.set(new URL(entry.url, sw.registration.scope).pathname, keyOf(entry));
const INDEX = byPath.get(new URL('index.html', sw.registration.scope).pathname);

/** Adds the isolation headers (what `npm run serve` sends) to a same-origin response. */
function isolated(response: Response): Response {
  if (response.status === 0 || response.type === 'opaque' || response.type === 'error') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function precache(): Promise<void> {
  const cache = await caches.open(CACHE);
  for (const entry of manifest) {
    const key = keyOf(entry);
    if (await cache.match(key)) continue;
    const response = await fetch(new URL(entry.url, sw.registration.scope).href, { cache: 'reload' });
    if (!response.ok) throw new Error(`${entry.url}: ${response.status}`);
    await cache.put(key, response);
  }
}

/** What this build doesn't list goes (older builds' files); only once nothing is running on them. */
async function dropOldFiles(): Promise<void> {
  const cache = await caches.open(CACHE);
  const wanted = new Set(manifest.map(keyOf));
  for (const request of await cache.keys()) {
    if (!wanted.has(request.url)) await cache.delete(request);
  }
}

sw.addEventListener('install', (event) => {
  event.waitUntil(
    precache().then(() => {
      // The first install has nobody to disturb; an update waits for the page to say so
      if (!sw.registration.active) return sw.skipWaiting();
      return undefined;
    }),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([dropOldFiles(), sw.clients.claim()]));
});

sw.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === 'SKIP_WAITING') void sw.skipWaiting();
  if (data?.type === 'STATUS') {
    void caches.open(CACHE).then(async (cache) => {
      let cached = 0;
      for (const entry of manifest) if (await cache.match(keyOf(entry))) cached++;
      event.source?.postMessage({ type: 'STATUS', files: manifest.length, cached });
    });
  }
});

sw.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith(
    (async () => {
      let key = byPath.get(url.pathname);
      // The app's pages: "/", and its hash routes (everything without a file extension)
      if (!key && request.mode === 'navigate' && !/\.[a-z0-9]+$/i.test(url.pathname)) key = INDEX;
      if (url.pathname === '/') key = INDEX;
      if (key) {
        const hit = await (await caches.open(CACHE)).match(key);
        if (hit) return isolated(hit);
      }
      try {
        return isolated(await fetch(request));
      } catch (err) {
        // Offline and not cached: say so plainly rather than a browser error page
        if (request.mode === 'navigate') {
          return new Response('Wizard’s Chess is offline and this page is not in its cache.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
        throw err;
      }
    })(),
  );
});
