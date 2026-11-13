import { isStartPageOf, pageAppName, startIndexHtml } from '../scripts/lib/start-pages.mjs';
import { startPath } from './preset/start-path';

/**
 * First-run links in the service worker (sw.ts): which page answers a navigation to `/start/<slug>/`.
 *
 * The host serves each link a page of its own: the app's page with the link's manifest (whose `start_url` is the
 * link) and the preset's name. An install reads that page as it arrives, so the worker must answer with it as well;
 * with the app's plain page, an iPhone's Home Screen app would start at "/" in its own empty storage and never be
 * set up.
 *
 * The worker cannot list the links: a personal link's name is its only secret, and sw.js is public. It learns a link
 * when somebody opens it: the host is asked once, and if the answer is that link's own page, the link's name and app
 * name are remembered. From then on the worker writes the page itself, from this build's cached page and with the
 * build's own function, so it needs no network and always matches the files this build cached.
 *
 * Everything here is logic only: the caches and the network are sw.ts's, passed in as a LinkStore.
 */

/** The cache the links are remembered in: apart from the build's files, so an update of the app keeps them. */
export const LINKS_CACHE = 'wizards-chess-links-v1';

/** How long the host gets to answer for a link the worker does not know yet, before the plain page is served. */
export const LINK_TIMEOUT_MS = 5000;

const APP_NAME_MAX = 30;

/** What is remembered about a link: its name, and the app name its preset gives ('' when it gives none). */
export interface LinkRecord {
  slug: string;
  appName: string;
}

/** The address a link's record is kept under in LINKS_CACHE (a cache keeps responses by address). */
export function linkRecordUrl(scope: string, slug: string): string {
  return new URL(`${startPath(slug)}link.json`, scope).href;
}

export function linkRecordText(link: LinkRecord): string {
  return JSON.stringify({ appName: link.appName });
}

export function readLinkRecord(slug: string, text: string): LinkRecord | null {
  try {
    const value = JSON.parse(text) as { appName?: unknown } | null;
    if (!value || typeof value.appName !== 'string') return null;
    return { slug, appName: [...value.appName].slice(0, APP_NAME_MAX).join('') };
  } catch {
    return null;
  }
}

/**
 * What a page from the host says about a link: its record when the page is that link's own; null when it is anything
 * else (a host answers an address it does not know with the app's plain page).
 */
export function linkFromPage(slug: string, html: string, plainHtml: string): LinkRecord | null {
  if (!isStartPageOf(html, slug)) return null;
  const name = pageAppName(html);
  // A preset that names no app leaves the app's own name on the page
  return { slug, appName: name === pageAppName(plainHtml) ? '' : name };
}

/** The link's page, written from this build's plain page as the build writes it; null if that page changed shape. */
export function linkPage(plainHtml: string, link: LinkRecord): string | null {
  try {
    return startIndexHtml(plainHtml, link.slug, link.appName);
  } catch {
    return null;
  }
}

/** The worker's caches and network, as far as links need them. */
export interface LinkStore {
  /** This build's plain page (the cached index.html); null when it is not in the cache. */
  plainPage(): Promise<string | null>;
  recall(slug: string): Promise<LinkRecord | null>;
  remember(link: LinkRecord): Promise<void>;
  /** The page the host serves at the link; null when there is no answer (offline, too slow, an error status). */
  hostPage(slug: string): Promise<string | null>;
}

/**
 * The page that answers `/start/<slug>/`, or null for the app's plain page (an unknown link, or one not seen yet
 * while the host cannot be reached). A known link costs no request; an unknown one is asked for every time, so a
 * link that is published later is found.
 */
export async function pageForLink(slug: string, store: LinkStore): Promise<string | null> {
  const plain = await store.plainPage();
  if (plain === null) return null;
  let link = await store.recall(slug);
  if (!link) {
    const served = await store.hostPage(slug);
    link = served === null ? null : linkFromPage(slug, served, plain);
    if (!link) return null;
    // A full or blocked cache only means the host is asked again next time
    await store.remember(link).catch(() => undefined);
  }
  return linkPage(plain, link);
}
