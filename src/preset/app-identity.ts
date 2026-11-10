import { startManifestUrl } from './preset';
import { DEFAULT_APP_NAME } from './profile';

/**
 * What the browser and the Home Screen call the app: the page title, the iOS Home Screen title, and which manifest
 * an install reads. A first-run link's own manifest carries the preset's name and starts the installed app at the
 * link (see first-run.ts); the page served for the link already has all three, and this keeps them right when the
 * service worker serves the plain app page instead.
 */
export function applyAppIdentity(doc: Document, appName: string, appliedSlug: string | null): void {
  const name = appName || DEFAULT_APP_NAME;
  if (doc.title !== name) doc.title = name;
  const appleTitle = doc.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
  if (appleTitle && appleTitle.content !== name) appleTitle.content = name;
  const manifest = doc.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (manifest && appliedSlug) {
    const href = startManifestUrl(appliedSlug);
    if (manifest.getAttribute('href') !== href) manifest.setAttribute('href', href);
  }
}
