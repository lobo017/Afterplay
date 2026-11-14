/**
 * The addresses of a first-run link (first-run.ts): `/start/<slug>/`, with its preset and manifest beside the page.
 * On its own, with no imports, because the service worker reads these too (sw-links.ts).
 */

/** Where first-run links live: `/start/<slug>/`, with the preset beside the page. */
export const START_PATH_PREFIX = '/start/';

/** A link's name: 3–64 lower-case letters, digits and hyphens (a personal one is long and random). */
export const START_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** The slug of a first-run link's path (`/start/abc`, `/start/abc/`, `/start/abc/index.html`), or null. */
export function startSlugFromPath(pathname: string): string | null {
  if (!pathname.startsWith(START_PATH_PREFIX)) return null;
  const parts = pathname.slice(START_PATH_PREFIX.length).split('/');
  const slug = parts[0] ?? '';
  const rest = parts.slice(1).join('/');
  if (rest !== '' && rest !== 'index.html') return null;
  return START_SLUG_PATTERN.test(slug) ? slug : null;
}

export const startPath = (slug: string): string => `${START_PATH_PREFIX}${slug}/`;
export const presetUrl = (slug: string): string => `${START_PATH_PREFIX}${slug}/preset.json`;
export const startManifestUrl = (slug: string): string => `${START_PATH_PREFIX}${slug}/manifest.webmanifest`;
/** A link's optional game history, beside its preset (first-run.ts, story/history-loader.ts). */
export const historyUrl = (slug: string): string => `${START_PATH_PREFIX}${slug}/history.json`;
