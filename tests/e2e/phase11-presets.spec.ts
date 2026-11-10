import fs from 'node:fs';
import path from 'node:path';
import { devices, expect, test, type Page } from '@playwright/test';
import { startServer, waitForOfflineReady, type Server } from './helpers/server';

// Phase 11 stage 3: presets and the first-run link. `/start/sample/` is the committed sample link (invented names:
// public/start/sample/preset.json); the build writes its page and manifest (scripts/build-start-pages.mjs).
// Runs in every project; the order "welcome, then the Add to Home Screen guide" only exists on the iPhone.
const SCREENSHOT_DIR = path.join('test-results', 'phase11-screens');
const SAMPLE = '/start/sample/';

const isPhoneProject = () => test.info().project.name === 'webkit-iphone';

async function screenshot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${test.info().project.name}-${name}.png`) });
}

const playFrame = (page: Page) => page.getByTestId('play-layout').getByTestId('chess-board-frame');

/** Opens a first-run link and waits until the app has dealt with it. */
async function openLink(page: Page, url: string, outcome: 'applied' | 'already' | 'failed' | 'none'): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('play-layout').getByTestId('chess-board')).toBeVisible();
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', outcome, { timeout: 15_000 });
}

async function closeWelcome(page: Page): Promise<void> {
  await expect(page.getByTestId('welcome-sheet')).toBeVisible();
  await page.getByTestId('welcome-done').click();
  await expect(page.getByTestId('welcome-sheet')).toBeHidden();
}

test.describe('Phase 11 — presets and the first-run link', () => {
  test('the sample link sets the app up once: look, names, bots, welcome, Home Screen name', async ({ page }) => {
    const presetRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/preset.json')) presetRequests.push(r.url());
    });
    await openLink(page, SAMPLE, 'applied');
    expect(presetRequests).toHaveLength(1);

    // The welcome message, shown as plain text in paragraphs
    const welcome = page.getByTestId('welcome-sheet');
    await expect(welcome).toBeVisible();
    await expect(page.getByTestId('welcome-title')).toHaveText('Welcome, Ada');
    await expect(page.getByTestId('welcome-message').locator('p')).toHaveCount(2);
    await expect(page.getByTestId('welcome-message')).toContainText('was set up for you');
    await expect(page.getByTestId('welcome-from')).toHaveText('A sample preset (invented names)');
    await screenshot(page, 'preset-welcome');
    await closeWelcome(page);

    // Look
    await expect(playFrame(page)).toHaveAttribute('data-theme', 'green');
    await expect(playFrame(page)).toHaveAttribute('data-piece-set', 'classic');
    const lightSquare = await page
      .getByTestId('play-layout')
      .getByTestId('square-e4')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(lightSquare).toBe('rgb(237, 238, 212)');
    // The classic pieces are their own drawings (a 45-unit box, not the app's 100)
    await expect(page.getByTestId('play-layout').locator('.wc-piece-svg').first()).toHaveAttribute(
      'viewBox',
      '0 0 45 45',
    );

    // Names: mine with its title, and the bot the preset's level names
    await expect(page.getByTestId('bottom-player-name')).toHaveText('Ada (White)');
    await expect(page.getByTestId('bottom-player-title')).toHaveText('Countess');
    await expect(page.getByTestId('bottom-player-title')).toBeVisible();
    await expect(page.getByTestId('top-player-name')).toHaveText('Professor Rook (800)');
    await expect(page.getByTestId('top-player-title')).toBeHidden();

    // The New game card: the three named bots, the preset's level and time control chosen
    await expect(page.getByTestId('custom-bots').locator('button')).toHaveCount(3);
    await expect(page.getByTestId('custom-bot-0')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('custom-bot-1')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('bot-rating-label')).toHaveText('Professor Rook · 800 Elo');
    await expect(page.getByTestId('time-control-10+0')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('bottom-clock')).toHaveText('10:00');
    await screenshot(page, 'preset-play');

    // The app's name: page title, the heading, the iOS Home Screen title, and the link's own manifest
    await expect(page).toHaveTitle("Ada's Chess");
    await expect(page.getByTestId('brand-title')).toHaveText("Ada's Chess");
    const head = await page.evaluate(() => ({
      manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
      appleTitle: document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')?.content,
      robots: document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content,
    }));
    expect(head).toEqual({
      manifest: '/start/sample/manifest.webmanifest',
      appleTitle: "Ada's Chess",
      robots: 'noindex',
    });
    const manifest = (await (await page.request.get('/start/sample/manifest.webmanifest')).json()) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      name: "Ada's Chess",
      short_name: "Ada's Chess",
      start_url: '/start/sample/',
      scope: '/',
      display: 'standalone',
    });

    // Settings: the profile, the username, and the welcome message again
    await page.getByTestId('btn-settings').click();
    await expect(page.getByTestId('settings-sheet')).toBeVisible();
    await expect(page.getByTestId('input-display-name')).toHaveValue('Ada');
    await expect(page.getByTestId('input-profile-title')).toHaveValue('Countess');
    await expect(page.getByTestId('input-chesscom-username')).toHaveValue('ada-sample');
    await screenshot(page, 'preset-settings');
    await page.getByTestId('btn-show-welcome').click();
    await expect(page.getByTestId('settings-sheet')).toBeHidden();
    await closeWelcome(page);

    // What I change afterwards is mine: a reload neither fetches the preset nor applies it again
    await page.getByTestId('btn-settings').click();
    await page.getByTestId('select-board-theme').selectOption('imperial-walnut');
    await page.getByTestId('input-display-name').fill('Ada L.');
    await page.getByTestId('input-display-name').blur();
    await page.getByTestId('settings-sheet-close').click();
    await expect(page.getByTestId('bottom-player-name')).toHaveText('Ada L. (White)');
    await openLink(page, SAMPLE, 'already');
    await expect(playFrame(page)).toHaveAttribute('data-theme', 'imperial-walnut');
    await expect(playFrame(page)).toHaveAttribute('data-piece-set', 'classic');
    await expect(page.getByTestId('bottom-player-name')).toHaveText('Ada L. (White)');
    await expect(page.getByTestId('top-player-name')).toHaveText('Professor Rook (800)');
    await expect(page).toHaveTitle("Ada's Chess");
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('welcome-sheet')).toBeHidden();
    expect(presetRequests).toHaveLength(1);
  });

  test('a game against a named bot is stored with both names and my title', async ({ page }) => {
    await openLink(page, SAMPLE, 'applied');
    await closeWelcome(page);
    await page.getByTestId('custom-bot-1').click();
    await expect(page.getByTestId('bot-rating-label')).toHaveText('The Gambit Goblin · 1200 Elo');
    await expect(page.getByTestId('bot-style-gambiteer')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('btn-new-game').click();
    await expect(page.getByTestId('top-player-name')).toHaveText('The Gambit Goblin (1200)');
    await page.evaluate(() => window.__wizardChessPlay!.controller.setBotMoveDelayMs(5));
    await page.getByTestId('play-layout').getByTestId('square-e2').click();
    await page.getByTestId('play-layout').getByTestId('square-e4').click();
    await expect
      .poll(() => page.evaluate(() => window.__wizardChessPlay!.controller.getGameTree().getMainLine().length), {
        timeout: 30_000,
      })
      .toBe(2);
    await page.evaluate(() => window.__wizardChessPlay!.controller.resign());
    await expect
      .poll(() => page.evaluate(async () => (await (await window.__wizardChessLibraryReady!).library.list()).length))
      .toBe(1);
    const record = await page.evaluate(async () => {
      const [game] = await (await window.__wizardChessLibraryReady!).library.list();
      return { white: game!.white, black: game!.black, source: game!.source, color: game!.playerColor, pgn: game!.pgn };
    });
    expect(record).toMatchObject({ white: 'Ada', black: 'The Gambit Goblin', source: 'play', color: 'w' });
    expect(record.pgn).toContain('[WhiteTitle "Countess"]');
    expect(record.pgn).toContain('[Event "Casual game vs The Gambit Goblin (1200)"]');
    expect(record.pgn).toContain('[BlackElo "1200"]');
    // The Games list shows the bot by its name
    await page.getByTestId('mode-tab-games').click();
    await expect(page.getByTestId('games-row')).toHaveCount(1);
    await expect(page.getByTestId('games-row-opponent')).toContainText('The Gambit Goblin');
  });

  test('an unknown link says so and leaves the app as it is', async ({ page }) => {
    await openLink(page, '/start/no-such-link/', 'failed');
    await expect(page.getByTestId('app-notice')).toBeVisible();
    await expect(page.getByTestId('app-notice-text')).toContainText('set-up link is not known here');
    await screenshot(page, 'preset-unknown-link');
    await page.getByTestId('btn-notice-ok').click();
    await expect(page.getByTestId('app-notice')).toBeHidden();
    await expect(playFrame(page)).toHaveAttribute('data-theme', 'marble-obsidian');
    await expect(page.getByTestId('bottom-player-name')).toHaveText('You (White)');
    await expect(page).toHaveTitle("Wizard's Chess");
    expect(await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.getAttribute('href'))).toBe(
      '/manifest.webmanifest',
    );
    await expect(page.getByTestId('welcome-sheet')).toBeHidden();
    // The board works
    await page.getByTestId('play-layout').getByTestId('square-e2').click();
    await page.getByTestId('play-layout').getByTestId('square-e4').click();
    await expect
      .poll(() => page.evaluate(() => window.__wizardChessPlay!.controller.getGameTree().getMainLine().length))
      .toBeGreaterThanOrEqual(1);
  });

  test('without a link nothing is personalized', async ({ page }) => {
    await openLink(page, '/', 'none');
    await expect(page.getByTestId('bottom-player-name')).toHaveText('You (White)');
    await expect(page.getByTestId('bottom-player-title')).toBeHidden();
    await expect(page.getByTestId('top-player-name')).toHaveText('Stockfish Club (1400)');
    await expect(page.getByTestId('custom-bots')).toBeHidden();
    await expect(page.getByTestId('bot-rating-label')).toHaveText('1400 Elo (Club)');
    await expect(page).toHaveTitle("Wizard's Chess");
    await expect(page.getByTestId('brand-title')).toHaveText("Wizard's Chess");
    await page.getByTestId('btn-settings').click();
    await expect(page.getByTestId('input-display-name')).toHaveValue('');
    await expect(page.getByTestId('row-welcome-message')).toBeHidden();
    // Settings › Profile alone gives me a name and a title
    await page.getByTestId('input-display-name').fill('Morgan');
    await page.getByTestId('input-profile-title').fill('CM');
    await page.getByTestId('input-profile-title').blur();
    await page.getByTestId('settings-sheet-close').click();
    await expect(page.getByTestId('bottom-player-name')).toHaveText('Morgan (White)');
    await expect(page.getByTestId('bottom-player-title')).toHaveText('CM');
    await page.reload();
    await expect(page.getByTestId('bottom-player-name')).toHaveText('Morgan (White)');
    await expect(page.getByTestId('bottom-player-title')).toHaveText('CM');
  });

  test('on an iPhone the Add to Home Screen guide follows the welcome and uses the app name', async ({
    page,
    browser,
  }) => {
    if (isPhoneProject()) {
      // A first visit: a fresh iPhone context without the project's "guide seen" storage state
      const context = await browser.newContext({
        ...devices['iPhone 13'],
        baseURL: test.info().project.use.baseURL,
        serviceWorkers: 'block',
        storageState: { cookies: [], origins: [] },
      });
      const first = await context.newPage();
      await openLink(first, SAMPLE, 'applied');
      const guide = first.getByTestId('install-guide');
      await expect(first.getByTestId('welcome-sheet')).toBeVisible();
      // The guide waits for the welcome
      await first.waitForTimeout(1200);
      await expect(guide).toBeHidden();
      await screenshot(first, 'preset-welcome-first-visit');
      await closeWelcome(first);
      await expect(guide).toBeVisible();
      await expect(first.getByTestId('install-guide-intro')).toContainText("Ada's Chess runs as an app");
      await expect(first.getByTestId('install-picture-home')).toContainText("Ada's Chess");
      await first.getByTestId('install-step-4').scrollIntoViewIfNeeded();
      await screenshot(first, 'preset-install-guide');
      await first.getByTestId('install-guide-done').click();
      await expect(guide).toBeHidden();
      // Both seen: neither opens again
      await openLink(first, SAMPLE, 'already');
      await first.waitForTimeout(1500);
      await expect(first.getByTestId('welcome-sheet')).toBeHidden();
      await expect(guide).toBeHidden();
      await context.close();
    } else {
      await openLink(page, SAMPLE, 'applied');
      await closeWelcome(page);
      await page.waitForTimeout(1200);
      await expect(page.getByTestId('install-guide')).toBeHidden();
    }
  });

  test('a welcome that was not closed is shown again; one that was is not', async ({ page }) => {
    await openLink(page, SAMPLE, 'applied');
    await expect(page.getByTestId('welcome-sheet')).toBeVisible();
    // Reloaded with the welcome still open
    await openLink(page, SAMPLE, 'already');
    await closeWelcome(page);
    await openLink(page, SAMPLE, 'already');
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('welcome-sheet')).toBeHidden();
  });
});

test.describe('Phase 11 — the first-run link offline', () => {
  // The installed app starts at the link every time, so the link has to open with no network
  test.use({ serviceWorkers: 'allow' });
  let server: Server | null = null;
  test.beforeEach(async ({ page }) => {
    // Its own origin, which the iPhone project's "install guide seen" storage state does not cover
    await page.addInitScript(() => localStorage.setItem('wc-install-guide-seen', '1'));
  });
  test.afterEach(async () => {
    await server?.stop();
    server = null;
  });

  test('once set up, the link opens with no network and stays set up', async ({ page, context }) => {
    test.setTimeout(180_000);
    server = await startServer();
    await openLink(page, `${server.url}${SAMPLE}`, 'applied');
    await closeWelcome(page);
    await page.getByTestId('btn-settings').click();
    await waitForOfflineReady(page);
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    await server.stop();
    await context.setOffline(true);
    const network: string[] = [];
    page.on('response', (r) => {
      if (r.url().startsWith('http') && !r.fromServiceWorker()) network.push(r.url());
    });
    await openLink(page, `${server.url}${SAMPLE}`, 'already');
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    await expect(playFrame(page)).toHaveAttribute('data-theme', 'green');
    await expect(page.getByTestId('bottom-player-name')).toHaveText('Ada (White)');
    await expect(page.getByTestId('top-player-name')).toHaveText('Professor Rook (800)');
    // The plain app page came from the cache; the app put the link's name and manifest back
    await expect(page).toHaveTitle("Ada's Chess");
    expect(await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.getAttribute('href'))).toBe(
      '/start/sample/manifest.webmanifest',
    );
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('welcome-sheet')).toBeHidden();
    expect(network).toEqual([]);
  });
});
