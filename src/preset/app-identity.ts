import { startManifestUrl } from './preset';

/**
 * What the browser and the Home Screen call the app: the page title, the iOS Home Screen title, and which manifest
 * an install reads. A first-run link's own manifest carries the preset's name and starts the installed app at the
 * link (see first-run.ts); the page served for the link already has all three, and this keeps them right when the
 * service worker serves the plain app page instead.
 *
 * Without an app name the page's own title and Home Screen title are left exactly as the page came (and put back
 * if a name is taken away again).
 */
const pageDefaults = new WeakMap<Document, { title: string; appleTitle: string | null }>();

export function applyAppIdentity(doc: Document, appName: string, appliedSlug: string | null): void {
  const appleTitle = doc.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
  let defaults = pageDefaults.get(doc);
  if (!defaults) {
    if (!appName && !appliedSlug) return;
    defaults = { title: doc.title, appleTitle: appleTitle?.content ?? null };
    pageDefaults.set(doc, defaults);
  }
  const title = appName || defaults.title;
  if (doc.title !== title) doc.title = title;
  const apple = appName || defaults.appleTitle;
  if (appleTitle && apple !== null && appleTitle.content !== apple) appleTitle.content = apple;
  const manifest = doc.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (manifest && appliedSlug) {
    const href = startManifestUrl(appliedSlug);
    if (manifest.getAttribute('href') !== href) manifest.setAttribute('href', href);
  }
}
