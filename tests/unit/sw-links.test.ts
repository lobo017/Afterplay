import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isStartPageOf, pageAppName, startIndexHtml } from '../../scripts/lib/start-pages.mjs';
import { startPath, startSlugFromPath } from '../../src/preset/start-path';
import {
  LINKS_CACHE,
  linkFromPage,
  linkPage,
  linkRecordText,
  linkRecordUrl,
  pageForLink,
  readLinkRecord,
  type LinkRecord,
  type LinkStore,
} from '../../src/sw-links';

// The service worker's answer to a first-run link (src/sw-links.ts): the link's own page on every visit, written from
// the build's cached page, for links it can only learn when somebody opens them.
const PLAIN = `<!doctype html>
<html lang="en">
  <head>
    <meta name="apple-mobile-web-app-title" content="Afterplay" />
    <title>Afterplay</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  <link rel="manifest" href="/manifest.webmanifest"></head>
  <body><div id="app"></div></body>
</html>`;
/** The same page from a later build: other file names. */
const PLAIN_NEXT_BUILD = PLAIN.replace('index-abc.js', 'index-xyz.js');
const NAMES = ["Ada's Chess", 'Tom & "Jerry" <3', 'Grace &amp; Co', 'Schach für Ada', ''];

/** A LinkStore over plain maps, with the host's pages by slug and a log of what was asked of the host. */
function fakeStore(options: { plain?: string | null; host?: Record<string, string | null>; known?: LinkRecord[] }) {
  const records = new Map<string, LinkRecord>((options.known ?? []).map((link) => [link.slug, link]));
  const asked: string[] = [];
  const store: LinkStore = {
    plainPage: () => Promise.resolve(options.plain === undefined ? PLAIN : options.plain),
    recall: (slug) => Promise.resolve(records.get(slug) ?? null),
    remember: (link) => {
      records.set(link.slug, link);
      return Promise.resolve();
    },
    hostPage: (slug) => {
      asked.push(slug);
      return Promise.resolve(options.host?.[slug] ?? null);
    },
  };
  return { store, records, asked };
}

describe('Service worker — reading a link from the page the host serves', () => {
  it("knows a link's own page by its manifest, and reads the name the build wrote", () => {
    for (const name of NAMES) {
      const page = startIndexHtml(PLAIN, 'sample', name);
      expect(isStartPageOf(page, 'sample'), name).toBe(true);
      expect(pageAppName(page), name).toBe(name || 'Afterplay');
      expect(linkFromPage('sample', page, PLAIN), name).toEqual({ slug: 'sample', appName: name });
    }
  });

  it("is not fooled by the app's plain page, another link's page, or a name that is not a link's", () => {
    // A host answers an address it does not know with the plain page
    expect(linkFromPage('no-such-link', PLAIN, PLAIN)).toBeNull();
    expect(linkFromPage('other', startIndexHtml(PLAIN, 'sample', 'A'), PLAIN)).toBeNull();
    expect(linkFromPage('sample', '', PLAIN)).toBeNull();
    expect(linkFromPage('sample', 'Not Found', PLAIN)).toBeNull();
    expect(isStartPageOf(startIndexHtml(PLAIN, 'sample', 'A'), '../sample')).toBe(false);
    expect(
      isStartPageOf(PLAIN.replace('/manifest.webmanifest', '/start/Bad Slug/manifest.webmanifest'), 'Bad Slug'),
    ).toBe(false);
  });

  it('a link read from a newer build’s page is the same link', () => {
    // The host already serves the next build while this worker still has the old one cached
    const served = startIndexHtml(PLAIN_NEXT_BUILD, 'sample', "Ada's Chess");
    expect(linkFromPage('sample', served, PLAIN)).toEqual({ slug: 'sample', appName: "Ada's Chess" });
  });
});

describe('Service worker — writing a link’s page from the cached build', () => {
  it('writes exactly the page the build writes, for every kind of name', () => {
    for (const name of NAMES) {
      const built = startIndexHtml(PLAIN, 'sample', name);
      const link = linkFromPage('sample', built, PLAIN)!;
      expect(linkPage(PLAIN, link), name).toBe(built);
      // After an update of the app: the new build's page, not the one the link was learned from
      expect(linkPage(PLAIN_NEXT_BUILD, link), name).toBe(startIndexHtml(PLAIN_NEXT_BUILD, 'sample', name));
    }
  });

  it('the real page of this app can be rewritten', () => {
    // index.html as the build takes it in (vite adds the manifest link; the build step and the worker replace it)
    const index = fs
      .readFileSync('index.html', 'utf8')
      .replace('</head>', '<link rel="manifest" href="/manifest.webmanifest"></head>');
    const page = linkPage(index, { slug: 'sample', appName: "Ada's Chess" })!;
    expect(page).toContain('<link rel="manifest" href="/start/sample/manifest.webmanifest">');
    expect(page).toContain("<title>Ada's Chess</title>");
    expect(linkFromPage('sample', page, index)).toEqual({ slug: 'sample', appName: "Ada's Chess" });
  });

  it('gives up (the plain page is served) when the cached page is not the shape it rewrites', () => {
    expect(
      linkPage(PLAIN.replace('<link rel="manifest" href="/manifest.webmanifest">', ''), { slug: 's-1', appName: 'A' }),
    ).toBeNull();
    expect(linkPage(PLAIN, { slug: 'Bad Slug', appName: 'A' })).toBeNull();
  });
});

