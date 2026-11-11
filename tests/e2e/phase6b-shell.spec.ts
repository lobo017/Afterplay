import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 6b stage 1: the app frame. Four destinations (Play, Train, Review, Games), routes and
// the old links, the Settings sheet with About & diagnostics, and the phone tab bar.
const SCREENSHOT_DIR = path.join('test-results', 'phase6b-screens');
const MODES = ['play', 'train', 'review', 'games'] as const;

async function current(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="main-nav"] [aria-current="page"]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.mode ?? ''));
}

async function sideScroll(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test.describe('Phase 6b — app frame and navigation', () => {
  test('four destinations, one current at a time, each showing its screen', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (r) => {
      const host = new URL(r.url()).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost') external.push(r.url());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('main-nav').locator('button')).toHaveText(['Play', 'Train', 'Review', 'Games']);
    expect(await current(page)).toEqual(['play']);
    await expect(page.getByTestId('play-layout')).toBeVisible();

    const screens: Record<(typeof MODES)[number], string> = {
      play: 'play-layout',
      train: 'train-hub',
      review: 'analysis-layout',
      games: 'games-list',
    };
    for (const mode of [...MODES].reverse()) {
      await page.getByTestId(`mode-tab-${mode}`).click();
      expect(await current(page)).toEqual([mode]);
      await expect(page.getByTestId(screens[mode])).toBeVisible();
      await expect(page.getByTestId('app-shell')).toHaveAttribute('data-mode', mode);
      expect(await page.evaluate(() => window.__wizardChessAnalysis!.getMode())).toBe(mode);
    }
    // The old header badges and diagnostics strip are no longer on the page
    await expect(page.getByTestId('isolation-badge')).toBeHidden();
    await expect(page.getByTestId('stat-engine')).toBeHidden();
    expect(external).toEqual([]);
  });

  test('routes and the links from before (analysis, today, puzzles) open the right destination', async ({ page }) => {
    const cases: Array<[string, string]> = [
      ['/#play', 'play'],
      ['/#train', 'train'],
      ['/#review', 'review'],
      ['/#games', 'games'],
      ['/#analysis', 'review'],
      ['/#today', 'train'],
      ['/#puzzles', 'train'],
      ['/?mode=analysis', 'review'],
      ['/?mode=puzzles', 'train'],
    ];
    for (const [url, mode] of cases) {
      await page.goto(url);
      await expect(page.getByTestId(`mode-tab-${mode}`)).toHaveAttribute('aria-current', 'page');
      expect(await current(page), url).toEqual([mode]);
    }
    // Train opens on its hub; the puzzle trainer isn't loaded yet
    await page.goto('/#puzzles');
    await expect(page.getByTestId('train-hub')).toBeVisible();
    await expect(page.getByTestId('train-session')).toBeHidden();
  });

  test('Train: the hub starts a session, "‹ Train" and the Train tab return to the hub', async ({ page }) => {
    await page.goto('/#train');
    await page.evaluate(() => window.__wizardChessPuzzlesReady);
    await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready');
    await page.getByTestId('btn-train-start').click();
    await expect(page.getByTestId('train-session')).toBeVisible();
    await expect(page.getByTestId('puzzle-trainer')).toHaveAttribute('data-puzzle-state', 'playing', {
      timeout: 15_000,
    });
    expect(await page.evaluate(() => window.__wizardChessPuzzles!.getTrainView())).toBe('session');

    await page.getByTestId('btn-train-hub').click();
    await expect(page.getByTestId('train-hub')).toBeVisible();
    await expect(page.getByTestId('train-session')).toBeHidden();

    // Leaving Train keeps the session; coming back shows it; Train again goes to the hub
    await page.getByTestId('btn-today-rated').click();
    await expect(page.getByTestId('train-session')).toBeVisible();
    await page.getByTestId('mode-tab-play').click();
    await page.getByTestId('mode-tab-train').click();
    await expect(page.getByTestId('train-session')).toBeVisible();
    await page.getByTestId('mode-tab-train').click();
    await expect(page.getByTestId('train-hub')).toBeVisible();
  });

  test('Settings opens from the top bar and closes by button, Escape and backdrop, returning focus', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const sheet = page.getByTestId('settings-sheet');
    const opener = page.getByTestId('btn-settings');
    await expect(sheet).toBeHidden();

    await opener.click();
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('role', 'dialog');
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(sheet.locator('h2')).toHaveText('Settings');
    // Focus moved into the sheet
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="settings-sheet"]') !== null)).toBe(
      true,
    );

    // About & diagnostics holds what used to be in the header and footer
    const about = page.getByTestId('settings-about');
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
    await expect(about.getByTestId('isolation-badge')).toBeVisible();
    await expect(about.getByTestId('isolation-badge')).toContainText('COOP/COEP Isolated');
    await expect(about.getByTestId('core-badge')).toContainText('IDB v4');
    await expect(about.getByTestId('engine-badge')).toContainText('Stockfish 17.1 WASM');
    await expect(about.getByTestId('network-badge')).toHaveText('Offline shell · network only for the Chess.com sync');
    await expect(about.getByTestId('stat-network')).toContainText('Only the Chess.com sync, when you press it');
    for (const id of ['threading', 'network', 'datasets', 'rules', 'pgn', 'storage', 'engine', 'bot']) {
      await expect(about.getByTestId(`stat-${id}`)).toBeVisible();
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-settings-about.png') });

    // The performance overlay switch, and the backtick key, both still work
    const overlaySwitch = about.getByTestId('toggle-dev-overlay');
    await expect(overlaySwitch).toHaveAttribute('aria-checked', 'false');
    await overlaySwitch.click();
    await expect(page.getByTestId('dev-overlay')).toBeVisible();
    await expect(overlaySwitch).toHaveAttribute('aria-checked', 'true');
    await overlaySwitch.click();
    await expect(page.getByTestId('dev-overlay')).toBeHidden();

    await page.getByTestId('settings-sheet-close').click();
    await expect(sheet).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    await page.getByTestId('settings-sheet-backdrop').click({ position: { x: 40, y: 400 } });
    await expect(sheet).toBeHidden();

    // Tab stays inside the open sheet
    await opener.click();
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="settings-sheet"]') !== null)).toBe(
      true,
    );
    await page.keyboard.press('Escape');
    await page.keyboard.press('`');
    await expect(page.getByTestId('dev-overlay')).toBeVisible();
  });

  test('phone: a bottom tab bar, the screen name on top, full-screen Settings, no sideways scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const nav = (await page.getByTestId('main-nav').boundingBox())!;
    expect(Math.round(nav.y + nav.height)).toBe(844);
    expect(Math.round(nav.width)).toBe(390);
    await expect(page.getByTestId('screen-title')).toHaveText('Play');
    // The app's heading gives way to the screen name: out of sight (a 1 px clipped box), still there for screen readers
    const heading = page.getByRole('heading', { name: 'Afterplay' });
    await expect(heading).toBeAttached();
    const headingBox = (await heading.boundingBox())!;
    expect(headingBox.width).toBeLessThanOrEqual(1);
    expect(headingBox.height).toBeLessThanOrEqual(1);
    for (const mode of MODES) {
      await page.getByTestId(`mode-tab-${mode}`).click();
      await expect(page.getByTestId('screen-title')).toHaveText(mode[0]!.toUpperCase() + mode.slice(1));
      expect(await sideScroll(page), mode).toBeLessThanOrEqual(0);
      // Each nav button is a comfortable touch target
      const b = (await page.getByTestId(`mode-tab-${mode}`).boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId('mode-tab-play').click();
    // The bottom of the page isn't hidden under the tab bar
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const lastBottom = await page.evaluate(() => {
      // checkVisibility: closed <details> content keeps a layout box but isn't shown
      const els = [...document.querySelectorAll('.wc-main *')].filter((e) => e.checkVisibility());
      return Math.max(...els.map((e) => e.getBoundingClientRect().bottom));
    });
    expect(lastBottom).toBeLessThanOrEqual(nav.y + 1);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-shell-play.png') });

    await page.getByTestId('btn-settings').click();
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
    const sheet = (await page.getByTestId('settings-sheet').boundingBox())!;
    expect(Math.round(sheet.width)).toBe(390);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-settings-about.png') });
  });
});
