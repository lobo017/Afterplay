import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devices, expect, test, type Page } from '@playwright/test';
import { presetAppName, startIndexHtml, startManifest } from '../../scripts/lib/start-pages.mjs';
import { startServer, waitForOfflineReady, type Server } from './helpers/server';

// Phase 11: a first-run link with the service worker in control. The host serves a link's own page (its manifest, the
// preset's name) only to a browser the worker does not control yet; from the second visit on the worker answers, and
// it has to answer with that link's page too: "Add to Home Screen" reads the manifest of the page as it was served,
// and a manifest that starts at "/" installs an app that never opens the link, so it is never set up.
//
// Every test serves the build on an origin of its own, with the worker on. Runs in every project. Playwright cannot
// press "Add to Home Screen": the installed app is modelled as what it is, a browser with empty storage of its own,
// running standalone, opened at the start_url of the manifest the page named.
const SAMPLE = '/start/sample/';
const SAMPLE_PAGE = {
  fromWorker: true,
  manifest: '/start/sample/manifest.webmanifest',
  title: "Ada's Chess",
  appleTitle: "Ada's Chess",
  noindex: true,
  startUrl: '/start/sample/',
  appName: "Ada's Chess",
};
const PLAIN_PAGE = {
  fromWorker: true,
  manifest: '/manifest.webmanifest',
  title: 'Afterplay',
  appleTitle: 'Afterplay',
  noindex: false,
  startUrl: '/',
  appName: 'Afterplay',
};

/** A second link, as the build would write it (scripts/build-start-pages.mjs); its name needs escaping in a page. */
const SECOND = '/start/second-link/';
const SECOND_PRESET = JSON.stringify({
  version: 1,
  appName: 'Grace & Co',
  profile: { displayName: 'Grace' },
  settings: { boardTheme: 'imperial-walnut' },
});
const SECOND_PAGE = {
  fromWorker: true,
  manifest: '/start/second-link/manifest.webmanifest',
  title: 'Grace &amp; Co',
  appleTitle: 'Grace &amp; Co',
  noindex: true,
  startUrl: '/start/second-link/',
  appName: 'Grace & Co',
};

const playFrame = (page: Page) => page.getByTestId('play-layout').getByTestId('chess-board-frame');

/**
 * Opens an address and reports the page as it was served, before any script ran (the app also puts a link's name and
 * manifest in place itself, a moment after load, which is too late for an install that reads the page as it came),
 * and what the manifest that page names says.
 */
async function open(page: Page, url: string) {
  const response = (await page.goto(url))!;
  const html = await response.text();
  const manifest = /<link rel="manifest" href="([^"]*)"/.exec(html)?.[1] ?? null;
  const named = manifest
    ? ((await (await page.request.get(new URL(manifest, url).href)).json()) as { start_url?: string; name?: string })
    : null;
  await expect(page.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
  return {
    fromWorker: response.fromServiceWorker(),
    manifest,
    title: /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? null,
    appleTitle: /<meta name="apple-mobile-web-app-title" content="([^"]*)"/.exec(html)?.[1] ?? null,
    noindex: /<meta name="robots" content="noindex"/.test(html),
    startUrl: named?.start_url ?? null,
    appName: named?.name ?? null,
  };
}

async function expectFirstRun(page: Page, outcome: 'applied' | 'already' | 'failed' | 'none'): Promise<void> {
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', outcome, { timeout: 15_000 });
}

async function closeWelcome(page: Page): Promise<void> {
  await expect(page.getByTestId('welcome-sheet')).toBeVisible();
  await page.getByTestId('welcome-done').click();
  await expect(page.getByTestId('welcome-sheet')).toBeHidden();
}

/** Waits until the worker has cached the build and controls the page (Settings › About says so). */
async function workerInControl(page: Page): Promise<void> {
  await page.getByTestId('btn-settings').click();
  await waitForOfflineReady(page);
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
}

async function expectSamplePreset(page: Page): Promise<void> {
  await expect(playFrame(page)).toHaveAttribute('data-theme', 'green');
  await expect(page.getByTestId('bottom-player-name')).toHaveText('Ada (White)');
  await expect(page.getByTestId('top-player-name')).toHaveText('Professor Rook (800)');
  await expect(page).toHaveTitle("Ada's Chess");
}

/** A first visit to the sample link (the host's page, no worker yet), set up, with the worker then in control. */
async function firstVisit(page: Page, origin: string): Promise<void> {
  const first = await open(page, `${origin}${SAMPLE}`);
  expect(first).toEqual({ ...SAMPLE_PAGE, fromWorker: false });
  await expectFirstRun(page, 'applied');
  await closeWelcome(page);
  await workerInControl(page);
}

