// First-run links (/start/<slug>/, src/preset/first-run.ts): the page and the manifest written beside each preset.
// Pure functions, shared by scripts/build-start-pages.mjs and its unit test.

/** The same rule as START_SLUG_PATTERN in src/preset/preset.ts. */
export const START_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const APP_NAME_MAX = 30;

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The preset's app name ('' when it names none); throws when the text is not a version 1 preset. */
export function presetAppName(presetText) {
  let preset;
  try {
    preset = JSON.parse(presetText);
  } catch {
    throw new Error('preset.json is not JSON');
  }
  if (!preset || typeof preset !== 'object' || Array.isArray(preset) || preset.version !== 1) {
    throw new Error('preset.json is not a version 1 preset');
  }
  if (typeof preset.appName !== 'string') return '';
  return [...preset.appName.replace(/\s+/g, ' ').trim()].slice(0, APP_NAME_MAX).join('').trim();
}

/**
 * The link's manifest: the app's own, started at the link (an iPhone's Home Screen app has its own empty storage,
 * so it has to open the link again to be set up) and named as the preset says.
 */
export function startManifest(baseManifestText, slug, appName) {
  if (!START_SLUG_PATTERN.test(slug)) throw new Error(`"${slug}" is not a valid link name`);
  const manifest = JSON.parse(baseManifestText);
  manifest.start_url = `/start/${slug}/`;
  if (appName) {
    manifest.name = appName;
    manifest.short_name = appName;
  }
  return `${JSON.stringify(manifest)}\n`;
}

/** Replaces exactly one match, or throws: a build whose page changed shape must not pass silently. */
function replaceOnce(html, pattern, replacement, what) {
  const matches = html.match(new RegExp(pattern.source, 'g'));
  if (!matches || matches.length !== 1) throw new Error(`index.html: expected one ${what}`);
  return html.replace(pattern, () => replacement);
}

/** The link's page: the app's page with the link's manifest, the preset's name, and kept out of search results. */
export function startIndexHtml(indexHtml, slug, appName) {
  if (!START_SLUG_PATTERN.test(slug)) throw new Error(`"${slug}" is not a valid link name`);
  let html = replaceOnce(
    indexHtml,
    /<link rel="manifest" href="[^"]*"\s*\/?>/,
    `<link rel="manifest" href="/start/${slug}/manifest.webmanifest">`,
    'manifest link',
  );
  if (appName) {
    const name = escapeHtml(appName);
    html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${name}</title>`, 'title');
    html = replaceOnce(
      html,
      /<meta name="apple-mobile-web-app-title" content="[^"]*"\s*\/?>/,
      `<meta name="apple-mobile-web-app-title" content="${name}" />`,
      'apple-mobile-web-app-title',
    );
  }
  return replaceOnce(html, /<head>/, '<head>\n    <meta name="robots" content="noindex" />', '<head>');
}
