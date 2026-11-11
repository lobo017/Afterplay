import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startServer, waitForOfflineReady, type Server } from './helpers/server';

// Phase 8, the offline gate: after the first load the app needs no network. The test serves the
// build from its own server, lets the service worker cache everything, then STOPS the server and
// switches the browser offline, and checks that play, analysis, review, train and the Games list
// all still work (and that the page is still cross-origin isolated, so the engine still gets its
// threads). Also installability, and the update flow (a new build goes in by itself when nothing is in
// progress, and waits behind a "New version available" banner when something is).
const SCREENSHOT_DIR = path.join('test-results', 'phase8-screens');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

test.use({ serviceWorkers: 'allow' });

const QUEEN_BLUNDER_PGN = `[Event "Offline review"]
[White "Me"]
[Black "Them"]
[Result "0-1"]

1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 0-1`;

const PASTED_GAME = `[Event "Pasted offline"]
[Site "?"]
[Date "2026.10.20"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 1-0`;

async function noExternalAndNoFailures(page: Page): Promise<{ failed: string[]; network: string[] }> {
  const failed: string[] = [];
  const network: string[] = [];
  page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => {
    // Everything the page gets must come out of the service worker's cache: nothing is fetched
    if (r.url().startsWith('http') && !r.fromServiceWorker()) network.push(r.url());
  });
  return { failed, network };
}

async function clickMove(page: Page, scope: string, from: string, to: string): Promise<void> {
  await page.getByTestId(scope).getByTestId(`square-${from}`).click();
  await page.getByTestId(scope).getByTestId(`square-${to}`).click();
}

