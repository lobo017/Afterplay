/**
 * Which build of the app is running, as a short text: the file name of the entry script the page was loaded with
 * (`/assets/index-<hash>.js`). Vite names a chunk by a hash of its content and of the chunks it imports, so the name
 * changes with any code change, and it needs no build step of its own.
 *
 * Fails closed: a page that was not loaded from a built entry script (the dev server, an unknown layout, no document)
 * has no build id, and whatever depends on one then does nothing. Never throws.
 */

/** The entry script of a built page: the hashed `index-*.js` in the site's `assets` folder. */
const ENTRY_SCRIPT = /^\/assets\/(index-[A-Za-z0-9_-]{6,40})\.js$/;

/** The build id of a script address (absolute, or relative to `base`), or null when it is not the built entry script. */
export function buildIdFromScriptUrl(src: string, base = 'file:///'): string | null {
  try {
    const match = ENTRY_SCRIPT.exec(new URL(src, base).pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The running build's id, read from the page's module scripts; null when it cannot be told. */
export function runningBuildId(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): string | null {
  try {
    if (!doc) return null;
    for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))) {
      const id = buildIdFromScriptUrl(script.getAttribute('src') ?? '', doc.baseURI);
      if (id) return id;
    }
    return null;
  } catch {
    return null;
  }
}