test.describe('Phase 11 — a first-run link with the worker in control', () => {
  test.use({ serviceWorkers: 'allow' });
  let server: Server | null = null;
  let buildDir: string | null = null;
  test.beforeEach(async ({ page }) => {
    // Its own origin, which the iPhone project's "install guide seen" storage state does not cover
    await page.addInitScript(() => localStorage.setItem('wc-install-guide-seen', '1'));
  });
  test.afterEach(async () => {
    await server?.stop();
    server = null;
    if (buildDir) fs.rmSync(buildDir, { recursive: true, force: true });
    buildDir = null;
  });

  test("a second visit is served the link's own page and manifest, and stays set up", async ({ page }) => {
    test.setTimeout(180_000);
    server = await startServer();
    await firstVisit(page, server.url);

    const second = await open(page, `${server.url}${SAMPLE}`);
    expect(second).toEqual(SAMPLE_PAGE);
    await expectFirstRun(page, 'already');
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    await expectSamplePreset(page);
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('welcome-sheet')).toBeHidden();
    // And every visit after it
    expect(await open(page, `${server.url}${SAMPLE}`)).toEqual(SAMPLE_PAGE);
  });

  test("a link the worker has not seen is served that link's page; an unknown one keeps the app's own", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // A copy of the build with a second link in it
    buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-links-'));
    fs.cpSync('dist', buildDir, { recursive: true });
    const linkDir = path.join(buildDir, 'start', 'second-link');
    fs.mkdirSync(linkDir, { recursive: true });
    const name = presetAppName(SECOND_PRESET);
    fs.writeFileSync(path.join(linkDir, 'preset.json'), SECOND_PRESET);
    fs.writeFileSync(
      path.join(linkDir, 'index.html'),
      startIndexHtml(fs.readFileSync(path.join(buildDir, 'index.html'), 'utf8'), 'second-link', name),
    );
    fs.writeFileSync(
      path.join(linkDir, 'manifest.webmanifest'),
      startManifest(fs.readFileSync(path.join(buildDir, 'manifest.webmanifest'), 'utf8'), 'second-link', name),
    );
    server = await startServer(buildDir);
    // The worker takes control on a visit to another link (the sample), as on a phone that opened the sample first
    await firstVisit(page, server.url);

    const other = await open(page, `${server.url}${SECOND}`);
    expect(other).toEqual(SECOND_PAGE);
    await expectFirstRun(page, 'applied');
    await expect(page).toHaveTitle('Grace & Co');
    await expect(playFrame(page)).toHaveAttribute('data-theme', 'imperial-walnut');
    await expect(page.getByTestId('bottom-player-name')).toHaveText('Grace (White)');
    // Now a link the worker knows
    expect(await open(page, `${server.url}${SECOND}`)).toEqual(SECOND_PAGE);
    await expectFirstRun(page, 'already');

    // A link that does not exist is not learned: the app's own page and manifest, and the app says so
    expect(await open(page, `${server.url}/start/no-such-link/`)).toEqual(PLAIN_PAGE);
    await expectFirstRun(page, 'failed');
    await expect(page.getByTestId('app-notice-text')).toContainText('set-up link is not known here');
    expect(await open(page, `${server.url}/start/no-such-link/`)).toEqual(PLAIN_PAGE);
  });

  test('the installed app: started where the second visit’s manifest says, it sets itself up, then opens with no network', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    server = await startServer();
    // In the browser: a first visit, then the visit "Add to Home Screen" is pressed on (the worker is in control)
    await firstVisit(page, server.url);
    const installedFrom = await open(page, `${server.url}${SAMPLE}`);
    expect(installedFrom.fromWorker).toBe(true);
    expect(installedFrom.startUrl, 'the manifest of the page as served names where the app starts').not.toBeNull();
    const launchUrl = new URL(installedFrom.startUrl!, server.url).href;

    // The Home Screen app: its own empty storage (and its own worker), standalone, opened at that start_url
    const device = {
      chromium: devices['Desktop Chrome'],
      webkit: devices['Desktop Safari'],
      'webkit-iphone': devices['iPhone 13'],
    }[test.info().project.name]!;
    const homeScreen = await browser.newContext({
      ...device,
      serviceWorkers: 'allow',
      storageState: { cookies: [], origins: [] },
    });
    try {
      await homeScreen.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });
      });
      const app = await homeScreen.newPage();
      const firstLaunch = await open(app, launchUrl);
      expect(firstLaunch.fromWorker).toBe(false);
      await expectFirstRun(app, 'applied');
      await expect(app.getByTestId('welcome-sheet')).toBeVisible();
      await expect(app.getByTestId('welcome-title')).toHaveText('Welcome, Ada');
      await expect(app.getByTestId('install-guide')).toBeHidden();
      await closeWelcome(app);
      await expectSamplePreset(app);
      await app.waitForTimeout(1200);
      await expect(app.getByTestId('install-guide')).toBeHidden();
      await workerInControl(app);

      // Every later launch starts at the link again; this one with no network at all
      await server.stop();
      await homeScreen.setOffline(true);
      const network: string[] = [];
      app.on('response', (r) => {
        if (r.url().startsWith('http') && !r.fromServiceWorker()) network.push(r.url());
      });
      const offlineLaunch = (await app.goto(launchUrl))!;
      const html = await offlineLaunch.text();
      await expect(app.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
      expect(offlineLaunch.fromServiceWorker()).toBe(true);
      // The page is the link's own, written by the worker from its cache
      expect(html).toContain('<link rel="manifest" href="/start/sample/manifest.webmanifest">');
      expect(html).toContain("<title>Ada's Chess</title>");
      expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Ada\'s Chess" />');
      await expectFirstRun(app, 'already');
      expect(await app.evaluate(() => window.crossOriginIsolated)).toBe(true);
      await expectSamplePreset(app);
      await app.waitForTimeout(1200);
      await expect(app.getByTestId('welcome-sheet')).toBeHidden();
      await expect(app.getByTestId('install-guide')).toBeHidden();
      expect(network).toEqual([]);
    } finally {
      await homeScreen.close();
    }
  });
});