test.describe('Phase 8 — offline', () => {
  let server: Server | null = null;
  // Each test serves the build on an origin of its own, which the iPhone project's "install guide seen" storage state
  // does not cover: mark it seen here too, so the guide does not cover the board
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wc-install-guide-seen', '1'));
  });
  test.afterEach(async () => {
    await server?.stop();
    server = null;
  });

  test('after the first load, play, analysis, review, train and the Games list work with no network', async ({
    page,
    context,
  }) => {
    test.setTimeout(420_000);
    server = await startServer();
    const url = server.url;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);
    await expect(page.getByTestId('play-layout')).toBeVisible();

    // The first load caches the build
    const ready = await waitForOfflineReady(page);
    expect(Number(/\d+/.exec(ready)![0])).toBeGreaterThan(20);
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    // The server goes away and the browser is switched offline: nothing can come from a network
    await server.stop();
    await context.setOffline(true);
    const probe = await page.evaluate(() =>
      fetch(`/not-in-the-cache-${Date.now()}`).then(
        (r) => `status ${r.status}`,
        () => 'network error',
      ),
    );
    expect(probe).toBe('network error');

    const tracked = await noExternalAndNoFailures(page);
    await page.reload();
    await expect(page.getByTestId('play-layout')).toBeVisible();
    // The worker serves the page with the isolation headers, so the engine keeps its threads
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));

    // --- Play: a move, and the bot (its own engine and worker) answers
    await clickMove(page, 'play-layout', 'e2', 'e4');
    await expect
      .poll(() => page.evaluate(() => window.__wizardChessPlay!.controller.getGameTree().getMainLine().length), {
        timeout: 30_000,
      })
      .toBe(2);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'offline-play.png') });

    // --- Analysis: the live engine runs (multi-threaded: the page is isolated)
    await page.getByTestId('mode-tab-review').click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    await page.evaluate(() => window.__wizardChessAnalysis!.controller.loadFen('6k1/5ppp/8/8/8/8/8/3R2K1 w - - 0 1'));
    if ((await page.getByTestId('toggle-analysis-engine').getAttribute('aria-pressed')) !== 'true') {
      await page.getByTestId('toggle-analysis-engine').click();
    }
    await expect(page.getByTestId('eval-bar')).toHaveAttribute('data-mate', 'true', { timeout: 60_000 });
    await expect
      .poll(async () => Number(/\d+/.exec((await page.getByTestId('analysis-depth').textContent()) ?? '')?.[0] ?? 0), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(8);

    // --- Review: a game is reviewed start to end by the engine
    await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), QUEEN_BLUNDER_PGN);
    await page.getByTestId('btn-review-start').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
    await expect(page.getByTestId('review-body')).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'offline-review.png') });

    // --- Train: every trainer opens (their chunks, the puzzle worker and the endgame tables come from the cache)
    await page.getByTestId('mode-tab-train').click();
    await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await page.getByTestId('btn-train-start').click();
    await expect(page.getByTestId('puzzle-trainer')).toHaveAttribute('data-puzzle-state', 'playing', {
      timeout: 30_000,
    });
    await page.getByTestId('btn-train-hub').click();
    await page.getByTestId('btn-trainer-repertoire').click();
    await expect(page.getByTestId('repertoire-trainer')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('btn-train-hub').click();
    await page.getByTestId('btn-trainer-endgames').click();
    await expect(page.getByTestId('endgame-trainer')).toHaveAttribute('data-endgame-state', 'playing', {
      timeout: 30_000,
    });
    // The exact defender answers from its worker: a queen move, then the opponent's king moves
    await clickMove(page, 'endgame-trainer', 'd1', 'd2');
    await expect(page.getByTestId('endgame-moves')).toHaveText('1 move');
    await expect(page.getByTestId('endgame-status')).toHaveText('Your move as White', { timeout: 30_000 });
    await page.getByTestId('btn-train-hub').click();
    await page.getByTestId('btn-trainer-visualization').click();
    await expect(page.getByTestId('visualization-trainer')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'offline-train.png') });

    // --- Games list: paste a game (the import worker), find it, open it
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-list')).toBeVisible();
    await page.getByTestId('btn-games-import').click();
    await page.getByTestId('btn-games-paste').click();
    await page.getByTestId('games-paste-text').fill(PASTED_GAME);
    await page.getByTestId('btn-games-paste-import').click();
    await expect(page.getByTestId('games-message')).toContainText('Imported 1 game');
    await expect(page.getByTestId('games-row')).toHaveCount(1);
    await expect(page.getByTestId('games-row-opening')).toContainText('Sicilian');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'offline-games.png') });

    // The library survives another offline load
    await page.reload();
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-row')).toHaveCount(1);

    // Nothing failed, and nothing came from a network
    expect(tracked.failed).toEqual([]);
    expect(tracked.network).toEqual([]);
  });

  test('the app is installable: a full manifest with PNG icons, and the worker controls the page', async ({
    page,
    browserName,
  }) => {
    server = await startServer();
    await page.goto(server.url);
    await waitForOfflineReady(page);
    const manifest = await page.evaluate(async () => {
      const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href;
      return (await fetch(href)).json() as Promise<{
        name: string;
        start_url: string;
        display: string;
        icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
      }>;
    });
    expect(manifest).toMatchObject({ name: 'Afterplay', start_url: '/', display: 'standalone' });
    for (const size of ['192x192', '512x512']) {
      expect(
        manifest.icons.some((i) => i.sizes === size && i.type === 'image/png' && (i.purpose ?? 'any').includes('any')),
      ).toBe(true);
    }
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    // Every icon the manifest lists is really there, and really an image
    for (const icon of manifest.icons) {
      const res = await page.request.get(new URL(icon.src, server.url).href);
      expect(res.status(), icon.src).toBe(200);
      expect(res.headers()['content-type'], icon.src).toContain('image/');
    }
    // Safari's Home Screen: its icon (an image), the app's name and full screen
    const apple = await page.evaluate(() => ({
      icon: document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.href ?? null,
      capable: document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-capable"]')?.content ?? null,
      title: document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')?.content ?? null,
    }));
    expect(apple.capable).toBe('yes');
    expect(apple.title).toBe('Afterplay');
    const appleIcon = await page.request.get(apple.icon!);
    expect(appleIcon.status()).toBe(200);
    expect(appleIcon.headers()['content-type']).toContain('image/png');
    // Chrome's own installability check (Chromium only: WebKit has no such check) finds nothing wrong
    if (browserName !== 'chromium') return;
    const cdp = await page.context().newCDPSession(page);
    const result = (await cdp.send('Page.getInstallabilityErrors' as never)) as {
      installabilityErrors: Array<{ errorId: string }>;
    };
    // (A test browser runs in an incognito-like profile, where Chrome never offers installing)
    expect(result.installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito')).toEqual([]);
  });

  /** A copy of the build to serve, and a way to turn it into a "new build" (a changed page and worker). */
  function makeEditableBuild(): { dir: string; publishNewBuild(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-update-'));
    fs.cpSync('dist', dir, { recursive: true });
    return {
      dir,
      publishNewBuild() {
        const indexPath = path.join(dir, 'index.html');
        fs.writeFileSync(
          indexPath,
          fs
            .readFileSync(indexPath, 'utf8')
            .replace('<title>Afterplay</title>', '<title>Afterplay (new build)</title>'),
        );
        // (a real build also lists the page's new revision in the worker's file list)
        const swPath = path.join(dir, 'sw.js');
        const swText = fs.readFileSync(swPath, 'utf8');
        const bumped = swText.replace(/("revision":")[0-9a-f]+(","url":"index\.html")/, '$1new-build$2');
        expect(bumped).not.toBe(swText);
        fs.writeFileSync(swPath, bumped);
      },
    };
  }

  /** What the app does when it comes back to the front (a phone resuming the home-screen app). */
  async function resume(page: Page): Promise<void> {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  }

  test('with nothing in progress, an update is applied by itself and saved data survives it', async ({ page }) => {
    test.setTimeout(180_000);
    const build = makeEditableBuild();
    server = await startServer(build.dir);
    await page.goto(server.url);
    await waitForOfflineReady(page);
    const firstScript = await page.evaluate(() => (navigator.serviceWorker.controller as ServiceWorker).scriptURL);

    // Something saved on the old build
    await page.getByTestId('mode-tab-games').click();
    await page.getByTestId('btn-games-import').click();
    await page.getByTestId('btn-games-paste').click();
    await page.getByTestId('games-paste-text').fill(PASTED_GAME);
    await page.getByTestId('btn-games-paste-import').click();
    await expect(page.getByTestId('games-message')).toContainText('Imported 1 game');
    expect(await page.evaluate(() => window.__wizardChessUpdate?.inProgress())).toEqual([]);

    // A new build is published; the app finds it (as it does at launch) and, with nothing in progress, takes it
    build.publishNewBuild();
    let bannerSeen = false;
    const watchBanner = setInterval(() => {
      void page
        .getByTestId('update-banner')
        .isVisible()
        .then((v) => (bannerSeen ||= v))
        .catch(() => undefined);
    }, 100);
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    await expect.poll(() => page.title(), { timeout: 60_000 }).toBe('Afterplay (new build)');
    clearInterval(watchBanner);
    expect(bannerSeen, 'no banner when nothing is in progress').toBe(false);
    expect(await page.evaluate(() => (navigator.serviceWorker.controller as ServiceWorker).scriptURL)).toBe(
      firstScript,
    );

    // The new build has the old build's data
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-row')).toHaveCount(1);
    await expect(page.getByTestId('games-row-opening')).toContainText('Sicilian');
    fs.rmSync(build.dir, { recursive: true, force: true });
  });

  test('with a game in progress, an update waits behind the banner until Reload', async ({ page }) => {
    test.setTimeout(180_000);
    const build = makeEditableBuild();
    server = await startServer(build.dir);
    await page.goto(server.url);
    await waitForOfflineReady(page);
    await expect(page.getByTestId('update-banner')).toBeHidden();

    // A game under way
    await clickMove(page, 'play-layout', 'e2', 'e4');
    await expect.poll(() => page.evaluate(() => window.__wizardChessUpdate?.inProgress())).toContain('game');

    build.publishNewBuild();
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('update-banner')).toContainText('New version available');
    expect(await page.title()).toBe('Afterplay');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'update-banner.png') });
    await page.getByTestId('btn-update-later').click();
    await expect(page.getByTestId('update-banner')).toBeHidden();

    // Coming back to the app with the game still on: the banner again, never a reload under the game
    await resume(page);
    await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2500);
    expect(await page.title()).toBe('Afterplay');

    // Reload takes the new build
    await Promise.all([page.waitForEvent('load'), page.getByTestId('btn-update-reload').click()]);
    await expect.poll(() => page.title(), { timeout: 30_000 }).toBe('Afterplay (new build)');
    fs.rmSync(build.dir, { recursive: true, force: true });
  });
});