describe('Service worker — which page answers /start/<slug>/', () => {
  const samplePage = startIndexHtml(PLAIN, 'sample', "Ada's Chess");

  it('a link it knows: its page from the cache, and the host is not asked', async () => {
    const { store, asked } = fakeStore({ known: [{ slug: 'sample', appName: "Ada's Chess" }] });
    expect(await pageForLink('sample', store)).toBe(samplePage);
    expect(asked).toEqual([]);
  });

  it('a link it has not seen: the host is asked once, the link is remembered, and its page is this build’s', async () => {
    const hostPage = startIndexHtml(PLAIN_NEXT_BUILD, 'sample', "Ada's Chess");
    const { store, records, asked } = fakeStore({ host: { sample: hostPage } });
    expect(await pageForLink('sample', store)).toBe(samplePage);
    expect(records.get('sample')).toEqual({ slug: 'sample', appName: "Ada's Chess" });
    // The next visit, and one with no network
    expect(await pageForLink('sample', store)).toBe(samplePage);
    expect(asked).toEqual(['sample']);
  });

  it('an unknown link: the plain page, nothing remembered, and the host is asked again next time', async () => {
    const { store, records, asked } = fakeStore({ host: { 'no-such-link': PLAIN } });
    expect(await pageForLink('no-such-link', store)).toBeNull();
    expect(await pageForLink('no-such-link', store)).toBeNull();
    expect(records.size).toBe(0);
    expect(asked).toEqual(['no-such-link', 'no-such-link']);
  });

  it('a link not seen yet with no answer from the host (offline, too slow): the plain page, nothing remembered', async () => {
    const { store, records } = fakeStore({ host: { sample: null } });
    expect(await pageForLink('sample', store)).toBeNull();
    expect(records.size).toBe(0);
  });

  it('a link is still served when it cannot be remembered', async () => {
    const { store, asked } = fakeStore({ host: { sample: samplePage } });
    store.remember = () => Promise.reject(new Error('QuotaExceededError'));
    expect(await pageForLink('sample', store)).toBe(samplePage);
    expect(await pageForLink('sample', store)).toBe(samplePage);
    expect(asked).toEqual(['sample', 'sample']);
  });

  it('without the cached page there is nothing to write from, and the host is not asked', async () => {
    const { store, asked } = fakeStore({ plain: null, host: { sample: samplePage } });
    expect(await pageForLink('sample', store)).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe('Service worker — what it keeps about a link', () => {
  it('a record holds the app name only, under an address of the link’s own', () => {
    expect(LINKS_CACHE).toBe('wizards-chess-links-v1');
    expect(linkRecordUrl('https://example.test/', 'sample')).toBe('https://example.test/start/sample/link.json');
    // Not an address the app or the worker takes for the link's page
    expect(startSlugFromPath(new URL(linkRecordUrl('https://example.test/', 'sample')).pathname)).toBeNull();
    expect(startPath('sample')).toBe('/start/sample/');
    const text = linkRecordText({ slug: 'sample', appName: 'Tom & "Jerry" <3' });
    expect(JSON.parse(text)).toEqual({ appName: 'Tom & "Jerry" <3' });
    expect(readLinkRecord('sample', text)).toEqual({ slug: 'sample', appName: 'Tom & "Jerry" <3' });
    expect(readLinkRecord('sample', linkRecordText({ slug: 'sample', appName: '' }))).toEqual({
      slug: 'sample',
      appName: '',
    });
  });

  it('a record that is not one is no record', () => {
    for (const text of ['', '<html>', 'null', '[]', '{}', '{"appName":3}']) {
      expect(readLinkRecord('sample', text), text).toBeNull();
    }
    expect(readLinkRecord('sample', `{"appName":"${'n'.repeat(50)}"}`)!.appName).toHaveLength(30);
  });
});

describe('Service worker — the links stay out of its public file', () => {
  it('no link is listed for the worker: first-run folders are not in its file list, and it names no slug', () => {
    expect(fs.readFileSync('vite.config.ts', 'utf8')).toContain("globIgnores: ['**/*.map', 'start/**']");
    for (const file of ['src/sw.ts', 'src/sw-links.ts', 'src/preset/start-path.ts']) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/start\/sample/);
      expect(text, file).not.toMatch(/gift\.local/);
    }
  });

  it('the link logic itself never touches the network (sw.ts does, through the LinkStore)', () => {
    expect(fs.readFileSync('src/sw-links.ts', 'utf8')).not.toMatch(/\bfetch\(|caches\./);
  });
});
